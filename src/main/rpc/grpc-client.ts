import * as grpc from "@grpc/grpc-js";
import { randomUUID } from "crypto";
import { createReadStream, createWriteStream, statSync } from "fs";
import { mkdir } from "fs/promises";
import { basename, dirname } from "path";
import { IMBOSS_SERVICE_NAME, imbossServiceDefinition } from "./grpc-service";
import { DEFAULT_TIMEOUT_MS, timeoutForChannel } from "./timeouts";

/**
 * The desktop side of the remote transport.
 *
 * Lives in the Electron **main** process (not the renderer): grpc-js needs
 * Node's `http2`/`tls`, and keeping it here means the renderer, the preload
 * contract and the CSP stay exactly as they are. Every channel call is one
 * unary `Invoke`; every main → renderer event arrives on one long-lived
 * `Subscribe` stream that is re-established automatically.
 *
 * Authentication: the shared token rides in `authorization` metadata on every
 * call. It is never logged and never reached the renderer (the shell keeps it in
 * this process only).
 */

/** Metadata keys the backend understands. */
const TOKEN_HEADER = "authorization";
const CLIENT_ID_HEADER = "x-imboss-client";
const APP_VERSION_HEADER = "x-imboss-app-version";

export interface RemoteEndpoint {
  /** `host:port`. */
  target: string;
  token: string;
  /** Stable per app launch, so a reconnect keeps the same single-client slot. */
  clientId: string;
  /** Reported in logs on both ends. */
  appVersion: string;
}

export interface RemoteInfo {
  appVersion: string;
  apiVersion: number;
  dataRoot: string;
  channels: string[];
  singleClient: boolean;
}

