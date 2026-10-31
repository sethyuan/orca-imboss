import {
  SPEND_GROUPINGS,
  SPEND_GROUPING_LABELS,
  SPEND_RANGES,
  SPEND_RANGE_LABELS,
} from "@shared/constants/spend";
import { matchesTagFilter } from "@shared/constants/tags";
import { t } from "@shared/l10n";
import type { SpendGrouping, SpendRange, SpendReport } from "@shared/types";
import { useEffect, useState } from "react";
import { appStore, useApp } from "../../../../app-store";
import { useModuleFilter } from "../../../../hooks/use-module-filter";
import { ModuleView } from "../../../app-shell";
import { Avatar } from "../../../avatar";
import { EmployeeAvatar } from "../../../employee-avatar";
import { IconStats } from "../../../icons";
import { ItemList } from "../../../item-list";
import { ListPane } from "../../../list-pane";
import { ListRow } from "../../../list-row";
import { SegmentedControl } from "../../../segmented-control";
import { TagSelect } from "../../../tag-select";
import "../../module-common.css";
import { formatCost, formatTokensCompact } from "../format";
import { SpendDetail } from "../spend-detail";
import "./index.css";

/** One row of the list pane: the grand total, one chat, or one employee. */
interface SpendListEntry {
  key: string;
  /** `null` for the grand-total row. */
  employeeId: number | null;
  /** `null` for the grand-total and employee rows. */
  chatId: number | null;
  name: string;
  sub?: string;
  tokens: number;
  cost: number;
}

