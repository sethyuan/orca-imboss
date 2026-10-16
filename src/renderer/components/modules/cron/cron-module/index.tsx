import { t } from "@shared/l10n";
import type { CronJobInfo } from "@shared/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cls } from "reactutils";
import { appStore, useApp } from "../../../../app-store";
import { useDebouncedValue } from "../../../../hooks/use-debounced-value";
import { ModuleView } from "../../../app-shell";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { EmployeeAvatar } from "../../../employee-avatar";
import { Field } from "../../../field";
import { IconChat, IconEdit, IconPlay, IconTrash } from "../../../icons";
import { Input } from "../../../input";
import { ItemList } from "../../../item-list";
import { ListPane } from "../../../list-pane";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import { Textarea } from "../../../textarea";
import { Toggle } from "../../../toggle";
import "../../module-common.css";
import { describeSchedule, formatRunTime } from "./cron-format";
import "./index.css";

/**
 * Scheduled tasks — the unified manager for every employee's cron jobs. Mounted
 * as a top-level sidebar module in the list/detail layout: the left list groups
 * all jobs by employee (each group headed by the employee's name; jobs sorted
 * by creation time and showing chat, schedule, description and next run), the
 * right pane shows the selected job's full detail plus its
 * Edit / Enable-Disable / Run now / Remove actions.
 *
 * Jobs can also be created/removed by employees through `imb_set_cronjob` /
 * `imb_remove_cronjob`; the list is (re)fetched on every module entry.
 */
