import { createHash, randomInt } from "crypto";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { getDataRoot } from "../../data-dir";
import type { QqConfig } from "../store";
import { chunkText } from "../format";
import { downloadInboundFile, mimeByFileName } from "../media";
import type {
  AdapterCallbacks,
  AdapterSession,
  InboundMedia,
  IntegrationAdapter,
} from "../types";
import { errorMessage, fileNameFromPath } from "../util";

/**
 * QQ adapter — official QQ Bot platform over the WebSocket gateway
 * (`qq-official-bot`). Uses the C2C + group intents and openid identities.
 *
 * The SDK is loaded lazily (dynamic import) so app startup is unaffected; the
 * adapter talks to it through a narrow local interface.
 */

const MAX_MESSAGE_LENGTH = 1000;
const DEDUP_LIMIT = 500;
/** `file_type` of a rich-media upload: 4 = generic file (any format). */
const FILE_TYPE_FILE = 4;
/** The platform rejects uploads above this hard limit (`850031`). */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** Local files are uploaded in chunks; the server's own retry window is 5 min. */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
/** One chunk PUT; the SDK uses the same 120s for its own part uploads. */
const UPLOAD_PART_TIMEOUT_MS = 120 * 1000;
const SEND_TIMEOUT_MS = 30 * 1000;
/** `md5_10m`: MD5 of the first 10002432 bytes (a platform-side dedup hint). */
const MD5_10M_BYTES = 10002432;

type QqSdk = typeof import("qq-official-bot");
type QqBot = InstanceType<QqSdk["Bot"]>;
type QqSendable = Parameters<InstanceType<QqSdk["Bot"]>["sendGroupMessage"]>[1];
type QqQuotable = { id?: string; event_id?: string };
/** Result of a rich-media upload (`file_info` is what a message carries). */
type QqUploadResult = import("qq-official-bot").FileUploadResult;
type QqUploadPreparation = import("qq-official-bot").UploadPrepareResult;

/** Minimal shape of the parsed message event we consume. */
interface QqElement {
  type: string;
  data?: { text?: string; url?: string; name?: string };
}

interface QqEvent {
  message_id?: string;
  event_id?: string;
  group_id?: string;
  user_id?: string;
  sender?: { user_name?: string; user_openid?: string };
  author?: { user_openid?: string; member_openid?: string };
  message?: QqElement[];
}

/**
 * Body of `POST /v2/{groups|users}/{id}/messages` for a rich-media message.
 * The SDK's high-level send path has no file segment, so a generic file is
 * uploaded through the SDK (`file_type=4`) and then sent through this payload.
 */
interface QqMediaMessageBody {
  msg_type: 7;
  media: { file_info: string };
  msg_seq: number;
  msg_id?: string;
  event_id?: string;
}

export class QqAdapter implements IntegrationAdapter {
  readonly platform = "qq" as const;

  private bot: QqBot | null = null;
  private sdkPromise: Promise<QqSdk> | null = null;
  private readonly seen = new Set<string>();

