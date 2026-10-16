import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";
import {
  A2A_VERSION_HEADER,
  Extensions,
  HTTP_EXTENSION_HEADER,
  SSE_HEADERS,
  TaskState,
  formatSSEErrorEvent,
  formatSSEEvent,
  type AgentCard,
  type Part,
  type Task,
  type TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  defaultServerCallContextBuilder,
  validateVersion,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import { ASSISTANT_ID } from "@shared/constants/employees";
import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import type {
  MessageAttachment,
  RemoteCaller,
  RemoteInboundConfig,
  RemoteInboundInput,
} from "@shared/types";
import { deliverAndAwait, disposeForChat } from "../agent/session-queue";
import { savePastedFile } from "../attachments";
import * as dbMessages from "../db/messages";
import * as dbCallers from "../db/remote-callers";
import { getSetting, setSetting } from "../db/settings";
import { partsToContent, type RemoteFile } from "./client";
import {
  callerIdForToken,
  callerTokenFor,
  loadRemoteAgentSecrets,
  setCallerToken,
} from "./store";

/**
 * Inbound half of the A2A bridge: this company's own agent endpoint.
 *
 * Other companies' agents call us here. Each request becomes a conversation in
 * the chat list — one per caller *and* A2A contextId, because a contextId is a
 * conversation in A2A terms — and is run through the local assistant. The
 * assistant's replies stream back as task artifacts, so the caller sees the
 * answer the way it would from any A2A agent, while the boss watches (and can
 * join) the same conversation locally.
 *
 * Off by default and bound to loopback: exposing an agent to the internet is a
 * deliberate decision, and reachability (a tunnel, a VPN, a port forward) is
 * the boss's own to arrange. Authentication is a per-caller bearer token, so
 * one partner can be revoked without disturbing the others.
 */

/** Message kind the assistant uses to ask the boss a question mid-turn. */
const ASK_KIND = "ask";

/** Artifact id the assistant's answer is streamed under. */
const ANSWER_ARTIFACT_ID = "reply";

/** Where the authenticated caller rides on the A2A call context. */
const CALLER_STATE_KEY = "remoteCaller";

/** Defaults applied when a setting has never been written. */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_NAME = "imboss";

/** Ceiling on a request body (files arrive base64-encoded inside JSON). */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

/** Ceiling on a single file a caller sends. */
const MAX_INBOUND_FILE_BYTES = 16 * 1024 * 1024;

/** Longest name accepted for a company or a caller. */
const MAX_NAME = 200;

/** JSON-RPC error codes the transport layer does not export. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const CONTENT_TYPE_NOT_SUPPORTED = -32005;

/** Send one JSON-RPC envelope as a plain (non-streaming) HTTP reply. */
function replyJsonRpc(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** A caller as the HTTP layer resolved it from the presented token. */
interface CallerRef {
  id: number;
  name: string;
  employeeId: number;
}

/** An authenticated A2A caller identity, as the SDK expects it. */
class CallerUser {
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.name;
  }
}

/**
 * Runs one inbound A2A request as a turn of the local assistant.
 *
 * The request is stored in the caller's conversation first, so the boss can see
 * what was asked and reply in the same chat. The assistant's own output is
 * streamed back as artifact chunks by observing the message table — the
 * assistant posts through its `imb_*` tools, so there is no other hook.
 */
class InboundExecutor implements AgentExecutor {
  /** Tasks in flight, so a cancel can stop the right conversation. */
  private readonly running = new Map<
    string,
    { chatId: number; contextId: string }
  >();

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const caller = callerFromContext(requestContext.context);
    if (caller === null) {
      throw new Error("Unauthenticated A2A request.");
    }

    const { text, files } = partsToContent(requestContext.userMessage.parts);
    const chatId = resolveCallerChat(caller, requestContext.contextId);
    const attachments = storeFiles(chatId, files);
    const body =
      text.length > 0
        ? text
        : attachments.length > 0
          ? `Attached: ${attachments.map((a) => a.name).join(", ")}`
          : t("(empty request)");
    dbMessages.appendMessage(chatId, caller.employeeId, body, {
      ...(attachments.length > 0
        ? { attachments, attachmentTotal: attachments.length }
        : {}),
    });

    const { taskId, contextId } = requestContext;
    // The protocol requires the first event of a stream to be the task or a
    // message; the snapshot also hands the caller its contextId.
    eventBus.publish(
      AgentEvent.task(taskSnapshot(requestContext.task, taskId, contextId)),
    );
    this.running.set(taskId, { chatId, contextId });

    // Every message the assistant posts becomes its own artifact, so a reply
    // that came in several parts (an answer and a question, say) keeps its
    // shape at the other end instead of being glued into one blob. The
    // terminal status carries no message of its own: repeating the text there
    // would make the caller render the same answer twice.
    let replyIndex = 0;
    let asked = false;
    const unsubscribe = dbMessages.onMessageAppended((message) => {
      if (message.chatId !== chatId) return;
      if (message.senderEmployeeId !== ASSISTANT_ID) return;
      if (message.kind === ASK_KIND) asked = true;
      const value = message.content.trim();
      if (value.length === 0) return;
      eventBus.publish(
        AgentEvent.artifactUpdate(
          answerChunk(taskId, contextId, replyIndex++, value),
        ),
      );
    });

    try {
      await deliverAndAwait(ASSISTANT_ID, chatId, body);
    } finally {
      unsubscribe();
      this.running.delete(taskId);
    }

    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: asked
            ? TaskState.TASK_STATE_INPUT_REQUIRED
            : TaskState.TASK_STATE_COMPLETED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const run = this.running.get(taskId);
    if (run !== undefined) {
      // Dropping the session is what actually stops the turn: the queue rejects
      // the pending `deliverAndAwait` in `execute`, which unwinds the stream.
      void disposeForChat(run.chatId);
    }
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: run?.contextId ?? "",
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
  }
}

