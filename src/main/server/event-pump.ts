import type { AgentStreamPayload } from "@shared/types";

/**
 * Outbound event stream for one connected client.
 *
 * Three problems this solves, all of them specific to a *remote* renderer (the
 * in-process transport has none of them):
 *
 * 1. **Token-level chat.** `agentSession:event` fires once per streamed token.
 *    Over a socket that is one HTTP/2 frame each; a run producing 60 tokens/s
 *    would spend most of its bandwidth on frame headers. Deltas of the same
 *    content block are therefore concatenated inside a short flush window
 *    ({@link COALESCE_WINDOW_MS}). Nothing else is ever merged, so state events
 *    (`agent_start`, `message_end`, `steer_state`, …) keep their exact order.
 * 2. **Gaps.** Every flushed event gets a contiguous, per-client `seq`. A client
 *    that reconnects asks to resume from its last applied `seq`; if the history
 *    is still in the ring buffer it is replayed, so a one-second network blip is
 *    invisible. If it is not (server restart, long outage), the stream is
 *    replaced by one `server:resync` event and the client refetches snapshots —
 *    never a silently blank UI.
 * 3. **Backpressure.** A slow reader must not grow memory without bound. The
 *    queue is capped; when it overflows, streamed deltas are dropped first
 *    (they are reconstructible: the renderer re-reads the message once the run
 *    ends, and `live_seed` re-primes an in-flight one). If even that is not
 *    enough, the oldest non-delta event is dropped and `dropped` is reported on
 *    the next event so the client resyncs.
 */

/** Flush window for coalesced deltas. */
export const COALESCE_WINDOW_MS = 40;
/** Soft cap on queued events (one flush); overflow drops deltas first. */
export const MAX_QUEUED_EVENTS = 512;
/** Hard cap; beyond this the oldest event is dropped regardless of kind. */
export const HARD_MAX_QUEUED_EVENTS = 2048;
/** How many flushed events are kept for a reconnect to replay. */
export const REPLAY_BUFFER_SIZE = 1024;

/** One event as it appears on the wire. */
export interface WireEvent {
  channel: string;
  payload: unknown;
  hasPayload: boolean;
  /** Contiguous per client, starting at 1. */
  seq: number;
  /** Events dropped inside this window (backpressure). */
  dropped: number;
}

/** Writes one event to the transport (throws if the stream is gone). */
export type WireWriter = (event: WireEvent) => void;

interface QueuedEvent {
  channel: string;
  payload: unknown;
  hasPayload: boolean;
  /** Merge key for coalescible deltas (`null` = never merge). */
  coalesceKey: string | null;
}

/** Channels/events that are safe to merge (streamed text-ish deltas only). */
function coalesceKeyFor(channel: string, payload: unknown): string | null {
  if (channel !== "agentSession:event") return null;
  const envelope = payload as AgentStreamPayload | undefined;
  const event = envelope?.event;
  if (!event || event.type !== "message_update") return null;
  if (
    event.subType !== "text_delta" &&
    event.subType !== "thinking_delta" &&
    event.subType !== "toolcall_delta"
  ) {
    return null;
  }
  if (typeof event.delta !== "string") return null;
  // Same session, same content block, same kind of delta.
  return `${envelope.employeeId}:${envelope.chatId}:${event.contentIndex ?? "?"}:${event.subType}`;
}

/** Append `delta` of `next` onto the queued `previous` delta event. */
function mergeDelta(previous: QueuedEvent, next: QueuedEvent): QueuedEvent {
  const before = previous.payload as AgentStreamPayload;
  const after = next.payload as AgentStreamPayload;
  if (
    before.event.type !== "message_update" ||
    after.event.type !== "message_update"
  ) {
    return next;
  }
  const delta = `${before.event.delta ?? ""}${after.event.delta ?? ""}`;
  return {
    channel: previous.channel,
    hasPayload: true,
    coalesceKey: previous.coalesceKey,
    // New object: the payload handed in may be referenced elsewhere (the
    // in-process broadcaster shares it with the sender).
    payload: {
      ...after,
      event: { ...after.event, delta },
    } satisfies AgentStreamPayload,
  };
}

export class EventStream {
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writer: WireWriter | null = null;
  /** Next `seq` to assign; kept across reconnects while the process lives. */
  private nextSeq = 1;
  /** Flushed events, for a reconnect to replay. */
  private readonly replay: WireEvent[] = [];
  /** Events dropped since the last flush, reported on the next event. */
  private droppedSinceFlush = 0;

  /** Total events written (observability / tests). */
  private written = 0;
  /** Deltas merged into a previous event (observability / tests). */
  private merged = 0;