  constructor(
    private readonly config: QqConfig,
    private readonly callbacks: AdapterCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!this.config.appId || !this.config.secret) {
      throw new Error("QQ App ID and Secret are not configured.");
    }
    this.callbacks.onState("connecting");
    const sdk = await this.loadSdk();
    const bot: QqBot = new sdk.Bot({
      appid: this.config.appId,
      secret: this.config.secret,
      intents: ["GROUP_AND_C2C_EVENT"],
      mode: sdk.ReceiverMode.WEBSOCKET,
      logLevel: "error",
      // Keep any SDK session state inside the app's data folder.
      dataDir: join(getDataRoot(), "integrations"),
    });
    bot.on("message.private", (event) =>
      this.handle(event as unknown as QqEvent, false),
    );
    bot.on("message.group", (event) =>
      this.handle(event as unknown as QqEvent, true),
    );
    this.bot = bot;
    await bot.start();
    this.callbacks.onState("connected", this.config.appId);
  }

  async stop(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try {
        await bot.stop();
      } catch (err) {
        console.error("[integrations:qq] stop failed:", errorMessage(err));
      }
    }
    this.callbacks.onState("disabled");
  }

  async sendText(session: AdapterSession, text: string): Promise<void> {
    const source = parseReplyContext(session.replyContext);
    for (const chunk of chunkText(text, MAX_MESSAGE_LENGTH)) {
      if (chunk.trim().length === 0) continue;
      await this.send(session.sessionId, chunk, source);
    }
  }

  async sendMedia(
    session: AdapterSession,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const name = fileNameFromPath(filePath);
    const mime = mimeByFileName(name);
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");
    const isAudio = mime.startsWith("audio/");
    // A document (or anything that is not one of the three rich-media types the
    // SDK models as message segments) is sent as a native file message: it is
    // uploaded first, then sent as `msg_type=7` with the returned `file_info`.
    if (!isImage && !isVideo && !isAudio) {
      if (caption && caption.trim().length > 0) {
        await this.sendText(session, caption);
      }
      await this.sendFile(session, filePath);
      return;
    }
    const sdk = await this.loadSdk();
    const element: QqSendable = isImage
      ? sdk.segment.image(filePath)
      : isVideo
        ? sdk.segment.video(filePath)
        : sdk.segment.audio(filePath);
    if (caption && caption.trim().length > 0) {
      await this.sendText(session, caption);
    }
    await this.send(
      session.sessionId,
      element,
      parseReplyContext(session.replyContext),
    );
  }

  private handle(event: QqEvent, isGroup: boolean): void {
    const messageId = event.message_id ?? event.event_id;
    if (messageId) {
      if (this.seen.has(messageId)) return;
      this.seen.add(messageId);
      if (this.seen.size > DEDUP_LIMIT) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
    const senderId =
      event.sender?.user_openid ??
      event.author?.user_openid ??
      event.author?.member_openid ??
      event.user_id ??
      "";
    const sessionId = isGroup
      ? `group:${event.group_id ?? ""}`
      : `c2c:${senderId}`;
    const replyContext =
      event.message_id || event.event_id
        ? JSON.stringify({
            id: event.message_id,
            event_id: event.event_id,
          } satisfies QqQuotable)
        : undefined;
    const senderName =
      event.sender?.user_name ??
      (isGroup ? `QQ ${event.group_id ?? ""}` : `QQ ${senderId}`);
    this.callbacks.onMessage({
      sessionId,
      senderId,
      senderName,
      text: extractText(event),
      ...(replyContext ? { replyContext } : {}),
      kind: isGroup ? "group" : "private",
      media: extractMedia(event),
    });
  }

  /** Route a C2C/group send, retrying without the passive-reply source. */
  private async send(
    sessionId: string,
    message: QqSendable,
    source: QqQuotable | undefined,
  ): Promise<void> {
    const bot = this.bot;
    if (!bot) throw new Error("QQ bot is not connected.");
    const target = parseSession(sessionId);
    const entry =
      target.kind === "group" ? bot.group(target.id) : bot.user(target.id);
    try {
      await entry.send(message, source);
    } catch (err) {
      // A stale passive-reply source (window expired) must not drop the reply:
      // retry as an active message.
      if (source) {
        await entry.send(message);
        return;
      }
      throw err;
    }
  }

  /**
   * Upload a local file as QQ rich media (`file_type=4`) and send it as a
   * `msg_type=7` message.
   *
   * The upload endpoint is scene-scoped (a file uploaded for a group cannot be
   * sent to a C2C chat), so it is chosen from the session id. `file_type` must
   * be explicit: the SDK infers it from the extension and falls back to image,
   * which the platform rejects with `850019` for a document.
   *
   * The chunk loop is ours rather than `entry.upload()` (`FileProcessor`): the
   * SDK computes each chunk's offset as `index * block_size`, but the live
   * upload_prepare returns **1-based** part indexes, so a single-part file (any
   * attachment smaller than one 10 MB block) uploads a zero-byte chunk and the
   * merge then fails with `850012` / `40093006`. Offsets are accumulated here
   * instead, which is correct for both index bases.
   */
  private async sendFile(
    session: AdapterSession,
    filePath: string,
  ): Promise<void> {
    const bot = this.bot;
    if (!bot) throw new Error("QQ bot is not connected.");
    const target = parseSession(session.sessionId);
    const name = fileNameFromPath(filePath);
    await assertSendableFile(filePath);
    const uploaded = await withTimeout<QqUploadResult>(
      uploadRichMediaFile(bot, target, filePath, name),
      UPLOAD_TIMEOUT_MS,
      `QQ rich-media upload of "${name}" timed out.`,
    );
    const fileInfo =
      typeof uploaded?.file_info === "string" ? uploaded.file_info.trim() : "";
    if (fileInfo.length === 0) {
      throw new Error(
        `QQ rich-media upload of "${name}" returned no file_info.`,
      );
    }
    await this.sendFileMessage(
      target,
      fileInfo,
      parseReplyContext(session.replyContext),
    );
  }

  /**
   * Send an uploaded file. Prefers a passive reply (the platform pushes the
   * message inside the 5 min / 60 min reply window); when that window expired
   * the same file is retried as an active message, mirroring `send()`.
   */
  private async sendFileMessage(
    target: { kind: "c2c" | "group"; id: string },
    fileInfo: string,
    source: QqQuotable | undefined,
  ): Promise<void> {
    const bot = this.bot;
    if (!bot) throw new Error("QQ bot is not connected.");
    const path =
      target.kind === "group"
        ? `/v2/groups/${target.id}/messages`
        : `/v2/users/${target.id}/messages`;
    const post = async (quote: QqQuotable | undefined): Promise<void> => {
      const body: QqMediaMessageBody = {
        msg_type: 7,
        media: { file_info: fileInfo },
        // A duplicate `msg_id` + `msg_seq` is rejected by the platform, so every
        // attempt gets a fresh sequence number.
        msg_seq: randomInt(1, 1_000_000),
      };
      if (quote?.id) body.msg_id = quote.id;
      if (quote?.event_id) body.event_id = quote.event_id;
      try {
        // `timeout` is the SDK request's own (axios) timeout, so a stalled
        // platform call cannot hold the forward chain open.
        await bot.request.post(path, body, { timeout: SEND_TIMEOUT_MS });
      } catch (err) {
        throw new Error(
          `QQ rejected the file message: ${requestErrorDetail(err)}`,
        );
      }
    };
    try {
      await post(source);
    } catch (err) {
      // A stale passive-reply source must not drop the file: retry as an
      // active message, exactly like the text/media paths.
      if (!source) throw err;
      await post(undefined);
    }
  }

  private loadSdk(): Promise<QqSdk> {
    this.sdkPromise ??= import("qq-official-bot") as Promise<QqSdk>;
    return this.sdkPromise;
  }
}

