import type {
  SpendChatEmployeeReport,
  SpendChatFilterTotal,
  SpendChatReport,
  SpendEmployeeChatReport,
  SpendEmployeeReport,
  SpendModelBreakdown,
  SpendRange,
  SpendReport,
  SpendTotals,
  SpendTrendBucket,
} from "@shared/types";
import { SPEND_EMPLOYEE_RECENT_CHATS } from "@shared/constants/spend";
import { matchesTagFilter } from "@shared/constants/tags";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "fs/promises";
import { loadPiSdk } from "./agent/pi-sdk";
import { listEmployeeIdentities } from "./db/employees";
import { getDB } from "./db/index";
import { tagsForChats } from "./db/tags";
import { getResolvedLocale } from "./locale";

/**
 * Usage statistics aggregated from the persisted Pi session JSONL files.
 *
 * The report is computed by streaming those files (nothing is mirrored in
 * SQLite); a per-file `(mtimeMs, size)` cache keeps a revisit cheap and
 * reparses only sessions that changed. A malformed or unreadable session is
 * skipped rather than failing the whole report.
 *
 * Tool-result usage (`message.role === "toolResult"`) is deliberately ignored:
 * it covers nested calls outside the main loop's accounting, and counting it
 * alongside the assistant responses would double count that spend.
 */