  /** Attach a writer; `resumeFromSeq > 0` asks for a replay after that point. */
  attach(
    writer: WireWriter,
    resumeFromSeq = 0,
  ): { resumed: number; resync: "history-lost" | "server-restarted" | null } {
    this.writer = writer;

    const lastSeq = this.nextSeq - 1;
    if (resumeFromSeq <= 0) {
      return { resumed: 0, resync: null };
    }
    if (resumeFromSeq > lastSeq) {
      // The client claims more history than this process ever produced: it
      // talked to a previous backend instance (or a different one).
      return { resumed: 0, resync: "server-restarted" };
    }
    const oldest = this.replay[0]?.seq ?? this.nextSeq;
    if (resumeFromSeq < oldest - 1) {
      // The gap starts before the ring buffer: we cannot fill it in.
      return { resumed: 0, resync: "history-lost" };
    }

    const pending = this.replay.filter((event) => event.seq > resumeFromSeq);
    // `emit`, not `write`: replayed events are already in the buffer, and
    // re-buffering them would duplicate history on every reconnect.
    for (const event of pending) this.emit(event);
    return { resumed: pending.length, resync: null };
  }

  detach(): void {
    this.writer = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.droppedSinceFlush = 0;
  }

  /**
   * Queue one event.
   *
   * While no stream is attached the event is **journaled** instead of dropped:
   * the client is expected to reconnect and ask to resume, and a browser-style
   * "window is gone, throw it away" would leave a hole it can never fill. The
   * journal is the same bounded ring buffer as the replay history, so a long
   * outage ends in `history-lost` and a snapshot refetch rather than in
   * unbounded memory.
   */
  push(channel: string, payload: unknown, hasPayload: boolean): void {
    if (this.writer === null) {
      this.journal(channel, payload, hasPayload);
      return;
    }

    const coalesceKey = hasPayload ? coalesceKeyFor(channel, payload) : null;
    const candidate: QueuedEvent = {
      channel,
      payload,
      hasPayload,
      coalesceKey,
    };

    if (coalesceKey !== null) {
      // Merge into the last queued event only when it is the *last* one: merging
      // into an older entry would reorder content relative to events after it.
      const last = this.queue[this.queue.length - 1];
      if (last !== undefined && last.coalesceKey === coalesceKey) {
        this.queue[this.queue.length - 1] = mergeDelta(last, candidate);
        this.merged += 1;
        this.scheduleFlush();
        return;
      }
    }

    this.queue.push(candidate);
    this.enforceBackpressure();
    this.scheduleFlush();
  }

  /** Write whatever is queued right now (tests and shutdown). */
  flushNow(): void {
    this.flush();
  }

  /** Sequence number of the newest event written (0 = nothing yet). */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Flush counters, for the equivalence/diagnostics harness. */
  stats(): {
    written: number;
    merged: number;
    queued: number;
    nextSeq: number;
  } {
    return {
      written: this.written,
      merged: this.merged,
      queued: this.queue.length,
      nextSeq: this.nextSeq,
    };
  }

  private enforceBackpressure(): void {
    while (this.queue.length > MAX_QUEUED_EVENTS) {
      // Deltas first: an interrupted stream is recoverable, a missing
      // `message_end` is not.
      const index = this.queue.findIndex((entry) => entry.coalesceKey !== null);
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.droppedSinceFlush += 1;
        continue;
      }
      if (this.queue.length <= HARD_MAX_QUEUED_EVENTS) {
        // Only non-delta events are left and we are under the hard cap: keep
        // them and let the flush drain the queue.
        return;
      }
      this.queue.shift();
      this.droppedSinceFlush += 1;
    }
    if (this.queue.length > HARD_MAX_QUEUED_EVENTS) {
      this.queue.splice(0, this.queue.length - HARD_MAX_QUEUED_EVENTS);
      this.droppedSinceFlush += 1;
    }
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, COALESCE_WINDOW_MS);
    // A pending flush must not keep the process alive on shutdown.
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.queue.length === 0) {
      this.droppedSinceFlush = 0;
      return;
    }
    const drained = this.queue;
    this.queue = [];
    const dropped = this.droppedSinceFlush;
    this.droppedSinceFlush = 0;

    drained.forEach((entry, index) => {
      const event: WireEvent = {
        channel: entry.channel,
        payload: entry.payload,
        hasPayload: entry.hasPayload,
        seq: this.nextSeq,
        // Report the loss once, on the first event of the batch, so the client
        // resyncs as early as possible.
        dropped: index === 0 ? dropped : 0,
      };
      this.nextSeq += 1;
      this.write(event);
    });
  }

  /** Buffer an event while detached, so a reconnect can replay it. */
  private journal(
    channel: string,
    payload: unknown,
    hasPayload: boolean,
  ): void {
    this.replay.push({
      channel,
      payload,
      hasPayload,
      seq: this.nextSeq,
      dropped: 0,
    });
    this.nextSeq += 1;
    if (this.replay.length > REPLAY_BUFFER_SIZE) this.replay.shift();
  }

  private write(event: WireEvent): void {
    this.emit(event);
    this.replay.push(event);
    if (this.replay.length > REPLAY_BUFFER_SIZE) this.replay.shift();
  }

  /** Hand one event to the transport, without touching the replay buffer. */
  private emit(event: WireEvent): void {
    if (this.writer === null) return;
    try {
      this.writer(event);
      this.written += 1;
    } catch (error) {
      // A write failure means the stream is gone; the reconnect path takes over.
      console.error(
        "[server] event write failed:",
        error instanceof Error ? error.message : error,
      );
      this.writer = null;
    }
  }
}
