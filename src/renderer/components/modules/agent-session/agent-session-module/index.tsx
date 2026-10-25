import { t } from "@shared/l10n";
import type {
  AgentSessionLiveBlock,
  AgentSessionSendResult,
  AgentSessionSteerState,
  AgentSessionViewEntry,
  AgentStreamEvent,
  AgentStreamPayload,
} from "@shared/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { cls } from "reactutils";
import { appStore, sessionKey, useApp } from "../../../../app-store";
import { ModuleView } from "../../../app-shell";
import { EmployeeAvatar } from "../../../employee-avatar";
import { HaltButton } from "../../../halt-button";
import { IconButton } from "../../../icon-button";
import { IconChevronDown, IconChevronUp, IconHalt } from "../../../icons";
import { Markdown } from "../../../markdown";
import { useMentionResolver } from "../../../markdown/use-mention";
import { Tooltip } from "../../../tooltip";
import "../../chat/thread.css";
import {
  addSentRow,
  applySteerStateRow,
  markRowBusy,
  reconcilePending,
  removeRow,
  settleWithdrawFailure,
  type PendingFeedback,
  type PendingSend,
} from "./pending-sends";
import { SessionComposer } from "../session-composer";
import "./index.css";

export interface AgentSessionModuleProps {
  employeeId: number;
  chatId: number;
}

/** One reconstructed block of the currently streaming assistant message. */
interface LiveBlock {
  /** Stable React key within the live message. */
  key: string;
  kind: "text" | "thinking" | "tool";
  text: string;
  toolCallId?: string;
  name?: string;
  argsSummary?: string;
  argsDetail?: string;
  status?: "running" | "ok" | "error";
  /** Thinking block finished streaming (auto-folded). */
  done?: boolean;
}

interface LiveState {
  seq: number;
  finalized: boolean;
  blocks: Array<LiveBlock | undefined>;
}

/**
 * Delay (ms) before re-reading the persisted session after a change event.
 */
const REFRESH_DELAY = 150;
/** Distance from the bottom (px) still considered "pinned" for auto-scroll. */
const PIN_THRESHOLD = 32;
/** Gap (px) kept between the viewport top and a divider a jump lands on. */
const JUMP_TOP_GAP = 16;
/** Scroll-offset tolerance (px) used to decide which divider is "nearest". */
const JUMP_EPSILON = 1;
/** Clamp a content-space scroll offset to the thread's reachable range. */
function clampScrollTop(top: number, maxScroll: number): number {
  return Math.min(Math.max(top, 0), maxScroll);
}

interface SessionScroll {
  scrollTop: number;
  pinned: boolean;
}
const sessionScrollStore = new Map<string, SessionScroll>();

/** Measured jump anchors (one per rendered wake divider). */
interface JumpAnchors {
  /** `scrollHeight` the measurement belongs to; the cache key. */
  scrollHeight: number;
  /** `scrollTop` values that put each divider at the top anchor line. */
  tops: number[];
}

/** Which jump buttons can do something at the current scroll position. */
interface JumpAvailability {
  prev: boolean;
  next: boolean;
}
const NO_JUMPS: JumpAvailability = { prev: false, next: false };

/**
 * Wording of a row's one-shot report (see `PendingFeedback`).
 *
 * Withdrawal is a normal outcome, not an error: Pi may already have injected the
 * text, or the queue may no longer hold it. The row says which, and then removes
 * itself (`FEEDBACK_MS`) — the one thing that must never happen is the boss
 * believing a message was taken back when the model has already read it.
 */
function pendingFeedbackLabel(feedback: PendingFeedback): string {
  switch (feedback) {
    case "delivered":
      return t("Delivered — cannot withdraw");
    case "gone":
      return t("No longer pending — cannot withdraw");
    case "lost":
      // Not a withdrawal: the run ended / was interrupted / the session was torn
      // down while the text was still queued, so it may never arrive.
      return t("Not confirmed — the agent may not have received this");
    default:
      return t("Withdrawal status unknown");
  }
}

/** How long a one-shot feedback line stays before the row removes itself. */
const FEEDBACK_MS = 4000;

/**
 * Read-only view of one `(employee, chat)` agent session.
 *
 * History comes from the persisted JSONL projection (`sessions:entries`);
 * live content is reconstructed from the bound token-level stream
 * (`agentSession:event`). Only the streaming assistant message is held in
 * memory — once it is persisted (`message_end`) the projection becomes the
 * source of truth and the live tail is dropped. There is intentionally no
 * system prompt, tool arguments or tool results.
 */