export function SpendModule(): React.JSX.Element {
  const {
    spendGrouping,
    spendRange,
    activeSpendEmployeeId,
    activeSpendChatId,
  } = useApp();
  const [report, setReport] = useState<SpendReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the employees/chats change subscriptions to re-fetch the report.
  const [refreshToken, setRefreshToken] = useState(0);
  // Conversation-grouping tag filter (AND), stored on the appStore so a module
  // switch keeps it (session-only: an app restart clears it) — the grouping,
  // range and selected row already live there for the same reason.
  const { tags: tagFilter, setTags: setTagFilter } = useModuleFilter("spend");
  // Serialized tag filter: the tag-filtered "All conversations" total is
  // computed main-side (`SpendReport.chatFilterTotal`), so a tag change has to
  // refetch. Keying the effect on this string (instead of the array) refetches
  // on a real change only, not on a new array instance carrying the same tags.
  const tagFilterKey = tagFilter.join("\u0000");
  // Candidate tags, re-read on every mount (the `chat_tags` table may have
  // changed while the module was unmounted).
  const [tagOptions, setTagOptions] = useState<string[]>([]);

  // The conversation grouping has no range picker: it always shows the
  // all-time totals.
  const effectiveRange: SpendRange =
    spendGrouping === "chat" ? "all" : spendRange;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void imb.spend
      // The filter only narrows the "All conversations" total; the rows below
      // are narrowed locally (see `visibleChats`) so switching tags never waits
      // for the round trip.
      .report(effectiveRange, tagFilter)
      .then((next) => {
        if (alive) setReport(next);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `tagFilter` is covered by `tagFilterKey` (same source array).
  }, [effectiveRange, tagFilterKey, refreshToken]);

  // Names/roles in the report come from the DB; a create/rename/delete pushed
  // by main (or the agent's `imb_set_employees`) invalidates them.
  useEffect(
    () => imb.employees.onChanged(() => setRefreshToken((token) => token + 1)),
    [],
  );

  // Chat titles in the conversation grouping come from the DB too.
  useEffect(
    () => imb.chats.onChanged(() => setRefreshToken((token) => token + 1)),
    [],
  );

  // Candidate tags for the conversation-grouping filter.
  useEffect(() => {
    let alive = true;
    void imb.tags
      .list()
      .then((tags) => {
        if (alive) setTagOptions(tags);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  // Drop a selection whose employee vanished from the report (hard delete).
  useEffect(() => {
    if (report === null || activeSpendEmployeeId === null) return;
    if (
      !report.employees.some((row) => row.employeeId === activeSpendEmployeeId)
    ) {
      appStore.activeSpendEmployeeId = null;
    }
  }, [report, activeSpendEmployeeId]);

  // Drop a selection whose chat vanished from the report (hard delete).
  useEffect(() => {
    if (report === null || activeSpendChatId === null) return;
    if (!report.chats.some((row) => row.chatId === activeSpendChatId)) {
      appStore.activeSpendChatId = null;
    }
  }, [report, activeSpendChatId]);

  const entries: SpendListEntry[] = [];
  if (report !== null) {
    if (spendGrouping === "chat") {
      // Only the conversation rows are narrowed here; the "All conversations"
      // total comes back already filtered (`chatFilterTotal`), computed by main
      // from the same per-conversation accumulators. Both use the shared
      // `matchesTagFilter` rule, so the row always equals the sum of the rows
      // below it.
      const visibleChats =
        tagFilter.length === 0
          ? report.chats
          : report.chats.filter((chat) =>
              matchesTagFilter(chat.tags, tagFilter),
            );
      // "全部对话" is the default-selected first row (no subtitle).
      entries.push({
        key: "total",
        employeeId: null,
        chatId: null,
        name: t("All conversations"),
        tokens: report.chatFilterTotal.totals.totalTokens,
        cost: report.chatFilterTotal.totals.cost,
      });
      for (const chat of visibleChats) {
        const title = chat.title || t("Untitled");
        entries.push({
          key: `c${chat.chatId}`,
          employeeId: null,
          chatId: chat.chatId,
          name: title,
          sub: `${formatTokensCompact(chat.totals.totalTokens)} · ${chat.employees.length} ${t("Employees")}`,
          tokens: chat.totals.totalTokens,
          cost: chat.totals.cost,
        });
      }
    } else {
      entries.push({
        key: "total",
        employeeId: null,
        chatId: null,
        name: t("All employees"),
        tokens: report.totals.totalTokens,
        cost: report.totals.cost,
      });
      for (const employee of report.employees) {
        entries.push({
          key: `e${employee.employeeId}`,
          employeeId: employee.employeeId,
          chatId: null,
          name: employee.name,
          sub: employee.role || "—",
          tokens: employee.totals.totalTokens,
          cost: employee.totals.cost,
        });
      }
    }
  }

  const active = (entry: SpendListEntry): boolean =>
    spendGrouping === "chat"
      ? entry.chatId === activeSpendChatId
      : entry.employeeId === activeSpendEmployeeId;

  const list = (
    <ListPane
      title={t("Statistics")}
      search={
        <div className="imb-spend-search">
          <SegmentedControl
            options={SPEND_GROUPINGS.map((value) => ({
              value,
              label: t(SPEND_GROUPING_LABELS[value]),
            }))}
            value={spendGrouping}
            onChange={(value: SpendGrouping) => {
              appStore.spendGrouping = value;
            }}
            label={t("Group by")}
          />
          {spendGrouping === "employee" && (
            <SegmentedControl
              options={SPEND_RANGES.map((value) => ({
                value,
                label: t(SPEND_RANGE_LABELS[value]),
              }))}
              value={spendRange}
              onChange={(value) => {
                appStore.spendRange = value;
              }}
              label={t("Time range")}
            />
          )}
          {spendGrouping === "chat" && (
            <TagSelect
              className="imb-spend-tag-filter"
              value={tagFilter}
              options={tagOptions}
              allowNoTag
              placeholder={t("Filter by tags")}
              onChange={setTagFilter}
            />
          )}
        </div>
      }
    >
      <ItemList
        items={entries}
        getItemKey={(entry) => entry.key}
        loading={loading && report === null}
        loadError={error}
        emptyMessage={t("No spend recorded yet")}
        estimateSize={() => 56}
        renderItem={(entry) => (
          <ListRow
            active={active(entry)}
            avatar={
              entry.chatId !== null ? (
                <Avatar
                  letter={(entry.name.slice(0, 1) || "?").toUpperCase()}
                  name={entry.name}
                  size={30}
                  alt
                />
              ) : entry.employeeId === null ? (
                <span className="imb-spend-total-avatar">
                  <IconStats />
                </span>
              ) : (
                <EmployeeAvatar employeeId={entry.employeeId} size={30} />
              )
            }
            name={entry.name}
            meta={formatCost(entry.cost)}
            sub={entry.sub}
            onClick={() => {
              if (spendGrouping === "chat") {
                appStore.activeSpendChatId = entry.chatId;
              } else {
                appStore.activeSpendEmployeeId = entry.employeeId;
              }
            }}
          />
        )}
      />
    </ListPane>
  );

  const detail = (
    <SpendDetail
      report={report}
      grouping={spendGrouping}
      employeeId={spendGrouping === "employee" ? activeSpendEmployeeId : null}
      chatId={spendGrouping === "chat" ? activeSpendChatId : null}
      loading={loading}
      error={error}
    />
  );

  return <ModuleView list={list} detail={detail} />;
}
