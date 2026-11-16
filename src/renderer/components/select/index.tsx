import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cls } from "reactutils";
import { useDropdownPosition } from "../../hooks/use-dropdown-position";
import { useEscapeKey } from "../../hooks/use-escape-key";
import { usePopupLayer } from "../../hooks/use-popup-layer";
import { IconChevronDown, IconSearch } from "../icons";
import "./index.css";

/** Resting time on the trigger before a hover-opened panel appears. */
const DEFAULT_HOVER_OPEN_DELAY = 200;
/** Grace after the pointer left trigger and panel; it bridges their gap. */
const DEFAULT_HOVER_CLOSE_DELAY = 150;

export interface SelectOption {
  value: string;
  label: string;
  /**
   * Muted gloss after `label` on the same row. The closed control shows it
   * too, because that control repeats the selected option's text.
   */
  note?: string;
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
  /**
   * Show a filter input at the top of the panel and narrow `options` by it.
   *
   * Off by default: a plain form select keeps its old behaviour (and stays
   * keyboard-cyclable). The filter matches `label` and `note`, case-insensitive,
   * unless `filterOption` says otherwise.
   */
  searchable?: boolean;
  /** Placeholder (and accessible name) of that filter input. */
  searchPlaceholder?: string;
  /**
   * Custom filter for `searchable` mode. Receives the trimmed, lower-cased
   * query; the default matches `label` or `note`.
   */
  filterOption?: (option: SelectOption, query: string) => boolean;
  /**
   * Custom row content, for a richer option than a single line (an avatar, a
   * trailing gloss). The row keeps the shared menu geometry and the selected
   * check mark; `label` still drives the default filter and the trigger text.
   */
  renderOption?: (option: SelectOption) => ReactNode;
  /** Text of the "nothing to offer" row, instead of the default `—`. */
  emptyMessage?: ReactNode;
  /**
   * Minimum width of the portaled panel, for triggers narrower than the rows
   * they open (see `useDropdownPosition`).
   */
  panelMinWidth?: number;
  /**
   * Trigger appearance.
   *
   * - `"field"` (default): the bordered form control — a value/placeholder plus
   *   a caret that flips while open.
   * - `"ghost"`: a borderless disclosure button (short label + an **upward**
   *   caret, because such a control sits at the bottom of a pane and therefore
   *   opens upward). Hover/focus use the ghost-button recipe from the design
   *   system, so it reads as an action, not as a form field.
   * - `"icon"`: the same ghost button reduced to its **caret only** (14px, still
   *   pointing up) with no label; the hit area stays a full 30px control. `label`
   *   is then the only accessible name, so a caller must pass one.
   */
  variant?: "field" | "ghost" | "icon";
  /**
   * Open the panel when the pointer **rests** on the trigger (off by default).
   *
   * Opt-in, because a hover-opened panel is a different animal from a clicked
   * one:
   *
   * - It is opened by the pointer alone, so it takes **no focus** (a boss typing
   *   in the composer must not lose the caret merely because the mouse crossed
   *   the trigger) and its search box does not autofocus.
   * - It is transient: leaving the trigger *and* the panel closes it after
   *   `hoverCloseDelay`, so the pointer can cross the gap to the portaled panel —
   *   but not while it is still in use (the filter has the caret, or holds text).
   * - A panel opened by click or keyboard keeps today's behaviour exactly: it
   *   stays until something closes it (a pick, Escape, a click outside).
   *
   * Click, keyboard (`Enter` / `Space` / `ArrowUp` / `ArrowDown`) and touch taps
   * still open the panel, so the control never becomes pointer-only. Only
   * `pointerType === "mouse"` counts as hover: a touch `pointerenter` must not
   * pre-open the panel under the finger's own tap.
   */
  openOnHover?: boolean;
  /** How long the pointer must rest on the trigger before the panel opens. */
  hoverOpenDelay?: number;
  /** How long the pointer may be outside trigger and panel before it closes. */
  hoverCloseDelay?: number;
}

