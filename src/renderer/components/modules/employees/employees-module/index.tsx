import {
  BUILTIN_GENERATE_IMAGE_MARKER,
  BUILTIN_REMOVE_CRON_MARKER,
  BUILTIN_SET_CRON_MARKER,
} from "@shared/constants/agent_tools";
import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import type {
  Employee,
  EmployeeImportPreview,
  EmployeeImportResult,
  EmployeeInput,
  InstalledSkill,
  ModelOption,
} from "@shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appStore, useApp } from "../../../../app-store";
import { useDebouncedValue } from "../../../../hooks/use-debounced-value";
import { useModuleFilter } from "../../../../hooks/use-module-filter";
import { useMultiSelect } from "../../../../hooks/use-multi-select";
import { ModuleView } from "../../../app-shell";
import { Button } from "../../../button";
import {
  ContextMenu,
  type ContextMenuItem,
  type ContextMenuState,
} from "../../../context-menu";
import { EmployeeAvatar } from "../../../employee-avatar";
import { IconX } from "../../../icons";
import { ItemList } from "../../../item-list";
import { ListPane } from "../../../list-pane";
import { ListRow } from "../../../list-row";
import { Modal } from "../../../modal";
import "../../../modules/module-common.css";
import type { MultiSelectOption } from "../../../multi-select";
import { SearchInput } from "../../../search-input";
import { useFavoriteModels } from "../../../../use-favorite-models";
import { EmployeeDetail } from "../employee-detail";
import { EmployeeImportModal } from "../employee-import-modal";
import { EmployeeRecruitModal } from "../employee-recruit-modal";

/**
 * How long the transient import result stays on screen. The app's other short
 * flashes use 1.5s ("Saved"), but a result summary is a sentence long, so it
 * gets 5s — still within the "a few seconds" convention.
 */
const IMPORT_NOTICE_MS = 5000;

/** Skill names stay the option label. The description is hover text only. */
function toSkillOptions(
  skills: readonly InstalledSkill[],
): MultiSelectOption[] {
  return skills.map((skill) => ({
    value: skill.name,
    label: skill.name,
    description: skill.description,
  }));
}

