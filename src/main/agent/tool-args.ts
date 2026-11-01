import { homedir } from "os";

/**
 * Tool-argument formatting for the read-only agent session view.
 *
 * The session view shows a compact one-line summary of a tool call and, on
 * click, a capped pretty-printed detail. Formatting lives in the main process
 * so that huge argument values (file bodies, `content` up to 100k chars) are
 * capped before they cross the IPC boundary or the live event stream. Tool
 * *results* are never formatted or exposed.
 */

/** Cap for the whole collapsed summary line. */
const MAX_SUMMARY = 160;
/** Cap for one value inside the collapsed summary. */
const MAX_VALUE = 60;
/** Cap for one string value inside the expanded detail. */
const MAX_DETAIL_VALUE = 4000;
/** Cap for the whole expanded detail. */
const MAX_DETAIL = 8000;
/** A non-listed string longer than this becomes a size placeholder. */
const LARGE_STRING = 200;

/**
 * Known large text fields: always summarized as `«N chars»` once they exceed a
 * modest length, so they cannot crowd out the discriminating arguments.
 */
const LARGE_FIELDS = new Set([
  "content",
  "newText",
  "oldText",
  "systemPrompt",
  "prompt",
  "instructions",
  // A redirect posted by `imb_interrupt` can be a whole brief; it must not crowd
  // out the employee/chat ids that identify the call.
  "instruction",
]);

/** Keys that usually identify what a call acted on (shown first). */
const PRIORITY_KEYS = [
  "path",
  "file_path",
  "command",
  "pattern",
  "query",
  "url",
  "title",
  "name",
  "id",
  "chatId",
  "employeeId",
  "schedule",
  "role",
];

/** Keys whose string values are paths (home shortened to `~`). */
const PATH_KEYS = new Set(["path", "file_path", "cwd", "dir", "directory"]);

/**
 * One-line summary of a tool call's arguments. Never throws: malformed input
 * degrades to an empty string.
 */
export function summarizeToolArgs(name: string, args: unknown): string {
  const record = asRecord(args);
  if (record === null) return "";

  const known = summarizeKnown(name, record);
  if (known !== null) return known;

  // Generic fallback: priority keys first, then the rest, each value compacted.
  const entries = Object.entries(record);
  if (entries.length === 0) return "";
  const ordered = [...entries].sort((a, b) => priority(a[0]) - priority(b[0]));
  const pairs = ordered.map(
    ([key, value]) => `${key}=${formatValue(key, value)}`,
  );
  return truncate(pairs.join(" "), MAX_SUMMARY);
}

/**
 * Capped pretty-printed arguments for the expandable detail, or `undefined`
 * when there is nothing to show.
 */
export function formatToolArgsDetail(args: unknown): string | undefined {
  const record = asRecord(args);
  if (record === null || Object.keys(record).length === 0) return undefined;
  let text: string;
  try {
    text = JSON.stringify(
      record,
      (_key, value: unknown) =>
        typeof value === "string" && value.length > MAX_DETAIL_VALUE
          ? `${value.slice(0, MAX_DETAIL_VALUE)}\n… [${value.length - MAX_DETAIL_VALUE} more chars]`
          : value,
      2,
    );
  } catch {
    // Circular / non-serializable args: fall back to a plain string.
    text = String(record);
  }
  return truncate(text, MAX_DETAIL);
}

