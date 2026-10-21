import { normalizeTag } from "@shared/constants/tags";
import { t } from "@shared/l10n";
import { useMemo } from "react";
import { MultiSelect } from "../multi-select";

export const GROUP_FILTER_UNGROUPED = "__ungrouped__";

export interface GroupSelectProps {
  value: string[];
  options: string[];
  onChange: (value: string[]) => void;
  allowCreate?: boolean;
  allowUngrouped?: boolean;
  placeholder?: string;
  disabled?: boolean;
  noClear?: boolean;
  className?: string;
  id?: string;
}

export function GroupSelect({
  value,
  options,
  onChange,
  allowCreate = false,
  allowUngrouped = false,
  placeholder = "",
  disabled = false,
  noClear = false,
  className,
  id,
}: GroupSelectProps): React.JSX.Element {
  const merged = useMemo(() => {
    const missing = value.filter(
      (group) => group !== GROUP_FILTER_UNGROUPED && !options.includes(group),
    );
    const base = missing.length > 0 ? [...options, ...missing] : options;
    return allowUngrouped ? [GROUP_FILTER_UNGROUPED, ...base] : base;
  }, [options, value, allowUngrouped]);

  const multiOptions = useMemo(
    () =>
      merged.map((group) => ({
        value: group,
        label:
          group === GROUP_FILTER_UNGROUPED ? t("Ungrouped") : group,
      })),
    [merged],
  );

  function handleChange(next: string[]): void {
    if (!allowUngrouped) {
      onChange(next);
      return;
    }
    const hadUngrouped = value.includes(GROUP_FILTER_UNGROUPED);
    const hasUngrouped = next.includes(GROUP_FILTER_UNGROUPED);
    const real = next.filter((g) => g !== GROUP_FILTER_UNGROUPED);
    if (hasUngrouped && !hadUngrouped) {
      onChange([GROUP_FILTER_UNGROUPED]);
      return;
    }
    if (hasUngrouped && hadUngrouped && real.length > 0) {
      onChange(real);
      return;
    }
    onChange(next);
  }

  function handleCreate(text: string): void {
    const group = normalizeTag(text);
    if (group.length === 0 || value.includes(group)) return;
    handleChange([...value, group]);
  }

  return (
    <MultiSelect
      id={id}
      className={className}
      value={value}
      options={multiOptions}
      onChange={handleChange}
      searchable
      clearable={!noClear}
      searchPlaceholder={t("Search or add group")}
      onSearchCreate={allowCreate ? handleCreate : undefined}
      placeholder={placeholder}
      emptyHint={t("No groups yet")}
      disabled={disabled}
    />
  );
}