/** One provider call's usage, flattened for aggregation. */
interface SpendRecord {
  /** Epoch ms; 0 when the entry carried no parseable timestamp. */
  ts: number;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** Token + cost payload read off a `Usage` object. */
type SpendCounters = Omit<SpendRecord, "ts" | "provider" | "model">;

interface CachedSession {
  mtimeMs: number;
  size: number;
  records: SpendRecord[];
}

/** Parsed usage per session file, invalidated by mtime/size. */
const sessionCache = new Map<string, CachedSession>();

/** Concurrent session-file reads, so a long history cannot exhaust memory. */
const READ_CONCURRENCY = 4;

interface SessionRow {
  employee_id: number;
  chat_id: number;
  session: string;
}

interface ChatRow {
  id: number;
  title: string;
  from_chat_id: number | null;
  pinned: number;
  last_message_at: number;
}

/** Accumulator used for both the grand total and each employee. */
interface Accumulator {
  totals: SpendTotals;
  byModel: Map<string, SpendModelBreakdown>;
  /** Trend buckets keyed by `HH` (today) or `YYYY-MM-DD` (week/month). */
  trend: Map<string, SpendTotals>;
  chats: Set<number>;
}

/**
 * Build the usage report for `range` (the `spend:report` IPC payload).
 *
 * `chatTags` is the conversation grouping's tag filter: it narrows **only**
 * `chatFilterTotal` (the "All conversations" number). The grand total, the
 * employee rows and the `chats` rows are unaffected — the renderer narrows its
 * own list rows. Passing no filter (or an empty one) reproduces the unfiltered
 * report exactly.
 */
export async function buildSpendReport(
  range: SpendRange,
  chatTags: readonly string[] = [],
): Promise<SpendReport> {
  const now = Date.now();
  const cutoff = rangeCutoff(range, now);
  const rows = getDB()
    .prepare("SELECT employee_id, chat_id, session FROM sessions")
    .all() as SessionRow[];
  const identities = new Map(
    listEmployeeIdentities().map((identity) => [identity.id, identity]),
  );

  const perEmployee = new Map<number, Accumulator>();
  const perChat = new Map<number, Accumulator>();
  // Per-(chat, employee) totals for each conversation's employee mini-table.
  const perChatEmployee = new Map<number, Map<number, SpendTotals>>();
  const grand = createAccumulator();

  // Conversations are grouped by their root (user) chat: a task group chat
  // spawned from a root chat rolls its spend up into that root chat and is
  // never listed on its own.
  const chatRows = getDB()
    .prepare(
      "SELECT id, title, from_chat_id, pinned, last_message_at FROM chats",
    )
    .all() as ChatRow[];
  const rootOf = buildRootMap(chatRows);
  const chatTitles = new Map(
    chatRows.map((row) => [row.id, row.title] as const),
  );
  // Sort key mirroring the chat module's list order (pinned first, then most
  // recent message), so a conversation sits in the same place in both modules.
  const chatOrder = new Map(
    chatRows.map(
      (row) =>
        [row.id, { pinned: row.pinned, lastAt: row.last_message_at }] as const,
    ),
  );

  const parsed = await mapLimit(rows, READ_CONCURRENCY, async (row) => ({
    row,
    records: await recordsForSession(row.session),
  }));

  // "today" plots hourly buckets; week/month plot daily buckets.
  const trendKey = range === "today" ? hourKey : localDay;

  for (const { row, records } of parsed) {
    const rootChatId = rootOf.get(row.chat_id) ?? row.chat_id;
    for (const record of records) {
      // Records without a timestamp only count in "all time" (cutoff 0).
      if (cutoff > 0 && (record.ts === 0 || record.ts < cutoff)) continue;
      addRecord(
        accumulatorFor(perEmployee, row.employee_id),
        record,
        row,
        trendKey,
      );
      const chatAccumulator = accumulatorFor(perChat, rootChatId);
      addRecord(chatAccumulator, record, row, trendKey);
      addCounters(
        accumulatorForTotals(perChatEmployee, rootChatId, row.employee_id),
        record,
      );
      addRecord(grand, record, row, trendKey);
    }
  }

  const employees: SpendEmployeeReport[] = [...perEmployee.entries()]
    .map(([employeeId, accumulator]) => {
      const identity = identities.get(employeeId);
      // Full per-conversation list, most recent first; the payload keeps only
      // the newest SPEND_EMPLOYEE_RECENT_CHATS rows and reports the rest in
      // `byChatTotal` for the "showing N of M" hint.
      const byChat = employeeChatRows(
        employeeId,
        perChatEmployee,
        chatTitles,
        chatOrder,
      );
      return {
        employeeId,
        name: identity?.name ?? `Employee #${employeeId}`,
        role: identity?.role ?? "",
        chats: accumulator.chats.size,
        totals: accumulator.totals,
        byModel: sortModels([...accumulator.byModel.values()]),
        byChat: byChat.slice(0, SPEND_EMPLOYEE_RECENT_CHATS),
        byChatTotal: byChat.length,
        trend: fillTrend(accumulator.trend, range, now),
      };
    })
    .filter((employee) => employee.totals.calls > 0)
    .sort(compareByCost);

  // Per-conversation rows (keyed by root chat id).
  const tagsByChat = tagsForChats([...perChat.keys()]);
  const chats: SpendChatReport[] = [...perChat.entries()]
    .map(([chatId, accumulator]) => {
      const employeeRows: SpendChatEmployeeReport[] = [
        ...(perChatEmployee.get(chatId)?.entries() ?? []),
      ].map(([employeeId, totals]) => {
        const identity = identities.get(employeeId);
        return {
          employeeId,
          name: identity?.name ?? `Employee #${employeeId}`,
          role: identity?.role ?? "",
          totals,
        };
      });
      employeeRows.sort(
        (a, b) =>
          b.totals.cost - a.totals.cost ||
          b.totals.totalTokens - a.totals.totalTokens ||
          a.employeeId - b.employeeId,
      );
      return {
        chatId,
        title: chatTitles.get(chatId) ?? "",
        employees: employeeRows,
        totals: accumulator.totals,
        byModel: sortModels([...accumulator.byModel.values()]),
        tags: tagsByChat.get(chatId) ?? [],
      };
    })
    .filter((chat) => chat.totals.calls > 0)
    .sort((a, b) => {
      // Same ordering as the chat module: pinned chats first, then by the
      // root chat's last-message time, with the id breaking ties.
      const left = chatOrder.get(a.chatId);
      const right = chatOrder.get(b.chatId);
      return (
        Number(right?.pinned ?? 0) - Number(left?.pinned ?? 0) ||
        (right?.lastAt ?? 0) - (left?.lastAt ?? 0) ||
        b.chatId - a.chatId
      );
    });

  // Sorted once and shared: with no tag filter the "All conversations" total
  // *is* the grand total, so both fields point at the same numbers.
  const grandByModel = sortModels([...grand.byModel.values()]);

  return {
    range,
    generatedAt: now,
    totals: grand.totals,
    byModel: grandByModel,
    trend: fillTrend(grand.trend, range, now),
    employees,
    chats,
    chatFilterTotal: buildChatFilterTotal(
      perChat,
      tagsByChat,
      chatTags,
      grand,
      grandByModel,
      chats.length,
    ),
  };
}

/**
 * Aggregate the conversations matched by `filter` into the "All conversations"
 * number: token/cost totals plus a merged per-model breakdown.
 *
 * Derived from the finished per-conversation accumulators (the same objects the
 * `chats` rows are built from), so it agrees with the visible rows by
 * construction and never re-reads a session file.
 *
 * An empty filter returns the grand total's own objects instead of re-summing:
 * every usage record is folded into both the grand total and its root chat, so
 * `sum(chats[].totals) === totals`, and reusing the grand total keeps the
 * unfiltered number bit-for-bit what it was before tag filtering existed.
 */
function buildChatFilterTotal(
  perChat: Map<number, Accumulator>,
  tagsByChat: Map<number, string[]>,
  filter: readonly string[],
  grand: Accumulator,
  grandByModel: SpendModelBreakdown[],
  chatCount: number,
): SpendChatFilterTotal {
  if (filter.length === 0) {
    return {
      tags: [],
      chats: chatCount,
      totals: grand.totals,
      byModel: grandByModel,
    };
  }

  const totals = emptyTotals();
  const byModel = new Map<string, SpendModelBreakdown>();
  let matched = 0;
  for (const [chatId, accumulator] of perChat) {
    if (!matchesTagFilter(tagsByChat.get(chatId) ?? [], filter)) continue;
    matched += 1;
    addTotals(totals, accumulator.totals);
    for (const [key, model] of accumulator.byModel) {
      let merged = byModel.get(key);
      if (!merged) {
        merged = {
          provider: model.provider,
          model: model.model,
          totals: emptyTotals(),
        };
        byModel.set(key, merged);
      }
      addTotals(merged.totals, model.totals);
    }
  }

  return {
    tags: [...filter],
    chats: matched,
    totals,
    byModel: sortModels([...byModel.values()]),
  };
}

/** Fold one ready-made `SpendTotals` bucket into another (incl. the call count). */
function addTotals(target: SpendTotals, source: SpendTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
  target.calls += source.calls;
}

function createAccumulator(): Accumulator {
  return {
    totals: emptyTotals(),
    byModel: new Map(),
    trend: new Map(),
    chats: new Set(),
  };
}

function accumulatorFor(
  map: Map<number, Accumulator>,
  employeeId: number,
): Accumulator {
  let accumulator = map.get(employeeId);
  if (!accumulator) {
    accumulator = createAccumulator();
    map.set(employeeId, accumulator);
  }
  return accumulator;
}

/** Lazily create the totals bucket for one (chat, employee) pair. */
function accumulatorForTotals(
  map: Map<number, Map<number, SpendTotals>>,
  chatId: number,
  employeeId: number,
): SpendTotals {
  let byEmployee = map.get(chatId);
  if (!byEmployee) {
    byEmployee = new Map();
    map.set(chatId, byEmployee);
  }
  let totals = byEmployee.get(employeeId);
  if (!totals) {
    totals = emptyTotals();
    byEmployee.set(employeeId, totals);
  }
  return totals;
}

/**
 * One employee's per-conversation rows, most recent first: the root chat's
 * last-message time (descending, id breaking ties) — the same ordering the
 * chat module's list uses, so "recent conversations" mean the same thing in
 * both modules. The caller caps the payload; this returns the full list.
 * Derived from the per-(chat, employee) map so the hot aggregation loop
 * stays single-pass.
 */
function employeeChatRows(
  employeeId: number,
  perChatEmployee: Map<number, Map<number, SpendTotals>>,
  chatTitles: Map<number, string>,
  chatOrder: Map<number, { pinned: number; lastAt: number }>,
): SpendEmployeeChatReport[] {
  const rows: SpendEmployeeChatReport[] = [];
  for (const [chatId, byEmployee] of perChatEmployee) {
    const totals = byEmployee.get(employeeId);
    if (!totals) continue;
    rows.push({ chatId, title: chatTitles.get(chatId) ?? "", totals });
  }
  return rows.sort(
    (a, b) =>
      (chatOrder.get(b.chatId)?.lastAt ?? 0) -
        (chatOrder.get(a.chatId)?.lastAt ?? 0) || b.chatId - a.chatId,
  );
}

/**
 * Resolve every chat to its root (user) chat id from one chat snapshot.
 * Cycle-safe: a malformed self/circular `from_chat_id` chain resolves to the
 * last id visited rather than looping. Unknown ids fall back to themselves.
 */
function buildRootMap(rows: readonly ChatRow[]): Map<number, number> {
  const parents = new Map<number, number | null>();
  for (const row of rows) parents.set(row.id, row.from_chat_id);

  const roots = new Map<number, number>();
  for (const row of rows) {
    let current = row.id;
    const seen = new Set<number>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parents.get(current);
      if (parent === null || parent === undefined) break;
      current = parent;
    }
    roots.set(row.id, current);
  }
  return roots;
}

