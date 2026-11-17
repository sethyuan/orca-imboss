import { t } from "@shared/l10n";
import type { WorkRoom } from "@shared/types";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { appStore, useApp } from "../../../../app-store";
import { Markdown } from "../../../markdown";
import { useMentionResolver } from "../../../markdown/use-mention";
import { Tooltip } from "../../../tooltip";
import { FocusScreen } from "../focus-screen";
import { RoomBoard } from "../room-board";
import {
  createWorkStatusStage,
  isWebglAvailable,
  type WorkStatusStage,
} from "../scene/stage";
import { useWorkRooms } from "../use-work-rooms";
import "./index.css";

/**
 * Work status: every in-progress task group as a 3D room, with a bird's-eye grid
 * and a focus mode per room.
 *
 * Two things about *how* it is mounted matter here:
 *
 * - It is **not unmounted when another module is opened** (`WorkStatusHost` in
 *   `App.tsx` keeps it mounted for the whole session and only hides it). Clicking
 *   an employee or a screen leaves the module to open an agent session / a chat;
 *   coming back must show the board exactly as it was left — same focused room,
 *   same camera. Keeping the component mounted is the whole trick: nothing has to
 *   be serialized, and the cost is one idle WebGL context.
 * - The render loop is still stopped while the module is hidden (`setActive`), so
 *   being kept alive never means rendering off screen.
 *
 * The scene owns positions, this component owns content: bubbles, plates and the
 * focused room's screen are React trees portalled into hosts the scene keeps
 * positioned. That is what lets a bubble be the app's own Markdown renderer (with
 * `@id` mentions resolved to names) and a plate be a real `Tooltip`.
 */

/** One-line plate copy: the group's title plus its progress summary. */
function plateLabel(room: WorkRoom): string {
  const done =
    room.progress?.steps.filter((step) => step.status === "done").length ?? 0;
  const total = room.progress?.steps.length ?? 0;
  const summary =
    total === 0
      ? t("No progress yet")
      : t("${done}/${total} done")
          .replace("${done}", String(done))
          .replace("${total}", String(total));
  return `${room.title} · ${summary}`;
}

/**
 * One bubble the scene is currently showing.
 *
 * Both the *kind* and the *text* come from the scene's state machine: it is the
 * only place that knows whether a message is news (the snapshot always carries
 * the room's latest notify message, including history it must not replay).
 */
interface BubbleRef {
  chatId: number;
  employeeId: number;
  kind: "working" | "message";
  content: string;
}

function bubbleParts(
  key: string,
): { chatId: number; employeeId: number } | null {
  const [chat, employee] = key.split(":");
  const chatId = Number(chat);
  const employeeId = Number(employee);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(employeeId)) {
    return null;
  }
  return { chatId, employeeId };
}