/** One self-contained artifact holding a single message from the assistant. */
function answerChunk(
  taskId: string,
  contextId: string,
  index: number,
  value: string,
): TaskArtifactUpdateEvent {
  return {
    taskId,
    contextId,
    artifact: {
      artifactId: `${ANSWER_ARTIFACT_ID}-${index}`,
      name: "reply",
      description: "",
      parts: [textPart(value)],
      metadata: undefined,
      extensions: [],
    },
    append: false,
    lastChunk: true,
    metadata: undefined,
  };
}

function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

/** The snapshot published first, carrying over an existing task's history. */
function taskSnapshot(
  existing: Task | undefined,
  taskId: string,
  contextId: string,
): Task {
  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: existing ? [...existing.artifacts] : [],
    history: existing ? [...existing.history] : [],
    metadata: undefined,
  };
}

/** The caller the HTTP layer authenticated, or null. */
function callerFromContext(context: ServerCallContext): CallerRef | null {
  const value = context.state.get(CALLER_STATE_KEY);
  if (typeof value !== "object" || value === null) return null;
  const ref = value as CallerRef;
  return typeof ref.id === "number" && typeof ref.employeeId === "number"
    ? ref
    : null;
}

/** The conversation for one (caller, contextId) pair, created on first use. */
function resolveCallerChat(caller: CallerRef, contextId: string): number {
  const existing = dbCallers.findCallerChat(caller.id, contextId);
  if (existing !== null) return existing;
  return dbCallers.createCallerChat(
    caller.id,
    contextId,
    caller.employeeId,
    caller.name.slice(0, MAX_NAME),
  );
}

