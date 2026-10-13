import { t } from "@shared/l10n";
import type { AssetSummary } from "@shared/types";
import { ListRow } from "../../../../list-row";
import {
  categoryIcon,
  categoryLabelKey,
  chatLabel,
  type EmployeeLike,
  formatDateTime,
  formatSize,
  senderLabel,
} from "../helpers";
import "./index.css";

export interface AssetListRowProps {
  asset: AssetSummary;
  employees: readonly EmployeeLike[];
  active: boolean;
  selected: boolean;
  onContextMenu?: (event: React.MouseEvent) => void;
}

/** One asset row: category icon, name, size/category/chat, sender/date. */
export function AssetListRow({
  asset,
  employees,
  active,
  selected,
  onContextMenu,
}: AssetListRowProps): React.JSX.Element {
  const Icon = categoryIcon(asset.category);
  const meta = `${formatSize(asset.size)} · ${t(
    categoryLabelKey(asset.category),
  )} · ${chatLabel(asset.chatTitle)}`;
  const sub = `${senderLabel(asset.senderEmployeeId, employees)} · ${formatDateTime(
    asset.createdAt,
  )}`;

  return (
    <ListRow
      active={active}
      selected={selected}
      avatar={
        <span className="imb-asset-row-icon" aria-hidden="true">
          <Icon className="imb-icon imb-sm" />
        </span>
      }
      name={asset.name}
      meta={meta}
      sub={sub}
      badge={
        asset.occurrences > 1 ? (
          <span className="imb-badge">
            {t("${count}×", { count: String(asset.occurrences) })}
          </span>
        ) : undefined
      }
      onContextMenu={onContextMenu}
    />
  );
}
