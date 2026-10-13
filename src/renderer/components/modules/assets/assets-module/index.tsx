import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import type {
  AssetDetail,
  AssetFilter,
  AssetRef,
  AssetSummary,
  HiddenAsset,
} from "@shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appStore, useApp } from "../../../../app-store";
import { useInfiniteList } from "../../../../hooks/use-infinite-list";
import { useMultiSelect } from "../../../../hooks/use-multi-select";
import { ModuleView } from "../../../app-shell";
import { Button } from "../../../button";
import {
  ContextMenu,
  type ContextMenuItem,
  type ContextMenuState,
} from "../../../context-menu";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { EmptyState } from "../../../empty-state";
import { ItemList } from "../../../item-list";
import { ListPane } from "../../../list-pane";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import { Textarea } from "../../../textarea";
import { AssetActions, type AssetCommands } from "./asset-actions";
import { AssetFilters } from "./asset-filters";
import { AssetListRow } from "./asset-list-row";
import { AssetPreview } from "./asset-preview";
import {
  assetKey,
  basename,
  categoryLabelKey,
  chatLabel,
  formatDateTime,
  formatSize,
  refOf,
  senderLabel,
} from "./helpers";
import "../../module-common.css";
import "./index.css";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

/** Default prompt prefilled in the hand-off modal (translated at mount). */
const DEFAULT_HANDOFF_PROMPT_KEY = "Here are the files:";

