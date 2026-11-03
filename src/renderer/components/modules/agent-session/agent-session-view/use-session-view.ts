import type {
  AgentSessionAttachment,
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
import { appStore, sessionKey, useApp } from "../../../../app-store";
import { useMentionResolver } from "../../../markdown/use-mention";
import {
  MY_JUMP_TOP_GAP,
  type MyMessageEntry,
} from "../../chat/my-message-jump";
import { collapseWhitespace } from "../../chat/preview-text";
import {
  SEARCHABLE_SELECTOR,
  useThreadFind,
} from "../../chat/thread-find/use-thread-find";
import {
  prefersReducedMotion,
  scrollThreadToRow,
} from "../../chat/thread-scroll";
import {
  addSentRow,
  applySteerStateRow,
  markRowBusy,
  reconcilePending,
  removeRow,
  settleWithdrawFailure,
  type PendingFeedback,
  type PendingSend,
} from "../agent-session-module/pending-sends";

/**
 * Content containers the find engine searches, on top of the shared chat list
 * (`SEARCHABLE_SELECTOR`): what the boss typed into the composer and the
 * reasoning text of a thinking block are plain text, not Markdown. Assistant
 * text and a compaction summary already render as `.imb-markdown`, so they are
 * covered by the shared list. Tool names / arguments / details stay out on
 * purpose: they are call chrome, not conversation.
 */
const SESSION_SEARCHABLE_SELECTOR = [
  SEARCHABLE_SELECTOR,
  ".imb-session-user-text",
  ".imb-session-thinking-body",
].join(", ");

/**
 * Row selector of this view: every rendered entry carries `data-message-id`
 * (the same row contract the chat threads use), there is no `.imb-msg` here.
 */
const SESSION_ROW_SELECTOR = "[data-message-id]";

/** One reconstructed block of the currently streaming assistant message. */
export interface LiveBlock {
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
export interface JumpAvailability {
  prev: boolean;
  next: boolean;
}
const NO_JUMPS: JumpAvailability = { prev: false, next: false };

/**
 * State and behaviour of one `(employee, chat)` agent session, as a hook.
 *
 * Extracted verbatim from the agent-session module so the **same** implementation
 * can back two hosts (see `.pi/facts/employee-direct-chat-plan.md`):
 *
 * - `AgentSessionModule` — the Nav-opened, single-pane session view;
 * - the chat module's **employee direct chat**, whose detail pane is this session
 *   instead of the conversation's `messages`.
 *
 * Never build a second session view: everything (history projection, live token
 * stream, scroll/pin, jump dividers, in-thread find, interjection rows) lives
 * here, and `<SessionThread>` in `./session-thread.tsx` is its only renderer.
 *
 * History comes from the persisted JSONL projection (`sessions:entries`); live
 * content is reconstructed from the bound token-level stream
 * (`agentSession:event`). Only the streaming assistant message is held in
 * memory — once it is persisted (`message_end`) the projection becomes the
 * source of truth and the live tail is dropped. There is intentionally no
 * system prompt, tool arguments or tool results.
 */
export function useSessionView(employeeId: number, chatId: number) {
  // `resyncEpoch` re-reads/re-binds the session after an unresumable remote
  // event-stream gap; the hosts read the employee/chat title themselves.
  const { resyncEpoch } = useApp();
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
    // `resyncEpoch` re-binds after an unresumable event-stream gap: the server
    // answers a bind with a `live_seed` of the in-flight message, which is how
    // this view recovers the deltas it missed.
  }, [employeeId, chatId, resyncEpoch]);

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
    (
      text: string,
      result: AgentSessionSendResult,
      attachments: AgentSessionAttachment[],
    ): void => {
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
          ...(attachments.length > 0 ? { attachments } : {}),
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

  /**
   * Record a message the boss sent **into the conversation** (a direct chat's
   * chat composer) that the transcript cannot show yet.
   *
   * `chat:send` stores the message and queues the prompt, but Pi only persists
   * the user message when the turn actually starts — which can be minutes away
   * while the employee is busy. Without this row the boss would see nothing at
   * all after pressing send.
   *
   * `mode: "queued"` on purpose: the text sits in the app queue, so it is
   * guaranteed to run eventually — it must never be reported as unconfirmed
   * (`reconcilePending` only does that for steer rows) and it offers no
   * withdrawal. The row removes itself once the transcript carries the text.
   */
  const addPendingChatSend = useCallback(
    (text: string, attachments: AgentSessionAttachment[]): void => {
      pendingSeqRef.current += 1;
      setPending((prev) =>
        addSentRow(prev, {
          id: pendingSeqRef.current,
          text,
          mode: "queued",
          runEndSeq: runEndSeqRef.current,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      );
      // A newly sent message is what the boss wants to look at.
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
        const draft = appStore.sessionDrafts[draftKey];
        if ((draft?.text ?? "").length === 0) {
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
   * Open the conversation a `kind: "chat"` attachment chip references. The
   * session view stays in the Nav — this only routes the *click*.
   */
  const openConversationById = useCallback((targetChatId: number): void => {
    void appStore.openConversationById(targetChatId);
  }, []);

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

  // --- My messages + in-thread find ------------------------------------------
  /**
   * The boss's own prompts, one line each (`MyMessageJump`'s list). Only
   * prompts that carry text are listed: an attachment-only send has no words to
   * show, exactly like the root chat's list (which skips text-less messages).
   */
  const myEntries = useMemo<MyMessageEntry[]>(() => {
    const list: MyMessageEntry[] = [];
    for (const entry of entries) {
      if (entry.kind !== "user") continue;
      const text = collapseWhitespace(entry.text);
      if (text.length > 0) list.push({ id: entry.id, text });
    }
    return list;
  }, [entries]);

  /** The row of one entry, addressed by its `data-message-id` (see the row
   *  contract: every rendered entry's root element carries it). */
  const findEntryRow = useCallback((id: string): HTMLElement | null => {
    const thread = threadRef.current;
    if (thread === null) return null;
    for (const row of thread.querySelectorAll<HTMLElement>(
      SESSION_ROW_SELECTOR,
    )) {
      if (row.dataset.messageId === id) return row;
    }
    return null;
  }, []);

  /**
   * Jump to one of the boss's prompts (a pick in the `MyMessageJump` panel).
   * Same landing as every other jump in this view: the row goes to the landing
   * line, flashes once, and the view stops following the live tail so streamed
   * content cannot yank it back.
   */
  const jumpToEntry = useCallback(
    (id: string): void => {
      const thread = threadRef.current;
      const row = findEntryRow(id);
      if (thread === null || row === null) return;
      scrollThreadToRow(thread, row, {
        topGap: MY_JUMP_TOP_GAP,
        beforeScroll: (target) => {
          pinnedRef.current = false;
          sessionScrollStore.set(sessionKeyStr, {
            scrollTop: target,
            pinned: false,
          });
        },
        flash: row,
      });
    },
    [findEntryRow, sessionKeyStr],
  );

  /**
   * The panel's 「Go to bottom」: back to the newest content and resume following
   * it. The same end state as sending a message: `pinned` is set *before*
   * scrolling, so the follow effect keeps the view on the tail.
   */
  const jumpToLatest = useCallback((): void => {
    const el = threadRef.current;
    if (el === null) return;
    pinnedRef.current = true;
    sessionScrollStore.set(sessionKeyStr, {
      scrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
      pinned: true,
    });
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [sessionKeyStr]);

  /**
   * The boss's own choice of which thinking blocks are open (`undefined` = the
   * default: a persisted block starts folded, a streaming one is open until it
   * ends). Rewritten wholesale when a find session ends — see `handleFindClose`.
   */
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const toggleThinking = useCallback((key: string, next: boolean): void => {
    setThinkingOpen((prev) =>
      (prev[key] ?? false) === next ? prev : { ...prev, [key]: next },
    );
  }, []);

  /**
   * A find-bar jump: leave the bottom (the view is no longer following the live
   * tail) and record the landing position, so switching away and back keeps the
   * place the boss was reading.
   */
  const handleFindJump = useCallback(
    (target: number): void => {
      pinnedRef.current = false;
      sessionScrollStore.set(sessionKeyStr, {
        scrollTop: target,
        pinned: false,
      });
    },
    [sessionKeyStr],
  );

  /**
   * The bar closed: exactly the block the cursor was on (the one that was
   * highlighted) stays expanded, everything else folds — including blocks this
   * find session had only forced open, blocks an earlier jump of the same
   * session left behind, and blocks the boss had expanded by hand before
   * searching (the boss's rule: "除当前那一块，其它思考都折叠").
   *
   * With no match at all ("No matches", or the query was cleared) there is
   * nothing highlighted, so every block folds.
   *
   * A streaming block is unaffected: its own default (`!done`, i.e. open) is
   * what keeps it open, not this map.
   */
  const handleFindClose = useCallback(
    (lastActiveRow: HTMLElement | null): void => {
      const id = lastActiveRow?.dataset.messageId;
      const keep =
        id !== undefined &&
        lastActiveRow?.classList.contains("imb-session-thinking") === true
          ? id
          : null;
      setThinkingOpen((prev) => {
        const keys = Object.keys(prev);
        if (keep === null) return keys.length === 0 ? prev : {};
        return keys.length === 1 && prev[keep] === true
          ? prev
          : { [keep]: true };
      });
    },
    [],
  );

  /**
   * Find in this session (⌘F). The engine searches the *rendered* thread, so it
   * can only see thinking whose body is mounted — and a folded block renders no
   * body at all. While the bar is open, every thinking block whose text contains
   * the scanned query is therefore forced open (see `forcedThinking`), which is
   * what makes folded reasoning searchable at all; `handleFindClose` then decides
   * what is left expanded.
   *
   * `chatId` is the reset key: switching sessions remounts this view anyway
   * (`App.tsx` keys it by session), so this only guards a same-chat remount.
   */
  const threadFind = useThreadFind({
    chatId,
    // Only a change signal (and the long-conversation measure): a reload of the
    // projection re-scans, so a message that has just been persisted is
    // immediately searchable. The live tail is searchable through the DOM.
    messages: entries,
    threadRef,
    searchableSelector: SESSION_SEARCHABLE_SELECTOR,
    rowSelector: SESSION_ROW_SELECTOR,
    onBeforeJump: handleFindJump,
    onClose: handleFindClose,
  });

  const findQuery = threadFind.scannedQuery.toLowerCase();

  /**
   * Thinking blocks that must be mounted for the current query to be findable.
   * Derived from the *scanned* query (the same value the engine searches), so the
   * mounted content and the match list can never disagree.
   *
   * `liveBlocks` is read from this render's snapshot while `version` is the
   * dependency: every live mutation bumps it, and re-reading the blocks on each
   * streamed token would buy nothing.
   */
  const forcedThinking = useMemo(() => {
    const forced = new Set<string>();
    if (findQuery.length === 0) return forced;
    for (const entry of entries) {
      if (
        entry.kind === "thinking" &&
        entry.text.toLowerCase().includes(findQuery)
      ) {
        forced.add(entry.id);
      }
    }
    for (const block of liveBlocks) {
      if (
        block.kind === "thinking" &&
        block.text.toLowerCase().includes(findQuery)
      ) {
        forced.add(block.key);
      }
    }
    return forced;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the doc above.
  }, [entries, findQuery, version]);

  /**
   * Whether one thinking block renders expanded: a forced (find) block wins,
   * then the boss's own choice, then the streaming default.
   */
  const isThinkingOpen = useCallback(
    (key: string, fallback: boolean): boolean =>
      forcedThinking.has(key) || (thinkingOpen[key] ?? fallback),
    [forcedThinking, thinkingOpen],
  );

  return {
    employeeId,
    chatId,
    resolveMention,
    entries,
    loading,
    liveBlocks,
    pending,
    error,
    runError,
    streaming,
    threadRef,
    handleScroll,
    jump,
    jumpTo,
    myEntries,
    jumpToEntry,
    jumpToLatest,
    threadFind,
    dividerCount,
    isThinkingOpen,
    onToggleThinking: toggleThinking,
    dismissPending,
    withdrawPending,
    handleSent,
    addPendingChatSend,
    refill,
    openConversationById,
  };
}

/**
 * What one session view exposes. Both hosts render their header/error line from
 * this object and hand the rest to `<SessionThread>`.
 */
export type SessionView = ReturnType<typeof useSessionView>;