export function AgentSessionModule({
  employeeId,
  chatId,
}: AgentSessionModuleProps): React.JSX.Element {
  const { data, openedItems } = useApp();
  const [entries, setEntries] = useState<AgentSessionViewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Error reported by the run itself (`error` stream event). Kept apart from
   * `error` (read failures) because a successful refresh clears the latter —
   * otherwise a run failure would vanish ~150 ms after the `agent_end` that
   * schedules the next read.
   */
  const [runError, setRunError] = useState<string | null>(null);
  /** Cosmetic run state: a run is streaming, so a send would be a steer. */
  const [streaming, setStreaming] = useState(false);
  /**
   * Failure of the header's "open this session's conversation" link. Kept
   * apart from `error`/`runError` because it says nothing about the session.
   */
  const [linkError, setLinkError] = useState<string | null>(null);
  /** The link's IPC round-trip is in flight (also disables the button). */
  const [linkBusy, setLinkBusy] = useState(false);
  /** Texts sent from the composer that the transcript does not show yet. */
  const [pending, setPending] = useState<PendingSend[]>([]);
  const pendingSeqRef = useRef(0);
  /**
   * Text a successful withdrawal hands back to the composer (one-shot).
   *
   * It carries a `token` so that withdrawing the same text twice still triggers
   * exactly one refill, and it is only ever filled when the draft is empty (a
   * withdrawal must never swallow what the boss is typing).
   */
  const [refill, setRefill] = useState<{ text: string; token: number } | null>(
    null,
  );
  const refillSeqRef = useRef(0);
  /**
   * Bumped on every run end. A pending send that is older than this and still
   * absent from the projection can no longer arrive (see `reconcilePending`).
   */
  const runEndSeqRef = useRef(0);
  /** Synchronous mirror of `linkBusy` (guards double clicks in one frame). */
  const linkBusyRef = useRef(false);

  const liveRef = useRef<LiveState | null>(null);
  const liveSeqRef = useRef(0);
  // Any live mutation bumps the version so the ref-based live state re-renders.
  const [version, bump] = useReducer((n: number) => n + 1, 0);

  const sessionKeyStr = `${employeeId}/${chatId}`;
  const threadRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  /** Cached jump anchors; re-measured when `scrollHeight` moves. */
  const anchorsRef = useRef<JumpAnchors | null>(null);
  const [jump, setJump] = useState<JumpAvailability>(NO_JUMPS);
  /** Mirror of `jump` so scroll handling can compare without re-rendering. */
  const jumpRef = useRef<JumpAvailability>(NO_JUMPS);
  const restoreScrollRef = useRef<{ key: string; scrollTop: number } | null>(
    null,
  );
  const refreshTimer = useRef<number | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    const saved = sessionScrollStore.get(sessionKeyStr);
    pinnedRef.current = saved ? saved.pinned : true;
    restoreScrollRef.current =
      saved && !saved.pinned
        ? { key: sessionKeyStr, scrollTop: saved.scrollTop }
        : null;
  }, [sessionKeyStr]);

  const sessionItem = openedItems.find(
    (item) =>
      item.kind === "session" &&
      item.employeeId === employeeId &&
      item.chatId === chatId,
  );
  const session = sessionItem?.kind === "session" ? sessionItem : null;
  const employee = data.employees.items.find((e) => e.id === employeeId);
  const employeeName = employee?.name ?? t("Unnamed");
  const chatTitle = session?.chatTitle ?? t("Conversation");
  /** Label of the header's interrupt action (also its accessible name). */
  const interruptLabel = t("Interrupt current turn");
  // The transcript shows the raw `@<id>` text the model read; render names but
  // keep it non-interactive (this session's chat may not be where the mentioned
  // employee actually works).
  const { resolveMention } = useMentionResolver(chatId, false);

  const loadEntries = useCallback(async (): Promise<void> => {
    // Snapshot before the await: if a new live message starts while the read is
    // in flight, keep it instead of clearing it (would drop streamed tokens).
    const liveAtRequest = liveRef.current;
    try {
      const next = await imb.sessions.entries(employeeId, chatId);
      if (disposedRef.current) return;
      setEntries(next);
      // A send that has now appeared in the transcript no longer needs its
      // placeholder; one that still cannot appear is marked unconfirmed.
      setPending((prev) => reconcilePending(prev, next, runEndSeqRef.current));
      // The projection now contains every persisted message, so a live tail
      // that already ended (`message_end`) is a duplicate and is dropped. A
      // tail that is still streaming is *not* in the projection yet, so it is
      // kept — dropping it would erase already-streamed blocks until the next
      // delta recreated them. (Refreshes can land mid-stream, e.g. one
      // scheduled by `turn_start`.)
      const live = liveRef.current;
      if (live === liveAtRequest && live?.finalized) liveRef.current = null;
      setError(null);
      bump();
    } catch (err) {
      if (disposedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [employeeId, chatId]);

  // Initial history load. `loading` only guards the first paint so background
  // refreshes never blank the thread.
  useEffect(() => {
    disposedRef.current = false;
    setLoading(true);
    void loadEntries().finally(() => {
      if (!disposedRef.current) setLoading(false);
    });
    return () => {
      disposedRef.current = true;
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [loadEntries]);

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
    }
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void loadEntries();
    }, REFRESH_DELAY);
  }, [loadEntries]);

  // --- Live event application ------------------------------------------------
  const ensureLive = useCallback((): LiveState => {
    let state = liveRef.current;
    if (!state || state.finalized) {
      liveSeqRef.current += 1;
      state = { seq: liveSeqRef.current, finalized: false, blocks: [] };
      liveRef.current = state;
    }
    return state;
  }, []);

  const ensureBlock = useCallback(
    (state: LiveState, index: number, kind: LiveBlock["kind"]): LiveBlock => {
      let block = state.blocks[index];
      if (!block || block.kind !== kind) {
        block = { key: `${state.seq}:${index}`, kind, text: "" };
        state.blocks[index] = block;
      }
      // A block restored from a live seed may be marked finished already; any
      // new delta means it is still growing (e.g. thinking that was streaming
      // when the view was remounted), so it must not stay folded.
      if (block.done) block.done = false;
      return block;
    },
    [],
  );

  const applyMessageUpdate = useCallback(
    (event: Extract<AgentStreamEvent, { type: "message_update" }>): void => {
      // Only assistant messages stream, so the first delta implicitly opens a
      // new live message (or reopens one after the previous finalized).
      const state = ensureLive();
      const index = event.contentIndex ?? 0;
      switch (event.subType) {
        case "thinking_start":
          ensureBlock(state, index, "thinking");
          break;
        case "thinking_delta":
          ensureBlock(state, index, "thinking").text += event.delta ?? "";
          break;
        case "thinking_end":
          ensureBlock(state, index, "thinking").done = true;
          break;
        case "text_start":
          ensureBlock(state, index, "text");
          break;
        case "text_delta":
          ensureBlock(state, index, "text").text += event.delta ?? "";
          break;
        case "toolcall_start":
          ensureBlock(state, index, "tool");
          break;
        case "toolcall_end": {
          const block = ensureBlock(state, index, "tool");
          if (event.toolCallId !== undefined)
            block.toolCallId = event.toolCallId;
          if (event.toolName !== undefined) block.name = event.toolName;
          if (event.toolArgsSummary !== undefined) {
            block.argsSummary = event.toolArgsSummary;
          }
          if (event.toolArgsDetail !== undefined) {
            block.argsDetail = event.toolArgsDetail;
          }
          block.status = "running";
          break;
        }
        default:
          // text_end / toolcall_delta (arguments) / done / error: ignored.
          break;
      }
    },
    [ensureBlock, ensureLive],
  );

  /** Update a tool's status in both the live tail and the projected history. */
  const applyToolStatus = useCallback(
    (toolCallId: string, status: "running" | "ok" | "error"): void => {
      const live = liveRef.current;
      if (live) {
        const block = live.blocks.find(
          (b): b is LiveBlock =>
            b !== undefined && b.kind === "tool" && b.toolCallId === toolCallId,
        );
        if (block) block.status = status;
      }
      setEntries((prev) => {
        let changed = false;
        const next = prev.map((entry) => {
          if (
            entry.kind === "tool" &&
            entry.toolCallId === toolCallId &&
            entry.status !== status
          ) {
            changed = true;
            return { ...entry, status };
          }
          return entry;
        });
        return changed ? next : prev;
      });
    },
    [],
  );

  /**
   * Seed the live tail with the assistant message that is **already streaming**.
   *
   * The main process pushes it once per `bind` (see `sendLiveSeed` in
   * `session-queue.ts`). It is required because the token stream only carries
   * deltas and the message is not persisted until `message_end`: without the
   * seed, everything that streamed while this view was unmounted (page or
   * session switch — the view unbinds on unmount) could never be rendered again,
   * so the boss saw the persisted history followed by a gap and then only the
   * tail.
   *
   * Applied only while this view has no live content of its own; a second or
   * stale seed is ignored (defensive — an applied seed must never duplicate the
   * text of an already reconstructed message). Blocks are placed by their real
   * `contentIndex`, so later deltas keep appending to exactly the right block.
   */
  const applyLiveSeed = useCallback((blocks: AgentSessionLiveBlock[]): void => {
    if (blocks.length === 0) return;
    const current = liveRef.current;
    if (current !== null && !current.finalized) return;
    liveSeqRef.current += 1;
    const state: LiveState = {
      seq: liveSeqRef.current,
      finalized: false,
      blocks: [],
    };
    for (const item of blocks) {
      const block = item.block;
      if (!Number.isSafeInteger(item.index) || item.index < 0) continue;
      state.blocks[item.index] = {
        key: `${state.seq}:${item.index}`,
        kind: block.kind,
        // Only text/thinking carry content; a tool block's payload is its args.
        text: block.kind === "tool" ? "" : block.text,
        // A restored thinking block is finished by definition; `ensureBlock`
        // reopens it if it is in fact still streaming.
        ...(block.kind === "thinking" ? { done: true } : {}),
        ...(block.kind === "tool"
          ? {
              toolCallId: block.toolCallId,
              name: block.name,
              argsSummary: block.argsSummary,
              argsDetail: block.argsDetail,
              status: block.status,
            }
          : {}),
      };
    }
    liveRef.current = state;
    bump();
  }, []);

  /**
   * Apply one `steer_state` update to this view's interjection rows.
   *
   * The main process owns the phase (it is the only side that can see Pi's
   * steering queue), so the view never infers one:
   * - `pending`: the row exists and offers 「撤回」 (created here too, so a second
   *   window and a late mount converge on the same list);
   * - `injected` / `revoked`: the row is done — the transcript holds it, or it
   *   will never run;
   * - `lost` / `unknown`: not withdrawable and possibly never delivered — a
   *   one-shot line says so and the row removes itself.
   */
  const applySteerState = useCallback((steer: AgentSessionSteerState): void => {
    pendingSeqRef.current += 1;
    const rowId = pendingSeqRef.current;
    // One interjection, one row: the reducer upserts on `steerId`, so this can
    // never add a second bubble for a text the composer already showed.
    setPending((prev) => applySteerStateRow(prev, steer, rowId));
  }, []);

  const handleEvent = useCallback(
    (payload: AgentStreamPayload): void => {
      if (payload.employeeId !== employeeId || payload.chatId !== chatId)
        return;
      const event = payload.event;
      switch (event.type) {
        case "live_seed":
          applyLiveSeed(event.blocks);
          break;
        case "steer_state":
          applySteerState(event.steer);
          break;
        case "message_update":
          applyMessageUpdate(event);
          bump();
          break;
        case "tool_execution_start":
          applyToolStatus(event.toolCallId, "running");
          if (event.toolName) {
            const live = liveRef.current;
            if (live) {
              const block = live.blocks.find(
                (b): b is LiveBlock =>
                  b !== undefined &&
                  b.kind === "tool" &&
                  b.toolCallId === event.toolCallId,
              );
              if (block && !block.name) block.name = event.toolName;
            }
          }
          bump();
          break;
        case "tool_execution_end":
          applyToolStatus(event.toolCallId, event.isError ? "error" : "ok");
          bump();
          break;
        case "message_end":
          if (liveRef.current) {
            liveRef.current.finalized = true;
            bump();
          }
          scheduleRefresh();
          break;
        case "agent_start":
          setStreaming(true);
          scheduleRefresh();
          break;
        case "agent_end":
          // A retry keeps the run alive; any other end means Pi stopped
          // streaming, so the composer is a plain prompt again and a steered
          // text can no longer be persisted afterwards.
          if (!event.willRetry) {
            runEndSeqRef.current += 1;
            setStreaming(false);
          }
          scheduleRefresh();
          break;
        case "error":
          // A failed run would otherwise be invisible in this view: the queue
          // reports it only as an event. It also ends the run, so a steered
          // text that never showed up cannot arrive later.
          setRunError(event.message);
          setStreaming(false);
          runEndSeqRef.current += 1;
          break;
        case "turn_start":
        case "compaction_end":
          scheduleRefresh();
          break;
        default:
          break;
      }
    },
    [
      employeeId,
      chatId,
      applyLiveSeed,
      applySteerState,
      applyMessageUpdate,
      applyToolStatus,
      scheduleRefresh,
    ],
  );

  // Subscribe to the global event stream (routing by key) **before** binding.
  // `bind` answers with a `live_seed` for a run that is already streaming, and a
  // listener registered afterwards could miss it.
  useEffect(() => {
    const off = imb.agentSession.onEvent(handleEvent);
    return off;
  }, [handleEvent]);

  // Bind the session so its events reach this window. Only the mounted view
  // binds; the seed sent on bind fills in whatever streamed while it was away.
  useEffect(() => {
    void imb.agentSession.bind(employeeId, chatId);
    return () => {
      void imb.agentSession.unbind(employeeId, chatId);
    };
  }, [employeeId, chatId]);

  // Seed the run state: a session opened *while* it is streaming never emitted
  // an `agent_start` for this window, so without this snapshot the composer
  // would claim "Send" and the interrupt chip would be disabled. Cosmetic only
  // (routing is decided main-side), so a failure is ignored.
  //
  // The same snapshot restores the interjection placeholders that are still
  // withdrawable (`pending`): the row is the only place the text exists, so
  // without it a withdrawal would be impossible after a module switch. Settled
  // rows (`injected`/`revoked`/`lost`) are deliberately not restored — they are
  // history, and re-showing a stale row would be noise.
  useEffect(() => {
    let cancelled = false;
    void imb.agentSession
      .state(employeeId, chatId)
      .then((state) => {
        if (cancelled) return;
        setStreaming(state.streaming);
        const pendingSteers = (state.steers ?? []).filter(
          (steer) => steer.phase === "pending",
        );
        if (pendingSteers.length === 0) return;
        setPending((prev) =>
          // `addSentRow` upserts on `steerId`, so a row created by a
          // `steer_state` event (or by a send) while this read was in flight is
          // refreshed instead of duplicated.
          pendingSteers.reduce((rows, steer) => {
            pendingSeqRef.current += 1;
            return addSentRow(rows, {
              id: pendingSeqRef.current,
              text: steer.text,
              mode: "steer",
              steerId: steer.id,
              runEndSeq: runEndSeqRef.current,
            });
          }, prev),
        );
      })
      .catch(() => {
        // Labels only — never surface this.
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId, chatId]);

  /**
   * Record a send that the transcript cannot show yet (nothing is written to
   * the conversation and Pi persists a steer only at the next turn boundary),
   * and pin the thread so the placeholder is visible.
   *
   * An interjection arrives with a `steerId` and starts out `pending`: the main
   * process owns its phase from here on (withdrawable until Pi injects it).
   */
  const handleSent = useCallback(
    (text: string, result: AgentSessionSendResult): void => {
      pendingSeqRef.current += 1;
      const id = pendingSeqRef.current;
      // An interjection **upserts on its `steerId`**: the main process pushed
      // `steer_state` before this reply arrived, so its row may already exist —
      // appending here would render the same interjection twice.
      setPending((prev) =>
        addSentRow(prev, {
          id,
          text,
          mode: result.mode,
          runEndSeq: runEndSeqRef.current,
          ...(result.steerId !== undefined ? { steerId: result.steerId } : {}),
        }),
      );
      // A new send supersedes the previous run failure (there is exactly one
      // banner and no dismiss affordance, matching the chat module's error).
      setRunError(null);
      pinnedRef.current = true;
    },
    [],
  );

  /** Drop one placeholder (the boss decided it is not coming back). */
  const dismissPending = useCallback((id: number): void => {
    setPending((prev) => removeRow(prev, id));
  }, []);

  /** Replace an interjection row's affordance with a one-shot reason. */
  const showWithdrawFeedback = useCallback(
    (steerId: string, reason: PendingFeedback): void => {
      setPending((prev) => settleWithdrawFailure(prev, steerId, reason));
    },
    [],
  );

  /**
   * Withdraw one interjection (its text never reaches the model).
   *
   * Only the row's `phase` decides whether this is offered, and the main process
   * re-validates it anyway: a text Pi already injected cannot be taken back, and
   * the row then says so instead of disappearing as if it had worked.
   */
  const withdrawPending = useCallback(
    async (item: PendingSend): Promise<void> => {
      const steerId = item.steerId;
      if (steerId === undefined || item.busy === true) return;
      setPending((prev) => markRowBusy(prev, item.id));
      try {
        const result = await imb.agentSession.revokeSteer(
          employeeId,
          chatId,
          steerId,
        );
        if (disposedRef.current) return;
        if (!result.withdrawn) {
          showWithdrawFeedback(steerId, result.reason ?? "unknown");
          return;
        }
        setPending((prev) => removeRow(prev, item.id));
        // Hand the text back to the composer, so it can be edited and sent again
        // — but never overwrite a draft the boss is typing into.
        const draftKey = sessionKey(employeeId, chatId);
        if ((appStore.sessionDrafts[draftKey] ?? "").length === 0) {
          refillSeqRef.current += 1;
          setRefill({ text: item.text, token: refillSeqRef.current });
        }
      } catch (err) {
        if (disposedRef.current) return;
        console.error(
          "[agent-session] failed to withdraw an interjection:",
          err instanceof Error ? err.message : err,
        );
        showWithdrawFeedback(steerId, "unknown");
      }
    },
    [chatId, employeeId, showWithdrawFeedback],
  );

  /**
   * Jump to the conversation this session belongs to (the chat title in the
   * header). Root chats open in the Chat module, task group chats in their own
   * view — `appStore.openConversationById` owns that routing (it is the same
   * rule the chat cards and cron jobs use); here we only report failures.
   *
   * The session itself stays in the Nav and a running turn is untouched: this
   * view merely unmounts, and `agentSession.unbind` keeps main-side runs going.
   */
  const openConversation = useCallback(async (): Promise<void> => {
    // Ref-guarded, not just `disabled`: two clicks inside one frame would both
    // pass a state check and fire two IPC round-trips.
    if (linkBusyRef.current) return;
    linkBusyRef.current = true;
    setLinkBusy(true);
    setLinkError(null);
    try {
      const opened = await appStore.openConversationById(chatId);
      if (!opened && !disposedRef.current) {
        setLinkError(t("Conversation unavailable"));
      }
    } catch (err) {
      if (!disposedRef.current) {
        setLinkError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      linkBusyRef.current = false;
      if (!disposedRef.current) setLinkBusy(false);
    }
  }, [chatId]);

  // --- Jump to previous / next "new message" divider -------------------------
  /**
   * Measure the scroll position of every rendered wake divider, in the scroll
   * container's content space.
   *
   * Two deliberate choices:
   * - Position comes from rects relative to the thread, **not** `offsetTop`:
   *   `.imb-app` is `position: relative`, so a divider's `offsetParent` is not
   *   the thread and its `offsetTop` carries the header/titlebar offset.
   * - Cached by `scrollHeight`, which changes whenever anything above a divider
   *   resizes (a message streamed, a thinking block toggled, an image loaded).
   *
   * `force` re-measures even when `scrollHeight` is unchanged; the click handler
   * always passes it so a jump can never use a stale measurement.
   */
  const readAnchors = useCallback((force = false): JumpAnchors | null => {
    const el = threadRef.current;
    if (el === null) return null;
    const cached = anchorsRef.current;
    if (!force && cached !== null && cached.scrollHeight === el.scrollHeight) {
      return cached;
    }
    const threadRect = el.getBoundingClientRect();
    const tops: number[] = [];
    el.querySelectorAll<HTMLElement>("[data-session-divider]").forEach(
      (node) => {
        const rect = node.getBoundingClientRect();
        tops.push(rect.top - threadRect.top + el.scrollTop - JUMP_TOP_GAP);
      },
    );
    const measured: JumpAnchors = { scrollHeight: el.scrollHeight, tops };
    anchorsRef.current = measured;
    return measured;
  }, []);

  /**
   * Which jump buttons can do something from the current scroll position?
   *
   * Each direction is actionable when it can move the view at all:
   * - "previous" = a divider above the viewport's top anchor line, **or** any
   *   room above (`scrollTop > 0`) — pressing it again then goes to the very
   *   top of the transcript;
   * - "next" = a divider below it, **or** any room below — pressing it again
   *   then goes to the very bottom, including while pinned/following.
   * Only a direction with nowhere left to go is disabled.
   *
   * Divider targets are clamped to the reachable range, so a divider that cannot
   * be brought to the anchor line (it is closer to the end than one viewport)
   * never leaves a button enabled that could not move the view.
   */
  const computeJump = useCallback((): JumpAvailability => {
    const el = threadRef.current;
    const anchors = readAnchors();
    if (el === null || anchors === null) return NO_JUMPS;
    const scrollTop = el.scrollTop;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    let hasPrev = false;
    let hasNext = false;
    for (const raw of anchors.tops) {
      const top = clampScrollTop(raw, maxScroll);
      if (top < scrollTop - JUMP_EPSILON) hasPrev = true;
      else if (top > scrollTop + JUMP_EPSILON) hasNext = true;
    }
    return {
      prev: hasPrev || scrollTop > JUMP_EPSILON,
      next: hasNext || maxScroll - scrollTop > JUMP_EPSILON,
    };
  }, [readAnchors]);

  /** Recompute availability; re-render only when it actually changed. */
  const syncJump = useCallback((): void => {
    const next = computeJump();
    const current = jumpRef.current;
    if (current.prev === next.prev && current.next === next.next) return;
    jumpRef.current = next;
    setJump(next);
  }, [computeJump]);

  /** Scroll to the nearest "new message" divider, or to the very top/bottom. */
  const jumpTo = useCallback(
    (direction: "prev" | "next"): void => {
      const el = threadRef.current;
      const anchors = readAnchors(true);
      if (el === null || anchors === null) return;
      const scrollTop = el.scrollTop;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const targets = anchors.tops.map((raw) => clampScrollTop(raw, maxScroll));
      const nearest =
        direction === "next"
          ? targets.find((top) => top > scrollTop + JUMP_EPSILON)
          : targets.findLast((top) => top < scrollTop - JUMP_EPSILON);
      // No divider left in that direction: the same button keeps going to the
      // very end of the transcript (top for "previous", bottom for "next").
      // Those edges get no `JUMP_TOP_GAP` — that gap is divider alignment only.
      const target = nearest ?? (direction === "next" ? maxScroll : 0);
      // Already there (the button should be disabled in that case): do nothing
      // rather than start a pointless scroll.
      if (Math.abs(target - scrollTop) <= JUMP_EPSILON) return;
      // Following the live tail must not fight the jump: the follow effect runs
      // on every streamed delta, so `pinned` is cleared *before* scrolling and
      // the stored position is made to agree with it. Nothing re-pins manually:
      // when the jump lands at the bottom, `handleScroll` restores `pinned` from
      // the real position, which is exactly the desired behaviour.
      pinnedRef.current = false;
      sessionScrollStore.set(sessionKeyStr, { scrollTop, pinned: false });
      // `scrollTo` on the thread itself — never `scrollIntoView`, which would
      // also scroll ancestors.
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      el.scrollTo({
        top: target,
        behavior: reduceMotion ? "auto" : "smooth",
      });
    },
    [readAnchors, sessionKeyStr],
  );

  // Re-measure when the projected content changes (dividers added/removed) and
  // seed the button state. Pure scroll-position changes are handled by
  // `handleScroll`, which every programmatic scroll also triggers.
  useLayoutEffect(() => {
    readAnchors(true);
    syncJump();
  }, [entries, loading, readAnchors, syncJump]);

  // Auto-scroll to the newest content while pinned, or restore saved scroll
  // position. `pending` participates because a just-sent placeholder is new
  // content at the bottom, even though no entry arrived.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const restore = restoreScrollRef.current;
    if (restore && restore.key === sessionKeyStr && !loading) {
      el.scrollTop = restore.scrollTop;
      restoreScrollRef.current = null;
      return;
    }
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, version, loading, sessionKeyStr, pending]);

  const handleScroll = useCallback((): void => {
    const el = threadRef.current;
    if (!el) return;
    const pinned =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
    pinnedRef.current = pinned;
    sessionScrollStore.set(sessionKeyStr, {
      scrollTop: el.scrollTop,
      pinned,
    });
    syncJump();
  }, [sessionKeyStr, syncJump]);

  const live = liveRef.current;
  const liveBlocks = live
    ? live.blocks.filter((b): b is LiveBlock => b !== undefined)
    : [];

  // One divider per wake entry, minus a leading one (a batch boundary above the
  // first entry has nothing to separate, so `SessionEntry` skips it). Derived
  // from the projection, never from the DOM.
  const dividerCount = useMemo(() => {
    const wakes = entries.filter((entry) => entry.kind === "wake").length;
    return entries[0]?.kind === "wake" ? wakes - 1 : wakes;
  }, [entries]);

  const content = (
    <>
      <div className="imb-chat-header">
        <div className="imb-chat-header-avatar">
          <EmployeeAvatar employeeId={employeeId} size={30} showName />
        </div>
        <div className="imb-session-heading">
          {/* The employee's name links to their detail pane (Employees module).
              Plain text while the employee collection does not resolve the id
              (a deleted employee has no detail page to open). */}
          {employee !== undefined ? (
            <Tooltip placement="bottom" content={t("View employee details")}>
              <button
                type="button"
                className="imb-chat-title imb-session-employee-link"
                // The tooltip is the visible hint; drop the native duplicate.
                title=""
                aria-label={`${t("View employee details")}: ${employeeName}`}
                onClick={() => void appStore.openEmployeeDetail(employeeId)}
              >
                {employeeName}
              </button>
            </Tooltip>
          ) : (
            <div className="imb-chat-title">{employeeName}</div>
          )}
          {/* The conversation this session belongs to — a button, because the
              boss wants "click the group title → go to that group". Muted at
              rest (it is a caption) and accent on hover only: no underline, no
              permanent icon (boss's call). The tooltip carries the full title,
              which the row itself may ellipsize. */}
          <Tooltip placement="bottom" content={chatTitle} disabled={linkBusy}>
            <button
              type="button"
              className="imb-session-subtitle imb-session-chat-link"
              // The Tooltip is the visible hint; drop the native duplicate.
              title=""
              aria-label={`${t("Open chat")}: ${chatTitle}`}
              disabled={linkBusy}
              onClick={() => void openConversation()}
            >
              {chatTitle}
            </button>
          </Tooltip>
        </div>
        {/* Interrupts the current turn of *this* session only (queued work is
            kept, the session stays alive). One click, no confirmation: stopping a
            single turn is cheap and simply talking again resumes the work.
            Disabled while the session is idle — `interruptTurn` is a no-op then,
            and a greyed chip states that honestly.

            Deliberately independent from the composer's send/interject button:
            steer keeps the running turn, interrupt throws it away, so the
            destructive action must not share the highest-traffic control. */}
        <HaltButton
          className="imb-session-interrupt"
          label={interruptLabel}
          confirm={false}
          disabled={!streaming}
          onInterrupt={() => imb.agentSession.interruptTurn(employeeId, chatId)}
        >
          <IconHalt />
          <span className="imb-session-interrupt-label">{interruptLabel}</span>
        </HaltButton>
      </div>
      {/* The thread and the floating jump control share a positioned wrapper so
          the control can sit above the composer without a fixed offset. */}
      <div className="imb-session-thread-wrap">
        <div
          className={cls(
            "imb-thread imb-session-thread",
            dividerCount > 0 && "imb-has-jumps",
          )}
          ref={threadRef}
          onScroll={handleScroll}
        >
          {!loading &&
          entries.length === 0 &&
          liveBlocks.length === 0 &&
          pending.length === 0 ? (
            <div className="imb-chat-empty-detail">
              {t("No session content yet")}
            </div>
          ) : (
            <>
              {entries.map((entry, index) => (
                <SessionEntry
                  key={entry.id}
                  entry={entry}
                  first={index === 0}
                  resolveMention={resolveMention}
                />
              ))}
              {liveBlocks.map((block) => (
                <LiveBlockView
                  key={block.key}
                  block={block}
                  resolveMention={resolveMention}
                />
              ))}
            </>
          )}
          {pending.map((item) => (
            <PendingSendRow
              key={item.id}
              item={item}
              onDismiss={dismissPending}
              onWithdraw={withdrawPending}
            />
          ))}
        </div>
        {dividerCount > 0 && (
          <SessionJumpButtons availability={jump} onJump={jumpTo} />
        )}
      </div>
      {error !== null || runError !== null || linkError !== null ? (
        // In flow, above the composer: the shared `.imb-chat-error` is a fixed
        // toast that would land on top of the composer here.
        <p className="imb-error-text imb-session-error" role="alert">
          {error ?? runError ?? linkError}
        </p>
      ) : null}
      {/* The view's only write affordance — injects into this very session
          (nothing is written to the conversation). */}
      <SessionComposer
        employeeId={employeeId}
        chatId={chatId}
        employeeName={employeeName}
        streaming={streaming}
        refill={refill}
        onSent={handleSent}
      />
    </>
  );

  return <ModuleView content={content} />;
}

