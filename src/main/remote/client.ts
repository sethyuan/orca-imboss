import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import { randomUUID } from "crypto";
import { authFetch } from "./card";

/**
 * A2A client for one remote peer.
 *
 * The card is cached in the database, so every send reuses it instead of
 * re-running discovery. Responses are normalized into three things the chat can
 * store: complete pieces of agent content (with any files that came with them),
 * task-state changes, and the task/conversation ids that make the next turn and
 * a recovered stream possible.
 *
 * Streaming is deliberately lossy in one direction: A2A artifact updates are
 * incremental (`append` / `lastChunk`), while an imboss message row is
 * append-only. Incremental chunks are therefore buffered per artifact id and
 * emitted once the artifact is complete.
 */

/** Normalized task state (the A2A enum flattened to strings). */
export type RemoteTaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "input-required"
  | "auth-required"
  | "unknown";

function mapState(state: TaskState): RemoteTaskState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input-required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth-required";
    default:
      return "unknown";
  }
}

/**
 * A state a task does not leave on its own: the peer either finished, failed,
 * was canceled, refused, needs credentials, or is waiting for us to say
 * something else. Anything else means the task is still running, which is what
 * tells a dropped stream apart from a finished one.
 */
export function isTerminalState(state: RemoteTaskState): boolean {
  return state !== "submitted" && state !== "working" && state !== "unknown";
}

/** A binary part of an A2A message, in either direction. */
export interface RemoteFile {
  name: string;
  mime: string;
  data: Buffer;
}

/** Callbacks the caller implements to store what the peer produced. */
export interface RemoteStreamHandlers {
  /**
   * A complete piece of agent content, plus any files that arrived with it.
   * At least one of the two is non-empty.
   */
  onContent(text: string, files: RemoteFile[]): void;
  /** The peer's task changed state. */
  onState(state: RemoteTaskState): void;
  /** The peer's A2A conversation id (echo it back on the next turn). */
  onContext(contextId: string): void;
  /** The peer's task id (the handle for recovering a dropped stream). */
  onTask(taskId: string): void;
}

/** What one send (or recovery) produced. */
export interface RemoteSendResult {
  /** Task id seen on the wire, or null when the peer answered with a message. */
  taskId: string | null;
  /** Conversation id the peer handed back, when it sent one. */
  contextId: string | null;
  /** True once the task reached a state it will not leave on its own. */
  terminal: boolean;
}

/** Split A2A parts into chat-readable Markdown plus the files they carry. */
function partsToContent(parts: readonly Part[] | undefined): {
  text: string;
  files: RemoteFile[];
} {
  const files: RemoteFile[] = [];
  if (!parts) return { text: "", files };
  const lines: string[] = [];
  for (const part of parts) {
    const content = part.content;
    if (content === undefined) continue;
    switch (content.$case) {
      case "text":
        lines.push(content.value);
        break;
      case "url":
        lines.push(
          `[${part.filename.length > 0 ? part.filename : content.value}](${content.value})`,
        );
        break;
      case "raw": {
        const name = part.filename.length > 0 ? part.filename : "file";
        const mime =
          part.mediaType.length > 0
            ? part.mediaType
            : "application/octet-stream";
        files.push({ name, mime, data: Buffer.from(content.value) });
        lines.push(`[${name} · ${mime}]`);
        break;
      }
      case "data":
        lines.push(
          `\`\`\`json\n${JSON.stringify(content.value, null, 2)}\n\`\`\``,
        );
        break;
    }
  }
  return { text: lines.join("\n").trim(), files };
}

/**
 * Turns a peer's stream into the pieces the chat stores, once.
 *
 * One collector spans a send *and* its recovery, so an answer the peer already
 * streamed before the connection dropped is never posted twice when the task is
 * re-read or re-subscribed.
 */
export class RemoteAnswerCollector {
  private readonly pendingArtifacts = new Map<
    string,
    { text: string[]; files: RemoteFile[] }
  >();
  /** Artifacts already delivered, so a task snapshot after an artifact update
   * (or vice versa) never posts the same artifact twice. */
  private readonly emittedArtifacts = new Set<string>();
  /** A task snapshot repeats the status message a status update already
   * carried; identical consecutive content is collapsed. */
  private lastKey = "";