/** Default `searchable` match: the label or its gloss, case-insensitive. */
function matchesQuery(option: SelectOption, query: string): boolean {
  return (
    option.label.toLowerCase().includes(query) ||
    (option.note ?? "").toLowerCase().includes(query)
  );
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
  searchable = false,
  searchPlaceholder = "",
  filterOption,
  renderOption,
  emptyMessage,
  panelMinWidth = 0,
  variant = "field",
  openOnHover = false,
  hoverOpenDelay = DEFAULT_HOVER_OPEN_DELAY,
  hoverCloseDelay = DEFAULT_HOVER_CLOSE_DELAY,
}: SelectProps): React.JSX.Element {
  const uid = useId();
  const listboxId = `select-${uid}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  /** Filter text of `searchable` mode; cleared whenever the panel closes. */
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  /**
   * Whether the highlighted row should be scrolled into view.
   *
   * The highlight moves for two very different reasons: keyboard navigation
   * (where the row may be outside the panel's scrollport — it must be brought
   * in) and a pointer hovering a row (where it is already visible, and scrolling
   * would fight the pointer). Only the first sets this flag.
   */
  const scrollToActiveRef = useRef(false);
  /**
   * True while the panel is open *because the pointer rests on the trigger*
   * (`openOnHover`): it takes no focus and closes when the pointer leaves.
   */
  const [hoverOpen, setHoverOpen] = useState(false);
  /** Mirrors `hoverOpen` for the timers, which fire outside React's render. */
  const hoverOpenRef = useRef(false);
  /** Pending "open after the dwell" timer. */
  const hoverOpenTimerRef = useRef<number | null>(null);
  /** Pending "close after the grace" timer. */
  const hoverCloseTimerRef = useRef<number | null>(null);
  /**
   * Where the pointer currently is. Both are needed because the trigger and the
   * portaled panel are separate DOM trees: the close timer must not fire while
   * the pointer sits in either one, whatever order the enter/leave events
   * arrive in.
   */
  const triggerHoverRef = useRef(false);
  const panelHoverRef = useRef(false);
  /** Mirrors `query` for the close timer, which fires outside React's render. */
  const queryRef = useRef("");
  queryRef.current = query;
  const { panelStyle, positionPanel } = useDropdownPosition(
    rootRef,
    panelMinWidth,
  );

  // The options the panel actually shows: all of them unless a searchable panel
  // is being filtered. The highlight index always addresses this list.
  const visible = useMemo((): SelectOption[] => {
    if (!searchable) return options;
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return options;
    const matches = filterOption ?? matchesQuery;
    return options.filter((option) => matches(option, needle));
  }, [filterOption, options, query, searchable]);
  // Clamped highlight: filtering can shrink the list under the old index, and
  // an empty result must never address `visible[NaN]`.
  const active =
    visible.length === 0
      ? -1
      : Math.min(Math.max(activeIndex, 0), visible.length - 1);

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

  /** Drop both hover timers (open and close); safe to call at any time. */
  const clearHoverTimers = useCallback((): void => {
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const openPanel = useCallback(
    (
      /**
       * Why it opens. `"hover"` = the pointer rested on the trigger: the panel
       * then takes no focus and closes when the pointer leaves.
       */
      source: "hover" | "interaction" = "interaction",
    ): void => {
      if (disabled) return;
      clearHoverTimers();
      positionPanel();
      setOpen(true);
      setHoverOpen(source === "hover");
      hoverOpenRef.current = source === "hover";
      setQuery("");
      // Opening highlights an option (the value, or the first one): make sure it
      // is on screen even when it sits deep in a long list.
      scrollToActiveRef.current = true;
      setActiveIndex(
        // A searchable panel always starts at the top of an unfiltered list: the
        // caller's value is not what the boss is hunting for there.
        searchable
          ? 0
          : selectedIndex >= 0
            ? selectedIndex
            : fallbackIndex >= 0
              ? fallbackIndex
              : 0,
      );
    },
    [
      clearHoverTimers,
      disabled,
      fallbackIndex,
      positionPanel,
      searchable,
      selectedIndex,
    ],
  );

  const closePanel = useCallback((): void => {
    clearHoverTimers();
    setOpen(false);
    setHoverOpen(false);
    hoverOpenRef.current = false;
    // The panel is about to unmount: it will never send its own leave event, so
    // the zone must be reset here or a stale "pointer is in the panel" would
    // block the next close.
    panelHoverRef.current = false;
    setActiveIndex(-1);
    setQuery("");
    scrollToActiveRef.current = false;
  }, [clearHoverTimers]);

  /**
   * The pointer entered the trigger or the portaled panel.
   *
   * Both zones cancel the pending close (crossing the gap between them must not
   * dismiss the panel) and the trigger zone also schedules the open.
   */
  function enterHoverZone(
    zone: "trigger" | "panel",
    event?: React.PointerEvent,
  ): void {
    const onTrigger = zone === "trigger";
    if (onTrigger) {
      // A touch `pointerenter` fired by the very tap that is about to click must
      // not pre-open the panel (and must not mark the zone as hovered); keyboard
      // has no pointer events at all.
      if (event !== undefined && event.pointerType !== "mouse") return;
      triggerHoverRef.current = true;
    } else {
      panelHoverRef.current = true;
    }
    if (!openOnHover || disabled) return;
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (!onTrigger || open || hoverOpenTimerRef.current !== null) return;
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      // The pointer may have moved on during the dwell.
      if (!triggerHoverRef.current) return;
      openPanel("hover");
    }, hoverOpenDelay);
  }

  /**
   * Whether the pointer-opened panel is still being used.
   *
   * A hover-opened panel is transient, but not while the boss is working inside
   * it: the filter having the caret (he clicked into it and may be typing) or
   * holding text (he is narrowing the list) both make "the pointer left" a bad
   * reason to take it away. Focus leaving the panel with the pointer elsewhere
   * releases it again, so it can never get stuck on screen.
   */
  function panelInUse(): boolean {
    const panel = panelRef.current;
    if (panel !== null && panel.contains(document.activeElement)) return true;
    return queryRef.current.length > 0;
  }

  /** Close a pointer-opened panel unless it is still hovered or in use. */
  function releaseHoverPanel(): void {
    if (!open || !hoverOpenRef.current) return;
    if (triggerHoverRef.current || panelHoverRef.current) return;
    if (panelInUse()) return;
    closePanel();
  }

  /** The pointer left the trigger or the panel. */
  function leaveHoverZone(zone: "trigger" | "panel"): void {
    if (zone === "trigger") triggerHoverRef.current = false;
    else panelHoverRef.current = false;
    if (!openOnHover) return;
    // Leaving before the dwell elapsed cancels the open…
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    // …and only a pointer-opened panel is transient: a panel opened by click or
    // keyboard stays until something closes it, exactly as before.
    if (!hoverOpenRef.current || hoverCloseTimerRef.current !== null) return;
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      releaseHoverPanel();
    }, hoverCloseDelay);
  }

  // A control that turned disabled (a pick is in flight, the list reloaded) must
  // drop any pending hover work rather than open a panel for it later.
  useEffect(() => {
    if (!disabled) return;
    clearHoverTimers();
    triggerHoverRef.current = false;
    panelHoverRef.current = false;
  }, [clearHoverTimers, disabled]);

  // Never leave a timer behind on unmount.
  useEffect(() => clearHoverTimers, [clearHoverTimers]);

  const commit = useCallback(
    (index: number): void => {
      if (index < 0 || index >= visible.length) return;
      onChange(visible[index].value);
      closePanel();
    },
    [closePanel, onChange, visible],
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

  /**
   * Keep the highlighted option inside the panel's scrollport.
   *
   * Runs after the panel exists (the effect only fires once `panelStyle` has
   * positioned it, so the first frame measures a real scrollport) and after the
   * list has grown/shrunk (filtering), and it scrolls **only as far as needed**:
   * a row just below the fold comes up by exactly its overshoot, so the list
   * never jumps to a centred position. Assignment is instant on purpose — an
   * animated scroll would lag every key repeat.
   *
   * `scrollTo(..., { behavior: "auto" })` rather than a bare `scrollTop` write:
   * it also overrides a `scroll-behavior: smooth` inherited from the page.
   */
  useLayoutEffect(() => {
    if (!open || !scrollToActiveRef.current) return;
    const panel = panelRef.current;
    if (panel === null || active < 0) return;
    const row = panel.querySelector<HTMLElement>(
      `[data-select-option="${active}"]`,
    );
    if (row === null) return;
    const panelRect = panel.getBoundingClientRect();
    // The search row is sticky over the list, so the usable top edge starts
    // below it; the bottom edge is the panel's own.
    const sticky = panel.querySelector<HTMLElement>(".imb-ms-search");
    const top = panelRect.top + (sticky?.offsetHeight ?? 0);
    const bottom = panelRect.bottom;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top >= top && rowRect.bottom <= bottom) return;
    const delta =
      rowRect.top < top ? rowRect.top - top : rowRect.bottom - bottom;
    panel.scrollTo({ top: panel.scrollTop + delta, behavior: "auto" });
  }, [active, open, panelStyle, query, visible]);

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
        scrollToActiveRef.current = true;
        if (visible.length > 0) {
          setActiveIndex((active + 1) % visible.length);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        scrollToActiveRef.current = true;
        if (visible.length > 0) {
          setActiveIndex((active - 1 + visible.length) % visible.length);
        }
        break;
      case "Home":
        event.preventDefault();
        scrollToActiveRef.current = true;
        if (visible.length > 0) setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        scrollToActiveRef.current = true;
        if (visible.length > 0) setActiveIndex(visible.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(active);
        break;
      case "Tab":
        closePanel();
        break;
      default: {
        // A searchable panel owns its own input; type-ahead would fight it.
        if (
          !searchable &&
          event.key.length === 1 &&
          /[A-Za-z0-9]/.test(event.key)
        ) {
          bufferRef.current += event.key.toLowerCase();
          if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
          bufferTimerRef.current = setTimeout(() => {
            bufferRef.current = "";
          }, 500);
          const match = options.findIndex((o) =>
            o.label.toLowerCase().startsWith(bufferRef.current),
          );
          if (match >= 0) {
            scrollToActiveRef.current = true;
            setActiveIndex(match);
          }
        }
      }
    }
  }

  function optionId(index: number): string {
    return `${listboxId}-opt-${index}`;
  }

  return (
    <div
      className={cls("imb-select-wrap", invalid && "imb-has-error")}
      ref={rootRef}
      // The hover zone is the trigger; the panel is portaled elsewhere and
      // carries the other half of the zone (see `enterHoverZone`).
      onPointerEnter={
        openOnHover ? (event) => enterHoverZone("trigger", event) : undefined
      }
      onPointerLeave={openOnHover ? () => leaveHoverZone("trigger") : undefined}
    >
      <button
        type="button"
        className={cls(
          "imb-select",
          variant === "ghost" && "imb-select-ghost",
          variant === "icon" && "imb-select-icon",
        )}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && active >= 0 ? optionId(active) : undefined
        }
        aria-invalid={invalid || undefined}
        aria-label={label}
        disabled={disabled}
        // A hover-opened panel is not a click target yet: clicking the trigger
        // then means "I want to use this now", so it turns into an ordinary
        // (focused, staying) panel instead of closing under the pointer.
        data-hover-open={hoverOpen || undefined}
        onClick={() => {
          if (!open) {
            openPanel();
            return;
          }
          if (hoverOpen) {
            openPanel();
            // The panel is already mounted, so `autoFocus` cannot help: focus
            // its filter explicitly, as a click-opened panel always did.
            searchRef.current?.focus();
            return;
          }
          closePanel();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {variant === "icon" ? null : (
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
        )}
        <IconChevronDown
          className={cls(
            "imb-icon",
            "imb-sm",
            "imb-select-caret",
            // A ghost trigger opens upward, so its caret points up — always,
            // in both states: it describes where the panel appears, and flipping
            // it upside-down while open would contradict that.
            variant === "ghost" || variant === "icon"
              ? "imb-is-up"
              : open && "imb-is-open",
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
            // The other half of the hover zone: entering the panel cancels the
            // pending close, so the pointer can cross the gap above/below it.
            onPointerEnter={
              openOnHover ? () => enterHoverZone("panel") : undefined
            }
            onPointerLeave={
              openOnHover ? () => leaveHoverZone("panel") : undefined
            }
            // Focus leaving the panel releases a pointer-opened panel (once the
            // pointer is elsewhere too), so it can never be left unclosable.
            onBlur={
              openOnHover
                ? (event) => {
                    const next = event.relatedTarget as Node | null;
                    if (next !== null && panelRef.current?.contains(next)) {
                      return;
                    }
                    releaseHoverPanel();
                  }
                : undefined
            }
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
            {searchable && (
              // A filter row inside the panel: the same search recipe the
              // multi-select panel uses, so every searchable dropdown looks
              // and behaves the same. The input owns the keyboard while open.
              <li className="imb-ms-search" role="presentation">
                <IconSearch className="imb-icon imb-sm" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder || label || undefined}
                  // A hover-opened panel must not take focus: the boss may be
                  // typing in the composer underneath. Click and keyboard still
                  // land in the filter, exactly as before.
                  autoFocus={!hoverOpen}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      scrollToActiveRef.current = true;
                      if (visible.length > 0) {
                        setActiveIndex((active + 1) % visible.length);
                      }
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      scrollToActiveRef.current = true;
                      if (visible.length > 0) {
                        setActiveIndex(
                          (active - 1 + visible.length) % visible.length,
                        );
                      }
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      commit(active);
                    } else if (event.key === "Tab") {
                      closePanel();
                    }
                  }}
                />
              </li>
            )}
            {visible.length === 0 && (
              <li className="imb-select-empty" role="presentation">
                {emptyMessage ?? "—"}
              </li>
            )}
            {visible.map((option, index) => (
              <li
                key={option.value}
                id={optionId(index)}
                data-select-option={index}
                role="option"
                aria-selected={option.value === value}
                className={cls(
                  "imb-select-option imb-menu-row",
                  index === active && "imb-is-active",
                  option.value === value && "imb-is-selected",
                )}
                onMouseEnter={() => {
                  scrollToActiveRef.current = false;
                  setActiveIndex(index);
                }}
                onClick={() => commit(index)}
              >
                {renderOption !== undefined ? (
                  <span className="imb-select-option-label imb-is-custom">
                    {renderOption(option)}
                  </span>
                ) : (
                  <span
                    className={cls(
                      "imb-select-option-label",
                      option.note && "imb-has-note",
                    )}
                  >
                    {option.note ? (
                      <>
                        <span className="imb-select-value-main">
                          {option.label}
                        </span>
                        <span className="imb-select-note">{option.note}</span>
                      </>
                    ) : (
                      option.label
                    )}
                  </span>
                )}
                {option.value === value && (
                  <span className="imb-select-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