/** Refuse files the platform (or the upload path) cannot handle. */
async function assertSendableFile(filePath: string): Promise<void> {
  const name = fileNameFromPath(filePath);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(filePath);
  } catch (err) {
    throw new Error(`Cannot read "${name}": ${errorMessage(err)}`);
  }
  if (!info.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (info.size <= 0) {
    throw new Error(`Refusing to send the empty file "${name}".`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(
      `"${name}" is ${info.size} bytes; QQ accepts files up to ${MAX_FILE_BYTES} bytes.`,
    );
  }
}

/**
 * Upload a local file as QQ rich media (`file_type=4`) and return the merge
 * result, whose `file_info` is what a `msg_type=7` message carries.
 *
 * Chunked upload, per the official flow: `upload_prepare` → PUT each part →
 * `upload_part_finish` → `POST .../files` to merge. The three API calls reuse
 * the SDK's public `FileProcessor`; only the part loop is ours, because the SDK
 * derives each part's offset from the part index (`index * block_size`) while
 * the live API numbers parts from 1 — with one part (any attachment below one
 * 10 MB block) it therefore uploads zero bytes and the merge fails with
 * `850012` / `40093006`. Accumulating offsets is correct for both index bases.
 */
async function uploadRichMediaFile(
  bot: QqBot,
  target: { kind: "c2c" | "group"; id: string },
  filePath: string,
  name: string,
): Promise<QqUploadResult> {
  // The upload endpoints are scene-scoped: a group upload cannot be sent to a
  // C2C chat and vice versa.
  const targetType = target.kind === "group" ? "group" : "user";
  const buffer = await readFile(filePath);
  if (buffer.length === 0) {
    throw new Error(`Refusing to upload the empty file "${name}".`);
  }
  const prepared: QqUploadPreparation = await bot.fileProcessor.prepareUpload(
    targetType,
    target.id,
    {
      file_type: FILE_TYPE_FILE,
      file_size: String(buffer.length),
      file_name: name,
      md5: hashHex("md5", buffer),
      sha1: hashHex("sha1", buffer),
      md5_10m: hashHex("md5", buffer.subarray(0, MD5_10M_BYTES)),
    },
  );
  const uploadId =
    typeof prepared?.upload_id === "string" ? prepared.upload_id.trim() : "";
  if (uploadId.length === 0) {
    throw new Error(`QQ refused the upload of "${name}" (no upload_id).`);
  }
  const parts = [...(prepared.parts ?? [])].sort(
    (a, b) => Number(a.index) - Number(b.index),
  );
  if (parts.length === 0) {
    throw new Error(`QQ refused the upload of "${name}" (no parts).`);
  }
  let offset = 0;
  for (const part of parts) {
    const declared = Number(part.block_size);
    const size =
      Number.isFinite(declared) && declared > 0
        ? declared
        : buffer.length - offset;
    const chunk = buffer.subarray(offset, offset + size);
    if (chunk.length === 0) {
      throw new Error(`QQ upload of "${name}" produced an empty part.`);
    }
    offset += chunk.length;
    await withOneRetry(
      async () => {
        await putUploadPart(part.presigned_url, chunk);
        await bot.fileProcessor.finishUploadPart(targetType, target.id, {
          upload_id: uploadId,
          part_index: Number(part.index),
          block_size: String(chunk.length),
          md5: hashHex("md5", chunk),
        });
      },
      (err) =>
        `upload part ${String(part.index)} of "${name}" failed: ${requestErrorDetail(err)}`,
    );
  }
  if (offset !== buffer.length) {
    // The prepared part list must cover the whole file; anything else means the
    // upload contract changed and merging would produce a corrupt file.
    throw new Error(
      `QQ upload of "${name}" covered ${offset} of ${buffer.length} bytes.`,
    );
  }
  return bot.fileProcessor.completeUpload(
    {
      targetType,
      targetId: target.id,
      fileType: FILE_TYPE_FILE,
      // Only produce a `file_info`; the message is sent by `sendFileMessage()`
      // so it can still carry the passive-reply credentials.
      sendMessage: false,
      fileName: name,
    },
    uploadId,
    name,
  );
}

/** PUT one presigned chunk; the SDK's own part timeout is 120s. */
async function putUploadPart(
  presignedUrl: string,
  chunk: Buffer,
): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    // A plain Buffer is not part of the DOM `BodyInit` typings; a Uint8Array
    // over the same bytes is (fetch copies it, no extra copy of the whole file).
    body: new Uint8Array(chunk),
    signal: AbortSignal.timeout(UPLOAD_PART_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`chunk PUT failed with HTTP ${response.status}`);
  }
}

