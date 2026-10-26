import * as grpc from "@grpc/grpc-js";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { MAX_STREAMED_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from "../rpc/files-guard";
import { getTransferTempRoot } from "../file-browser";

/**
 * Server-side accumulation of one upload stream.
 *
 * Two modes, chosen by the client per upload:
 *
 * - **memory** (default) — the bytes are buffered and handed to the channel
 *   handler as a `Buffer`. Bounded by {@link MAX_UPLOAD_BYTES}. An aborted upload
 *   leaves nothing behind: the "no half-written file" guarantee is structural,
 *   not a cleanup path.
 * - **temp file** (`meta.to_temp_file`) — the bytes go straight to disk and the
 *   handler receives the **path**. This is what makes a 2 GB backup import
 *   possible without ever holding it in RAM; an aborted upload leaves a
 *   `.partial` file, which the startup sweep removes.
 *
 * The cap is enforced while streaming, not only from `meta.total_bytes`: a client
 * that lies about the size must still be stopped before it can exhaust anything.
 */

export interface UploadMeta {
  channel: string;
  argsJson: Uint8Array;
  totalBytes: number;
  uploadId: string;
  fileName: string;
  toTempFile: boolean;
}

export interface UploadState {
  meta: UploadMeta | null;
  /** Memory mode only. */
  chunks: Buffer[];
  /** Temp-file mode only: where the bytes are being written. */
  sink: { path: string; stream: ReturnType<typeof createWriteStream> } | null;
  received: number;
}

export interface UploadOutcome {
  /** What to append as the channel's last argument. */
  payload: Buffer | string;
  /** Set in temp-file mode: delete this after the handler has consumed it. */
  tempPath: string | null;
}

/** Consume one `UploadChunk` message (meta first, then data). */
export function processUploadChunk(state: UploadState, raw: unknown): void {
  const chunk = (raw ?? {}) as {
    meta?: {
      channel?: unknown;
      argsJson?: Uint8Array;
      totalBytes?: number;
      uploadId?: unknown;
      fileName?: unknown;
      toTempFile?: unknown;
    };
    data?: Uint8Array;
  };

  if (chunk.meta) {
    if (state.meta !== null) {
      throw uploadError(grpc.status.INVALID_ARGUMENT, "Upload sent metadata twice.");
    }
    const channel =
      typeof chunk.meta.channel === "string" ? chunk.meta.channel : "";
    if (channel.length === 0) {
      throw uploadError(grpc.status.INVALID_ARGUMENT, "Upload metadata has no channel.");
    }
    const totalBytes =
      typeof chunk.meta.totalBytes === "number" ? chunk.meta.totalBytes : 0;
    if (!Number.isFinite(totalBytes) || totalBytes < 0) {
      throw uploadError(grpc.status.INVALID_ARGUMENT, "Upload size is invalid.");
    }
    const toTempFile = chunk.meta.toTempFile === true;
    const cap = toTempFile ? MAX_STREAMED_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
    if (totalBytes > cap) {
      throw uploadError(
        grpc.status.RESOURCE_EXHAUSTED,
        `Upload is too large (${totalBytes} bytes, limit ${cap}).`,
      );
    }
    state.meta = {
      channel,
      argsJson:
        chunk.meta.argsJson instanceof Uint8Array
          ? chunk.meta.argsJson
          : Buffer.alloc(0),
      totalBytes,
      uploadId:
        typeof chunk.meta.uploadId === "string" ? chunk.meta.uploadId : "",
      fileName:
        typeof chunk.meta.fileName === "string" ? chunk.meta.fileName : "",
      toTempFile,
    };
    if (toTempFile) state.sink = openSink(state.meta);
    return;
  }

  if (!(chunk.data instanceof Uint8Array)) {
    // An empty `oneof` (or an unknown field) is not a data frame.
    return;
  }
  if (state.meta === null) {
    throw uploadError(
      grpc.status.INVALID_ARGUMENT,
      "Upload sent data before its metadata.",
    );
  }
  const cap = state.meta.toTempFile ? MAX_STREAMED_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
  state.received += chunk.data.length;
  if (state.received > cap) {
    throw uploadError(
      grpc.status.RESOURCE_EXHAUSTED,
      `Upload exceeds the ${cap} byte limit.`,
    );
  }
  if (state.sink !== null) {
    state.sink.stream.write(Buffer.from(chunk.data));
  } else {
    state.chunks.push(Buffer.from(chunk.data));
  }
}

/** Finish the upload: returns the argument to hand the channel handler. */
export async function finishUpload(state: UploadState): Promise<UploadOutcome> {
  const meta = state.meta;
  if (meta === null) {
    throw uploadError(grpc.status.INVALID_ARGUMENT, "Upload sent no metadata.");
  }

  if (state.sink !== null) {
    await closeSink(state.sink.stream);
    const finalPath = state.sink.path.replace(/\.partial$/, "");
    try {
      renameSync(state.sink.path, finalPath);
    } catch (error) {
      throw uploadError(
        grpc.status.INTERNAL,
        `The uploaded file could not be stored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { payload: finalPath, tempPath: finalPath };
  }

  const bytes = Buffer.concat(state.chunks);
  if (bytes.length !== meta.totalBytes) {
    throw uploadError(
      grpc.status.INVALID_ARGUMENT,
      `Upload is incomplete (${bytes.length} of ${meta.totalBytes} bytes).`,
    );
  }
  return { payload: bytes, tempPath: null };
}

/** Abandon an upload: nothing may be left on disk. */
export function discardUpload(state: UploadState): void {
  if (state.sink !== null) {
    state.sink.stream.destroy();
    rmSync(state.sink.path, { force: true });
    state.sink = null;
  }
  state.chunks = [];
}

/** Create the temp file a streamed upload is written to. */
function openSink(meta: UploadMeta): {
  path: string;
  stream: ReturnType<typeof createWriteStream>;
} {
  const dir = join(getTransferTempRoot(), "uploads");
  mkdirSync(dir, { recursive: true });
  const token = /^[a-zA-Z0-9-]{1,64}$/.test(meta.uploadId)
    ? meta.uploadId
    : `anon-${Date.now()}`;
  const name = sanitizeSegment(meta.fileName || "upload");
  const path = join(dir, `${token}-${name}.partial`);
  return { path, stream: createWriteStream(path, { mode: 0o600 }) };
}

function closeSink(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });
}

/** Reduce a name to a single safe path segment. */
function sanitizeSegment(name: string): string {
  const base = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return base.slice(0, 120) || "upload";
}

function uploadError(code: grpc.status, message: string): grpc.ServiceError {
  const error = new Error(message) as grpc.ServiceError;
  error.code = code;
  error.details = message;
  error.metadata = new grpc.Metadata();
  return error;
}