/** Store files a caller sent as normal chat attachments. */
function storeFiles(chatId: number, files: RemoteFile[]): MessageAttachment[] {
  const stored: MessageAttachment[] = [];
  for (const file of files) {
    if (file.data.length === 0 || file.data.length > MAX_INBOUND_FILE_BYTES) {
      continue;
    }
    try {
      stored.push(savePastedFile(chatId, file.name, file.mime, file.data));
    } catch (err) {
      console.error(
        `[remote] could not store "${file.name}" from a caller:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return stored;
}

/**
 * The endpoint: one HTTP server serving the agent card and JSON-RPC.
 *
 * The card is served unauthenticated — that is how a partner discovers whether
 * we are reachable at all — while every JSON-RPC call needs a caller token.
 */
class RemoteInboundServer {
  private server: Server | null = null;
  private transport: JsonRpcTransportHandler | null = null;
  private card: AgentCard | null = null;
  private running = false;
  private error: string | null = null;
  private boundPort: number | null = null;
  private boundHost: string | null = null;

  /** Load the secrets file, then start the listener when it is enabled. */
  async init(): Promise<void> {
    await loadRemoteAgentSecrets();
    if (readConfig().enabled) await this.restart();
  }

  /** Persist a new configuration and apply it immediately. */
  async configure(input: RemoteInboundInput): Promise<RemoteInboundConfig> {
    await loadRemoteAgentSecrets();
    const current = readConfig();
    const enabled = input.enabled ?? current.enabled;
    const host = normalizeHost(input.host ?? current.host);
    const port = normalizePort(input.port ?? current.port);
    const name = normalizeName(input.name ?? current.name);
    setSetting(SettingKeys.RemoteInboundEnabled, enabled ? "1" : "0");
    setSetting(SettingKeys.RemoteInboundHost, host);
    setSetting(SettingKeys.RemoteInboundPort, String(port));
    setSetting(SettingKeys.RemoteInboundName, name);
    await this.restart();
    return this.status();
  }

  /** Start, stop or rebind the listener to match the stored settings. */
  async restart(): Promise<void> {
    await this.stop();
    const config = readConfig();
    if (!config.enabled) return;

    const card = buildCard(config);
    const handler = new DefaultRequestHandler(
      card,
      new InMemoryTaskStore(),
      new InboundExecutor(),
    );
    this.card = card;
    this.transport = new JsonRpcTransportHandler(handler);

    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;
    this.boundHost = config.host;
    this.boundPort = config.port;
    this.error = null;

    await new Promise<void>((resolve) => {
      const onStartError = (err: Error): void => {
        this.error = describeListenFailure(config.host, config.port, err);
        this.running = false;
        this.server = null;
        this.transport = null;
        this.card = null;
        console.error("[remote] A2A endpoint failed to start:", err.message);
        resolve();
      };
      server.once("error", onStartError);
      server.listen(config.port, config.host, () => {
        server.off("error", onStartError);
        // A listener that dies later must not keep reporting itself as running.
        server.on("error", (err) => {
          this.error = describeListenFailure(config.host, config.port, err);
          this.running = false;
          console.error("[remote] A2A endpoint error:", err.message);
        });
        this.running = true;
        console.log(
          `[remote] A2A endpoint listening on ${config.host}:${config.port}`,
        );
        resolve();
      });
    });
  }

  /** Close the listener (idempotent). */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.transport = null;
    this.card = null;
    this.running = false;
    this.boundPort = null;
    this.boundHost = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // An SSE stream would otherwise hold the close open for as long as the
      // caller keeps the connection.
      server.closeAllConnections();
    });
  }

  /** Renderer snapshot of the endpoint's state. */
  status(): RemoteInboundConfig {
    return {
      ...readConfig(),
      running: this.running,
      url: this.running ? advertisedUrl(this.boundHost, this.boundPort) : null,
      error: this.error,
    };
  }

  /** Every caller, with its token so the boss can copy or rotate it. */
  listCallers(): RemoteCaller[] {
    return dbCallers.listRemoteCallers().map((record) => ({
      id: record.id,
      name: record.name,
      token: callerTokenFor(record.id) ?? "",
      chatCount: dbCallers.countCallerChats(record.id),
      createdAt: record.createdAt,
    }));
  }

  /** Register a partner and issue its first token. */
  async addCaller(name: string): Promise<RemoteCaller> {
    await loadRemoteAgentSecrets();
    const record = dbCallers.createRemoteCaller(normalizeName(name));
    if (record === null) {
      throw new Error("Could not create the remote caller.");
    }
    const token = newToken();
    await setCallerToken(record.id, token);
    return {
      id: record.id,
      name: record.name,
      token,
      chatCount: 0,
      createdAt: record.createdAt,
    };
  }

  /** Replace a caller's token, invalidating the previous one at once. */
  async regenerateCallerToken(id: number): Promise<RemoteCaller> {
    await loadRemoteAgentSecrets();
    const record = dbCallers.getRemoteCaller(id);
    if (record === null) throw new Error("Unknown remote caller.");
    const token = newToken();
    await setCallerToken(id, token);
    return {
      id: record.id,
      name: record.name,
      token,
      chatCount: dbCallers.countCallerChats(id),
      createdAt: record.createdAt,
    };
  }

  /** Revoke a caller: its token, its conversations and its identity row. */
  async removeCaller(id: number): Promise<void> {
    await loadRemoteAgentSecrets();
    for (const chatId of dbCallers.listCallerChats(id)) {
      await disposeForChat(chatId);
    }
    await setCallerToken(id, null);
    dbCallers.deleteRemoteCaller(id);
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (req.method === "GET") {
        this.serveCard(req, res);
        return;
      }
      if (req.method !== "POST") {
        replyJsonRpc(res, 405, {
          jsonrpc: "2.0",
          id: null,
          error: { code: INVALID_REQUEST, message: "Method not allowed." },
        });
        return;
      }
      await this.serveJsonRpc(req, res);
    } catch (err) {
      console.error(
        "[remote] A2A request failed:",
        err instanceof Error ? err.message : err,
      );
      if (!res.headersSent) {
        replyJsonRpc(res, 500, {
          jsonrpc: "2.0",
          id: null,
          error: { code: INTERNAL_ERROR, message: "Internal error." },
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  /** GET: the agent card, unauthenticated, with a weak ETag. */
  private serveCard(req: IncomingMessage, res: ServerResponse): void {
    const card = this.card;
    if (card === null) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The endpoint is not running." }));
      return;
    }
    const body = JSON.stringify(card, null, 2);
    const etag = weakETag(body);
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      ETag: etag,
    });
    res.end(body);
  }

  /** POST: bearer auth, then the JSON-RPC dispatch (streaming or single). */
  private async serveJsonRpc(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const transport = this.transport;
    if (transport === null) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The endpoint is not running." }));
      return;
    }

    const caller = authenticate(req);
    if (caller === null) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: INVALID_REQUEST,
            message: "A valid bearer token is required.",
          },
        }),
      );
      return;
    }

    // Mirror the reference JSON-RPC host: a declared content type must be JSON.
    const contentType = header(req, "content-type");
    if (contentType !== undefined) {
      const mediaType = contentType.split(";")[0].trim().toLowerCase();
      if (mediaType.length > 0 && mediaType !== "application/json") {
        replyJsonRpc(res, 200, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: CONTENT_TYPE_NOT_SUPPORTED,
            message: `Unsupported Content-Type "${contentType}"; expected application/json.`,
          },
        });
        return;
      }
    }

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new SyntaxError("body is not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      replyJsonRpc(res, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: PARSE_ERROR, message: "Invalid JSON payload." },
      });
      return;
    }

    const id =
      typeof body["id"] === "string" || typeof body["id"] === "number"
        ? (body["id"] as string | number)
        : null;

    const context = defaultServerCallContextBuilder({
      extensions: Extensions.parseServiceParameter(
        header(req, HTTP_EXTENSION_HEADER),
      ),
      user: new CallerUser(caller.name),
      headers: req.headers,
      requestedVersion: header(req, A2A_VERSION_HEADER),
    });
    context.state.set(CALLER_STATE_KEY, caller);

    // Version and dispatch failures are JSON-RPC errors, not HTTP failures:
    // only an internal error deserves a 5xx (mirrors the reference host).
    const card = this.card;
    let result: unknown;
    try {
      if (card !== null) {
        validateVersion(context.requestedVersion, card, "JSONRPC");
      }
      result = await transport.handle(body, context);
    } catch (err) {
      const mapped = JsonRpcTransportHandler.mapToJSONRPCError(err);
      replyJsonRpc(res, mapped.code === INTERNAL_ERROR ? 500 : 200, {
        jsonrpc: "2.0",
        id,
        error: mapped,
      });
      return;
    }

    if (!isAsyncIterable(result)) {
      replyJsonRpc(res, 200, result);
      return;
    }

    const iterator = result[Symbol.asyncIterator]();
    let first: IteratorResult<unknown>;
    try {
      first = await iterator.next();
    } catch (err) {
      // A failure before the first event is still a plain JSON-RPC reply.
      replyJsonRpc(res, 200, {
        jsonrpc: "2.0",
        id,
        error: JsonRpcTransportHandler.mapToJSONRPCError(err),
      });
      return;
    }

    for (const [key, value] of Object.entries(SSE_HEADERS)) {
      res.setHeader(key, value);
    }
    res.flushHeaders();
    try {
      if (!first.done) res.write(formatSSEEvent(first.value));
      for await (const event of remaining(iterator)) {
        res.write(formatSSEEvent(event));
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.write(
          formatSSEErrorEvent({
            jsonrpc: "2.0",
            id,
            error: JsonRpcTransportHandler.mapToJSONRPCError(err),
          }),
        );
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }
}

/** Yield whatever is left of an iterator already advanced once. */
async function* remaining<T>(
  iterator: AsyncIterator<T>,
): AsyncGenerator<T, void, undefined> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

/** The configured endpoint, with defaults applied. */
function readConfig(): Omit<RemoteInboundConfig, "running" | "url" | "error"> {
  return {
    enabled: getSetting(SettingKeys.RemoteInboundEnabled) === "1",
    host: normalizeHost(getSetting(SettingKeys.RemoteInboundHost) ?? ""),
    port: normalizePort(
      Number(getSetting(SettingKeys.RemoteInboundPort) ?? DEFAULT_PORT),
    ),
    name: normalizeName(getSetting(SettingKeys.RemoteInboundName) ?? ""),
  };
}

/**
 * The agent card partners resolve.
 *
 * Served in the JSON Schema shape rather than the protobuf one: the SDK's own
 * resolver passes such a card through untouched, and it is what non-SDK A2A
 * clients expect to parse.
 */
function buildCard(
  config: Omit<RemoteInboundConfig, "running" | "url" | "error">,
): AgentCard {
  return {
    name: config.name,
    // Deliberately not localized: the card is read by other companies' agents,
    // not by this app's UI.
    description:
      "An imboss agent. Send a request and it is handled by this company's AI staff; the reply comes back as the task's artifact.",
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: advertisedUrl(config.host, config.port),
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
    ],
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
    },
    security: [{ bearer: [] }],
    defaultInputModes: ["text/plain", "application/octet-stream"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  } as unknown as AgentCard;
}

/**
 * The URL to advertise: the bind address, except that a wildcard bind has no
 * usable host of its own, so the machine's LAN address is used instead.
 */
function advertisedUrl(host: string | null, port: number | null): string {
  const bindHost = host ?? DEFAULT_HOST;
  const bindPort = port ?? DEFAULT_PORT;
  const wildcard = bindHost === "0.0.0.0" || bindHost === "::";
  const displayHost = wildcard ? (firstLanAddress() ?? "127.0.0.1") : bindHost;
  const formatted = displayHost.includes(":")
    ? `[${displayHost}]`
    : displayHost;
  return `http://${formatted}:${bindPort}`;
}

/** The machine's first non-internal IPv4 address, if it has one. */
function firstLanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal)
        return address.address;
    }
  }
  return null;
}