/**
 * The platform documents transient part failures (`850012 "bdh need retry"`), so
 * one retry per part; the presigned URL accepts a repeated PUT.
 */
async function withOneRetry<T>(
  task: () => Promise<T>,
  describe: (err: unknown) => string,
): Promise<T> {
  try {
    return await task();
  } catch (first) {
    console.warn(`[integrations:qq] ${describe(first)}; retrying once.`);
    try {
      return await task();
    } catch (second) {
      throw new Error(describe(second));
    }
  }
}

/** Lowercase hex digest of `data` (`md5` / `sha1`), as the upload API expects. */
function hashHex(algorithm: "md5" | "sha1", data: Buffer): string {
  return createHash(algorithm).update(data).digest("hex");
}

/**
 * Platform error code + message of a failed SDK request, when the response
 * carries one (QQ answers failures with `{ code, message }`). Falls back to the
 * thrown value's own message.
 */
function requestErrorDetail(err: unknown): string {
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (typeof data === "object" && data !== null) {
    const { code, message } = data as { code?: unknown; message?: unknown };
    if (typeof message === "string" && message.trim().length > 0) {
      return typeof code === "number" || typeof code === "string"
        ? `${String(code)} ${message}`
        : message;
    }
  }
  return errorMessage(err);
}

/**
 * Reject with `message` after `ms`. The underlying request keeps running (the
 * SDK's request object exposes no abort signal); it is already handled by the
 * race, so a late failure cannot surface as an unhandled rejection.
 */
async function withTimeout<T>(
  task: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseSession(sessionId: string): {
  kind: "c2c" | "group";
  id: string;
} {
  const separator = sessionId.indexOf(":");
  const kind = sessionId.slice(0, separator);
  const id = sessionId.slice(separator + 1);
  return { kind: kind === "group" ? "group" : "c2c", id };
}

function parseReplyContext(
  context: string | undefined,
): QqQuotable | undefined {
  if (!context) return undefined;
  try {
    const parsed = JSON.parse(context) as QqQuotable;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function extractText(event: QqEvent): string {
  const parts: string[] = [];
  for (const element of event.message ?? []) {
    if (element.type === "text" && element.data?.text) {
      parts.push(element.data.text);
    }
  }
  return parts.join("").trim();
}

function extractMedia(event: QqEvent): InboundMedia[] {
  const media: InboundMedia[] = [];
  for (const element of event.message ?? []) {
    const url = element.data?.url;
    if (!url) continue;
    const kind = mediaKind(element.type);
    const fileName =
      element.data?.name ?? `${kind}_${event.message_id ?? Date.now()}`;
    media.push({
      kind,
      fileName,
      mime: mimeByFileName(fileName),
      // The platform's attachment URL is a presigned CDN link: fetch it with a
      // bounded time/size (see `downloadInboundFile`) instead of an open fetch.
      save: (targetDir) => downloadInboundFile(url, targetDir, fileName),
    });
  }
  return media;
}

function mediaKind(type: string): InboundMedia["kind"] {
  switch (type) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "voice":
      return "voice";
    default:
      return "file";
  }
}
