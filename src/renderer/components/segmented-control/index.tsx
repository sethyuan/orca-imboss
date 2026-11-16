import type { CSSProperties, ReactNode } from "react";
import { cls } from "reactutils";
import "./index.css";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible text, or the accessible name when `icon` is set. */
  label: string;
  /**
   * Optional glyph. When present the segment renders icon-only and `label` stays
   * as its accessible name (required: the titlebar switch has no visible text).
   */
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label?: string;
  /** `mini` = 22px track with fixed-width icon segments (chrome-band density). */
  size?: "regular" | "mini";
}

/**
 * macOS capsule segmented control: one tinted track, and a single raised thumb
 * that slides between the equal-width segments.
 *
 * The thumb is one absolutely positioned element whose offset is derived from
 * `--imb-seg-index` / `--imb-seg-count` (set here), so the selection animation
 * is a compositor-only `transform` — no per-segment background cross-fades and
 * no measuring in JS.
 *
 * `icon` / `size` are additive: a caller that passes neither gets exactly the
 * text-only, 30px-tall control it always had.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "regular",
}: SegmentedControlProps<T>): React.JSX.Element {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      className={cls("imb-segmented-group", size === "mini" && "imb-is-mini")}
      role="group"
      aria-label={label}
      style={
        {
          "--imb-seg-index": index,
          "--imb-seg-count": Math.max(options.length, 1),
        } as CSSProperties
      }
    >
      <span className="imb-segmented-thumb" aria-hidden="true" />
      {options.map((option) => (
        <SegmentedButton
          key={option.value}
          active={option.value === value}
          label={option.label}
          icon={option.icon}
          onClick={() => onChange(option.value)}
        />
      ))}
    </div>
  );
}

interface SegmentedButtonProps {
  active: boolean;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}

function SegmentedButton({
  active,
  label,
  icon,
  onClick,
}: SegmentedButtonProps): React.JSX.Element {
  // An icon-only segment has no visible text, so the label becomes its
  // accessible name and the glyph itself is decoration.
  const decoration =
    icon !== undefined ? (
      <span className="imb-segmented-glyph" aria-hidden="true">
        {icon}
      </span>
    ) : null;

  return (
    <button
      type="button"
      className={cls("imb-segmented-btn", active && "imb-is-active")}
      aria-pressed={active}
      aria-label={decoration ? label : undefined}
      onClick={onClick}
    >
      {decoration ?? label}
    </button>
  );
}
