import * as grpc from "@grpc/grpc-js";
import { timingSafeEqual } from "crypto";
import { createReadStream, rmSync } from "fs";
import {
  discardUpload,
  finishUpload,
  processUploadChunk,
  type UploadState,
} from "./upload";
import {
  DOWNLOAD_CHUNK_BYTES,
  MAX_CONCURRENT_UPLOADS,
  checkDownloadable,
  keepsTempUpload,
} from "../rpc/files-guard";
import type { CallContext, Handler } from "../rpc/types";
import {
  IMBOSS_API_VERSION,
  IMBOSS_SERVICE_NAME,
  imbossServiceDefinition,
} from "../rpc/grpc-service";
import { UnsupportedOnHostError } from "../platform";
import { APP_VERSION } from "../version";
import type { ServerConfig } from "./config";
import {
  AlreadyConnectedError,
  subscribers,
  type EventWriter,
} from "./subscribers";

/**
 * The backend's gRPC surface: `Info`, `Invoke` and `Subscribe`.
 *
 * Three coarse methods carry the whole IPC channel table (see
 * `.pi/facts/grpc-remote-backend-research.md` §3): the channel name is the RPC
 * method id and the channel's positional arguments are the payload. That keeps
 * one implementation per channel, one validator (the existing `assert*` helpers)
 * and zero proto/TypeScript drift, at the cost of per-channel typed protos —
 * which the `method` metadata field compensates for in logs and limits.
 */

/** Upper bound for a single call; a hung handler must not pin a stream forever. */
const MAX_CALL_TIMEOUT_MS = 30 * 60 * 1000;
/** Default deadline when the caller does not ask for one. */
const DEFAULT_CALL_TIMEOUT_MS = 60 * 1000;

export interface RpcServerOptions {
  config: ServerConfig;
  /** Channel table from the shared registration functions. */
  handlers: Map<string, Handler>;
  /** Channel names, reported by `Info` and used for capability checks. */
  channels: string[];
}

export interface RpcServerHandle {
  /** Address actually bound (`host:port`, with the real port when `:0` was asked). */
  address: string;
  close(): Promise<void>;
}

/** Read and verify the bearer token; returns the caller's client id. */
function authorize(
  call:
    | grpc.ServerUnaryCall<unknown, unknown>
    | grpc.ServerWritableStream<unknown, unknown>
    | grpc.ServerReadableStream<unknown, unknown>,
  token: string,
): string {
  const values = call.metadata.get("authorization");
  const presented = values.length > 0 ? String(values[0]) : "";
  if (!safeEqual(presented, `Bearer ${token}`)) {
    throw serviceError(
      grpc.status.UNAUTHENTICATED,
      "Invalid or missing token.",
    );
  }
  const clientId = call.metadata.get("x-imboss-client");
  const id = clientId.length > 0 ? String(clientId[0]).trim() : "";
  if (id.length === 0 || id.length > 128) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      "Missing x-imboss-client metadata.",
    );
  }
  return id;
}

/** Constant-time comparison (length differences leak nothing useful). */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still compare something of the same length so the timing stays flat.
    const padded = Buffer.alloc(left.length);
    right.copy(padded);
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    timingSafeEqual(left, padded);
    return false;
  }
  return timingSafeEqual(left, right);
}

function serviceError(code: grpc.status, message: string): grpc.ServiceError {
  const error = new Error(message) as grpc.ServiceError;
  error.code = code;
  error.details = message;
  error.metadata = new grpc.Metadata();
  return error;
}

/** Map any thrown value onto a gRPC status without losing the message. */
function toServiceError(
  error: unknown,
  signal?: AbortSignal,
): grpc.ServiceError {
  if (error instanceof AlreadyConnectedError) {
    return serviceError(grpc.status.FAILED_PRECONDITION, error.message);
  }
  if (error instanceof UnsupportedOnHostError) {
    return serviceError(grpc.status.UNIMPLEMENTED, error.message);
  }
  if (signal?.aborted || isAbortError(error)) {
    return serviceError(grpc.status.CANCELLED, "Call cancelled by the client.");
  }
  if (isServiceError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  // Every channel handler reports user-facing problems by throwing an Error with
  // a readable message (`assertString`, "Conversation not found.", …). The status
  // is deliberately uniform: the renderer only ever shows the message, and the
  // status codes are for operators reading logs.
  return serviceError(grpc.status.FAILED_PRECONDITION, message);
}

function isServiceError(value: unknown): value is grpc.ServiceError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "number" &&
    typeof (value as { details?: unknown }).details === "string"
  );
}