  /** Last state the peer reported (`null` before the first update). */
  lastState: RemoteTaskState | null = null;
  /** Task id seen so far, if any. */
  taskId: string | null = null;
  /** Conversation id seen so far, if any. */
  contextId: string | null = null;

  private readonly handlers: RemoteStreamHandlers;

  constructor(handlers: RemoteStreamHandlers) {
    this.handlers = handlers;
  }

  /** True once the task reached a state it will not leave on its own. */
  get terminal(): boolean {
    return this.lastState !== null && isTerminalState(this.lastState);
  }

  /** Feed one streamed response through the collector. */
  handle(response: StreamResponse): void {
    const payload = response.payload;
    if (payload === undefined) return;
    switch (payload.$case) {
      case "task":
        this.task(payload.value);
        break;
      case "statusUpdate":
        this.statusUpdate(payload.value);
        break;
      case "artifactUpdate":
        this.artifactUpdate(payload.value);
        break;
      case "message":
        this.message(payload.value);
        break;
    }
  }

  /** Emit content the peer produced, unless it is an exact repeat. */
  content(text: string, files: RemoteFile[] = []): void {
    const body = text.trim();
    if (body.length === 0 && files.length === 0) return;
    const key = `${body}\u0000${files.map((file) => file.name).join("\u0000")}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.handlers.onContent(body, files);
  }

  /** A complete task snapshot (the initial one, or a `getTask` read). */
  task(task: Task): void {
    this.noteIds(task.id, task.contextId);
    if (task.status) this.state(mapState(task.status.state));
    for (const artifact of task.artifacts) {
      if (this.emittedArtifacts.has(artifact.artifactId)) continue;
      this.flushArtifact(artifact.artifactId);
      this.emittedArtifacts.add(artifact.artifactId);
      this.emitParts(artifact.parts);
    }
    // A completed task may carry its answer in the status message instead of
    // an artifact (a plain message answer is not wrapped in a task at all).
    this.emitMessage(task.status?.message);
  }

  statusUpdate(event: TaskStatusUpdateEvent): void {
    this.noteIds(event.taskId, event.contextId);
    if (event.status) this.state(mapState(event.status.state));
    this.emitMessage(event.status?.message);
  }

  artifactUpdate(event: TaskArtifactUpdateEvent): void {
    const { artifact, append, lastChunk } = event;
    if (artifact === undefined) return;
    const { text, files } = partsToContent(artifact.parts);
    const previous = this.pendingArtifacts.get(artifact.artifactId);
    // `append: false` restarts the artifact (a replaced chunk).
    this.pendingArtifacts.set(artifact.artifactId, {
      text: append && previous ? [...previous.text, text] : [text],
      files: append && previous ? [...previous.files, ...files] : files,
    });
    if (lastChunk) this.flushArtifact(artifact.artifactId);
  }

  /** An agent-role message (user-role echoes are ignored). */
  message(message: Message | undefined): void {
    this.emitMessage(message);
  }

  /** Deliver any artifact the stream left unterminated. */
  flush(): void {
    for (const artifactId of [...this.pendingArtifacts.keys()]) {
      this.flushArtifact(artifactId);
    }
  }

  /** The result of everything fed through this collector so far. */
  result(): RemoteSendResult {
    return {
      taskId: this.taskId,
      contextId: this.contextId,
      terminal: this.terminal,
    };
  }

  private noteIds(taskId: string, contextId: string): void {
    if (taskId.length > 0 && taskId !== this.taskId) {
      this.taskId = taskId;
      this.handlers.onTask(taskId);
    }
    if (contextId.length > 0 && contextId !== this.contextId) {
      this.contextId = contextId;
      this.handlers.onContext(contextId);
    }
  }

  private state(state: RemoteTaskState): void {
    this.lastState = state;
    this.handlers.onState(state);
  }

  private flushArtifact(artifactId: string): void {
    const chunks = this.pendingArtifacts.get(artifactId);
    if (chunks === undefined) return;
    this.pendingArtifacts.delete(artifactId);
    this.emittedArtifacts.add(artifactId);
    this.content(chunks.text.join(""), chunks.files);
  }

  private emitParts(parts: readonly Part[] | undefined): void {
    const { text, files } = partsToContent(parts);
    this.content(text, files);
  }

  private emitMessage(message: Message | undefined): void {
    if (!message || message.role !== Role.ROLE_AGENT) return;
    this.emitParts(message.parts);
  }
}

/** Build a client for a cached agent card. */
async function createClient(card: unknown, token: string | null) {
  const fetchImpl = authFetch(token);
  return new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({ fetchImpl }),
      new RestTransportFactory({ fetchImpl }),
    ],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  }).createFromAgentCard(card as AgentCard);
}

/** How often a recovered task is re-read while it is still running. */
const RECOVERY_POLL_MS = 3000;

/** How long a recovered task is polled before the run is left to resume later. */
const RECOVERY_MAX_MS = 30 * 60 * 1000;

/** Sleep, but wake up immediately when the caller aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Send one user message to a peer and stream its answer back.
 *
 * Resolves once the peer's task reaches a terminal state or the stream ends —
 * including when it ends *early*, which is why the result reports whether the
 * task actually settled. Rejects when the request itself fails (unreachable
 * peer, rejected auth); the caller turns that into a chat message and a peer
 * status.
 */
export async function sendToRemoteAgent(options: {
  card: unknown;
  token: string | null;
  text: string;
  /** Conversation id from the previous turn, for multi-turn context. */
  contextId?: string | null;
  /** Files to upload as A2A `raw` parts. */
  files?: RemoteFile[];
  collector: RemoteAnswerCollector;
  signal?: AbortSignal;
}): Promise<RemoteSendResult> {
  const { card, token, text, contextId, files, collector, signal } = options;
  const client = await createClient(card, token);

  const parts: Part[] = [
    {
      content: { $case: "text", value: text },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    },
    ...(files ?? []).map((file): Part => ({
      content: { $case: "raw", value: file.data },
      metadata: undefined,
      filename: file.name,
      mediaType: file.mime.length > 0 ? file.mime : "application/octet-stream",
    })),
  ];

  const request: SendMessageRequest = {
    tenant: "",
    message: {
      messageId: randomUUID(),
      contextId: contextId ?? "",
      taskId: "",
      role: Role.ROLE_USER,
      parts,
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  };

  for await (const response of client.sendMessageStream(request, { signal })) {
    collector.handle(response);
  }

  // A stream that ended without a `lastChunk` still has to deliver what it
  // sent, so nothing is silently dropped.
  collector.flush();
  const result = collector.result();
  // No task id means there is nothing to recover: the peer answered with a
  // plain message (or refused outright), so this send is complete either way.
  return { ...result, terminal: result.terminal || result.taskId === null };
}

/**
 * Pick up a task whose stream ended (or died) before the peer finished.
 *
 * Three steps, cheapest first: read the task once (enough when it finished
 * while we were away, and it works against peers that do not stream
 * resubscription), then re-attach with A2A `resubscribe` — the protocol's own
 * answer to a dropped connection, which delivers everything produced meanwhile
 * — and only then fall back to polling `getTask` until the task settles.
 */
export async function recoverRemoteTask(options: {
  card: unknown;
  token: string | null;
  taskId: string;
  collector: RemoteAnswerCollector;
  signal?: AbortSignal;
  maxMs?: number;
}): Promise<RemoteSendResult> {
  const { card, token, taskId, collector, signal } = options;
  const maxMs = options.maxMs ?? RECOVERY_MAX_MS;
  const client = await createClient(card, token);

  // A task the peer no longer knows cannot be recovered; let the caller report
  // that instead of polling forever.
  collector.task(
    await client.getTask(
      { tenant: "", id: taskId, historyLength: 0 },
      { signal },
    ),
  );
  collector.flush();
  if (collector.terminal) return collector.result();

  try {
    for await (const response of client.resubscribeTask(
      { tenant: "", id: taskId },
      { signal },
    )) {
      collector.handle(response);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // Peers that do not support streaming resubscription land here; the
    // polling loop below still gets the answer.
  }
  collector.flush();
  if (collector.terminal) return collector.result();

  const startedAt = Date.now();
  while (!signal?.aborted && Date.now() - startedAt < maxMs) {
    await delay(RECOVERY_POLL_MS, signal);
    if (signal?.aborted) break;
    collector.task(
      await client.getTask(
        { tenant: "", id: taskId, historyLength: 0 },
        { signal },
      ),
    );
    collector.flush();
    if (collector.terminal) break;
  }
  return collector.result();
}