/** Shapes of the generated client we actually call. */
interface ImbossStub extends grpc.Client {
  Info(
    request: Record<string, never>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply?: unknown) => void,
  ): grpc.ClientUnaryCall;
  Invoke(
    request: { method: string; argsJson: Buffer; timeoutMs: number },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply?: unknown) => void,
  ): grpc.ClientUnaryCall;
  Subscribe(
    request: { channels: string[]; resumeFromSeq?: number },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<unknown>;
  Upload(
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply?: unknown) => void,
  ): grpc.ClientWritableStream<unknown>;
  Download(
    request: { path: string; version: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<unknown>;
}

/** Non-retryable statuses: nothing will change by trying again. */
const FATAL_STATUSES = new Set<number>([
  grpc.status.UNAUTHENTICATED,
  grpc.status.PERMISSION_DENIED,
  grpc.status.FAILED_PRECONDITION,
  grpc.status.UNIMPLEMENTED,
]);

/** Upload chunk size: one HTTP/2 frame-ish, keeps memory flat. */
const UPLOAD_CHUNK_BYTES = 256 * 1024;
/** How many uploads may be in flight at once from this client. */
const MAX_CONCURRENT_UPLOADS = 2;
/** Attempts per upload (the `.partial`/memory discipline makes a retry safe). */
const UPLOAD_ATTEMPTS = 3;
/** Statuses worth retrying: transport-level trouble, not a rejected request. */
const RETRYABLE_STATUSES = new Set<number>([
  grpc.status.UNAVAILABLE,
  grpc.status.INTERNAL,
  grpc.status.DEADLINE_EXCEEDED,
  grpc.status.CANCELLED,
]);

const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;
/** How long `connect()` waits for the stream handshake. */
const CONNECT_TIMEOUT_MS = 20_000;

export type EventSink = (channel: string, payload: unknown) => void;

/**
 * Called when the event history could not be replayed (server restarted, or the
 * outage outlasted the backend's buffer): everything the UI holds may be stale,
 * so the shell asks the renderer to refetch its snapshots.
 */
export type ResyncHandler = (reason: string) => void;

export class RemoteClient {
  private readonly stub: ImbossStub;
  private readonly metadata: grpc.Metadata;

  private sink: EventSink | null = null;
  private onResync: ResyncHandler | null = null;
  /**
   * Highest `Event.seq` applied. Sent back on reconnect so the backend can replay
   * exactly what was missed.
   */
  private lastSeq = 0;
  private stream: grpc.ClientReadableStream<unknown> | null = null;
  private retryDelay = MIN_RETRY_DELAY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastError: string | null = null;

  constructor(endpoint: RemoteEndpoint) {
    this.metadata = new grpc.Metadata();
    this.metadata.set(TOKEN_HEADER, `Bearer ${endpoint.token}`);
    this.metadata.set(CLIENT_ID_HEADER, endpoint.clientId);
    this.metadata.set(APP_VERSION_HEADER, endpoint.appVersion);

    const Stub = grpc.makeGenericClientConstructor(
      imbossServiceDefinition,
      "Imboss",
    ) as unknown as new (
      target: string,
      credentials: grpc.ChannelCredentials,
    ) => ImbossStub;
    // v1 serves plaintext gRPC; TLS is an accepted follow-up. The token is the
    // only protection, which is why the backend defaults are documented in the
    // packaged README.
    this.stub = new Stub(endpoint.target, grpc.credentials.createInsecure());
  }

  /** Handshake: verify the token, learn the backend's version and channel table. */
  async info(): Promise<RemoteInfo> {
    const reply = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        this.stub.Info(
          {},
          this.metadata,
          { deadline: Date.now() + CONNECT_TIMEOUT_MS },
          (error, value) => {
            if (error) {
              reject(remoteError(error));
              return;
            }
            resolve((value ?? {}) as Record<string, unknown>);
          },
        );
      },
    );

    const channels = Array.isArray(reply["channels"])
      ? (reply["channels"] as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];

    return {
      appVersion: asString(reply["appVersion"]),
      apiVersion: asNumber(reply["apiVersion"]),
      dataRoot: asString(reply["dataRoot"]),
      channels,
      singleClient: reply["singleClient"] === true,
    };
  }

  /** One channel call. Rejections carry the backend's own message. */
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    const timeoutMs = timeoutForChannel(method);
    const request = {
      method,
      argsJson: Buffer.from(JSON.stringify(args) ?? "[]", "utf8"),
      timeoutMs,
    };

    const reply = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        this.stub.Invoke(
          request,
          this.metadata,
          // The server enforces its own deadline; the client's is slightly later so
          // a timeout surfaces as the backend's status, not a bare CANCELLED.
          { deadline: Date.now() + timeoutMs + 5_000 },
          (error, value) => {
            if (error) {
              reject(remoteError(error));
              return;
            }
            resolve((value ?? {}) as Record<string, unknown>);
          },
        );
      },
    );

    if (reply["hasResult"] !== true) return undefined;
    const raw = reply["resultJson"];
    const text =
      raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : "";
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("The remote backend returned malformed JSON.");
    }
  }

  /**
   * Send `bytes` to a channel on the backend, which receives them as its last
   * positional argument. Returns that channel's result (e.g. a
   * `MessageAttachment` carrying the backend path).
   *
   * Concurrency is capped and retried: an interrupted upload leaves nothing
   * behind on the backend (its stream ends without the terminating call), so a
   * retry is always safe. Only transport failures are retried — a rejected
   * request (bad args, too large) is reported to the caller unchanged.
   */
  async upload(
    channel: string,
    args: unknown[],
    bytes: Uint8Array,
    fileName: string,
  ): Promise<unknown> {
    await this.acquireUploadSlot();
    try {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
        try {
          return await this.uploadOnce(channel, args, bytes, fileName);
        } catch (error) {
          lastError = error;
          const code = (error as { code?: number }).code;
          if (code === undefined || !RETRYABLE_STATUSES.has(code)) throw error;
          if (attempt === UPLOAD_ATTEMPTS) break;
          const delayMs = Math.min(
            MIN_RETRY_DELAY_MS * attempt,
            MAX_RETRY_DELAY_MS,
          );
          console.warn(
            `[remote] upload ${channel} failed (${describeGrpcError(error)}); retry ${attempt}/${UPLOAD_ATTEMPTS - 1} in ${delayMs}ms`,
          );
          await delay(delayMs);
        }
      }
      throw lastError;
    } finally {
      this.releaseUploadSlot();
    }
  }

  /**
   * Upload a **local file** without reading it into memory.
   *
   * The backend writes it to a temp file and hands that path to `channel`, which
   * is how a multi-hundred-megabyte import works on both sides. Same retry and
   * concurrency policy as {@link upload}.
   */
  async uploadFile(
    channel: string,
    args: unknown[],
    localPath: string,
  ): Promise<unknown> {
    const size = statSync(localPath).size;
    await this.acquireUploadSlot();
    try {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
        try {
          return await this.uploadFileOnce(channel, args, localPath, size);
        } catch (error) {
          lastError = error;
          const code = (error as { code?: number }).code;
          if (code === undefined || !RETRYABLE_STATUSES.has(code)) throw error;
          if (attempt === UPLOAD_ATTEMPTS) break;
          const delayMs = Math.min(
            MIN_RETRY_DELAY_MS * attempt,
            MAX_RETRY_DELAY_MS,
          );
          console.warn(
            `[remote] upload ${channel} failed (${describeGrpcError(error)}); retry ${attempt}/${UPLOAD_ATTEMPTS - 1} in ${delayMs}ms`,
          );
          await delay(delayMs);
        }
      }
      throw lastError;
    } finally {
      this.releaseUploadSlot();
    }
  }

  /**
   * Stream one local file to the backend's temp folder.
   *
   * Chunks come from disk so neither side ever holds the whole file: this is the
   * path a 2 GB backup import takes.
   */
  private uploadFileOnce(
    channel: string,
    args: unknown[],
    localPath: string,
    totalBytes: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const call = this.stub.Upload(
        this.metadata,
        { deadline: Date.now() + 60 * 60 * 1000 },
        (error: grpc.ServiceError | null, reply?: unknown) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(remoteError(error));
            return;
          }
          const value = (reply ?? {}) as {
            resultJson?: Uint8Array;
            hasResult?: boolean;
          };
          if (value.hasResult !== true) {
            resolve(undefined);
            return;
          }
          const text = value.resultJson
            ? Buffer.from(value.resultJson).toString("utf8")
            : "";
          resolve(text.length === 0 ? undefined : (JSON.parse(text) as unknown));
        },
      );
      call.on("error", (error: grpc.ServiceError) => {
        if (settled) return;
        settled = true;
        reject(remoteError(error));
      });

      call.write({
        meta: {
          channel,
          argsJson: Buffer.from(JSON.stringify(args), "utf8"),
          totalBytes,
          uploadId: randomUUID(),
          fileName: basename(localPath),
          toTempFile: true,
        },
      });

      // Read from disk chunk by chunk; when the transport pushes back, pause the
      // file stream and resume on the next tick so a big import keeps the event
      // loop (and the event stream) breathing.
      const source = createReadStream(localPath, {
        highWaterMark: UPLOAD_CHUNK_BYTES,
      });
      source.on("data", (chunk: Buffer | string) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (!call.write({ data: buffer })) {
          source.pause();
          setTimeout(() => source.resume(), 4);
        }
      });
      source.on("end", () => call.end());
      source.on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        cancelQuietly(call);
        reject(error);
      });
    });
  }

  /**
   * One file from the backend, as a `Response` body for the `imb-file:` scheme.
   *
   * A plain `ReadableStream` around the gRPC call (rather than a Node `Readable`
   * wrapper): the web stream starts pulling immediately, which is exactly what
   * `<img>` does, and cancelling the image cancels the call.
   */
  downloadResponse(path: string, version = ""): Response {
    const call = this.stub.Download({ path, version }, this.metadata, {
      deadline: Date.now() + 10 * 60 * 1000,
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        call.on("data", (chunk: unknown) => {
          const data = (chunk as { data?: Uint8Array }).data;
          if (data instanceof Uint8Array) controller.enqueue(data);
        });
        call.on("end", () => controller.close());
        call.on("error", (error: grpc.ServiceError) => {
          try {
            controller.error(remoteError(error));
          } catch {
            // Already closed by the consumer.
          }
        });
      },
      cancel() {
        cancelQuietly(call);
      },
    });
    return new Response(body);
  }

  /**
   * Download one file into `target` (parents created). Writes with backpressure
   * so a large archive never buffers in memory.
   */
  async downloadToFile(
    path: string,
    target: string,
    version = "",
  ): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const call = this.stub.Download({ path, version }, this.metadata, {
      deadline: Date.now() + 30 * 60 * 1000,
    });

    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(target, { mode: 0o600 });
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        // A call the server already closed cannot be cancelled; the throw would
        // escape the event handler and leave this promise pending forever.
        cancelQuietly(call);
        out.destroy();
        reject(error);
      };
      call.on("data", (chunk: unknown) => {
        const data = (chunk as { data?: Uint8Array }).data;
        if (!(data instanceof Uint8Array)) return;
        if (!out.write(Buffer.from(data))) {
          call.pause();
          out.once("drain", () => call.resume());
        }
      });
      call.on("end", () => {
        out.end();
      });
      call.on("error", (error: grpc.ServiceError) => fail(remoteError(error)));
      out.on("finish", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      out.on("error", (error: Error) => fail(error));
    });
  }

  private uploadSlotsInUse = 0;
  private readonly uploadWaiters: Array<() => void> = [];

  private async acquireUploadSlot(): Promise<void> {
    if (this.uploadSlotsInUse < MAX_CONCURRENT_UPLOADS) {
      this.uploadSlotsInUse += 1;
      return;
    }
    await new Promise<void>((resolve) => this.uploadWaiters.push(resolve));
    this.uploadSlotsInUse += 1;
  }

  private releaseUploadSlot(): void {
    this.uploadSlotsInUse = Math.max(0, this.uploadSlotsInUse - 1);
    const next = this.uploadWaiters.shift();
    if (next) next();
  }

  private uploadOnce(
    channel: string,
    args: unknown[],
    bytes: Uint8Array,
    fileName: string,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      // Client-streaming with a single reply: the callback answers it, so there
      // is no `data` event to listen for.
      const call = this.stub.Upload(
        this.metadata,
        { deadline: Date.now() + 10 * 60 * 1000 },
        (error: grpc.ServiceError | null, reply?: unknown) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(remoteError(error));
            return;
          }
          const value = (reply ?? {}) as {
            resultJson?: Uint8Array;
            hasResult?: boolean;
          };
          if (value.hasResult !== true) {
            resolve(undefined);
            return;
          }
          const text = value.resultJson
            ? Buffer.from(value.resultJson).toString("utf8")
            : "";
          resolve(
            text.length === 0 ? undefined : (JSON.parse(text) as unknown),
          );
        },
      );
      call.on("error", (error: grpc.ServiceError) => {
        if (settled) return;
        settled = true;
        reject(remoteError(error));
      });

      call.write({
        meta: {
          channel,
          argsJson: Buffer.from(JSON.stringify(args), "utf8"),
          totalBytes: bytes.length,
          uploadId: randomUUID(),
          fileName,
        },
      });
      for (
        let offset = 0;
        offset < bytes.length;
        offset += UPLOAD_CHUNK_BYTES
      ) {
        call.write({
          data: Buffer.from(
            bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES),
          ),
        });
      }
      call.end();
    });
  }

  /**
   * Open the event stream (idempotent). `sink` receives every pushed channel and
   * is re-used across reconnects.
   */
  startEvents(sink: EventSink, onResync?: ResyncHandler): void {
    this.sink = sink;
    this.onResync = onResync ?? null;
    if (this.stream !== null || this.stopped) return;
    this.openStream();
  }

  /** Resolves once the backend acknowledged the subscription (or rejects). */
  async waitForSubscription(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.subscribed) return;
      if (this.stopped) throw new Error("The remote client was closed.");
      if (this.lastError !== null && FATAL_STATUSES.has(this.lastFatalCode)) {
        throw new Error(this.lastError);
      }
      await delay(100);
    }
    throw new Error(
      this.lastError ?? "The remote backend did not confirm the subscription.",
    );
  }

  /** Parse an event payload (JSON envelope); `MALFORMED` when it is not JSON. */
  private decodePayload(event: {
    payloadJson?: Uint8Array;
    hasPayload?: boolean;
  }): unknown {
    if (event.hasPayload !== true || !event.payloadJson) return undefined;
    const text = Buffer.from(event.payloadJson).toString("utf8");
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return MALFORMED;
    }
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stream?.cancel();
    this.stream = null;
    this.stub.close();
  }

  private subscribed = false;
  private lastFatalCode = -1;

  private openStream(): void {
    this.subscribed = false;
    // No channel filter: a desktop shell wants every event the backend can push
    // (the filter exists for future multi-purpose clients). `resumeFromSeq` asks
    // the backend to replay what this client missed — a reconnect after a blip
    // then loses nothing instead of forcing a snapshot refetch.
    const stream = this.stub.Subscribe(
      { channels: [], resumeFromSeq: this.lastSeq },
      this.metadata,
      {},
    );
    this.stream = stream;

    stream.on("data", (value: unknown) => {
      const event = (value ?? {}) as {
        channel?: unknown;
        payloadJson?: Uint8Array;
        hasPayload?: boolean;
        seq?: unknown;
        dropped?: unknown;
      };
      const channel = asString(event.channel);
      if (channel === "") return;

      const seq = typeof event.seq === "number" ? event.seq : 0;

      if (channel === "server:subscribed" || channel === "server:resync") {
        // Control events describe the stream itself: adopt the backend's
        // position, then (only for a resync) tell the shell to refetch.
        const payload = this.decodePayload(event) as
          { lastSeq?: unknown; reason?: unknown } | undefined;
        const reported = payload?.lastSeq;
        if (typeof reported === "number" && reported >= 0) {
          this.lastSeq = reported;
        }
        this.subscribed = true;
        this.retryDelay = MIN_RETRY_DELAY_MS;
        this.lastError = null;
        if (channel === "server:resync") {
          const reason =
            typeof payload?.reason === "string"
              ? payload.reason
              : "history-lost";
          console.warn(
            `[remote] event history is not resumable (${reason}); asking the renderer to refetch`,
          );
          this.onResync?.(reason);
        }
        return;
      }

      // Stale (already applied) or out of order: drop it. This is what makes a
      // replayed window safe even if the backend replays from an older point.
      if (seq > 0 && seq <= this.lastSeq) return;

      const payload = this.decodePayload(event);
      if (payload === MALFORMED) {
        console.error(`[remote] malformed payload on ${channel}`);
        return;
      }

      const dropped = typeof event.dropped === "number" ? event.dropped : 0;
      if (dropped > 0) {
        // The backend had to discard events (slow reader). The UI may be
        // incomplete from here on, so refetch before rendering further.
        console.warn(
          `[remote] backend dropped ${dropped} event(s) before ${channel}; asking the renderer to refetch`,
        );
        this.onResync?.("backpressure");
      }

      if (seq > 0) {
        if (this.lastSeq > 0 && seq !== this.lastSeq + 1) {
          // A hole we never saw a control event for: treat it as lost history.
          console.warn(
            `[remote] event gap: expected #${this.lastSeq + 1}, got #${seq}; asking the renderer to refetch`,
          );
          this.onResync?.("history-lost");
        }
        this.lastSeq = seq;
      }

      this.sink?.(channel, payload);
    });

    stream.on("error", (error: grpc.ServiceError) => {
      this.lastError = remoteError(error).message;
      this.lastFatalCode = error.code;
      this.scheduleReconnect(error);
    });

    stream.on("end", () => {
      this.scheduleReconnect(null);
    });
  }

  private scheduleReconnect(error: grpc.ServiceError | null): void {
    if (this.stream !== null) {
      this.stream.removeAllListeners();
      this.stream = null;
    }
    this.subscribed = false;
    if (this.stopped) return;

    if (error !== null && FATAL_STATUSES.has(error.code)) {
      // A policy answer (bad token, second client): retrying would only spam the
      // backend log. Surface it once and stay down until the app restarts.
      console.error(`[remote] event stream refused: ${this.lastError}`);
      this.stopped = true;
      return;
    }

    const delayMs = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
    console.warn(
      `[remote] event stream lost (${this.lastError ?? "closed"}); retrying in ${delayMs}ms`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.openStream();
    }, delayMs);
  }
}