function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "AbortError"
  );
}

/** `bytes` field from a JSON value (`undefined` is not representable). */
function toJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) ?? "null", "utf8");
}

export async function startRpcServer(
  options: RpcServerOptions,
): Promise<RpcServerHandle> {
  const { config, handlers, channels } = options;
  const liveCalls = new Set<grpc.ServerWritableStream<unknown, unknown>>();
  /** Upload streams currently open, per the documented concurrency limit. */
  let openUploads = 0;

  const service = {
    Info(
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ): void {
      try {
        authorize(call, config.token);
        callback(null, {
          appVersion: APP_VERSION,
          apiVersion: IMBOSS_API_VERSION,
          dataRoot: config.dataRoot,
          channels,
          singleClient: true,
        });
      } catch (error) {
        callback(toServiceError(error));
      }
    },

    async Invoke(
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ): Promise<void> {
      const startedAt = Date.now();
      let method = "";
      let clientId = "";
      try {
        clientId = authorize(call, config.token);
        subscribers.assertAllowed(clientId);

        const request = call.request as {
          method?: string;
          argsJson?: Buffer | Uint8Array;
          timeoutMs?: number;
        };
        method = typeof request.method === "string" ? request.method : "";
        const handler = handlers.get(method);
        if (!handler) {
          throw serviceError(
            grpc.status.UNIMPLEMENTED,
            `Unknown channel "${method}".`,
          );
        }

        const args = parseArgs(request.argsJson);
        const controller = new AbortController();
        const timeoutMs = clampTimeout(request.timeoutMs);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onCancelled = (): void => controller.abort();
        call.on("cancelled", onCancelled);

        let result: unknown;
        try {
          const ctx: CallContext = {
            subscriber: subscribers.subscriberFor(clientId),
            signal: controller.signal,
          };
          result = await handler(ctx, ...args);
        } finally {
          clearTimeout(timer);
          call.removeListener("cancelled", onCancelled);
        }

        callback(null, {
          resultJson: toJsonBytes(result),
          hasResult: result !== undefined,
        });
        logCall(method, clientId, "OK", startedAt);
      } catch (error) {
        const serviceFailure = toServiceError(error);
        callback(serviceFailure);
        logCall(
          method.length > 0 ? method : "<unknown>",
          clientId.length > 0 ? clientId : "<unauthenticated>",
          grpc.status[serviceFailure.code] ?? String(serviceFailure.code),
          startedAt,
        );
      }
    },

    Subscribe(call: grpc.ServerWritableStream<unknown, unknown>): void {
      let clientId: string;
      try {
        clientId = authorize(call, config.token);
      } catch (error) {
        failStream(call, toServiceError(error));
        return;
      }

      const request = call.request as {
        channels?: string[];
        resumeFromSeq?: number;
      };
      const requested = Array.isArray(request.channels)
        ? request.channels.filter((entry) => typeof entry === "string")
        : [];
      const filter = requested.length > 0 ? new Set(requested) : null;
      const resumeFromSeq =
        typeof request.resumeFromSeq === "number" &&
        Number.isFinite(request.resumeFromSeq) &&
        request.resumeFromSeq > 0
          ? request.resumeFromSeq
          : 0;

      // Control events bypass the pump's sequence: they describe the stream
      // itself and carry the position the client should adopt.
      const writeControl = (
        channel: string,
        payload: Record<string, unknown>,
      ): void => {
        call.write({
          channel,
          payloadJson: toJsonBytes(payload),
          hasPayload: true,
          seq: 0,
          dropped: 0,
        });
      };

      const writer: EventWriter = (event) => {
        call.write({
          channel: event.channel,
          payloadJson: event.hasPayload
            ? toJsonBytes(event.payload)
            : Buffer.alloc(0),
          hasPayload: event.hasPayload,
          seq: event.seq,
          dropped: event.dropped,
        });
      };

      let outcome;
      try {
        outcome = subscribers.attach(clientId, filter, writer, resumeFromSeq);
      } catch (error) {
        failStream(call, toServiceError(error));
        return;
      }

      liveCalls.add(call);
      console.log(
        `[server] client ${clientId} subscribed` +
          (resumeFromSeq > 0
            ? ` (resume from #${resumeFromSeq}: replayed ${outcome.resumed}${outcome.resync ? `, resync ${outcome.resync}` : ""})`
            : ""),
      );
      if (outcome.resync !== null) {
        // The gap is too large to replay: tell the client to refetch snapshots
        // instead of leaving it with a silently incomplete view.
        writeControl("server:resync", {
          reason: outcome.resync,
          missedFrom: resumeFromSeq,
          lastSeq: outcome.lastSeq,
        });
      }
      writeControl("server:subscribed", {
        at: Date.now(),
        resumed: outcome.resumed,
        lastSeq: outcome.lastSeq,
      });

      // `cancelled` and `close` can both fire; the detach itself is idempotent,
      // the log line should not be.
      let detached = false;
      const detach = (): void => {
        if (detached) return;
        detached = true;
        liveCalls.delete(call);
        subscribers.detach(clientId, writer);
        console.log(`[server] client ${clientId} disconnected`);
      };
      call.on("cancelled", detach);
      call.on("error", detach);
      call.on("close", detach);
    },
  };

  const upload = async (
    call: grpc.ServerReadableStream<unknown, unknown>,
    callback: grpc.sendUnaryData<unknown>,
  ): Promise<void> => {
    const startedAt = Date.now();
    let clientId = "";
    let channel = "";
    // Declared before the try so the catch can clean up a temp file.
    const state: UploadState = {
      meta: null,
      chunks: [],
      sink: null,
      received: 0,
    };
    try {
      clientId = authorize(call, config.token);
      subscribers.assertAllowed(clientId);
      if (openUploads >= MAX_CONCURRENT_UPLOADS) {
        throw serviceError(
          grpc.status.RESOURCE_EXHAUSTED,
          `Too many concurrent uploads (limit ${MAX_CONCURRENT_UPLOADS}).`,
        );
      }
      openUploads += 1;

      console.log(`[server] upload started (client=${clientId})`);
      await new Promise<void>((resolve, reject) => {
        call.on("data", (chunk: unknown) => {
          try {
            processUploadChunk(state, chunk);
          } catch (error) {
            reject(error);
            call.destroy();
          }
        });
        call.on("end", () => resolve());
        call.on("error", (error: Error) => reject(error));
        call.on("cancelled", () =>
          reject(serviceError(grpc.status.CANCELLED, "Upload cancelled.")),
        );
      });

      if (state.meta === null) {
        throw serviceError(
          grpc.status.INVALID_ARGUMENT,
          "Upload sent no metadata.",
        );
      }
      console.log(
        `[server] upload received ${state.received} bytes for ${state.meta.channel}`,
      );
      channel = state.meta.channel;
      const handler = handlers.get(channel);
      if (!handler) {
        throw serviceError(
          grpc.status.UNIMPLEMENTED,
          `Unknown channel "${channel}".`,
        );
      }

      const args = parseArgs(Buffer.from(state.meta.argsJson));
      const outcome = await finishUpload(state);

      const controller = new AbortController();
      const ctx: CallContext = {
        subscriber: subscribers.subscriberFor(clientId),
        signal: controller.signal,
      };
      let result: unknown;
      try {
        result = await handler(ctx, ...args, outcome.payload);
      } finally {
        // A streamed upload normally exists only so this handler can consume it:
        // remove it even when the handler throws, so a failed import cannot
        // accumulate. Staging channels are the exception — their path is the
        // result.
        if (outcome.tempPath !== null && !keepsTempUpload(channel)) {
          rmSync(outcome.tempPath, { force: true });
        }
      }
      callback(null, {
        resultJson: toJsonBytes(result),
        hasResult: result !== undefined,
      });
      logCall(`upload:${channel}`, clientId, "OK", startedAt);
    } catch (error) {
      discardUpload(state);
      const serviceFailure = toServiceError(error);
      callback(serviceFailure);
      logCall(
        channel.length > 0 ? `upload:${channel}` : "upload",
        clientId.length > 0 ? clientId : "<unauthenticated>",
        grpc.status[serviceFailure.code] ?? String(serviceFailure.code),
        startedAt,
      );
    } finally {
      if (clientId.length > 0) openUploads = Math.max(0, openUploads - 1);
    }
  };

  const download = async (
    call: grpc.ServerWritableStream<unknown, unknown>,
  ): Promise<void> => {
    const startedAt = Date.now();
    let clientId = "";
    let path = "";
    try {
      clientId = authorize(call, config.token);
      subscribers.assertAllowed(clientId);
      const request = call.request as { path?: string };
      path = typeof request.path === "string" ? request.path : "";

      const denial = checkDownloadable(path);
      if (denial !== null) {
        throw serviceError(
          denial.code === "missing"
            ? grpc.status.NOT_FOUND
            : grpc.status.PERMISSION_DENIED,
          denial.message,
        );
      }

      // Stream in bounded chunks, respecting the stream's backpressure so a slow
      // client never balloons the server's memory.
      const file = createReadStream(path, {
        highWaterMark: DOWNLOAD_CHUNK_BYTES,
      });
      for await (const chunk of file) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
        for (
          let offset = 0;
          offset < buffer.length;
          offset += DOWNLOAD_CHUNK_BYTES
        ) {
          const slice = buffer.subarray(offset, offset + DOWNLOAD_CHUNK_BYTES);
          if (!call.write({ data: slice })) await onceDrain(call);
        }
      }
      call.end();
      logCall("download", clientId, "OK", startedAt);
    } catch (error) {
      const serviceFailure = toServiceError(error);
      // NOT `call.destroy(error)`: that closes the stream, and grpc-js sends the
      // trailing status from `_final` — which never runs on a destroyed stream,
      // so the client would see the call hang instead of the failure. Its
      // `'error'` listener is the documented path: it records the status and
      // ends the stream.
      failStream(call, serviceFailure);
      logCall(
        "download",
        clientId.length > 0 ? clientId : "<unauthenticated>",
        grpc.status[serviceFailure.code] ?? String(serviceFailure.code),
        startedAt,
      );
      void path;
    }
  };

  const server = new grpc.Server();
  server.addService(imbossServiceDefinition, {
    ...service,
    Upload: upload,
    Download: download,
  } as unknown as grpc.UntypedServiceImplementation);

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      config.listen,
      // TLS is a documented follow-up; see the risk note printed by the
      // bootstrap and the packaged README.
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    );
  });

  // `:0` asks the OS for a free port; report the real one so tests (and an
  // operator reading the log) see where it actually landed.
  const host = config.listen.slice(0, config.listen.lastIndexOf(":"));
  const address = boundPort > 0 ? `${host}:${boundPort}` : config.listen;

  console.log(
    `[server] ${IMBOSS_SERVICE_NAME} listening on ${address} (api v${IMBOSS_API_VERSION})`,
  );

  return {
    address,
    async close(): Promise<void> {
      for (const call of liveCalls) {
        try {
          call.end();
        } catch {
          // The stream may already be gone.
        }
      }
      liveCalls.clear();
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}

/** The payload is the positional argument array of the channel. */
function parseArgs(raw: Buffer | Uint8Array | undefined): unknown[] {
  if (raw === undefined || raw.length === 0) return [];
  const text = Buffer.from(raw).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw serviceError(grpc.status.INVALID_ARGUMENT, "argsJson is not JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw serviceError(
      grpc.status.INVALID_ARGUMENT,
      "argsJson must be a JSON array.",
    );
  }
  return parsed;
}

/**
 * Fail a server-*streaming* call.
 *
 * Must emit `'error'` rather than `destroy()`: grpc-js's writable stream records
 * the status in an `'error'` listener and sends it from `_final`, which never
 * runs once the stream is destroyed — the client would hang until its deadline
 * instead of seeing the error.
 */
function failStream(
  call: grpc.ServerWritableStream<unknown, unknown>,
  error: grpc.ServiceError,
): void {
  try {
    call.emit("error", error);
  } catch {
    // The stream was already finished; nothing left to report.
  }
}

/** Resolve when the stream drains, or after a bounded wait (a stalled peer). */
function onceDrain(
  call: grpc.ServerWritableStream<unknown, unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      call.removeListener("drain", done);
      call.removeListener("close", done);
      resolve();
    };
    const timer = setTimeout(done, 5000);
    call.once("drain", done);
    call.once("close", done);
  });
}

function clampTimeout(requested: number | undefined): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return DEFAULT_CALL_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_CALL_TIMEOUT_MS);
}

function logCall(
  method: string,
  clientId: string,
  status: string,
  startedAt: number,
): void {
  const ms = Date.now() - startedAt;
  console.log(`[rpc] ${method} client=${clientId} status=${status} ${ms}ms`);
}