/** Per-tool summaries for the core Pi tools and the app's own `imb_*` tools. */
function summarizeKnown(
  name: string,
  record: Record<string, unknown>,
): string | null {
  switch (name) {
    case "read":
      return pathWithRange(record);
    case "write":
    case "edit": {
      const path = text(record.path ?? record.file_path);
      return path ? shortenPath(path) : "";
    }
    case "bash":
    case "powershell": {
      const command = text(record.command);
      return command ? truncate(normalizeWhitespace(command), 80) : "";
    }
    case "grep": {
      const pattern = text(record.pattern);
      if (!pattern) return "";
      return `/${pattern}/ in ${shortenPath(text(record.path) || ".")}`;
    }
    case "find": {
      const pattern = text(record.pattern);
      if (!pattern) return "";
      return `${pattern} in ${shortenPath(text(record.path) || ".")}`;
    }
    case "ls":
      return shortenPath(text(record.path) || ".");
    case "imb_send_message": {
      const chatId = text(record.chatId);
      return chatId ? `chat ${chatId}` : "";
    }
    case "imb_create_chat": {
      const title = text(record.title);
      const count = Array.isArray(record.participants)
        ? record.participants.length
        : 0;
      const suffix = count > 0 ? ` · ${count} participants` : "";
      return title ? `${truncate(title, MAX_VALUE)}${suffix}` : suffix.slice(3);
    }
    case "imb_add_participant": {
      const chatId = text(record.chatId);
      const count = Array.isArray(record.participants)
        ? record.participants.length
        : 0;
      const suffix = count > 0 ? ` · ${count} participants` : "";
      return chatId ? `chat ${chatId}${suffix}` : suffix.slice(3);
    }
    case "imb_read_chat": {
      const chatId = text(record.chatId);
      return chatId ? `chat ${chatId}` : "";
    }
    case "imb_progress":
      return Array.isArray(record.steps) ? `${record.steps.length} steps` : "";
    case "imb_ask": {
      const questions = asRecord(record.questions)?.questions;
      return Array.isArray(questions) ? `${questions.length} questions` : "";
    }
    case "imb_set_employees":
      return Array.isArray(record.employees)
        ? `${record.employees.length} employees`
        : "";
    case "imb_set_cronjob": {
      const id = text(record.id);
      const schedule = text(record.schedule);
      return [id, schedule].filter((part) => part.length > 0).join(" · ");
    }
    case "imb_remove_cronjob":
      return text(record.id);
    case "imb_get_employee_stat": {
      // Bulk mode (no `employeeId`) reports every employee of the chat.
      const chatId = text(record.chatId);
      if (record.employeeId === undefined) {
        return chatId ? `all employees · chat ${chatId}` : "all employees";
      }
      return employeeAndChat(record);
    }
    case "imb_interrupt": {
      const target = employeeAndChat(record);
      const instruction = text(record.instruction);
      const suffix = instruction ? `${instruction.length} chars` : "";
      return [target, suffix].filter((part) => part.length > 0).join(" · ");
    }
    default:
      return null;
  }
}

/** `employee <id> · chat <id>` for the tools that act on one session pair. */
function employeeAndChat(record: Record<string, unknown>): string {
  const employeeId = text(record.employeeId);
  const chatId = text(record.chatId);
  return [
    employeeId ? `employee ${employeeId}` : "",
    chatId ? `chat ${chatId}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** `path` / `file_path` with an optional `:start-end` line range. */
function pathWithRange(record: Record<string, unknown>): string {
  const path = text(record.path ?? record.file_path);
  if (!path) return "";
  const offset = number(record.offset);
  const limit = number(record.limit);
  let display = shortenPath(path);
  if (offset !== null || limit !== null) {
    const start = offset ?? 1;
    const end = limit !== null ? start + limit - 1 : "";
    display += `:${start}${end !== "" ? `-${end}` : ""}`;
  }
  return display;
}

/** Format one generic `key=value` value. */
function formatValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (isLarge(key, value)) return `«${value.length} chars»`;
    const shown = PATH_KEYS.has(key) ? shortenPath(value) : value;
    return truncate(normalizeWhitespace(shown), MAX_VALUE);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return truncate(JSON.stringify(value), MAX_VALUE);
    } catch {
      return "…";
    }
  }
  return String(value);
}

function isLarge(key: string, value: string): boolean {
  return LARGE_FIELDS.has(key)
    ? value.length > 80
    : value.length > LARGE_STRING;
}

/** Sort rank for the generic fallback (lower = shown first). */
function priority(key: string): number {
  const index = PRIORITY_KEYS.indexOf(key);
  return index === -1 ? PRIORITY_KEYS.length : index;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Collapse the current user's home directory to `~`. */
function shortenPath(path: string): string {
  const home = homedir();
  if (home.length > 0 && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
