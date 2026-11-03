import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cls } from "reactutils";
import { useDropdownPosition } from "../../hooks/use-dropdown-position";
import { useEscapeKey } from "../../hooks/use-escape-key";
import { usePopupLayer } from "../../hooks/use-popup-layer";
import { IconChevronDown } from "../icons";
import "./index.css";

function optionMatchesTypeahead(option: SelectOption, buffer: string): boolean {
  const texts = [option.menuLabel ?? option.label, option.label];
  if (option.group) texts.push(option.group);
  return texts.some((text) => text.toLowerCase().startsWith(buffer));
}

export interface SelectOption {
  value: string;
  /** Text in the closed control. */
  label: string;
  /**
   * Muted gloss after `label` on the same row. The closed control shows it
   * too, because that control repeats the selected option's text.
   */
  note?: string;
  /**
   * Text of the open row when it should be shorter than `label`.
   * Type-ahead matches this, `label`, and `group`.
   */
  menuLabel?: string;
  /** Non-selectable heading inserted before the first row of a run. */
  group?: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  label?: string;
}

/**
 * Custom combobox (prototype used a native select; upgraded to a custom one
 * for keyboard/ARIA parity with the rest of the form controls).
 *
 * The dropdown panel is portaled to `document.body` and positioned from the
 * trigger's bounding rect. This escapes the overflow clipping of ancestors
 * such as the modal body, which would otherwise truncate a long list. It also
 * flips upward when there is more room above the trigger than below it.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "",
  invalid = false,
  disabled = false,
  id,
  label,
}: SelectProps): React.JSX.Element {
  const uid = useId();
  const listboxId = `select-${uid}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { panelStyle, positionPanel } = useDropdownPosition(rootRef);

  // Type-ahead buffer.
  const bufferRef = useRef("");
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const fallbackIndex =
    selectedIndex >= 0
      ? selectedIndex
      : value
        ? options.findIndex(
            (o) =>
              o.value.endsWith(`/${value}`) ||
              value.endsWith(`/${o.value}`) ||
              o.value === value,
          )
        : -1;
  const selected =
    fallbackIndex >= 0
      ? options[fallbackIndex]
      : value
        ? { value, label: value }
        : null;

  const openPanel = useCallback((): void => {
    if (disabled) return;
    positionPanel();
    setOpen(true);
    setActiveIndex(
      selectedIndex >= 0
        ? selectedIndex
        : fallbackIndex >= 0
          ? fallbackIndex
          : 0,
    );
  }, [disabled, fallbackIndex, positionPanel, selectedIndex]);

  const closePanel = useCallback((): void => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const commit = useCallback(
    (index: number): void => {
      if (index < 0 || index >= options.length) return;
      onChange(options[index].value);
      closePanel();
    },
    [closePanel, onChange, options.length],
  );

  // Close on pointerdown outside the trigger OR the portaled panel.
  useEffect(() => {
    if (!open) return;
    const listener = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closePanel();
    };
    document.addEventListener("mousedown", listener);
    return () => document.removeEventListener("mousedown", listener);
  }, [closePanel, open]);

  // Reposition the portaled panel if the viewport scrolls/resizes while open.
  useEffect(() => {
    if (!open) return;
    const reposition = (): void => positionPanel();
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open, positionPanel]);

  useEscapeKey(closePanel, open);
  // Leave Escape / the focus order to this panel while it is open, even when it
  // was opened from inside a `Modal` (its panel is portaled outside the dialog).
  usePopupLayer(open);

  function onTriggerKeyDown(event: React.KeyboardEvent): void {
    if (disabled) return;
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openPanel();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Tab":
        closePanel();
        break;
      default: {
        if (event.key.length === 1 && /[A-Za-z0-9]/.test(event.key)) {
          bufferRef.current += event.key.toLowerCase();
          if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
          bufferTimerRef.current = setTimeout(() => {
            bufferRef.current = "";
          }, 500);
          const match = options.findIndex((o) =>
            optionMatchesTypeahead(o, bufferRef.current),
          );
          if (match >= 0) setActiveIndex(match);
        }
      }
    }
  }

  function optionId(index: number): string {
    return `${listboxId}-opt-${index}`;
  }

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  return (
    <div
      className={cls("imb-select-wrap", invalid && "imb-has-error")}
      ref={rootRef}
    >
      <button
        type="button"
        className="imb-select"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        aria-invalid={invalid || undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span
          className={cls(
            "imb-select-value",
            !selected && "imb-is-placeholder",
            selected?.note && "imb-has-note",
          )}
          title={selected?.note}
        >
          {selected?.note ? (
            <>
              <span className="imb-select-value-main">{selected.label}</span>
              <span className="imb-select-note">{selected.note}</span>
            </>
          ) : selected ? (
            selected.label
          ) : (
            placeholder
          )}
        </span>
        <IconChevronDown
          className={cls(
            "imb-icon",
            "imb-sm",
            "imb-select-caret",
            open && "imb-is-open",
          )}
        />
      </button>
      {open &&
        panelStyle &&
        createPortal(
          <ul
            ref={panelRef}
            className="imb-select-panel imb-menu-surface"
            id={listboxId}
            role="listbox"
            style={{
              position: "fixed",
              top: panelStyle.top,
              bottom: panelStyle.bottom,
              left: panelStyle.left,
              width: panelStyle.width,
              maxHeight: panelStyle.maxHeight,
              right: "auto",
              zIndex: 50,
            }}
          >
            {options.length === 0 && (
              <li className="imb-select-empty" role="presentation">
                —
              </li>
            )}
            {options.map((option, index) => {
              const showGroup =
                !!option.group && option.group !== options[index - 1]?.group;
              const menuText = option.menuLabel ?? option.label;
              return (
                <Fragment key={option.value}>
                  {showGroup && (
                    <li className="imb-select-group" role="presentation">
                      {option.group}
                    </li>
                  )}
                  <li
                    id={optionId(index)}
                    role="option"
                    aria-selected={option.value === value}
                    aria-label={
                      option.menuLabel && option.menuLabel !== option.label
                        ? option.label
                        : undefined
                    }
                    className={cls(
                      "imb-select-option imb-menu-row",
                      option.group && "imb-is-grouped",
                      index === activeIndex && "imb-is-active",
                      option.value === value && "imb-is-selected",
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(index)}
                  >
                    <span
                      className={cls(
                        "imb-select-option-label",
                        option.note && "imb-has-note",
                      )}
                    >
                      {option.note ? (
                        <>
                          <span className="imb-select-value-main">
                            {menuText}
                          </span>
                          <span className="imb-select-note">{option.note}</span>
                        </>
                      ) : (
                        menuText
                      )}
                    </span>
                    {option.value === value && (
                      <span className="imb-select-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
