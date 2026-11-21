import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { t } from "@shared/l10n";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cls } from "reactutils";
import { useClickOutside } from "../../hooks/use-click-outside";
import { useEscapeKey } from "../../hooks/use-escape-key";
import { IconApp } from "../icons";
import { Tooltip } from "../tooltip";
import {
  computeAnchoredPosition,
  DEFAULT_OFFSET,
  type AnchoredPosition,
} from "../tooltip/position";

/** Read-only shape of a registered mini app (valtio snapshots are readonly). */
export interface NavMiniApp {
  readonly id: string;
  readonly name: string;
  readonly iconUrl: string | null;
}

/** Mini apps that still fit in the rail as rows; one more and they collapse. */
export const MINI_APP_INLINE_MAX = 3;

/** Pointer dwell before a hovered group tile reveals the grid. */
const HOVER_OPEN_DELAY_MS = 180;

/** Grace period for crossing the gap between the tile and the portaled grid. */
const HOVER_CLOSE_DELAY_MS = 160;

/** Cap on columns: beyond this the grid grows by rows (and scrolls inside). */
const MAX_COLUMNS = 5;

/**
 * Columns for the flyout: the fewest that still read square.
 *
 * `ceil(sqrt(n))` and "minimize |columns − rows|" tie on many counts (5 → 3×2 and
 * 2×3 both use 6 cells); ties go to the wider shape because the window height,
 * not its width, is what constrains a rail flyout.
 */
function gridColumns(count: number): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(count))));
}

type GroupState = "closed" | "hover" | "pinned";

export interface MiniAppGridProps {
  apps: readonly NavMiniApp[];
  /** The mini-app module is the one on screen. */
  moduleActive: boolean;
  /** Which mini app is on screen, if any. */
  activeId: string | null;
  onOpen: (id: string) => void;
  /** Persist a reordered id list (the rail's own sortable lists do the same). */
  onReorder: (ids: string[]) => void;
}

/**
 * The rail's mini-app group once it has outgrown the rail: one tile standing for
 * every mini app, plus a floating grid of all of them.
 *
 * Three states, not two, because "open" means different things:
 *
 * - `hover` — the pointer rested on the tile. Transient: it takes no focus (the
 *   rail can be passed over while typing elsewhere) and closes when the pointer
 *   leaves the tile *and* the grid.
 * - `pinned` — clicked, or opened from the keyboard. It stays until Escape, a
 *   click outside, picking an app, or clicking the tile again, and it is the only
 *   state where the cells can be dragged into a new order.
 * - `closed`.
 *
 * Every close records whether the pointer still rests on the tile: without that,
 * dismissing a hover-opened grid with Escape would pop it right back 180ms later.
 */
