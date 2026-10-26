import { EventStream, type WireEvent } from "./event-pump";
import type { Subscriber } from "../rpc/types";

/**
 * Connected clients of the backend, and the `Subscriber` implementations the
 * business layer pushes events to.
 *
 * v1 is single-client (see the accepted downgrade list): the backend serves one
 * desktop shell at a time, because shared UI state (`ui.*` settings, the window
 * the agents' notifications belong to) and single-flight flows
 * (`providers:login`) assume one human. A second client is **rejected with a
 * readable error** rather than silently ignored — the shell shows the message.
 *
 * Ownership is per `clientId` (a UUID the shell keeps for its lifetime), not per
 * connection, so a dropped stream can reconnect without fighting itself. The
 * per-client {@link EventStream} (sequence numbers + replay buffer) deliberately
 * outlives a disconnect: that is what makes a short network blip invisible
 * instead of forcing the renderer to reload.
 */

/** Thrown when a second client tries to attach; mapped to a gRPC status. */
export class AlreadyConnectedError extends Error {
  constructor() {
    super(
      "Another client is already connected to this backend. imboss supports a single remote client per backend; close the other instance (or restart the backend) and try again.",
    );
    this.name = "AlreadyConnectedError";
  }
}

/** Writes one event to a client's stream. */
export type EventWriter = (event: WireEvent) => void;

/** How many client ids keep their history alive (bounded, LRU-ish). */
const MAX_TRACKED_CLIENTS = 8;

interface ClientEntry {
  readonly id: string;
  /** Current stream writer (`null` between reconnects). */
  writer: EventWriter | null;
  /** Channels the client asked for; `null` = everything. */
  channels: Set<string> | null;
  readonly closeCallbacks: Set<() => void>;
  /** Assigned right after the entry is created (see `entryFor`). */
  subscriber: Subscriber;
  /** Sequence numbers + replay buffer; survives a disconnect. */
  readonly stream: EventStream;
  lastSeenAt: number;
}

export interface AttachOutcome {
  /** Events replayed to close the client's gap. */
  resumed: number;
  /** Set when the gap could not be filled; the client must refetch snapshots. */
  resync: "history-lost" | "server-restarted" | null;
  /** Sequence number of the newest event (0 = nothing ever sent). */
  lastSeq: number;
}

export class SubscriberRegistry {
  private readonly clients = new Map<string, ClientEntry>();
  /** The single client allowed to drive this backend. */
  private owner: string | null = null;

  /**
   * Reject a call from a client that does not own the backend.
   *
   * Called for every `Invoke` (and for every `Subscribe`), so a second shell
   * fails on its first request instead of halfway through a session.
   */
  assertAllowed(clientId: string): void {
    if (this.owner !== null && this.owner !== clientId) {
      throw new AlreadyConnectedError();
    }
  }

  /**
   * Attach a stream for `clientId`, replaying whatever it missed after
   * `resumeFromSeq`. A repeat attach by the same client replaces the previous
   * writer, which is what a reconnect needs.
   */
  attach(
    clientId: string,
    channels: Set<string> | null,
    writer: EventWriter,
    resumeFromSeq = 0,
  ): AttachOutcome {
    this.assertAllowed(clientId);
    this.owner = clientId;
    const entry = this.entryFor(clientId);
    entry.channels = channels;
    entry.writer = writer;
    entry.lastSeenAt = Date.now();
    const outcome = entry.stream.attach(writer, resumeFromSeq);
    return { ...outcome, lastSeq: entry.stream.lastSeq };
  }

  /**
   * Detach a stream. Only the stream that is actually attached may detach, and
   * releasing it frees the backend for another client — that is how a crashed
   * shell eventually hands the backend back. The client's sequence/replay state
   * is kept so it can resume.
   */
  detach(clientId: string, writer: EventWriter): void {
    const entry = this.clients.get(clientId);
    if (!entry || entry.writer !== writer) return;
    entry.stream.detach();
    entry.writer = null;
    entry.channels = null;
    this.fireClose(entry);
    if (this.owner === clientId) this.owner = null;
  }

  /** True while `clientId` holds the backend. */
  isOwner(clientId: string): boolean {
    return this.owner === clientId;
  }

  /** The Subscriber for one client (created on demand for `Invoke` calls). */
  subscriberFor(clientId: string): Subscriber {
    return this.entryFor(clientId).subscriber;
  }

  /** Push a broadcast event to every client that asked for the channel. */
  broadcast(channel: string, payload: unknown, hasPayload = true): void {
    for (const entry of this.clients.values()) {
      if (entry.channels !== null && !entry.channels.has(channel)) continue;
      entry.stream.push(channel, payload, hasPayload);
    }
  }

  /** Number of clients currently attached (for the startup log). */
  get attachedCount(): number {
    let count = 0;
    for (const entry of this.clients.values()) {
      if (entry.writer !== null) count += 1;
    }
    return count;
  }

  private entryFor(clientId: string): ClientEntry {
    const existing = this.clients.get(clientId);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }

    this.evictIfNeeded();

    // Built in two steps: the Subscriber needs the entry, the entry holds the
    // Subscriber.
    const entry = {
      id: clientId,
      writer: null,
      channels: null,
      closeCallbacks: new Set<() => void>(),
      lastSeenAt: Date.now(),
      stream: new EventStream(),
    } as ClientEntry;
    entry.subscriber = this.makeSubscriber(entry);
    this.clients.set(clientId, entry);
    return entry;
  }

  /**
   * Keep the tracked-client map bounded. Only *detached* entries may be evicted:
   * dropping the owner's history would break its reconnect, and dropping an
   * attached one would silently stop its events.
   */
  private evictIfNeeded(): void {
    if (this.clients.size < MAX_TRACKED_CLIENTS) return;
    let victim: ClientEntry | null = null;
    for (const entry of this.clients.values()) {
      if (entry.writer !== null) continue;
      if (victim === null || entry.lastSeenAt < victim.lastSeenAt)
        victim = entry;
    }
    if (victim !== null) this.clients.delete(victim.id);
  }

  private makeSubscriber(entry: ClientEntry): Subscriber {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const registry = this;
    return {
      id: `client:${entry.id}`,
      get alive(): boolean {
        return registry.aliveOf(entry);
      },
      send(channel: string, payload: unknown): void {
        entry.stream.push(channel, payload, payload !== undefined);
      },
      onClose(callback: () => void): () => void {
        return registry.registerClose(entry, callback);
      },
    };
  }

  /** @internal */
  registerClose(entry: ClientEntry, callback: () => void): () => void {
    entry.closeCallbacks.add(callback);
    return () => {
      entry.closeCallbacks.delete(callback);
    };
  }

  /** @internal A subscriber is "alive" while its stream is attached. */
  aliveOf(entry: ClientEntry): boolean {
    return this.clients.get(entry.id) === entry && entry.writer !== null;
  }

  private fireClose(entry: ClientEntry): void {
    const callbacks = [...entry.closeCallbacks];
    entry.closeCallbacks.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        console.error(
          "[server] subscriber close callback failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}

/**
 * One registry per process: the business layer's `sendToRenderer` and the
 * `agentSession:bind` subscriptions both resolve through it.
 */
export const subscribers = new SubscriberRegistry();
