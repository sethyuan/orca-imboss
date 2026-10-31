import { t } from "@shared/l10n";
import type {
  SpendChatReport,
  SpendEmployeeChatReport,
  SpendEmployeeReport,
  SpendGrouping,
  SpendModelBreakdown,
  SpendRange,
  SpendReport,
  SpendTotals,
  SpendTrendBucket,
} from "@shared/types";
import { appStore } from "../../../../app-store";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { EmployeeAvatar } from "../../../employee-avatar";
import { Tooltip } from "../../../tooltip";
import { formatCost, formatDayShort, formatTokens } from "../format";
import "./index.css";

export interface SpendDetailProps {
  report: SpendReport | null;
  /** Grouping the list is currently rendered under (drives the fallback view). */
  grouping: SpendGrouping;
  /** `null` shows the grand total across every employee. */
  employeeId: number | null;
  /** `null` shows the grand total; set when a conversation row is active. */
  chatId: number | null;
  loading: boolean;
  error: string | null;
}

/** One resolved detail view (an employee, a conversation, or the total). */
interface SpendView {
  eyebrow: string;
  title: string;
  sub?: string;
  totals: SpendTotals;
  byModel: SpendModelBreakdown[];
  /** Trend series to plot; `null` hides the section (chat views). */
  trend: SpendTrendBucket[] | null;
  /** Distinct chats; `null` where the count does not apply. */
  chats: number | null;
  /** Per-employee rows inside a conversation (only in the chat view). */
  employees: SpendChatReport["employees"] | null;
  /** Per-conversation rows for one employee (only in the employee view). */
  byChat: SpendEmployeeChatReport[] | null;
  /** Total conversations before the byChat cap; drives the "showing" hint. */
  byChatTotal: number | null;
}