export function MiniAppGrid({
  apps,
  moduleActive,
  activeId,
  onOpen,
  onReorder,
}: MiniAppGridProps): React.JSX.Element {
  const panelId = `imb-nav-appgrid-${useId()}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<GroupState>("closed");
  const [pos, setPos] = useState<AnchoredPosition | null>(null);
  /** A cell is being dragged: the names must not pop up over the drag. */
  const [dragging, setDragging] = useState(false);
  /** Mirrors `state` for the timers, which fire outside React's render. */
  const stateRef = useRef<GroupState>("closed");
  stateRef.current = state;
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  /**
   * Which of the two zones the pointer is in. Both are tracked because the tile
   * and the portaled grid are separate DOM trees: the close timer must not fire
   * while the pointer sits in either, whatever order the events arrive in.
   */
  const triggerHoverRef = useRef(false);
  const panelHoverRef = useRef(false);
  /** Set when a grid was dismissed while the pointer still rests on the tile. */
  const suppressHoverRef = useRef(false);
  /** The grid was opened from the keyboard: it owes the first cell the focus. */
  const focusPendingRef = useRef(false);

  const cols = gridColumns(apps.length);
  const appIds = apps.map((app) => app.id);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const clearTimers = useCallback((): void => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const open = useCallback(
    (next: Exclude<GroupState, "closed">, focusFirstCell = false): void => {
      clearTimers();
      focusPendingRef.current = focusFirstCell;
      setState(next);
    },
    [clearTimers],
  );

  const close = useCallback(
    (returnFocus = false): void => {
      clearTimers();
      // Only a pointer that stays on the tile needs suppressing; a dismissal
      // from inside the grid has nothing to re-open.
      suppressHoverRef.current = triggerRef.current?.matches(":hover") ?? false;
      setState("closed");
      if (returnFocus) triggerRef.current?.focus();
    },
    [clearTimers],
  );

  /** Close a hover-opened grid unless the pointer is back in either zone. */
  const scheduleClose = useCallback((): void => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    // A pinned grid is not transient: leaving it is not a reason to take it away.
    if (stateRef.current !== "hover") return;
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (stateRef.current !== "hover") return;
      if (triggerHoverRef.current || panelHoverRef.current) return;
      close();
    }, HOVER_CLOSE_DELAY_MS);
  }, [close]);

  function enterTrigger(event: React.PointerEvent<HTMLButtonElement>): void {
    // A touch `pointerenter` fired by the very tap that is about to click must
    // not pre-open the grid; keyboard has no pointer events at all.
    if (event.pointerType !== "mouse") return;
    triggerHoverRef.current = true;
    if (suppressHoverRef.current) return;
    if (stateRef.current !== "closed") return;
    if (openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      // The pointer may have moved on during the dwell.
      if (!triggerHoverRef.current) return;
      open("hover");
    }, HOVER_OPEN_DELAY_MS);
  }

  function leaveTrigger(): void {
    triggerHoverRef.current = false;
    suppressHoverRef.current = false;
    scheduleClose();
  }

  function enterPanel(): void {
    panelHoverRef.current = true;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function leavePanel(): void {
    panelHoverRef.current = false;
    scheduleClose();
  }

  function handleTriggerClick(): void {
    if (stateRef.current === "pinned") close();
    else open("pinned");
  }

  function handleTriggerKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown")
      return;
    // The native button would also fire a click for Enter/Space, toggling twice.
    event.preventDefault();
    open("pinned", true);
  }

  const panelCells = (): HTMLButtonElement[] =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        ".imb-nav-appcell",
      ) ?? [],
    );

  function handlePanelKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void {
    if (event.key === "Tab") {
      // The grid lives at the end of `<body>`, so letting Tab run would drop the
      // caret off the end of the document: leave the grid and go back to the tile.
      event.preventDefault();
      close(true);
      return;
    }
    const cells = panelCells();
    const index = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const last = cells.length - 1;
    let next = index;
    switch (event.key) {
      case "ArrowRight":
        next = index + 1;
        break;
      case "ArrowLeft":
        next = index - 1;
        break;
      case "ArrowDown":
        next = index + cols;
        break;
      case "ArrowUp":
        next = index - cols;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    cells[Math.min(Math.max(next, 0), last)]?.focus();
  }

  function openApp(id: string): void {
    onOpen(id);
    close();
  }

  function handleDragEnd(event: DragEndEvent): void {
    setDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = appIds.indexOf(String(active.id));
    const to = appIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(appIds, from, to));
  }

  const reposition = useCallback((): void => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    // `align: "start"` pins the grid's top edge to the tile's, so a change in row
    // count only ever extends it downwards instead of re-centering it.
    setPos(
      computeAnchoredPosition(
        "right",
        trigger.getBoundingClientRect(),
        panel.getBoundingClientRect(),
        DEFAULT_OFFSET,
        "start",
      ),
    );
  }, []);

  // Position before paint so the grid never flashes at the origin, and hand the
  // focus over here (the cells only exist after the render that opened it).
  useLayoutEffect(() => {
    if (state === "closed") {
      setPos(null);
      return;
    }
    reposition();
    if (!focusPendingRef.current) return;
    focusPendingRef.current = false;
    panelCells()[0]?.focus();
  }, [state, apps.length, reposition]);

  // Keep the grid glued to its tile while the rail scrolls or the window resizes.
  useEffect(() => {
    if (state === "closed") return;
    const onViewportChange = (): void => reposition();
    window.addEventListener("resize", onViewportChange);
    document.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("scroll", onViewportChange, true);
    };
  }, [state, reposition]);

  useClickOutside(
    [triggerRef, panelRef],
    useCallback((): void => close(), [close]),
    state !== "closed",
  );

  // Escape while the caret is inside the grid: give it back to the tile, which is
  // where the keyboard user came from.
  useEscapeKey(
    useCallback((): void => {
      close(panelRef.current?.contains(document.activeElement) === true);
    }, [close]),
    state !== "closed",
  );

  // Never leave a timer behind on unmount.
  useEffect(() => clearTimers, [clearTimers]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cls(
          "imb-nav-item",
          moduleActive && "imb-is-active",
          state !== "closed" && "imb-is-open",
        )}
        aria-label={t("Mini apps")}
        aria-expanded={state !== "closed"}
        aria-controls={panelId}
        aria-current={moduleActive ? "page" : undefined}
        onPointerEnter={enterTrigger}
        onPointerLeave={leaveTrigger}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <IconApp className="imb-icon" />
      </button>
      {state !== "closed" &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            className={cls(
              "imb-nav-appgrid imb-menu-surface",
              pos !== null && "imb-nav-appgrid-open",
              state === "pinned" && "imb-is-sortable",
            )}
            role="group"
            aria-label={t("Mini apps")}
            style={{ top: pos?.top, left: pos?.left }}
            onPointerEnter={enterPanel}
            onPointerLeave={leavePanel}
            onKeyDown={handlePanelKeyDown}
          >
            <div className="imb-nav-appgrid-scroll">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={() => setDragging(true)}
                onDragCancel={() => setDragging(false)}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={appIds} strategy={rectSortingStrategy}>
                  <div
                    className="imb-nav-appgrid-cells"
                    style={{
                      gridTemplateColumns: `repeat(${cols}, var(--imb-nav-appcell))`,
                    }}
                  >
                    {apps.map((app) => (
                      <MiniAppGridCell
                        key={app.id}
                        app={app}
                        active={moduleActive && app.id === activeId}
                        draggable={state === "pinned"}
                        tooltipDisabled={dragging}
                        onOpen={openApp}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

type MiniAppGridCellProps = {
  app: NavMiniApp;
  active: boolean;
  /** Hover-opened grids are transient: dragging is only wired once pinned. */
  draggable: boolean;
  tooltipDisabled: boolean;
  onOpen: (id: string) => void;
};

/**
 * One app in the grid: the icon alone, with its name behind a tooltip.
 *
 * Icon-only is the point of a launch grid — 5 columns of text would force the
 * panel to be as wide as the rail is tall — and the name is still the button's
 * accessible name, so it survives for screen readers and for the e2e locators.
 */
function MiniAppGridCell({
  app,
  active,
  draggable,
  tooltipDisabled,
  onOpen,
}: MiniAppGridCellProps): React.JSX.Element {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: app.id, disabled: !draggable });

  return (
    <Tooltip content={app.name} placement="top" disabled={tooltipDisabled}>
      <button
        ref={setNodeRef}
        type="button"
        className={cls(
          "imb-nav-appcell",
          active && "imb-is-active",
          isDragging && "imb-is-dragging",
        )}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        aria-current={active ? "page" : undefined}
        aria-label={app.name}
        onClick={() => onOpen(app.id)}
        {...(listeners ?? {})}
      >
        {app.iconUrl !== null ? (
          <img
            className="imb-nav-appcell-icon"
            src={app.iconUrl}
            alt=""
            draggable={false}
          />
        ) : (
          <IconApp className="imb-nav-appcell-icon" />
        )}
      </button>
    </Tooltip>
  );
}