export function CronModule(): React.JSX.Element {
  const { data } = useApp();
  const [jobs, setJobs] = useState<CronJobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The input keeps the raw `query` (instant feedback); filtering uses the
  // debounced value so the list is not re-scanned on every keystroke.
  const debouncedQuery = useDebouncedValue(query);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setJobs(await imb.cron.listAll());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch on every entry: jobs can change via the agent with no renderer
  // event (same convention as the other modules).
  useEffect(() => {
    void load();
  }, [load]);

  // Employee names come from the shared roster cache (loaded at startup).
  useEffect(() => {
    appStore.ensureEmployees();
  }, []);

  const employeeName = useCallback(
    (employeeId: number): string => {
      const employee = data.employees.items.find((e) => e.id === employeeId);
      return employee?.name?.trim() || t("Unnamed");
    },
    [data.employees.items],
  );

  const filtered = useMemo((): CronJobInfo[] => {
    const needle = debouncedQuery.trim().toLowerCase();
    if (!needle) return jobs;
    return jobs.filter(
      (job) =>
        employeeName(job.employeeId).toLowerCase().includes(needle) ||
        job.chatTitle.toLowerCase().includes(needle) ||
        job.schedule.toLowerCase().includes(needle) ||
        job.content.toLowerCase().includes(needle),
    );
  }, [jobs, debouncedQuery, employeeName]);

  // Group the (filtered) jobs by employee. Groups are ordered by employee id
  // (matching the Employees module); jobs stay in creation order within each
  // group (the server already returns `ORDER BY created_at`).
  const rows = useMemo((): CronListRow[] => {
    const byEmployee = new Map<number, CronJobInfo[]>();
    for (const job of filtered) {
      const list = byEmployee.get(job.employeeId);
      if (list) list.push(job);
      else byEmployee.set(job.employeeId, [job]);
    }
    const employeeIds = [...byEmployee.keys()].sort((a, b) => a - b);
    const out: CronListRow[] = [];
    for (const employeeId of employeeIds) {
      const employeeJobs = byEmployee.get(employeeId) ?? [];
      out.push({
        kind: "group",
        employeeId,
        name: employeeName(employeeId),
        count: employeeJobs.length,
      });
      for (const job of employeeJobs) out.push({ kind: "job", job });
    }
    return out;
  }, [filtered, employeeName]);

  // Keep a valid selection as the list / filter changes.
  useEffect(() => {
    if (loading) return;
    if (filtered.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) =>
      prev !== null && filtered.some((job) => job.id === prev)
        ? prev
        : filtered[0].id,
    );
  }, [filtered, loading]);

  const selected = filtered.find((job) => job.id === selectedId) ?? null;

  const replaceJob = useCallback((updated: CronJobInfo): void => {
    setJobs((prev) =>
      prev.map((job) => (job.id === updated.id ? updated : job)),
    );
  }, []);

  // Root chats open in the Chat module; spawned group chats open in the
  // Group chat module (both routed through appStore).
  const openChat = useCallback(async (chatId: number): Promise<void> => {
    try {
      const summary = await imb.chats.summary(chatId);
      if (summary === null) return;
      if (summary.fromChatId === null) {
        await appStore.focusChat(chatId);
      } else {
        appStore.openChat(summary);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleEnabled = useCallback(
    async (job: CronJobInfo): Promise<void> => {
      setBusy(true);
      setActionError(null);
      try {
        const updated = await imb.cron.setEnabled(job.id, !job.enabled);
        if (updated) replaceJob(updated);
        else await load();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [replaceJob, load],
  );

  const runNow = useCallback(async (job: CronJobInfo): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await imb.cron.runNow(job.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveEdit = useCallback(
    async (schedule: string, content: string): Promise<void> => {
      if (!selected) return;
      setBusy(true);
      setEditError(null);
      try {
        const updated = await imb.cron.update(selected.id, schedule, content);
        if (updated) {
          replaceJob(updated);
          setEditOpen(false);
        }
      } catch (err) {
        setEditError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [selected, replaceJob],
  );

  const confirmRemove = useCallback(async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setActionError(null);
    try {
      const removed = await imb.cron.remove(selected.id);
      if (removed) {
        setJobs((prev) => prev.filter((job) => job.id !== selected.id));
      }
      setRemoveOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected]);

  const list = (
    <ListPane
      title={t("Scheduled tasks")}
      search={
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("Search scheduled tasks")}
        />
      }
    >
      <ItemList
        items={rows}
        getItemKey={(row) =>
          row.kind === "group" ? `group:${row.employeeId}` : `job:${row.job.id}`
        }
        loading={loading}
        loadError={listError}
        emptyMessage={
          debouncedQuery.trim().length > 0
            ? t("No scheduled tasks match your search")
            : t("No scheduled tasks yet. Ask an employee to create one.")
        }
        renderItem={(row) =>
          row.kind === "group" ? (
            <CronGroupRow
              employeeId={row.employeeId}
              name={row.name}
              count={row.count}
            />
          ) : (
            <CronJobRow
              job={row.job}
              active={row.job.id === selectedId}
              onClick={() => setSelectedId(row.job.id)}
            />
          )
        }
      />
    </ListPane>
  );

  const detail = selected ? (
    <>
      <DetailHead
        eyebrow={t("Scheduled tasks")}
        title={
          <span className="imb-cron-detail-title">
            <EmployeeAvatar employeeId={selected.employeeId} size={22} />
            {employeeName(selected.employeeId)}
          </span>
        }
        sub={selected.chatTitle || t("Untitled")}
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<IconPlay />}
              loading={busy}
              onClick={() => void runNow(selected)}
            >
              {t("Run now")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<IconEdit />}
              disabled={busy}
              onClick={() => {
                setEditError(null);
                setEditOpen(true);
              }}
            >
              {t("Edit")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<IconTrash />}
              disabled={busy}
              onClick={() => setRemoveOpen(true)}
            >
              {t("Remove")}
            </Button>
          </>
        }
      />
      <DetailBody>
        <Field label={t("Employee")}>
          <div className="imb-cron-static">
            <EmployeeAvatar employeeId={selected.employeeId} size={22} />
            <span>{employeeName(selected.employeeId)}</span>
            <span className="imb-cron-id">#{selected.employeeId}</span>
          </div>
        </Field>
        <Field label={t("Chat")}>
          <button
            type="button"
            className="imb-cron-chat"
            title={t("Open chat")}
            onClick={() => void openChat(selected.chatId)}
          >
            <IconChat />
            <span>{selected.chatTitle || t("Untitled")}</span>
          </button>
        </Field>
        <Field label={t("Status")}>
          <div className="imb-cron-status">
            <Toggle
              checked={selected.enabled}
              disabled={busy}
              label={selected.enabled ? t("Disable") : t("Enable")}
              onChange={() => void toggleEnabled(selected)}
            />
            <span>{selected.enabled ? t("Enabled") : t("Disabled")}</span>
          </div>
        </Field>
        <Field label={t("Schedule")}>
          <div className="imb-cron-schedule">
            <span>{describeSchedule(selected.schedule)}</span>
            <code className="imb-cron-schedule-raw">{selected.schedule}</code>
          </div>
        </Field>
        <Field label={t("Description")}>
          <div className="imb-cron-desc imb-is-expanded">
            {selected.content}
          </div>
        </Field>
        <Field label={t("Next run")}>
          <div className="imb-cron-next">
            {selected.enabled
              ? formatRunTime(selected.nextRunAt)
              : t("Disabled")}
          </div>
        </Field>
        {actionError !== null && (
          <p className="imb-error-text imb-cron-action-error">{actionError}</p>
        )}
      </DetailBody>
    </>
  ) : null;

  return (
    <>
      <ModuleView list={list} detail={detail} />
      {selected !== null && (
        <CronEditModal
          key={selected.id}
          job={selected}
          open={editOpen}
          busy={busy}
          error={editError}
          onClose={() => setEditOpen(false)}
          onSubmit={(schedule, content) => void saveEdit(schedule, content)}
        />
      )}
      <Modal
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title={t("Remove scheduled task")}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRemoveOpen(false)}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void confirmRemove()}
            >
              {t("Remove")}
            </Button>
          </>
        }
      >
        <p className="imb-module-note">
          {t("This scheduled task will be removed. This cannot be undone.")}
        </p>
      </Modal>
    </>
  );
}

interface CronJobRowProps {
  job: CronJobInfo;
  active: boolean;
  onClick: () => void;
}

/** A list entry: an employee group header, or one of that employee's jobs. */
type CronListRow =
  | { kind: "group"; employeeId: number; name: string; count: number }
  | { kind: "job"; job: CronJobInfo };

interface CronGroupRowProps {
  employeeId: number;
  name: string;
  count: number;
}

/** Sticky-by-position group header naming the employee that owns the jobs. */
function CronGroupRow({
  employeeId,
  name,
  count,
}: CronGroupRowProps): React.JSX.Element {
  return (
    <div className="imb-cron-group">
      <EmployeeAvatar employeeId={employeeId} size={20} />
      <span className="imb-cron-group-name">{name}</span>
      <span className="imb-cron-group-count">{count}</span>
    </div>
  );
}

/** One job row: chat, schedule, description and next run (employee is the group). */
function CronJobRow({
  job,
  active,
  onClick,
}: CronJobRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cls(
        "imb-cron-row",
        active && "imb-is-active",
        !job.enabled && "imb-is-disabled",
      )}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
    >
      <span className="imb-cron-row-body">
        <span className="imb-cron-row-top">
          <span className="imb-cron-row-chat">
            <IconChat />
            <span>{job.chatTitle || t("Untitled")}</span>
          </span>
          {!job.enabled && <span className="imb-badge">{t("Disabled")}</span>}
          <span className="imb-cron-row-next">
            {job.enabled ? formatRunTime(job.nextRunAt) : t("Disabled")}
          </span>
        </span>
        <span className="imb-cron-row-schedule">
          {describeSchedule(job.schedule)}
        </span>
        <span className="imb-cron-row-desc">{job.content}</span>
      </span>
    </button>
  );
}

interface CronEditModalProps {
  job: CronJobInfo;
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (schedule: string, content: string) => void;
}

/** Edit modal for the two mutable fields: `schedule` + `content`. */
function CronEditModal({
  job,
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: CronEditModalProps): React.JSX.Element {
  const [schedule, setSchedule] = useState(job.schedule);
  const [content, setContent] = useState(job.content);
  const canSave = schedule.trim().length > 0 && content.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("Edit scheduled task")}
      error={error}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            loading={busy}
            disabled={!canSave}
            onClick={() => onSubmit(schedule.trim(), content.trim())}
          >
            {t("Save")}
          </Button>
        </>
      }
    >
      <Field label={t("Schedule")} htmlFor={`cron-edit-schedule-${job.id}`}>
        <Input
          id={`cron-edit-schedule-${job.id}`}
          value={schedule}
          mono
          data-autofocus
          onChange={(event) => setSchedule(event.target.value)}
        />
      </Field>
      <Field label={t("Description")} htmlFor={`cron-edit-content-${job.id}`}>
        <Textarea
          id={`cron-edit-content-${job.id}`}
          value={content}
          autosize
          minHeight={96}
          maxHeight={260}
          onChange={(event) => setContent(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