/** Render one projected history entry. */
function SessionEntry({
  entry,
  first,
  resolveMention,
}: {
  entry: AgentSessionViewEntry;
  /** True for the first rendered entry (some markers are skipped there). */
  first: boolean;
  resolveMention: (id: number) => string | null;
}): React.JSX.Element | null {
  switch (entry.kind) {
    case "wake":
      // A batch boundary above the first entry has nothing to separate.
      return first ? null : <SessionDivider />;
    case "user":
      return <div className="imb-session-user">{entry.text}</div>;
    case "text":
      return (
        <div className="imb-session-text">
          <Markdown content={entry.text} resolveMention={resolveMention} />
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={entry.text} streaming={false} />;
    case "interrupted":
      return <InterruptedDivider />;
    case "tool":
      return (
        <ToolBlock
          name={entry.name}
          status={entry.status}
          summary={entry.argsSummary}
          detail={entry.argsDetail}
        />
      );
    case "compaction":
      return (
        <CompactionBlock
          summary={entry.summary}
          resolveMention={resolveMention}
        />
      );
  }
}

/**
 * Placeholder for a message sent from the composer that the transcript cannot
 * show yet: nothing is written to the conversation (by design) and Pi persists
 * a steer only at the next turn boundary, so without this row a successful send
 * would look like nothing happened.
 *
 * Styled as the boss's own bubble but dimmed. What sits next to it depends on
 * what the row actually is:
 * - **interjection** (`steerId` set, still `pending`): one 「撤回」 button. The
 *   text has not reached the model, so it can still be taken back; the button
 *   itself is the state — no explanatory line (boss's call).
 * - **interjection, settled** (`lost` / `unknown`): a one-shot reason line and no
 *   button. The row removes itself after `FEEDBACK_MS`.
 * - **queued** send (v1 cannot withdraw those) or a legacy steer with no handle:
 *   the old status line plus a `×` that only dismisses the placeholder.
 */
function PendingSendRow({
  item,
  onDismiss,
  onWithdraw,
}: {
  item: PendingSend;
  onDismiss: (id: number) => void;
  onWithdraw: (item: PendingSend) => void;
}): React.JSX.Element {
  const feedback = item.feedback;
  // A one-shot line must not stay forever: the row is only there to report one
  // outcome, and leaving it behind would suggest a live state that is gone.
  useEffect(() => {
    if (feedback === undefined) return;
    const timer = window.setTimeout(() => onDismiss(item.id), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback, item.id, onDismiss]);

  const withdrawable =
    item.steerId !== undefined && item.phase === "pending" && !feedback;
  const label = withdrawable
    ? null
    : feedback !== undefined
      ? pendingFeedbackLabel(feedback)
      : item.unconfirmed
        ? t("Not confirmed — the agent may not have received this")
        : item.mode === "steer"
          ? t("Interjected — handled after the current turn")
          : t("Queued — handled as soon as the agent is free");
  const withdrawLabel = t("Withdraw");
  const dismissLabel = t("Dismiss");
  return (
    <div className="imb-session-pending">
      <div
        className={cls(
          "imb-session-user imb-session-pending-bubble",
          (item.unconfirmed || feedback !== undefined) && "imb-is-unconfirmed",
        )}
      >
        {item.text}
      </div>
      {withdrawable ? (
        <div className="imb-session-pending-hint">
          <button
            type="button"
            className="imb-session-pending-action"
            aria-label={withdrawLabel}
            disabled={item.busy === true}
            onClick={() => onWithdraw(item)}
          >
            {withdrawLabel}
          </button>
        </div>
      ) : (
        <div
          className={cls(
            "imb-session-pending-hint",
            (item.unconfirmed || feedback !== undefined) &&
              "imb-is-unconfirmed",
          )}
          role={feedback !== undefined ? "alert" : undefined}
        >
          <span>{label}</span>
          {/* A settled interjection has nothing left to dismiss: it reports an
              outcome and removes itself. Only the queued/legacy rows keep an
              explicit "I don't care anymore". */}
          {feedback === undefined && item.steerId === undefined && (
            <button
              type="button"
              className="imb-session-pending-dismiss"
              aria-label={dismissLabel}
              title={dismissLabel}
              onClick={() => onDismiss(item.id)}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Separator for a turn the boss interrupted. Structurally identical to
 * `SessionDivider` (same muted line + centered label) and only tinted with the
 * danger colour, so it reads as one of the app's system separators.
 *
 * Deliberately **not** a jump anchor (no `data-session-divider`): the prev/next
 * buttons walk the "new messages" batch dividers only. No timestamp either — the
 * marker is a boundary, not an event log line.
 */
function InterruptedDivider(): React.JSX.Element {
  const label = t("Interrupted");
  return (
    <div
      className="imb-session-divider imb-session-divider-interrupted"
      role="separator"
      aria-label={label}
    >
      <span className="imb-session-divider-label">{label}</span>
    </div>
  );
}

/**
 * Batch separator: a muted line with a centered label, drawn where an internal
 * "you have new messages" wake prompt sits in the session. One divider per
 * batch of processed messages (see `session-view.ts`).
 *
 * `data-session-divider` is the jump-anchor hook read by `readAnchors`
 * (`.imb-session-jumps` buttons); it is not used for styling.
 */
function SessionDivider(): React.JSX.Element {
  const label = t("New messages");
  return (
    <div
      className="imb-session-divider"
      role="separator"
      aria-label={label}
      data-session-divider=""
    >
      <span className="imb-session-divider-label">{label}</span>
    </div>
  );
}

/**
 * Floating "previous / next new message" control, fixed to the bottom-right of
 * the content pane (this view has no composer, and it is portaled into
 * `.imb-contentpane`, which is flush with the window edge).
 *
 * The up arrow sits above the down arrow. Each button first walks the wake
 * dividers, and once there is none left in that direction it keeps going to the
 * very top / bottom of the transcript. A direction is only disabled when the
 * view is already at that edge and no divider remains; the whole control is
 * only rendered when the session has at least one divider.
 */
function SessionJumpButtons({
  availability,
  onJump,
}: {
  availability: JumpAvailability;
  onJump: (direction: "prev" | "next") => void;
}): React.JSX.Element {
  return (
    <div className="imb-session-jumps">
      <IconButton
        className="imb-session-jump"
        label={t("Previous new message")}
        size={16}
        boxSize={32}
        disabled={!availability.prev}
        onClick={() => onJump("prev")}
      >
        <IconChevronUp />
      </IconButton>
      <IconButton
        className="imb-session-jump"
        label={t("Next new message")}
        size={16}
        boxSize={32}
        disabled={!availability.next}
        onClick={() => onJump("next")}
      >
        <IconChevronDown />
      </IconButton>
    </div>
  );
}

/** Render one reconstructed live block. */
function LiveBlockView({
  block,
  resolveMention,
}: {
  block: LiveBlock;
  resolveMention: (id: number) => string | null;
}): React.JSX.Element {
  switch (block.kind) {
    case "text":
      return (
        <div className="imb-session-text">
          <Markdown content={block.text} resolveMention={resolveMention} />
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={block.text} streaming={!block.done} />;
    case "tool":
      return (
        <ToolBlock
          name={block.name ?? t("Tool")}
          status={block.status ?? "running"}
          summary={block.argsSummary}
          detail={block.argsDetail}
        />
      );
  }
}

/**
 * Collapsible assistant reasoning. Auto-expands while streaming and folds once
 * the thinking block ends; a completed block starts folded and toggles on click.
 */
function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <div className={cls("imb-session-thinking", open && "imb-is-open")}>
      <button
        type="button"
        className="imb-session-thinking-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <IconChevronDown className="imb-icon imb-sm" />
        <span>{streaming ? t("Thinking…") : t("Thinking")}</span>
      </button>
      {open && <div className="imb-session-thinking-body">{text}</div>}
    </div>
  );
}

/** A tool call: name, a compact argument summary, and expandable args detail. */
function ToolBlock({
  name,
  status,
  summary,
  detail,
}: {
  name: string;
  status: "running" | "ok" | "error";
  summary?: string;
  detail?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = detail !== undefined && detail.length > 0;
  const row = (
    <>
      <span className="imb-session-tool-dot" aria-hidden="true" />
      <span className="imb-session-tool-name">{name}</span>
      {summary !== undefined && summary.length > 0 && (
        <span className="imb-session-tool-args" title={summary}>
          {summary}
        </span>
      )}
      <span className="imb-session-tool-status">
        {status === "running"
          ? t("Running")
          : status === "error"
            ? t("Failed")
            : t("Done")}
      </span>
    </>
  );
  return (
    <div
      className={cls(
        "imb-session-tool",
        `imb-is-${status}`,
        expandable && "imb-is-expandable",
        open && "imb-is-open",
      )}
    >
      {expandable ? (
        <button
          type="button"
          className="imb-session-tool-head"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {row}
        </button>
      ) : (
        <div className="imb-session-tool-head">{row}</div>
      )}
      {expandable && open && (
        <pre className="imb-session-tool-detail">{detail}</pre>
      )}
    </div>
  );
}

/** A compaction marker with its summary. */
function CompactionBlock({
  summary,
  resolveMention,
}: {
  summary: string;
  resolveMention: (id: number) => string | null;
}): React.JSX.Element {
  return (
    <div className="imb-session-compaction">
      <div className="imb-session-compaction-head">{t("Compacted")}</div>
      <div className="imb-session-compaction-body">
        <Markdown content={summary} resolveMention={resolveMention} />
      </div>
    </div>
  );
}