export function AssetsModule(): React.JSX.Element {
  const { data } = useApp();
  const [searchText, setSearchText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [view, setView] = useState<"all" | "hidden">("all");
  const [filter, setFilter] = useState<AssetFilter>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Trusted locator for the detail/preview; defaults to the selected list
  // asset's representative occurrence, overridable by clicking an occurrence.
  const [activeRef, setActiveRef] = useState<AssetRef | null>(null);
  const [assetDetail, setAssetDetail] = useState<AssetDetail | null>(null);
  const [occurrences, setOccurrences] = useState<AssetSummary[]>([]);
  const [hiddenItems, setHiddenItems] = useState<HiddenAsset[]>([]);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [trashTargets, setTrashTargets] = useState<AssetSummary[] | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffPrompt, setHandoffPrompt] = useState(() =>
    t(DEFAULT_HANDOFF_PROMPT_KEY),
  );

  const employees = data.employees.items;

  // Filter dropdowns need the chat + employee caches.
  useEffect(() => {
    appStore.ensureChats();
    appStore.ensureEmployees();
  }, []);

  // Debounce the search box before it feeds the infinite list's query.
  useEffect(() => {
    const id = window.setTimeout(
      () => setDebouncedQuery(searchText),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [searchText]);

  const list = useInfiniteList<AssetSummary>(
    (page) => imb.assets.list({ ...filter, query: page.query }, page),
    { query: debouncedQuery, pageSize: PAGE_SIZE },
  );
  const { reset: resetList } = list;

  // Non-search filters reset the list (a stable signature avoids re-running on
  // every render and skips the redundant mount-time reset).
  const filterSignature = [
    filter.chatId ?? "",
    filter.senderEmployeeId ?? "",
    filter.category ?? "",
    filter.from ?? "",
    filter.to ?? "",
    filter.imagesOnly === true ? "1" : "",
  ].join("|");
  const filterSigRef = useRef(filterSignature);
  useEffect(() => {
    if (filterSigRef.current === filterSignature) return;
    filterSigRef.current = filterSignature;
    resetList();
  }, [filterSignature, resetList]);

  const multi = useMultiSelect<AssetSummary, string>({
    getKey: (asset) => assetKey(asset),
    items: list.items,
    onActivate: (asset) => setSelectedKey(assetKey(asset)),
    resetVersion: list.resetVersion,
  });
  const selectedKeys = multi.selectedKeys;

  // Auto-select the first asset after page 1 loads (and recover when the
  // selected asset disappears, e.g. a filter change or hide/trash).
  useEffect(() => {
    if (list.loading) return;
    if (list.items.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((current) =>
      current !== null &&
      list.items.some((asset) => assetKey(asset) === current)
        ? current
        : assetKey(list.items[0]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.items, list.loading]);

  const selectedAsset =
    list.items.find((asset) => assetKey(asset) === selectedKey) ?? null;

  // Keep the active locator in sync with the selected list asset.
  const repMessageId = selectedAsset?.messageId ?? null;
  const repIndex = selectedAsset?.index ?? null;
  useEffect(() => {
    if (repMessageId === null || repIndex === null) {
      setActiveRef(null);
      return;
    }
    setActiveRef({ messageId: repMessageId, index: repIndex });
  }, [repMessageId, repIndex]);

  const activeMessageId = activeRef?.messageId ?? null;
  const activeIndex = activeRef?.index ?? null;

  const loadDetail = useCallback(async (): Promise<void> => {
    if (activeMessageId === null || activeIndex === null) {
      setAssetDetail(null);
      setOccurrences([]);
      return;
    }
    const ref: AssetRef = { messageId: activeMessageId, index: activeIndex };
    try {
      const [detail, occ] = await Promise.all([
        imb.assets.detail(ref),
        imb.assets.occurrences(ref),
      ]);
      setAssetDetail(detail);
      setOccurrences(occ);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeMessageId, activeIndex]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const loadHidden = useCallback(async (): Promise<void> => {
    setHiddenLoading(true);
    try {
      setHiddenItems(await imb.assets.hidden());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setHiddenLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "hidden") void loadHidden();
  }, [view, loadHidden]);

  const refresh = useCallback(async (): Promise<void> => {
    resetList();
    await loadDetail();
    if (view === "hidden") await loadHidden();
  }, [resetList, loadDetail, loadHidden, view]);

  // Main pushes `assets:changed` after hide/unhide/trash; keep open views fresh.
  useEffect(() => {
    const off = imb.assets.onChanged(() => {
      void refresh();
    });
    return off;
  }, [refresh]);

  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const commands = useMemo<AssetCommands>(
    () => ({
      reveal: (ref) => {
        void runAction(() =>
          imb.messages.revealAttachment(ref.messageId, ref.index),
        );
      },
      open: (ref) => {
        void runAction(() => imb.assets.open(ref));
      },
      copyPath: (paths) => {
        void runAction(async () => {
          const text = paths
            .filter((path): path is string => path !== null && path.length > 0)
            .join("\n");
          if (text.length === 0) return;
          await navigator.clipboard.writeText(text);
        });
      },
      saveAs: (ref) => {
        void runAction(async () => {
          await imb.assets.saveAs(ref);
        });
      },
      hide: (refs) => {
        void runAction(async () => {
          for (const ref of refs) await imb.assets.hide(ref);
          await refresh();
        });
      },
      requestTrash: (refs) => {
        const targets = list.items.filter((asset) =>
          refs.some(
            (ref) =>
              ref.messageId === asset.messageId && ref.index === asset.index,
          ),
        );
        setTrashTargets(targets.length > 0 ? targets : null);
      },
    }),
    [runAction, refresh, list.items],
  );

  // Current multi-selection, falling back to the active asset so single-click
  // selection can also be handed off / exported.
  const selectedAssets = useMemo((): AssetSummary[] => {
    if (selectedKeys.size > 0) {
      return list.items.filter((asset) => selectedKeys.has(assetKey(asset)));
    }
    return selectedAsset ? [selectedAsset] : [];
  }, [selectedKeys, list.items, selectedAsset]);

  const confirmTrash = useCallback(async (): Promise<void> => {
    if (trashTargets === null || trashTargets.length === 0) return;
    setBusy(true);
    try {
      for (const asset of trashTargets) await imb.assets.trash(refOf(asset));
      setTrashTargets(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [trashTargets, refresh]);

  const exportZip = useCallback(async (): Promise<void> => {
    const refs = selectedAssets.map(refOf);
    if (refs.length === 0) return;
    setBusy(true);
    try {
      await imb.assets.exportZip(refs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedAssets]);

  const handOff = useCallback(async (): Promise<void> => {
    if (selectedAssets.length === 0) return;
    setBusy(true);
    try {
      const chat = await imb.chats.create("", []);
      const attachments = selectedAssets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        type: asset.type,
        ...(asset.path ? { path: asset.path } : {}),
      }));
      await imb.chat.send(chat.id, handoffPrompt, attachments);
      setHandoffOpen(false);
      // Open the new chat the same way chat-module's `newChat` does: refresh
      // the cache, select it, and switch to the chat module.
      await appStore.reloadChats();
      appStore.setActiveRootChat(chat.id);
      appStore.focusChatId = chat.id;
      appStore.module = "chat";
      void imb.settings.set(SettingKeys.Module, "chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedAssets, handoffPrompt]);

  const restoreHidden = useCallback(
    async (path: string): Promise<void> => {
      try {
        await imb.assets.unhide(path);
        await loadHidden();
        resetList();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadHidden, resetList],
  );

  const buildMenuItems = useCallback(
    (targets: AssetSummary[]): ContextMenuItem[] => {
      const primary = targets[0];
      const refs = targets.map(refOf);
      return [
        {
          key: "reveal",
          label: t("Show in folder"),
          onSelect: () => {
            if (primary) commands.reveal(refOf(primary));
          },
        },
        {
          key: "open",
          label: t("Open"),
          onSelect: () => {
            if (primary) commands.open(refOf(primary));
          },
        },
        {
          key: "copy",
          label: t("Copy path"),
          onSelect: () => commands.copyPath(targets.map((a) => a.path)),
        },
        {
          key: "saveas",
          label: t("Save as…"),
          onSelect: () => {
            if (primary) commands.saveAs(refOf(primary));
          },
        },
        { key: "divider-1", divider: true },
        { key: "hide", label: t("Hide"), onSelect: () => commands.hide(refs) },
        {
          key: "trash",
          label: t("Move to trash"),
          danger: true,
          onSelect: () => commands.requestTrash(refs),
        },
      ];
    },
    [commands],
  );

  const openRowMenu = useCallback(
    (event: React.MouseEvent, asset: AssetSummary): void => {
      event.preventDefault();
      const key = assetKey(asset);
      const targets = selectedKeys.has(key)
        ? list.items.filter((item) => selectedKeys.has(assetKey(item)))
        : [asset];
      setCtxMenu({
        x: event.clientX,
        y: event.clientY,
        items: buildMenuItems(targets),
      });
    },
    [selectedKeys, list.items, buildMenuItems],
  );

  const listPane =
    view === "hidden" ? (
      <ListPane
        title={t("Assets")}
        footer={
          <>
            <ViewToggle view={view} onChange={setView} />
          </>
        }
      >
        {hiddenLoading ? (
          <EmptyState>{t("Loading…")}</EmptyState>
        ) : hiddenItems.length === 0 ? (
          <EmptyState>{t("No hidden assets")}</EmptyState>
        ) : (
          <ul className="imb-asset-hidden-list">
            {hiddenItems.map((item) => (
              <li key={item.path} className="imb-asset-hidden-row">
                <span className="imb-asset-hidden-body">
                  <span className="imb-asset-hidden-name">
                    {basename(item.path)}
                  </span>
                  <span className="imb-asset-hidden-path" title={item.path}>
                    {item.path}
                  </span>
                  <span className="imb-asset-hidden-meta">
                    {formatDateTime(item.hiddenAt)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void restoreHidden(item.path)}
                >
                  {t("Restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ListPane>
    ) : (
      <ListPane
        title={t("Assets")}
        search={
          <>
            <SearchInput
              value={searchText}
              onValueChange={setSearchText}
              placeholder={t("Search asset filename")}
            />
            <AssetFilters
              value={filter}
              onChange={setFilter}
              chats={data.chats.items}
              employees={employees}
            />
          </>
        }
        footer={
          <>
            <ViewToggle view={view} onChange={setView} />
            <Button
              block
              disabled={selectedAssets.length === 0}
              onClick={() => setHandoffOpen(true)}
            >
              {t("Hand off to assistant")}
            </Button>
            <Button
              block
              variant="secondary"
              loading={busy}
              disabled={selectedAssets.length === 0}
              onClick={() => void exportZip()}
            >
              {t("Export zip")}
            </Button>
          </>
        }
      >
        <ItemList
          items={list.items}
          getItemKey={(asset) => assetKey(asset)}
          loading={list.loading}
          loadingMore={list.loadingMore}
          hasMore={list.hasMore}
          loadMore={() => void list.loadMore()}
          loadError={list.error}
          emptyMessage={t("No assets")}
          selectable
          selectedKeys={selectedKeys}
          onItemClick={(asset, index, mods) =>
            multi.onItemClick(asset, index, mods)
          }
          renderItem={(asset, { selected: isSelectedRow }) => (
            <AssetListRow
              asset={asset}
              employees={employees}
              active={assetKey(asset) === selectedKey}
              selected={isSelectedRow}
              onContextMenu={(event) => openRowMenu(event, asset)}
            />
          )}
        />
      </ListPane>
    );

  const info: AssetSummary | null = assetDetail ?? selectedAsset;

  const detailPane = info ? (
    <>
      <DetailHead
        eyebrow={t("Asset")}
        title={info.name}
        actions={
          <AssetActions
            assets={selectedAssets}
            missing={assetDetail?.missing ?? false}
            commands={commands}
          />
        }
      />
      <DetailBody>
        {assetDetail ? (
          <AssetPreview asset={assetDetail} />
        ) : (
          <div className="imb-asset-preview-empty">{t("Loading…")}</div>
        )}
        <dl className="imb-asset-meta">
          <MetaRow label={t("Name")} value={info.name} />
          <MetaRow label={t("Size")} value={formatSize(info.size)} />
          <MetaRow label={t("Type")} value={info.type || "—"} />
          <MetaRow
            label={t("Category")}
            value={t(categoryLabelKey(info.category))}
          />
          <MetaRow label={t("Chat")} value={chatLabel(info.chatTitle)} />
          <MetaRow
            label={t("Sender")}
            value={senderLabel(info.senderEmployeeId, employees)}
          />
          <MetaRow
            label={t("Created")}
            value={formatDateTime(info.createdAt)}
          />
          <MetaRow label={t("Occurrences")} value={String(info.occurrences)} />
        </dl>
        {assetDetail?.missing === true && (
          <p className="imb-asset-missing">{t("File is missing")}</p>
        )}
        <h3 className="imb-asset-section-title">{t("Source messages")}</h3>
        {occurrences.length === 0 ? (
          <p className="imb-asset-occurrences-empty">{t("None")}</p>
        ) : (
          <ul className="imb-asset-occurrences">
            {occurrences.map((occ) => (
              <li key={`${occ.messageId}-${occ.index}`}>
                <button
                  type="button"
                  className="imb-asset-occurrence"
                  onClick={() =>
                    setActiveRef({ messageId: occ.messageId, index: occ.index })
                  }
                >
                  <span className="imb-asset-occurrence-title">
                    {chatLabel(occ.chatTitle)}
                  </span>
                  <span className="imb-asset-occurrence-meta">
                    {senderLabel(occ.senderEmployeeId, employees)} ·{" "}
                    {formatDateTime(occ.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DetailBody>
    </>
  ) : (
    <EmptyState>{t("Select an asset to view it")}</EmptyState>
  );

  return (
    <>
      <ModuleView list={listPane} detail={detailPane} />
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
      <Modal
        open={trashTargets !== null}
        onClose={() => setTrashTargets(null)}
        title={t("Move to trash")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setTrashTargets(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void confirmTrash()}
            >
              {t("Move to trash")}
            </Button>
          </>
        }
      >
        <p className="imb-module-note">
          {t("The file will be moved to the system trash.")}
        </p>
      </Modal>
      <Modal
        open={handoffOpen}
        onClose={() => setHandoffOpen(false)}
        title={t("Hand off to assistant")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setHandoffOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button loading={busy} onClick={() => void handOff()}>
              {t("Send")}
            </Button>
          </>
        }
      >
        <Textarea
          autosize
          value={handoffPrompt}
          aria-label={t("Message")}
          onChange={(event) => setHandoffPrompt(event.target.value)}
        />
        <p className="imb-module-note">
          {t("${count} file(s) will be attached.", {
            count: String(selectedAssets.length),
          })}
        </p>
      </Modal>
      {error !== null && (
        <p className="imb-error-text imb-module-error">{error}</p>
      )}
    </>
  );
}

/** Segmented switch between the normal list and the hidden view. */
function ViewToggle({
  view,
  onChange,
}: {
  view: "all" | "hidden";
  onChange: (next: "all" | "hidden") => void;
}): React.JSX.Element {
  return (
    <div className="imb-asset-view-toggle">
      <Button
        size="sm"
        block
        variant={view === "all" ? "primary" : "secondary"}
        onClick={() => onChange("all")}
      >
        {t("All")}
      </Button>
      <Button
        size="sm"
        block
        variant={view === "hidden" ? "primary" : "secondary"}
        onClick={() => onChange("hidden")}
      >
        {t("Hidden")}
      </Button>
    </div>
  );
}

/** One label/value row in the metadata block. */
function MetaRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="imb-asset-meta-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