/** Resolve the presented bearer token to a caller record. */
function authenticate(req: IncomingMessage): CallerRef | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const id = callerIdForToken(match[1]);
  if (id === null) return null;
  const record = dbCallers.getRemoteCaller(id);
  if (record === null) return null;
  return { id: record.id, name: record.name, employeeId: record.employeeId };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/** Read a request body, refusing anything past the ceiling. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> & AsyncIterator<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

function weakETag(body: string): string {
  return `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Turn a bind failure into something the boss can act on. The two common cases
 * (the port is taken, the port is privileged) get a plain sentence; anything
 * else keeps the OS text, which is the only useful part.
 */
function describeListenFailure(host: string, port: number, err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    return t("Port ${port} is already in use on ${host}.", {
      port: String(port),
      host,
    });
  }
  if (code === "EACCES") {
    return t("Not allowed to listen on ${host}:${port}.", {
      host,
      port: String(port),
    });
  }
  return t("Could not start the endpoint: ${error}", { error: err.message });
}

function normalizeHost(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_HOST;
}

function normalizePort(value: number): number {
  return Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : DEFAULT_PORT;
}

function normalizeName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_NAME;
  return trimmed.length > MAX_NAME ? trimmed.slice(0, MAX_NAME) : trimmed;
}

export const remoteInboundServer = new RemoteInboundServer();
