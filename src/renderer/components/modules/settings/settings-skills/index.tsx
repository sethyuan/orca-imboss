import { t } from "@shared/l10n";
import type { InstalledSkill } from "@shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appStore, useApp } from "../../../../app-store";
import { useDebouncedValue } from "../../../../hooks/use-debounced-value";
import { useMultiSelect } from "../../../../hooks/use-multi-select";
import { Avatar } from "../../../avatar";
import { Button } from "../../../button";
import { ContextMenu, type ContextMenuState } from "../../../context-menu";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { ItemList } from "../../../item-list";
import { ListPane } from "../../../list-pane";
import { ListRow } from "../../../list-row";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import "../../module-common.css";
import "../settings-split.css";
import "./index.css";

/**
 * Settings › Skills — the installed-skills manager, embedded in the Settings
 * detail pane as a nested master/detail split (skill list + selected skill's
 * description). Moved out of the top-level nav so all configuration lives
 * under Settings.
 */
export function SettingsSkills(): React.JSX.Element {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The input keeps the raw `query` (instant feedback); filtering uses the
  // debounced value so the list is not re-scanned on every keystroke.
  const debouncedQuery = useDebouncedValue(query);
  const [busy, setBusy] = useState(false);
  const [uninstallTarget, setUninstallTarget] = useState<InstalledSkill | null>(
    null,
  );
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkNames, setBulkNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const { data } = useApp();
  const loading = data.skills.loading;
  const listError = data.skills.error;

  // Centralized in appStore (loaded on first visit); filter client-side.
  const skills = useMemo((): readonly InstalledSkill[] => {
    const needle = debouncedQuery.trim().toLowerCase();
    if (!needle) return data.skills.items;
    return data.skills.items.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        (skill.description ?? "").toLowerCase().includes(needle),
    );
  }, [data.skills.items, debouncedQuery]);

  const multi = useMultiSelect<InstalledSkill, string>({
    getKey: (skill) => skill.name,
    items: skills,
    onActivate: (skill) => setSelectedName(skill.name),
  });
  const clearSelection = multi.clear;
  const selectSelection = multi.select;
  const selectedNameRef = useRef<string | null>(null);
  selectedNameRef.current = selectedName;

  // Query changes reset the selection.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, debouncedQuery]);

  // Re-fetch on every entry: skills live on the filesystem and can change
  // outside the app, and no `skills:changed` event is emitted. First load
  // shows the loading state; revisits revalidate silently.
  useEffect(() => {
    void appStore.reloadSkills();
  }, []);

  // Auto-select the first skill after the list loads (and recover when the
  // selected skill disappears, e.g. uninstall). The resolved active item is
  // mirrored into `selectedKeys` so the active row is always selected.
  useEffect(() => {
    if (loading) return;
    if (skills.length === 0) {
      setSelectedName(null);
      clearSelection();
      return;
    }
    const current = selectedNameRef.current;
    const nextName =
      current !== null && skills.some((skill) => skill.name === current)
        ? current
        : skills[0].name;
    setSelectedName(nextName);
    selectSelection(nextName);
  }, [skills, loading, clearSelection, selectSelection]);

  const importFromFolder = async (): Promise<void> => {
    setBusy(true);
    try {
      const names = await imb.skills.install();
      // `null` = user cancelled; `[]` = nothing importable. Best-effort import:
      // keep any valid skills with no UI feedback beyond re-listing them.
      if (names !== null && names.length > 0) {
        await appStore.reloadSkills();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (skill: InstalledSkill): Promise<void> => {
    setBusy(true);
    try {
      await imb.skills.uninstall(skill.name);
      setUninstallTarget(null);
      await appStore.reloadSkills();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const uninstallSelected = async (): Promise<void> => {
    if (bulkNames.length === 0) return;
    setBusy(true);
    try {
      for (const name of bulkNames) {
        await imb.skills.uninstall(name);
      }
      setBulkOpen(false);
      await appStore.reloadSkills();
      // Drop the just-uninstalled keys so a subsequent bulk action only acts
      // on the live list.
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelectAll = useCallback((): void => {
    if (multi.selectedKeys.size === skills.length && skills.length > 0) {
      multi.clear();
    } else {
      multi.selectAll();
    }
  }, [multi, skills.length]);

  const selected = skills.find((skill) => skill.name === selectedName) ?? null;

  const list = (
    <ListPane
      title={t("Skills")}
      search={
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("Search skill name or description")}
        />
      }
      footer={
        <Button block loading={busy} onClick={() => void importFromFolder()}>
          {t("Import Skills")}
        </Button>
      }
    >
      <ItemList
        items={skills}
        getItemKey={(skill) => skill.name}
        loading={loading}
        loadError={listError}
        emptyMessage={
          debouncedQuery.trim().length > 0
            ? t("No skills match your search")
            : t("No skills installed")
        }
        selectable
        selectedKeys={multi.selectedKeys}
        onItemClick={(skill, index, mods) =>
          multi.onItemClick(skill, index, mods)
        }
        renderItem={(skill, { selected: isSelectedRow }) => (
          <ListRow
            active={skill.name === selectedName}
            selected={isSelectedRow}
            avatar={
              <Avatar letter={skill.name.slice(0, 1)} name={skill.name} alt />
            }
            name={skill.name}
            sub={skill.description ?? "—"}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    key: "select-all",
                    label: t("Select all"),
                    onSelect: toggleSelectAll,
                  },
                  {
                    key: "uninstall",
                    label: t("Uninstall"),
                    danger: true,
                    onSelect: () => {
                      // Selection-aware: a right-click on an already-selected
                      // row uninstalls the whole selection; otherwise only the
                      // right-clicked skill (never a hidden select-all).
                      setBulkNames(
                        multi.selectedKeys.has(skill.name)
                          ? [...multi.selectedKeys]
                          : [skill.name],
                      );
                      setBulkOpen(true);
                    },
                  },
                ],
              });
            }}
          />
        )}
      />
    </ListPane>
  );

  const detail = selected ? (
    <>
      <DetailHead
        eyebrow="Skill"
        title={selected.name}
        actions={
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            onClick={() => setUninstallTarget(selected)}
          >
            {t("Uninstall")}
          </Button>
        }
      />
      <DetailBody style={{ paddingTop: "0" }}>
        <DetailReadOnlyDescription description={selected.description} />
      </DetailBody>
    </>
  ) : null;

  return (
    <div className="imb-settings-split">
      <div className="imb-settings-split-list">{list}</div>
      <div className="imb-settings-split-detail">{detail}</div>
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
      <Modal
        open={uninstallTarget !== null}
        onClose={() => setUninstallTarget(null)}
        title={t("Uninstall skill")}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => setUninstallTarget(null)}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                if (uninstallTarget) void uninstall(uninstallTarget);
              }}
            >
              {t("Uninstall")}
            </Button>
          </>
        }
      >
        <p className="imb-module-note">
          {t("Linked employees must choose again after removing.")}
        </p>
      </Modal>
      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title={t("Uninstall skills")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setBulkOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void uninstallSelected()}
            >
              {t("Uninstall")}
            </Button>
          </>
        }
      >
        <p className="imb-module-note">
          {t("Linked employees must choose again after removing.")}
        </p>
      </Modal>
      {error !== null && (
        <p className="imb-error-text imb-module-error">{error}</p>
      )}
    </div>
  );
}

/** Skill info is read-only (SKILL.md is the source of truth). */
function DetailReadOnlyDescription({
  description,
}: {
  description: string | null;
}): React.JSX.Element {
  return (
    <p className="imb-skill-readonly-text">
      {description && description.length > 0 ? description : "—"}
    </p>
  );
}