export function EmployeesModule(): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Search text stored on the appStore so a module switch does not lose it (the
  // module unmounts on a switch); session-only, cleared by an app restart.
  // The input keeps the raw `query` (instant feedback); filtering uses the
  // debounced value so large lists are not re-scanned on every keystroke.
  const { query, setQuery } = useModuleFilter("employees");
  const debouncedQuery = useDebouncedValue(query);
  const [recruitOpen, setRecruitOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  // Import is a two-step flow: inspect (nothing written) → confirm → apply.
  const [importPreview, setImportPreview] =
    useState<EmployeeImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState<"inspect" | "apply" | null>(
    null,
  );
  const [importOverwrite, setImportOverwrite] = useState(false);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const { data, focusEmployeeId } = useApp();
  const loading = data.employees.loading;
  const listError = data.employees.error;

  // Centralized in appStore (loaded once at startup); filter client-side.
  const employees = useMemo((): Employee[] => {
    // Valtio snapshot elements are deeply readonly; clone the nested ref
    // arrays into mutable copies so they satisfy the Employee type.
    const source = data.employees.items.map((employee) => ({
      ...employee,
      mcp: [...employee.mcp],
      skills: [...employee.skills],
    }));
    const needle = debouncedQuery.trim().toLowerCase();
    if (!needle) return source;
    return source.filter(
      (employee) =>
        employee.name.toLowerCase().includes(needle) ||
        employee.role.toLowerCase().includes(needle),
    );
  }, [data.employees.items, debouncedQuery]);

  // Model options still come via IPC (models out of scope); loaded once.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  // App default thinking level: named beside the employee's "Default" choice.
  const [defaultThinking, setDefaultThinking] = useState("");
  const favorites = useFavoriteModels();
  useEffect(() => {
    void Promise.all([
      imb.models.list(),
      imb.settings.get(SettingKeys.DefaultModel),
      imb.settings.get(SettingKeys.DefaultThinkingLevel),
    ])
      .then(([loaded, storedDefault, storedThinking]) => {
        setModels(loaded);
        setDefaultModel(storedDefault ?? "");
        setDefaultThinking(storedThinking ?? "");
      })
      .catch(() => {
        // Best-effort: model selects stay empty on failure.
      });
  }, []);

  // Re-fetch on every entry (best-effort): employees can be changed by the
  // agent with no renderer event, and the editor's MCP/skill option selects
  // must reflect the current backend state.
  useEffect(() => {
    void appStore.reloadEmployees();
    void appStore.reloadMcp();
    void appStore.reloadSkills();
  }, []);

  // Linked-MCP options = built-in opt-in tools (cron + image generation) +
  // configured MCP servers.
  const mcpOptions = useMemo((): MultiSelectOption[] => {
    return [
      { value: BUILTIN_SET_CRON_MARKER, label: t("Set cron job") },
      { value: BUILTIN_REMOVE_CRON_MARKER, label: t("Remove cron job") },
      { value: BUILTIN_GENERATE_IMAGE_MARKER, label: t("Generate image") },
      ...data.mcp.items.map((m) => ({ value: m.name, label: m.name })),
    ];
  }, [data.mcp.items]);

  const multi = useMultiSelect<Employee, number>({
    getKey: (employee) => employee.id,
    items: employees,
    onActivate: (employee) => setSelectedId(employee.id),
    // The built-in assistant is always pinned but never selectable; bulk
    // actions and "Select all" must not be able to reach it.
    isSelectable: (employee) => employee.id !== 0,
  });
  const clearSelection = multi.clear;
  const selectSelection = multi.select;
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;

  // Query changes reset the selection.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, debouncedQuery]);

  // Auto-select the first employee after page 1 loads (and recover when the
  // selected employee disappears, e.g. bulk delete). The resolved active item
  // is mirrored into `selectedKeys` so the active row is always selected.
  useEffect(() => {
    if (loading) return;
    if (employees.length === 0) {
      setSelectedId(null);
      clearSelection();
      return;
    }
    const current = selectedIdRef.current;
    const nextId =
      current !== null && employees.some((employee) => employee.id === current)
        ? current
        : employees[0].id;
    setSelectedId(nextId);
    selectSelection(nextId);
  }, [employees, loading, clearSelection, selectSelection]);

  // Jump to one employee (the agent-session header's name link). The id arrives
  // through the store because this module is unmounted on a module switch, and it
  // is consumed only once the employee is actually part of the list — the filter
  // reset that came with the jump is debounced, so the target may still be
  // filtered out on the first render. Declared after the auto-select effect on
  // purpose: both run in the same commit and the jump wins.
  useEffect(() => {
    if (focusEmployeeId === null) return;
    if (!employees.some((employee) => employee.id === focusEmployeeId)) return;
    setSelectedId(focusEmployeeId);
    selectSelection(focusEmployeeId);
    appStore.focusEmployeeId = null;
  }, [focusEmployeeId, employees, selectSelection]);

  const selected =
    employees.find((employee) => employee.id === selectedId) ?? null;

  const patch = useCallback(
    async (id: number, input: EmployeeInput): Promise<boolean> => {
      try {
        const updated = await imb.employees.update(id, input);
        if (updated) appStore.replaceEmployee(updated);
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [],
  );

  const create = useCallback(
    async (input: EmployeeInput): Promise<Employee | null> => {
      try {
        const created = await imb.employees.create(input);
        // Newest id sorts last (id ASC) — append so it is immediately visible.
        appStore.addEmployee(created);
        setSelectedId(created.id);
        setError(null);
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [],
  );

  const remove = useCallback(async (id: number): Promise<void> => {
    try {
      const removed = await imb.employees.remove(id);
      if (removed) appStore.removeEmployee(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const deleteSelected = useCallback(async (): Promise<void> => {
    const ids = deleteIds.filter((id) => id !== 0);
    if (ids.length === 0) return;
    try {
      setDeleteOpen(false);
      for (const id of ids) {
        await imb.employees.remove(id);
        appStore.removeEmployee(id);
      }
      // Drop the just-deleted keys so a subsequent bulk action only acts on
      // the live list.
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [deleteIds, clearSelection]);

  const toggleSelectAll = useCallback((): void => {
    // Compare against selectable rows only. The assistant (id 0) is never
    // selectable but can be the active item in `selectedKeys`, so it must be
    // excluded from the count or the toggle-to-clear branch would misfire.
    const selectableCount = employees.filter(
      (employee) => employee.id !== 0,
    ).length;
    const selectedSelectableCount = [...multi.selectedKeys].filter(
      (id) => id !== 0,
    ).length;
    if (selectedSelectableCount === selectableCount && selectableCount > 0) {
      multi.clear();
    } else {
      multi.selectAll();
    }
  }, [multi, employees]);

  // --- transient import notice ---------------------------------------------

  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Show the result notice, replacing (and re-timing) any previous one. */
  const showNotice = useCallback((message: string): void => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, IMPORT_NOTICE_MS);
  }, []);

  /** Hide the notice immediately and cancel its timer (close button). */
  const dismissNotice = useCallback((): void => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice(null);
  }, []);

  // Never leave a timer running after the module unmounts.
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };
  }, []);

  // --- import an exported employee -----------------------------------------

  /** Step 1: pick a file and unpack it into staging (nothing applied yet). */
  const startImport = useCallback(async (): Promise<void> => {
    if (importBusy !== null) return;
    setImportBusy("inspect");
    setImportError(null);
    dismissNotice();
    try {
      const preview = await imb.employees.importInspect();
      // `null` = the native open dialog was cancelled.
      if (preview !== null) {
        setImportPreview(preview);
        setImportOverwrite(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportBusy(null);
    }
  }, [importBusy, dismissNotice]);

  /** Drop a staged package (dialog dismissed or confirm refused). */
  const discardImport = useCallback((): void => {
    const token = importPreview?.token;
    setImportPreview(null);
    setImportOverwrite(false);
    setImportError(null);
    if (token !== undefined) void imb.employees.importCancel(token);
  }, [importPreview]);

  /** Write the previewed package; `overwrite` was confirmed by the user. */
  const applyImport = useCallback(
    async (overwrite: boolean): Promise<void> => {
      const preview = importPreview;
      if (preview === null || importBusy !== null) return;
      setImportBusy("apply");
      setImportError(null);
      try {
        const result = await imb.employees.importApply(preview.token, {
          overwrite,
        });
        appStore.addEmployee(result.employee);
        setSelectedId(result.employee.id);
        // The detail pane's MCP / skill option lists must show what the
        // package just installed.
        void appStore.reloadMcp();
        void appStore.reloadSkills();
        setImportPreview(null);
        setImportOverwrite(false);
        setImportConfirmOpen(false);
        showNotice(importSummary(result));
      } catch (err) {
        // The package is still staged, so the dialog stays open for a retry.
        setImportError(err instanceof Error ? err.message : String(err));
        setImportConfirmOpen(false);
      } finally {
        setImportBusy(null);
      }
    },
    [importPreview, importBusy, showNotice],
  );

  const confirmImport = useCallback((): void => {
    if (importPreview === null) return;
    setImportError(null);
    // An overwrite is destructive on local data: ask a second time.
    if (importOverwrite && importPreview.hasConflicts) {
      setImportConfirmOpen(true);
      return;
    }
    void applyImport(false);
  }, [importPreview, importOverwrite, applyImport]);

  const importTargets = useMemo(() => {
    if (importPreview === null) return { skills: [], mcp: [] };
    return {
      skills: importPreview.skills
        .filter((skill) => skill.exists && skill.invalidReason === null)
        .map((skill) => skill.name),
      mcp: importPreview.mcpServers
        .filter((server) => server.exists)
        .map((server) => server.name),
    };
  }, [importPreview]);

  const listPane = (
    <ListPane
      title={t("Employees")}
      search={
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("Filter by name or role")}
        />
      }
      footer={
        // The Recruit button opens a small menu: create a new employee (the
        // previous behaviour) or import an exported one. Reuses the module's
        // `ContextMenu` (same look as the row context menus).
        <Button
          block
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setCtxMenu({
              // Dropdown, not a cursor menu: attached to the button, opened
              // upwards and centred on it (flips back down only if it would
              // leave the viewport).
              anchor: { rect, placement: "top", align: "center" },
              items: [
                {
                  key: "recruit-new",
                  label: t("New employee…"),
                  onSelect: () => setRecruitOpen(true),
                },
                {
                  key: "recruit-import",
                  label: t("Import from file…"),
                  onSelect: () => void startImport(),
                },
              ],
            });
          }}
        >
          {t("Recruit")}
        </Button>
      }
    >
      <ItemList
        items={employees}
        getItemKey={(employee) => employee.id}
        loading={loading}
        loadError={listError}
        emptyMessage={t("No employees found")}
        selectable
        selectedKeys={multi.selectedKeys}
        onItemClick={(employee, index, mods) =>
          multi.onItemClick(employee, index, mods)
        }
        renderItem={(employee, { selected: isSelectedRow }) => (
          <ListRow
            active={employee.id === selectedId}
            selected={isSelectedRow}
            avatar={<EmployeeAvatar employeeId={employee.id} alt />}
            name={employee.name || t("Unnamed")}
            meta={`#${employee.id}`}
            sub={employee.role || "—"}
            badge={
              employee.id === 0 ? (
                <span className="imb-badge">{t("Built-in")}</span>
              ) : undefined
            }
            onContextMenu={(e) => {
              e.preventDefault();
              const items: ContextMenuItem[] = [
                {
                  key: "select-all",
                  label: t("Select all"),
                  onSelect: toggleSelectAll,
                },
              ];
              if (employee.id !== 0) {
                items.push({
                  key: "delete",
                  label: t("Delete"),
                  danger: true,
                  onSelect: () => {
                    // Selection-aware: a right-click on an already-selected
                    // row deletes the whole selection; otherwise it deletes
                    // just the right-clicked employee (never a hidden
                    // select-all).
                    setDeleteIds(
                      multi.selectedKeys.has(employee.id)
                        ? [...multi.selectedKeys]
                        : [employee.id],
                    );
                    setDeleteOpen(true);
                  },
                });
              }
              setCtxMenu({ x: e.clientX, y: e.clientY, items });
            }}
          />
        )}
      />
    </ListPane>
  );

  const detail = selected ? (
    <EmployeeDetail
      key={selected.id}
      employee={selected}
      mcpOptions={mcpOptions}
      skillOptions={toSkillOptions(data.skills.items)}
      models={models}
      defaultModel={defaultModel}
      defaultThinking={defaultThinking}
      favoriteModels={favorites.refs}
      onToggleFavorite={favorites.toggle}
      onPatch={(input) => patch(selected.id, input)}
      onRemove={() => void remove(selected.id)}
      onAvatarUpdated={(employee) => appStore.replaceEmployee(employee)}
    />
  ) : null;

  return (
    <>
      <ModuleView list={listPane} detail={detail} />
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t("Delete employees")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button variant="danger" onClick={() => void deleteSelected()}>
              {t("Delete")}
            </Button>
          </>
        }
      >
        <p className="imb-module-note">
          {t(
            "The employee's conversation records will also be cleared. This cannot be undone.",
          )}
        </p>
      </Modal>
      <EmployeeRecruitModal
        open={recruitOpen}
        onClose={() => setRecruitOpen(false)}
        mcpOptions={mcpOptions}
        skillOptions={toSkillOptions(data.skills.items)}
        models={models}
        defaultModel={defaultModel}
        defaultThinking={defaultThinking}
        favoriteModels={favorites.refs}
        onToggleFavorite={favorites.toggle}
        onCreate={create}
      />
      <EmployeeImportModal
        open={importPreview !== null}
        preview={importPreview}
        overwrite={importOverwrite}
        onOverwriteChange={setImportOverwrite}
        busy={importBusy === "apply"}
        error={importError}
        onCancel={discardImport}
        onConfirm={confirmImport}
      />
      <Modal
        open={importConfirmOpen}
        onClose={() => setImportConfirmOpen(false)}
        title={t("Overwrite existing items?")}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => setImportConfirmOpen(false)}
              disabled={importBusy === "apply"}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              loading={importBusy === "apply"}
              onClick={() => void applyImport(true)}
            >
              {t("Overwrite and import")}
            </Button>
          </>
        }
      >
        <p className="imb-module-note">
          {t(
            "These items already exist on this machine and will be replaced by the ones in the file:",
          )}
        </p>
        <ul className="imb-import-confirm-list">
          {importTargets.skills.map((name) => (
            <li key={`skill-${name}`}>
              {t("Skill folder “${name}”", { name })}
            </li>
          ))}
          {importTargets.mcp.map((name) => (
            <li key={`mcp-${name}`}>{t("MCP server “${name}”", { name })}</li>
          ))}
        </ul>
      </Modal>
      {notice !== null && (
        <div className="imb-employee-import-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="imb-employee-import-notice-close"
            aria-label={t("Close")}
            title={t("Close")}
            onClick={dismissNotice}
          >
            <IconX className="imb-icon imb-sm" />
          </button>
        </div>
      )}
      {error !== null && (
        <p className="imb-error-text imb-module-error">{error}</p>
      )}
    </>
  );
}

/** One-line summary of a finished import, shown as a module notice. */
function importSummary(result: EmployeeImportResult): string {
  const parts: string[] = [
    t("Imported ${name}.", {
      name: result.employee.name.trim() || t("Unnamed"),
    }),
  ];
  if (result.skills.installed.length > 0) {
    parts.push(
      t("Skills added: ${names}.", {
        names: result.skills.installed.join(", "),
      }),
    );
  }
  if (result.skills.overwritten.length > 0) {
    parts.push(
      t("Skills overwritten: ${names}.", {
        names: result.skills.overwritten.join(", "),
      }),
    );
  }
  if (result.skills.kept.length > 0) {
    parts.push(
      t("Skills kept as they are: ${names}.", {
        names: result.skills.kept.join(", "),
      }),
    );
  }
  if (result.mcp.added.length > 0) {
    parts.push(
      t("MCP servers added: ${names}.", { names: result.mcp.added.join(", ") }),
    );
  }
  if (result.mcp.overwritten.length > 0) {
    parts.push(
      t("MCP servers overwritten: ${names}.", {
        names: result.mcp.overwritten.join(", "),
      }),
    );
  }
  const secretNames = Object.entries(result.secretsToFill).map(
    ([name, keys]) => `${name} (${keys.join(", ")})`,
  );
  if (secretNames.length > 0) {
    parts.push(
      t("Fill in credentials for: ${names}.", {
        names: secretNames.join("; "),
      }),
    );
  }
  if (result.warnings.length > 0) {
    parts.push(
      t("${count} warning(s) were recorded for this import.", {
        count: String(result.warnings.length),
      }),
    );
  }
  return parts.join(" ");
}