export function SpendDetail({
  report,
  grouping,
  employeeId,
  chatId,
  loading,
  error,
}: SpendDetailProps): React.JSX.Element | null {
  if (error !== null) {
    return (
      <DetailBody>
        <p className="imb-module-note">
          {t("Failed to load spend statistics")}
        </p>
      </DetailBody>
    );
  }
  if (!report) {
    return loading ? (
      <DetailBody>
        <p className="imb-module-note">{t("Loading…")}</p>
      </DetailBody>
    ) : null;
  }

  const employee =
    employeeId === null
      ? null
      : (report.employees.find((row) => row.employeeId === employeeId) ?? null);
  const chat =
    chatId === null
      ? null
      : (report.chats.find((row) => row.chatId === chatId) ?? null);
  const view: SpendView = chat
    ? chatView(chat)
    : employee
      ? employeeView(employee)
      : totalView(report, grouping);

  return (
    <>
      <DetailHead eyebrow={view.eyebrow} title={view.title} sub={view.sub} />
      <DetailBody>
        <StatsGrid view={view} />
        {view.trend !== null && view.trend.length > 0 && (
          <section className="imb-spend-section">
            <h3>{t("Daily trend")}</h3>
            <UsageTrend buckets={view.trend} range={report.range} />
          </section>
        )}
        <section className="imb-spend-section">
          <h3>{t("By model")}</h3>
          {view.byModel.length === 0 ? (
            <p className="imb-module-note">{t("No spend recorded yet")}</p>
          ) : (
            <div className="imb-spend-table">
              <div className="imb-spend-table-head">
                <span>{t("Provider")}</span>
                <span>{t("Model")}</span>
                <span className="imb-spend-num">{t("Tokens")}</span>
                <span className="imb-spend-num">{t("Calls")}</span>
                <span className="imb-spend-num">{t("Cost")}</span>
              </div>
              {view.byModel.map((model) => (
                <div
                  className="imb-spend-table-row"
                  key={`${model.provider}\u0000${model.model}`}
                >
                  <span className="imb-spend-ellipsis">
                    {model.provider || "—"}
                  </span>
                  <span className="imb-spend-ellipsis" title={model.model}>
                    {model.model || "—"}
                  </span>
                  <span className="imb-spend-num">
                    {formatTokens(model.totals.totalTokens)}
                  </span>
                  <span className="imb-spend-num">
                    {formatTokens(model.totals.calls)}
                  </span>
                  <span className="imb-spend-num">
                    {formatCost(model.totals.cost)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
        {view.employees !== null && view.employees.length > 0 && (
          <section className="imb-spend-section">
            <h3>{t("By employee")}</h3>
            <div className="imb-spend-table imb-spend-employees-table">
              <div className="imb-spend-table-head">
                <span>{t("Employee")}</span>
                <span>{t("Role")}</span>
                <span className="imb-spend-num">{t("Tokens")}</span>
                <span className="imb-spend-num">{t("Cost")}</span>
              </div>
              {view.employees.map((employeeRow) => (
                <div
                  className="imb-spend-table-row"
                  key={employeeRow.employeeId}
                >
                  <button
                    type="button"
                    className="imb-spend-employee-cell imb-spend-link"
                    onClick={() => jumpToEmployee(employeeRow.employeeId)}
                  >
                    <EmployeeAvatar
                      employeeId={employeeRow.employeeId}
                      size={20}
                    />
                    <span
                      className="imb-spend-ellipsis"
                      title={employeeRow.name}
                    >
                      {employeeRow.name}
                    </span>
                  </button>
                  <span className="imb-spend-ellipsis">
                    {employeeRow.role || "—"}
                  </span>
                  <span className="imb-spend-num">
                    {formatTokens(employeeRow.totals.totalTokens)}
                  </span>
                  <span className="imb-spend-num">
                    {formatCost(employeeRow.totals.cost)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        {view.byChat !== null && view.byChat.length > 0 && (
          <section className="imb-spend-section">
            <h3>
              {t("By conversation")}
              {view.byChatTotal !== null &&
                view.byChatTotal > view.byChat.length && (
                  <span className="imb-spend-section-note">
                    {t(
                      "Showing the ${count} most recent conversations (${total} in total)",
                      {
                        count: String(view.byChat.length),
                        total: String(view.byChatTotal),
                      },
                    )}
                  </span>
                )}
            </h3>
            <div className="imb-spend-table imb-spend-chats-table">
              <div className="imb-spend-table-head">
                <span>{t("Conversation")}</span>
                <span className="imb-spend-num">{t("Tokens")}</span>
                <span className="imb-spend-num">{t("Cost")}</span>
              </div>
              {view.byChat.map((chatRow) => {
                const title = chatRow.title || t("Untitled");
                return (
                  <div className="imb-spend-table-row" key={chatRow.chatId}>
                    <button
                      type="button"
                      className="imb-spend-ellipsis imb-spend-link"
                      title={title}
                      onClick={() => jumpToChat(chatRow.chatId)}
                    >
                      {title}
                    </button>
                    <span className="imb-spend-num">
                      {formatTokens(chatRow.totals.totalTokens)}
                    </span>
                    <span className="imb-spend-num">
                      {formatCost(chatRow.totals.cost)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </DetailBody>
    </>
  );
}

function employeeView(employee: SpendEmployeeReport): SpendView {
  return {
    eyebrow: `Employee #${employee.employeeId}`,
    title: employee.name,
    sub: employee.role || "—",
    totals: employee.totals,
    byModel: employee.byModel,
    trend: employee.trend,
    chats: employee.chats,
    employees: null,
    byChat: employee.byChat,
    byChatTotal: employee.byChatTotal,
  };
}

function chatView(chat: SpendChatReport): SpendView {
  return {
    eyebrow: t("Conversation"),
    title: chat.title || t("Untitled"),
    sub: `${chat.employees.length} ${t("Employees")}`,
    totals: chat.totals,
    byModel: chat.byModel,
    // Conversations have no trend section (their window is always all-time).
    trend: null,
    chats: null,
    employees: chat.employees,
    byChat: null,
    byChatTotal: null,
  };
}

function totalView(report: SpendReport, grouping: SpendGrouping): SpendView {
  // The conversation grouping's fallback view is the "All conversations" total,
  // which follows the tag filter (computed by main, see `chatFilterTotal`) so
  // it matches the list row exactly. The employee grouping keeps the grand
  // total.
  const filtered = grouping === "chat";
  return {
    eyebrow: t("Total"),
    title: filtered ? t("All conversations") : t("All employees"),
    totals: filtered ? report.chatFilterTotal.totals : report.totals,
    byModel: filtered ? report.chatFilterTotal.byModel : report.byModel,
    // "全部对话" (all conversations) also omits the trend section.
    trend: filtered ? null : report.trend,
    chats: null,
    employees: null,
    byChat: null,
    byChatTotal: null,
  };
}

/** Jump to an employee's statistics by switching grouping + selection. */
function jumpToEmployee(employeeId: number): void {
  appStore.spendGrouping = "employee";
  appStore.activeSpendEmployeeId = employeeId;
}

/** Jump to a conversation's statistics by switching grouping + selection. */
function jumpToChat(chatId: number): void {
  appStore.spendGrouping = "chat";
  appStore.activeSpendChatId = chatId;
}

/** Token/cost tiles for one resolved view. */
function StatsGrid({ view }: { view: SpendView }): React.JSX.Element {
  const tiles: Array<{ label: string; value: string }> = [
    { label: t("Tokens"), value: formatTokens(view.totals.totalTokens) },
    { label: t("Cache read"), value: formatTokens(view.totals.cacheRead) },
    { label: t("Input tokens"), value: formatTokens(view.totals.input) },
    { label: t("Output tokens"), value: formatTokens(view.totals.output) },
    { label: t("Cache write"), value: formatTokens(view.totals.cacheWrite) },
    { label: t("Cost"), value: formatCost(view.totals.cost) },
    { label: t("Calls"), value: formatTokens(view.totals.calls) },
  ];
  if (view.chats !== null) {
    tiles.push({ label: t("Chats"), value: formatTokens(view.chats) });
  }
  return (
    <div className="imb-spend-stats">
      {tiles.map((tile) => (
        <div className="imb-spend-stat" key={tile.label}>
          <span className="imb-spend-stat-label">{tile.label}</span>
          <span className="imb-spend-stat-value">{tile.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Dense trend bar chart (pure CSS; no chart dependency). */
function UsageTrend({
  buckets,
  range,
}: {
  buckets: readonly SpendTrendBucket[];
  range: SpendRange;
}): React.JSX.Element {
  const max = buckets.reduce(
    (highest, bucket) => Math.max(highest, bucket.totals.totalTokens),
    0,
  );
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const hourly = range === "today";
  const axisLabel = (key: string): string =>
    hourly ? `${key}:00` : formatDayShort(key);
  // An hourly bucket spans its hour to the next one, e.g. `04:00~05:00`.
  const tooltipLabel = (key: string): string => {
    if (!hourly) return formatDayShort(key);
    const next = String(Number(key) + 1).padStart(2, "0");
    return `${key}:00~${next}:00`;
  };
  return (
    <div className="imb-spend-trend-block">
      <div className="imb-spend-trend" role="img" aria-label={t("Daily trend")}>
        {buckets.map((bucket) => {
          const tokens = bucket.totals.totalTokens;
          const height =
            max > 0 ? Math.max((tokens / max) * 100, tokens > 0 ? 2 : 0) : 0;
          return (
            <Tooltip
              key={bucket.key}
              placement="top"
              content={`${tooltipLabel(bucket.key)} · ${formatTokens(tokens)} ${t("Tokens")} · ${formatCost(bucket.totals.cost)}`}
            >
              <div className="imb-spend-trend-col">
                <div
                  className="imb-spend-trend-bar"
                  style={{ height: `${height}%` }}
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
      {first !== undefined && last !== undefined && (
        <div className="imb-spend-trend-axis">
          <span>{axisLabel(first.key)}</span>
          <span>{axisLabel(last.key)}</span>
        </div>
      )}
    </div>
  );
}