function addRecord(
  accumulator: Accumulator,
  record: SpendRecord,
  row: SessionRow,
  trendKey: (ts: number) => string,
): void {
  addCounters(accumulator.totals, record);
  accumulator.chats.add(row.chat_id);

  const key = `${record.provider}\u0000${record.model}`;
  let model = accumulator.byModel.get(key);
  if (!model) {
    model = {
      provider: record.provider,
      model: record.model,
      totals: emptyTotals(),
    };
    accumulator.byModel.set(key, model);
  }
  addCounters(model.totals, record);

  if (record.ts > 0) {
    const bucketKey = trendKey(record.ts);
    let bucket = accumulator.trend.get(bucketKey);
    if (!bucket) {
      bucket = emptyTotals();
      accumulator.trend.set(bucketKey, bucket);
    }
    addCounters(bucket, record);
  }
}

function emptyTotals(): SpendTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    calls: 0,
  };
}

function addCounters(totals: SpendTotals, counters: SpendCounters): void {
  totals.input += counters.input;
  totals.output += counters.output;
  totals.cacheRead += counters.cacheRead;
  totals.cacheWrite += counters.cacheWrite;
  totals.totalTokens += counters.totalTokens;
  totals.cost += counters.cost;
  totals.calls += 1;
}

/** Read + cache one session file's usage records (never throws). */
async function recordsForSession(sessionPath: string): Promise<SpendRecord[]> {
  try {
    const info = await stat(sessionPath);
    const cached = sessionCache.get(sessionPath);
    if (
      cached &&
      cached.mtimeMs === info.mtimeMs &&
      cached.size === info.size
    ) {
      return cached.records;
    }
    const content = await readFile(sessionPath, "utf8");
    const pi = await loadPiSdk();
    const records = parseSpendRecords(pi.parseSessionEntries(content));
    sessionCache.set(sessionPath, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      records,
    });
    return records;
  } catch (err) {
    console.error(
      `[spend] failed to read session ${sessionPath}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Flatten every usage-carrying entry of one session, in append order. */
function parseSpendRecords(entries: FileEntry[]): SpendRecord[] {
  const records: SpendRecord[] = [];
  // Model in effect for entries that do not name one themselves.
  let provider = "";
  let model = "";

  for (const entry of entries) {
    if (entry.type === "model_change") {
      provider = nonEmpty(entry.provider) ?? provider;
      model = nonEmpty(entry.modelId) ?? model;
      continue;
    }
    if (entry.type === "message") {
      const message = entry.message as unknown as
        | {
            role?: unknown;
            provider?: unknown;
            model?: unknown;
            timestamp?: unknown;
            usage?: unknown;
          }
        | undefined;
      if (!message || message.role !== "assistant") continue;
      const counters = readCounters(message.usage);
      if (!counters) continue;
      records.push({
        ts: entryTime(entry) || numericTime(message.timestamp),
        provider: nonEmpty(message.provider) ?? provider,
        model: nonEmpty(message.model) ?? model,
        ...counters,
      });
      continue;
    }
    if (entry.type === "usage") {
      const counters = readCounters(entry.usage);
      if (!counters) continue;
      records.push({
        ts: entryTime(entry),
        provider: nonEmpty(entry.provider) ?? provider,
        model: nonEmpty(entry.model) ?? model,
        ...counters,
      });
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const counters = readCounters(entry.usage);
      if (!counters) continue;
      records.push({
        ts: entryTime(entry),
        provider,
        model,
        ...counters,
      });
    }
  }
  return records;
}

/** Read the token + cost counters off a `Usage`-shaped value. */
function readCounters(value: unknown): SpendCounters | null {
  if (value === null || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  // Providers report `totalTokens`; fall back to the parts when absent.
  const totalTokens = count(usage.totalTokens);
  const cost = readCost(usage.cost);
  if (input + output + cacheRead + cacheWrite + totalTokens + cost === 0) {
    return null;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens:
      totalTokens > 0 ? totalTokens : input + output + cacheRead + cacheWrite,
    cost,
  };
}

function readCost(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  return count((value as Record<string, unknown>).total);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Entry-level ISO timestamp → epoch ms (0 when unparseable). */
function entryTime(entry: { timestamp?: unknown }): number {
  if (typeof entry.timestamp !== "string") return 0;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Message-level epoch timestamp, accepted only when it looks like ms. */
function numericTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 1e11
    ? value
    : 0;
}

/** Local `YYYY-MM-DD` for an epoch-ms value. */
function localDay(ms: number): string {
  return dayKey(new Date(ms));
}

/** Local zero-padded hour (`00`–`23`) for an epoch-ms value. */
function hourKey(ms: number): string {
  return String(new Date(ms).getHours()).padStart(2, "0");
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Start of the requested window (0 = everything). */
function rangeCutoff(range: SpendRange, now: number): number {
  if (range === "all") return 0;
  const start = startOfToday(now);
  if (range === "today") return start;
  if (range === "month") {
    const from = new Date(now);
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
    return from.getTime();
  }
  // "week": the current week, starting on the locale's first day of week.
  const from = new Date(start);
  from.setDate(from.getDate() - daysSinceWeekStart(now));
  return from.getTime();
}

/**
 * Days elapsed since the start of the current week, where the first day of
 * week follows the resolved locale (e.g. Monday for zh-CN, Sunday for
 * en-US). Falls back to Monday when the runtime cannot report week info.
 */
function daysSinceWeekStart(now: number): number {
  // JS `getDay()`: 0 = Sunday … 6 = Saturday; weekInfo.firstDay: 1 = Monday
  // … 7 = Sunday. Convert both to 0 = Sunday … 6 = Saturday for the delta.
  const today = new Date(now).getDay();
  const firstDay = localeFirstDay();
  const first = firstDay === 7 ? 0 : firstDay;
  return (today - first + 7) % 7;
}

/** Locale first day of week (1 = Monday … 7 = Sunday), defaulting to Monday. */
function localeFirstDay(): number {
  try {
    const locale = new Intl.Locale(getResolvedLocale());
    const weekInfo =
      (
        locale as Intl.Locale & {
          getWeekInfo?: () => { firstDay?: unknown };
          weekInfo?: { firstDay?: unknown };
        }
      ).getWeekInfo?.() ??
      (locale as unknown as { weekInfo?: { firstDay?: unknown } }).weekInfo;
    const firstDay = weekInfo?.firstDay;
    if (
      typeof firstDay === "number" &&
      Number.isInteger(firstDay) &&
      firstDay >= 1 &&
      firstDay <= 7
    ) {
      return firstDay;
    }
  } catch {
    // Malformed locale tag or unsupported Intl API — use the default below.
  }
  return 1;
}

function startOfToday(now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/**
 * Dense trend series for the chart, with empty buckets materialized as
 * zeroes: 24 hourly buckets for "today", the full week (locale's first day
 * → +6) for "week", and every day of the month for "month". "All time" has
 * no trend, so it returns an empty series.
 */
function fillTrend(
  trend: Map<string, SpendTotals>,
  range: SpendRange,
  now: number,
): SpendTrendBucket[] {
  if (range === "all") return [];

  const buckets: SpendTrendBucket[] = [];
  if (range === "today") {
    for (let hour = 0; hour < 24; hour++) {
      const key = String(hour).padStart(2, "0");
      buckets.push({ key, totals: trend.get(key) ?? emptyTotals() });
    }
    return buckets;
  }

  const start = new Date(startOfToday(now));
  const end = new Date(start);
  if (range === "week") {
    start.setDate(start.getDate() - daysSinceWeekStart(now));
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 6);
  } else {
    start.setDate(1);
    end.setTime(start.getTime());
    // Day 0 of next month is the last day of this month.
    end.setMonth(end.getMonth() + 1, 0);
  }

  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const key = dayKey(cursor);
    buckets.push({ key, totals: trend.get(key) ?? emptyTotals() });
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

function sortModels(models: SpendModelBreakdown[]): SpendModelBreakdown[] {
  return models.sort(
    (a, b) =>
      b.totals.cost - a.totals.cost ||
      b.totals.totalTokens - a.totals.totalTokens,
  );
}

function compareByCost(a: SpendEmployeeReport, b: SpendEmployeeReport): number {
  return (
    b.totals.cost - a.totals.cost ||
    b.totals.totalTokens - a.totals.totalTokens ||
    a.employeeId - b.employeeId
  );
}

/** Run `fn` over `items` with at most `limit` promises in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