/** Sentinel for a payload that is not JSON (dropped, never forwarded). */
const MALFORMED = Symbol("malformed-payload");

/** The renderer-visible message: the backend's own text, never a stack. */
function remoteError(error: grpc.ServiceError): Error {
  const message =
    typeof error.details === "string" && error.details.length > 0
      ? error.details
      : error.message ||
        `Remote call failed (${grpc.status[error.code] ?? error.code}).`;
  const wrapped = new Error(message) as Error & { code?: number };
  wrapped.name =
    error.code === grpc.status.UNAUTHENTICATED
      ? "RemoteAuthError"
      : "RemoteCallError";
  // Keep the status so callers can tell "no such file" from "backend is down".
  wrapped.code = error.code;
  return wrapped;
}

/**
 * `ClientReadableStream.cancel()` throws when the call already finished. A
 * cancelled/failed stream is exactly when we call it, so the throw has to be
 * swallowed rather than turned into an unhandled rejection.
 */
function cancelQuietly(call: { cancel(): void }): void {
  try {
    call.cancel();
  } catch {
    // Already ended: nothing to cancel.
  }
}

/** Short, log-friendly description of a gRPC failure. */
function describeGrpcError(error: unknown): string {
  const failure = error as { code?: number; details?: string };
  if (typeof failure.code === "number") {
    return `${grpc.status[failure.code] ?? failure.code}: ${failure.details ?? ""}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh client id (one per desktop launch). */
export function newClientId(): string {
  return randomUUID();
}

export { DEFAULT_TIMEOUT_MS, IMBOSS_SERVICE_NAME };