export function WorkStatusModule(): React.JSX.Element {
  const { module, theme } = useApp();
  const active = module === "work-status";
  const { rooms, truncated, loading, error, loaded, reload } =
    useWorkRooms(active);

  // Decided once per session: without a usable WebGL context the module shows the
  // 2D board instead (a lost context can only be lost, never gained).
  const [mode, setMode] = useState<"3d" | "2d">(() =>
    isWebglAvailable() ? "3d" : "2d",
  );

  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const stageRef = useRef<WorkStatusStage | null>(null);
  const [screenTarget, setScreenTarget] = useState<HTMLElement | null>(null);
  const [plateTargets, setPlateTargets] = useState<
    ReadonlyMap<number, HTMLElement>
  >(new Map());
  /** Bubble hosts, and what each one must show (both come from the scene). */
  const [bubbles, setBubbles] = useState<
    ReadonlyMap<string, { element: HTMLElement; ref: BubbleRef }>
  >(new Map());
  const [focusedChatId, setFocusedChatId] = useState<number | null>(null);
  /** The bubble the boss clicked open (nearly full-window reading view). */
  const [expanded, setExpanded] = useState<BubbleRef | null>(null);

  // The 3D shell has no CSS tokens, so the scene needs the effective mode
  // itself: explicit dark, or "system" resolved through the media query.
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const dark = theme.mode === "dark" || (theme.mode === "system" && systemDark);

  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const activeRef = useRef(active);
  activeRef.current = active;
  const focusedChatIdRef = useRef<number | null>(null);
  focusedChatIdRef.current = focusedChatId;

  useEffect(() => {
    if (mode !== "3d" || host === null) return;
    const stage = createWorkStatusStage(host, {
      onFocusChange: setFocusedChatId,
      onScreenTarget: setScreenTarget,
      onPlateTarget: (chatId, element) => {
        // Only fires when a plate host is created or removed, not per frame.
        setPlateTargets((previous) => {
          const next = new Map(previous);
          if (element === null) next.delete(chatId);
          else next.set(chatId, element);
          return next;
        });
      },
      onBubbleTarget: (key, element, content) => {
        const parts = bubbleParts(key);
        setBubbles((previous) => {
          const next = new Map(previous);
          if (element === null || content === null || parts === null) {
            next.delete(key);
          } else {
            next.set(key, {
              element,
              ref: { ...parts, kind: content.kind, content: content.content },
            });
          }
          return next;
        });
      },
      openRoom: (chatId) => {
        void appStore.openChatById(chatId);
      },
      openSession: (chatId, employeeId) => {
        void appStore.openAgentSession(employeeId, chatId);
      },
      // The GPU context died (a driver reset, a sleeping laptop): keep the data
      // view by switching to the 2D board for the rest of the session.
      onContextLost: () => setMode("2d"),
    });
    stageRef.current = stage;
    stage.setRooms({ rooms: roomsRef.current, truncated: false });
    stage.setTheme(darkRef.current);
    stage.setActive(activeRef.current);
    // A rebuilt stage (the board went empty and came back) starts in bird's-eye;
    // re-apply the focus the module already had, so the view the boss left is
    // still the view they return to.
    if (focusedChatIdRef.current !== null) {
      stage.focusRoom(focusedChatIdRef.current);
    }
    return () => {
      stageRef.current = null;
      stage.dispose();
      setScreenTarget(null);
      setPlateTargets(new Map());
      setBubbles(new Map());
      setFocusedChatId(null);
      setExpanded(null);
    };
  }, [host, mode]);

  useEffect(() => {
    stageRef.current?.setRooms({ rooms, truncated });
  }, [rooms, truncated]);

  useEffect(() => {
    stageRef.current?.setActive(active);
  }, [active, host]);

  useEffect(() => {
    stageRef.current?.setTheme(dark);
  }, [dark, host]);

  // The focused room is re-derived from the freshest snapshot on every refresh,
  // so a card that just changed shows its new steps on the wall.
  const focusedRoom =
    focusedChatId === null
      ? null
      : (rooms.find((room) => room.chatId === focusedChatId) ?? null);
  useEffect(() => {
    if (focusedChatId !== null && focusedRoom === null) {
      stageRef.current?.exitFocus();
    }
  }, [focusedChatId, focusedRoom]);

  /**
   * `Esc` closes the topmost layer: the reading view if it is open (that panel
   * handles it), otherwise the focused room — the same action as right-click and
   * the header's back button, never a new meaning. It stays out of the way of any
   * input or dialog that owns `Esc` itself.
   */
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || expanded !== null) return;
      if (focusedChatIdRef.current === null) return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
        ) !== null
      ) {
        return;
      }
      event.preventDefault();
      stageRef.current?.exitFocus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, expanded]);

  const showStage = mode === "3d" && rooms.length > 0;
  const showBoard = mode === "2d" && rooms.length > 0;

  return (
    <div
      className="imb-ws-module"
      data-module="work-status"
      data-ws-mode={mode}
      data-active={active ? "true" : "false"}
    >
      <header className="imb-ws-head">
        {focusedRoom !== null ? (
          // Focused: the group's own title takes the header's place (same slot,
          // same typography, same truncation), with the full title on hover.
          <Tooltip content={focusedRoom.title} placement="bottom">
            <h1 className="imb-ws-title imb-ws-title-room">
              {focusedRoom.title}
            </h1>
          </Tooltip>
        ) : (
          <>
            <h1 className="imb-ws-title">{t("Work status")}</h1>
            <span className="imb-ws-count">
              {rooms.length === 1
                ? t("1 task group")
                : t("${count} task groups").replace(
                    "${count}",
                    String(rooms.length),
                  )}
              {truncated ? ` · ${t("most recent only")}` : ""}
            </span>
          </>
        )}
        <span className="imb-ws-spacer" />
        {focusedChatId !== null && (
          <button
            type="button"
            className="imb-btn-sm"
            onClick={() => stageRef.current?.exitFocus()}
          >
            {t("Back to all rooms")}
          </button>
        )}
        <button type="button" className="imb-btn-sm" onClick={reload}>
          {t("Refresh")}
        </button>
      </header>

      {error !== null && (
        <p className="imb-ws-error" role="alert">
          {t("Could not read the work status: ${message}").replace(
            "${message}",
            error,
          )}
        </p>
      )}

      <div className="imb-ws-body">
        {loaded && rooms.length === 0 && !loading ? (
          <div className="imb-ws-empty">
            <p>
              {t(
                "No task group is in progress right now — a room appears while someone is working in it.",
              )}
            </p>
          </div>
        ) : null}

        {showStage ? (
          <div
            className="imb-ws-canvas-host"
            ref={setHost}
            role="application"
            aria-label={t("Task group rooms")}
          />
        ) : null}

        {/* The 3D scene is pixels: screen readers (and tests without a GPU) get
            the same board as text, always. */}
        <ul className="imb-ws-sr">
          {rooms.map((room) => (
            <li key={room.chatId}>
              {room.title} —{" "}
              {room.progress === null
                ? t("No progress yet")
                : `${room.progress.title}: ${
                    room.progress.steps.filter((step) => step.status === "done")
                      .length
                  }/${room.progress.steps.length} ${t("Done")}`}
              {rooms.length > 0
                ? `; ${t("${count} working").replace(
                    "${count}",
                    String(room.members.filter((m) => m.running).length),
                  )}`
                : ""}
            </li>
          ))}
        </ul>

        {/* Name plates: positioned by the scene (a 3D anchor), rendered here so
            each one is a real `Tooltip` trigger carrying the full title. */}
        {[...plateTargets].map(([chatId, element]) => {
          const room = rooms.find((item) => item.chatId === chatId);
          if (room === undefined) return null;
          return createPortal(
            <Tooltip content={room.title} placement="top">
              <span
                className="imb-ws-roomlabel"
                data-dense={plateTargets.size > 8 ? "1" : "0"}
              >
                {plateLabel(room)}
              </span>
            </Tooltip>,
            element,
            chatId,
          );
        })}

        {/* Bubbles: same hosts pattern, but the body is the app's Markdown
            renderer with `@id` mentions resolved — identical to a thread bubble. */}
        {[...bubbles].map(([key, { element, ref }]) =>
          createPortal(
            <BubbleView
              key={key}
              bubbleRef={ref}
              dense={bubbles.size > 8}
              // Reading a message is a focused-room action: from the grid a bubble
              // is a glance, and clicking one must not interrupt "click = focus".
              interactive={ref.chatId === focusedChatId}
              onExpand={setExpanded}
            />,
            element,
            key,
          ),
        )}

        {showBoard ? <RoomBoard rooms={rooms} /> : null}
        {!showStage && !showBoard && loading ? (
          <div className="imb-ws-empty">{t("Loading…")}</div>
        ) : null}
      </div>

      {/* The focused room's wall screen is positioned by the 3D stage (CSS3D), so
          the card is portalled into the element it keeps in the scene. */}
      {screenTarget !== null && focusedRoom !== null
        ? createPortal(<FocusScreen room={focusedRoom} />, screenTarget)
        : null}

      {expanded !== null ? (
        <ExpandedBubble
          chatId={expanded.chatId}
          employeeId={expanded.employeeId}
          content={expanded.content}
          messageId={
            rooms
              .find((room) => room.chatId === expanded.chatId)
              ?.bubbles.find((b) => b.employeeId === expanded.employeeId)
              ?.messageId ?? null
          }
          roomTitle={
            rooms.find((room) => room.chatId === expanded.chatId)?.title ?? ""
          }
          onClose={() => setExpanded(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * One bubble on an employee's head.
 *
 * The body is the app's Markdown renderer: a bubble shows the message the
 * employee posted when it woke someone, and that text is authored as Markdown
 * with `@<id>` mentions — exactly what a thread bubble shows. Clicking it opens
 * the reading view; the "working…" bubble is not a message, so it is inert.
 */
function BubbleView({
  bubbleRef,
  dense,
  interactive,
  onExpand,
}: {
  bubbleRef: BubbleRef;
  dense: boolean;
  /** Focused room: clickable, full size. Grid: a glance, smaller, inert. */
  interactive: boolean;
  onExpand: (ref: BubbleRef) => void;
}): React.JSX.Element {
  const { resolveMention } = useMentionResolver(bubbleRef.chatId, false);
  const size = {
    "data-dense": dense ? "1" : "0",
    "data-focus": interactive ? "1" : "0",
  } as const;

  if (bubbleRef.kind === "working") {
    return (
      <div className="imb-ws-bubble" data-kind="working" {...size}>
        <span className="imb-ws-bubble-working">{t("Working…")}</span>
        <span className="imb-ws-bubble-tail" aria-hidden="true" />
      </div>
    );
  }

  const body = (
    <div className="imb-ws-bubble-body">
      <Markdown
        content={bubbleRef.content}
        inline
        resolveMention={resolveMention}
      />
    </div>
  );

  if (!interactive) {
    return (
      <div
        className="imb-ws-bubble imb-ws-bubble-message"
        data-kind="message"
        {...size}
      >
        {body}
        <span className="imb-ws-bubble-tail" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className="imb-ws-bubble imb-ws-bubble-message"
      data-kind="message"
      {...size}
      role="button"
      tabIndex={0}
      aria-label={t("Read the message")}
      onClick={() => onExpand(bubbleRef)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onExpand(bubbleRef);
      }}
    >
      {body}
      <span className="imb-ws-bubble-tail" aria-hidden="true" />
    </div>
  );
}

/**
 * The reading view: one message, nearly full window, scrolling inside instead of
 * stretching it.
 *
 * It is an overlay *inside* the module, not a change of camera or module: the
 * room keeps its focus and the camera keeps its pose, so closing the bubble puts
 * the boss back exactly where they were.
 */
function ExpandedBubble({
  chatId,
  content: preview,
  messageId,
  roomTitle,
  onClose,
}: {
  chatId: number;
  employeeId: number;
  content: string;
  messageId: number | null;
  roomTitle: string;
  onClose: () => void;
}): React.JSX.Element {
  const { resolveMention } = useMentionResolver(chatId, false);
  const [content, setContent] = useState<string>(preview);
  const [loading, setLoading] = useState(messageId !== null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The snapshot clamps a bubble to a preview length; the reading view needs the
  // whole message. One read of that chat's messages when it opens (the app's
  // existing channel — no new API), then keep it.
  useEffect(() => {
    if (messageId === null) return;
    let alive = true;
    void imb.messages
      .list(chatId)
      .then((messages) => {
        if (!alive) return;
        const found = messages.find((message) => message.id === messageId);
        if (found !== undefined) setContent(found.content);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [chatId, messageId]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="imb-ws-bubble-overlay"
      // A click anywhere outside the panel closes it (the panel stops propagation).
      onClick={onClose}
    >
      <div
        className="imb-ws-bubble-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Read the message")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="imb-ws-bubble-panel-head">
          <span className="imb-ws-bubble-panel-title">
            {roomTitle.length > 0 ? roomTitle : t("Message")}
          </span>
          <button
            type="button"
            className="imb-btn-sm"
            onClick={onClose}
            aria-label={t("Close")}
          >
            {t("Close")}
          </button>
        </header>
        <div
          className="imb-ws-bubble-panel-body"
          aria-busy={loading ? "true" : "false"}
        >
          <Markdown content={content} resolveMention={resolveMention} />
        </div>
      </div>
    </div>
  );
}
