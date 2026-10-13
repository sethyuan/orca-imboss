import { ASSET_CATEGORIES } from "@shared/constants/assets";
import { t } from "@shared/l10n";
import type {
  AssetCategory,
  AssetDetail,
  AssetFilter,
  AssetRef,
  AssetSummary,
} from "@shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appStore, useApp } from "../../../../app-store";
import { useInfiniteList } from "../../../../hooks/use-infinite-list";
import { Button } from "../../../button";
import { EmptyState } from "../../../empty-state";
import { ItemList } from "../../../item-list";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import { Select } from "../../../select";
import {
  AssetActions,
  type AssetCommands,
} from "../assets-module/asset-actions";
import { AssetListRow } from "../assets-module/asset-list-row";
import { AssetPreview } from "../assets-module/asset-preview";
import {
  assetKey,
  categoryLabelKey,
  chatLabel,
  formatDateTime,
  formatSize,
  refOf,
  senderLabel,
} from "../assets-module/helpers";
import "../../module-common.css";
import "../assets-module/index.css";
import "./index.css";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

export interface AssetsPanelProps {
  /** Chat whose assets are listed. */
  chatId: number;
  onClose: () => void;
}

/**
 * In-chat asset panel: every attachment produced in (or sent to) the current
 * conversation, with the same list/preview/action building blocks as the global
 * Assets module — without leaving the chat. Mounted only while open.
 */
export function AssetsPanel({
  chatId,
  onClose,
}: AssetsPanelProps): React.JSX.Element {
  const { data } = useApp();
  const employees = data.employees.items;
  const chatTitle =
    data.chats.items.find((chat) => chat.id === chatId)?.title ?? "";

  const [searchText, setSearchText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [category, setCategory] = useState<AssetCategory | "">("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [assetDetail, setAssetDetail] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trashTarget, setTrashTarget] = useState<AssetSummary | null>(null);

  useEffect(() => {
    appStore.ensureEmployees();
  }, []);

  useEffect(() => {
    const id = window.setTimeout(
      () => setDebouncedQuery(searchText),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [searchText]);

  const list = useInfiniteList<AssetSummary>(
    (page) =>
      imb.assets.list(
        {
          chatId,
          ...(category === "" ? {} : { category }),
          query: page.query,
        } satisfies AssetFilter,
        page,
      ),
    { query: debouncedQuery, pageSize: PAGE_SIZE },
  );
  const { reset: resetList } = list;

  // A type-filter change reloads from the first page.
  const categoryRef = useRef(category);
  useEffect(() => {
    if (categoryRef.current === category) return;
    categoryRef.current = category;
    resetList();
  }, [category, resetList]);

  const selectedAsset =
    list.items.find((asset) => assetKey(asset) === selectedKey) ?? null;

  // Auto-select the first asset once page 1 is in.
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
  }, [list.items, list.loading]);

  const repMessageId = selectedAsset?.messageId ?? null;
  const repIndex = selectedAsset?.index ?? null;

  const loadDetail = useCallback(async (): Promise<void> => {
    if (repMessageId === null || repIndex === null) {
      setAssetDetail(null);
      return;
    }
    try {
      setAssetDetail(
        await imb.assets.detail({ messageId: repMessageId, index: repIndex }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [repMessageId, repIndex]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const refresh = useCallback(async (): Promise<void> => {
    resetList();
    await loadDetail();
  }, [resetList, loadDetail]);

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
      reveal: (ref: AssetRef) => {
        void runAction(() =>
          imb.messages.revealAttachment(ref.messageId, ref.index),
        );
      },
      open: (ref: AssetRef) => {
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
      saveAs: (ref: AssetRef) => {
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
      requestTrash: () => {
        if (selectedAsset) setTrashTarget(selectedAsset);
      },
    }),
    [runAction, refresh, selectedAsset],
  );

  const confirmTrash = useCallback(async (): Promise<void> => {
    if (trashTarget === null) return;
    setBusy(true);
    try {
      await imb.assets.trash(refOf(trashTarget));
      setTrashTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [trashTarget, refresh]);

  const selectedKeys = useMemo(
    () => new Set<string>(selectedKey === null ? [] : [selectedKey]),
    [selectedKey],
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={t("Assets")}
      sub={chatLabel(chatTitle)}
      size="lg"
    >
      <div className="imb-asset-panel">
        <div className="imb-asset-panel-list">
          <div className="imb-asset-panel-toolbar">
            <SearchInput
              value={searchText}
              onValueChange={setSearchText}
              placeholder={t("Search asset filename")}
            />
            <Select
              value={category}
              label={t("Category")}
              onChange={(next) =>
                setCategory(next === "" ? "" : (next as AssetCategory))
              }
              options={[
                { value: "", label: t("All categories") },
                ...ASSET_CATEGORIES.map((item) => ({
                  value: item,
                  label: t(categoryLabelKey(item)),
                })),
              ]}
            />
          </div>
          <div className="imb-asset-panel-scroll">
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
              onItemClick={(asset) => setSelectedKey(assetKey(asset))}
              renderItem={(asset, { selected }) => (
                <AssetListRow
                  asset={asset}
                  employees={employees}
                  active={assetKey(asset) === selectedKey}
                  selected={selected}
                />
              )}
            />
          </div>
        </div>

        <div className="imb-asset-panel-detail">
          {assetDetail && selectedAsset ? (
            <>
              <AssetPreview asset={assetDetail} />
              <dl className="imb-asset-meta">
                <PanelMeta
                  label={t("Size")}
                  value={formatSize(selectedAsset.size)}
                />
                <PanelMeta
                  label={t("Type")}
                  value={selectedAsset.type || "—"}
                />
                <PanelMeta
                  label={t("Category")}
                  value={t(categoryLabelKey(selectedAsset.category))}
                />
                <PanelMeta
                  label={t("Sender")}
                  value={senderLabel(selectedAsset.senderEmployeeId, employees)}
                />
                <PanelMeta
                  label={t("Created")}
                  value={formatDateTime(selectedAsset.createdAt)}
                />
              </dl>
              {assetDetail.missing && (
                <p className="imb-asset-missing">{t("File is missing")}</p>
              )}
              <AssetActions
                assets={[selectedAsset]}
                missing={assetDetail.missing}
                commands={commands}
              />
              {trashTarget !== null && (
                <div className="imb-asset-panel-confirm">
                  <span>
                    {t("The file will be moved to the system trash.")}
                  </span>
                  <div className="imb-asset-panel-confirm-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setTrashTarget(null)}
                    >
                      {t("Cancel")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy}
                      onClick={() => void confirmTrash()}
                    >
                      {t("Move to trash")}
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <EmptyState>{t("Select an asset to view it")}</EmptyState>
          )}
        </div>
      </div>
      {error !== null && (
        <p className="imb-error-text imb-module-error">{error}</p>
      )}
    </Modal>
  );
}

/** One label/value row in the panel's metadata block. */
function PanelMeta({
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
