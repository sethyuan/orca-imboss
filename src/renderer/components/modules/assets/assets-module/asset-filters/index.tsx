import { ASSET_CATEGORIES } from "@shared/constants/assets";
import { t } from "@shared/l10n";
import type { AssetFilter } from "@shared/types";
import { Input } from "../../../../input";
import { Select } from "../../../../select";
import { Toggle } from "../../../../toggle";
import {
  categoryLabelKey,
  chatLabel,
  type ChatLike,
  type EmployeeLike,
} from "../helpers";
import "./index.css";

export interface AssetFiltersProps {
  /** Current filter, minus `query` (the module owns search text separately). */
  value: AssetFilter;
  onChange: (next: AssetFilter) => void;
  chats: readonly ChatLike[];
  employees: readonly EmployeeLike[];
}

/** Seconds → `YYYY-MM-DD` for a native date input ("" when unset). */
function toDateInput(secs: number | undefined): string {
  if (secs === undefined) return "";
  const date = new Date(secs * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Native date input value → UNIX seconds at the start/end of that day. */
function fromDateInput(value: string, endOfDay: boolean): number | undefined {
  if (value.length === 0) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59)
    : new Date(year, month - 1, day, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor(date.getTime() / 1000);
}

/**
 * Presentational filter bar: category / chat / sender selects, an images-only
 * switch and a from/to date range. Emits a fresh `AssetFilter` (minus `query`)
 * on every change; the module owns the state and resets the list.
 */
export function AssetFilters({
  value,
  onChange,
  chats,
  employees,
}: AssetFiltersProps): React.JSX.Element {
  const patch = (next: Partial<AssetFilter>): void => {
    onChange({ ...value, ...next });
  };

  return (
    <div className="imb-asset-filters">
      <div className="imb-asset-filters-grid">
        <Select
          value={value.category ?? ""}
          label={t("Category")}
          onChange={(next) =>
            patch({
              category:
                next === "" ? undefined : (next as AssetFilter["category"]),
            })
          }
          options={[
            { value: "", label: t("All categories") },
            ...ASSET_CATEGORIES.map((category) => ({
              value: category,
              label: t(categoryLabelKey(category)),
            })),
          ]}
        />
        <Select
          value={value.chatId === undefined ? "" : String(value.chatId)}
          label={t("Chat")}
          onChange={(next) =>
            patch({ chatId: next === "" ? undefined : Number(next) })
          }
          options={[
            { value: "", label: t("All chats") },
            ...chats.map((chat) => ({
              value: String(chat.id),
              label: chatLabel(chat.title),
            })),
          ]}
        />
        <Select
          value={
            value.senderEmployeeId === undefined
              ? ""
              : String(value.senderEmployeeId)
          }
          label={t("Sender")}
          onChange={(next) =>
            patch({
              senderEmployeeId: next === "" ? undefined : Number(next),
            })
          }
          options={[
            { value: "", label: t("All senders") },
            ...employees.map((employee) => ({
              value: String(employee.id),
              label: employee.name,
            })),
          ]}
        />
      </div>
      <div className="imb-asset-filters-row">
        <Input
          type="date"
          className="imb-asset-filters-date"
          aria-label={t("From")}
          value={toDateInput(value.from)}
          onChange={(event) =>
            patch({ from: fromDateInput(event.target.value, false) })
          }
        />
        <span className="imb-asset-filters-sep">–</span>
        <Input
          type="date"
          className="imb-asset-filters-date"
          aria-label={t("To")}
          value={toDateInput(value.to)}
          onChange={(event) =>
            patch({ to: fromDateInput(event.target.value, true) })
          }
        />
        <label className="imb-asset-filters-toggle">
          <Toggle
            checked={value.imagesOnly === true}
            label={t("Images only")}
            onChange={(checked) => patch({ imagesOnly: checked || undefined })}
          />
          <span>{t("Images only")}</span>
        </label>
      </div>
    </div>
  );
}
