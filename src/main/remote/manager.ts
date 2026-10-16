import { readFileSync, statSync } from "fs";
import { t } from "@shared/l10n";
import {
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_TOTAL_BYTES,
} from "@shared/constants/attachments";
import { ASSISTANT_ID } from "@shared/constants/employees";
import type {
  MessageAttachment,
  RemoteAgent,
  RemoteAgentInput,
} from "@shared/types";
import { savePastedFile } from "../attachments";
import * as dbMessages from "../db/messages";
import * as dbRemote from "../db/remote-agents";
import { normalizeRemoteUrl, resolveRemoteCard } from "./card";
import {
  RemoteAnswerCollector,
  recoverRemoteTask,
  sendToRemoteAgent,
  type RemoteFile,
  type RemoteTaskState,
} from "./client";
import { loadRemoteAgentSecrets, setToken, tokenFor } from "./store";

/**
 * Bridge between an imboss conversation and a remote A2A peer.
 *
 * The user writes in the peer's chat; `send()` streams the peer's answer back
 * into that chat as messages authored by the peer's hidden employee row. State
 * changes the chat cannot render as content (failure, waiting for input) are
 * posted as short `remote-status` notes.
 *
 * Two things make the bridge survive real networks: the peer's conversation id
 * is persisted and echoed on the next turn (so multi-turn context works), and a
 * run is tracked by its task id so a stream that drops can be re-attached
 * (`recoverRemoteTask`) instead of losing the answer. A run still marked
 * 'working' when the app starts was orphaned by the previous process, so it is
 * resumed rather than left hanging.
 */

/** Message kind for app-generated notes about a peer's task state. */
const STATUS_KIND = "remote-status";

/** Message kind for content the peer produced. */
const CONTENT_KIND = "text";

/** Caps applied to a peer's answer before it reaches the message table. */
const MAX_CONTENT = 100_000;

/** How a run ended, as reported back to the caller. */
export type RemoteRunStatus =
  "completed" | "working" | "failed" | "canceled" | "no-reply";

/** What one `send()` did. */
export interface RemoteSendOutcome {
  /** The peer's conversation. */
  chatId: number;
  /** Text the peer produced during this call, or null when it produced none. */
  answer: string | null;
  status: RemoteRunStatus;
}

/** What an assistant-initiated delegation to a peer did. */
export interface RemoteDelegateResult {
  agent: { id: number; name: string; chatId: number };
  status: RemoteRunStatus;
  /** The peer's answer, when it arrived within the caller's budget. */
  answer: string | null;
}

interface InFlightSend {
  chatId: number;
  controller: AbortController;
}

class RemoteAgentManager {
  private readonly inFlight = new Map<number, InFlightSend>();
  private nextSendId = 1;
  private started = false;
  private resumed = false;

  /** Load the peer secrets file and resume any interrupted run. Idempotent. */
  async init(): Promise<void> {
    if (!this.started) {
      this.started = true;
      await loadRemoteAgentSecrets();
    }
    if (!this.resumed) {
      this.resumed = true;
      this.resumeOrphanedRuns();
    }
  }

  /** Renderer snapshot of every peer. */
  list(): RemoteAgent[] {
    return dbRemote.listRemoteAgents().map(dbRemote.toRemoteAgentView);
  }

  /**
   * Add a peer: resolve its agent card, then create the peer, its hidden
   * employee row and its conversation in one transaction. A card that cannot
   * be resolved fails the add, so a peer is never stored in a broken state.
   */
  async add(input: RemoteAgentInput): Promise<RemoteAgent> {
    await this.init();
    const url = normalizeRemoteUrl(input.url);
    if (this.list().some((agent) => agent.url === url)) {
      throw new Error("This remote agent has already been added.");
    }
    const token = input.token?.trim() ?? "";
    const resolved = await resolveRemoteCard(
      url,
      token.length > 0 ? token : null,
    );
    const record = dbRemote.createRemoteAgent({
      url,
      card: resolved.card,
      name: resolved.name,
      role: resolved.description,
      status: "ok",
      statusDetail: null,
    });
    if (!record) throw new Error("Could not create the remote agent.");
    if (token.length > 0) await setToken(record.id, token);
    return dbRemote.toRemoteAgentView(record);
  }

  /** Delete a peer, its conversation and its hidden employee row. */
  async remove(id: number): Promise<boolean> {
    const record = dbRemote.getRemoteAgent(id);
    if (record) this.disposeForChat(record.chatId);
    const removed = dbRemote.deleteRemoteAgent(id);
    if (removed) await setToken(id, null);
    return removed;
  }

  /** Re-resolve the agent card and record the outcome. */
  async refresh(id: number): Promise<RemoteAgent> {
    await this.init();
    const record = dbRemote.getRemoteAgent(id);
    if (!record) throw new Error("Unknown remote agent.");
    try {
      const resolved = await resolveRemoteCard(record.url, tokenFor(id));
      dbRemote.updateRemoteAgentCard(id, resolved.card, "ok", null);
      dbRemote.renameRemoteAgentEmployee(
        record.employeeId,
        resolved.name,
        resolved.description,
      );
    } catch (err) {
      // Keep the last good card so the peer stays usable; only the status and
      // the detail change.
      dbRemote.updateRemoteAgentCard(
        id,
        record.card,
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
    const updated = dbRemote.getRemoteAgent(id);
    if (!updated) throw new Error("Unknown remote agent.");
    return dbRemote.toRemoteAgentView(updated);
  }

  /**
   * Send one user message to the peer owning `chatId` and post its answer.
   * Never throws: failures become a message in the conversation plus a peer
   * status, because the caller is the fire-and-forget `chat:send` path. The
   * returned outcome lets a caller that *does* wait (assistant delegation) read
   * the answer directly.
   */
  async send(
    chatId: number,
    text: string,
    attachments?: MessageAttachment[],
  ): Promise<RemoteSendOutcome> {
    await this.init();
    const record = dbRemote.getRemoteAgentByChat(chatId);
    if (!record) {
      console.error(
        `[remote] chat ${chatId} is not bridged to a remote agent; dropping the send.`,
      );
      return { chatId, answer: null, status: "failed" };
    }
    if (record.card === null) {
      // The cached card is unusable (a corrupt row). The peer can still be
      // refreshed from Settings, so say so instead of failing silently.
      this.note(
        chatId,
        record.employeeId,
        t(
          "This remote agent has no usable agent card. Refresh it in Settings → Remote agents.",
        ),
        STATUS_KIND,
        false,
      );
      return { chatId, answer: null, status: "failed" };
    }

    const sendId = this.nextSendId++;
    const controller = new AbortController();
    this.inFlight.set(sendId, { chatId, controller });

    const answers: string[] = [];
    const collector = new RemoteAnswerCollector({
      onContent: (body, files) => {
        const stored = this.storeFiles(chatId, files);
        if (body.length === 0 && stored.length === 0) return;
        if (body.length > 0) answers.push(body);
        this.post(chatId, record.employeeId, body, {
          kind: CONTENT_KIND,
          attachments: stored,
        });
      },
      onState: (state) => {
        const note = stateNote(state);
        if (note !== null) {
          this.note(chatId, record.employeeId, note, STATUS_KIND, false);
        }
      },
      onContext: (contextId) => {
        dbRemote.setRemoteAgentContextId(record.id, contextId);
      },
      onTask: (taskId) => {
        dbRemote.setRemoteAgentRun(record.id, "working", taskId);
      },
    });

    const { files, uploaded, named } = this.collectOutgoing(attachments);
    let settled = false;
    let taskId: string | null = null;

    try {
      const result = await sendToRemoteAgent({
        card: record.card,
        token: tokenFor(record.id),
        text: composePrompt(text, uploaded, named),
        contextId: record.contextId,
        files,
        collector,
        signal: controller.signal,
      });
      taskId = result.taskId;
      settled = result.terminal;
      if (!settled && taskId !== null) {
        // The stream ended before the peer finished — usually a dropped
        // connection. Re-attach to the task rather than losing the answer.
        settled = await this.recover(record, taskId, collector, controller);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return { chatId, answer: null, status: "canceled" };
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[remote] send to peer ${record.id} failed:`, detail);
      // A stream that died mid-task is still recoverable by its task id.
      const handle = collector.taskId ?? taskId;
      if (handle !== null && !collector.terminal) {
        settled = await this.recover(record, handle, collector, controller);
      }
      if (!settled) {
        dbRemote.updateRemoteAgentCard(record.id, record.card, "error", detail);
        this.note(
          chatId,
          record.employeeId,
          t("The remote agent request failed: ${error}", { error: detail }),
          STATUS_KIND,
          false,
        );
        return { chatId, answer: null, status: "failed" };
      }
    } finally {
      this.inFlight.delete(sendId);
    }

    // A peer that failed its last refresh but just answered is healthy again.
    if (record.status !== "ok") {
      dbRemote.updateRemoteAgentCard(record.id, record.card, "ok", null);
    }

    const answer = answers.length > 0 ? answers.join("\n\n") : null;
    const status = runStatus(collector.lastState, settled, answer !== null);
    if (status === "working") {
      // Nothing settled, so the task may still answer later. Leave the run
      // marked so it is picked up again (now, or at the next start).
      this.note(
        chatId,
        record.employeeId,
        t(
          "The remote agent is still working. Its answer will appear here when it finishes.",
        ),
        STATUS_KIND,
        true,
      );
      this.watchLater(record.id, chatId, record.employeeId);
    } else {
      dbRemote.setRemoteAgentRun(record.id, "idle", taskId);
      if (status === "no-reply") {
        this.note(
          chatId,
          record.employeeId,
          t("The remote agent finished without a reply."),
          STATUS_KIND,
          true,
        );
      }
    }
    return { chatId, answer, status };
  }

  /**
   * Assistant-initiated send: post the request into the peer's own
   * conversation (so the boss can follow the exchange), then wait up to
   * `waitMs` for an answer. A peer slower than the budget keeps working in the
   * background — its answer lands in that conversation, and a restart still
   * resumes it.
   */
  async delegate(options: {
    agent: string;
    message: string;
    waitMs: number;
  }): Promise<RemoteDelegateResult> {
    await this.init();
    const peer = this.resolvePeer(options.agent);
    const text = options.message.trim();
    if (text.length === 0) throw new Error("A message is required.");
    dbMessages.appendMessage(peer.chatId, ASSISTANT_ID, text, {
      kind: CONTENT_KIND,
    });
    const run = this.send(peer.chatId, text);
    const agent = { id: peer.id, name: peer.name, chatId: peer.chatId };
    if (options.waitMs <= 0) return { agent, status: "working", answer: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.waitMs);
    });
    try {
      // The send is not cancelled when the budget expires: it keeps streaming
      // into the conversation, which is exactly what the caller is told.
      const outcome = await Promise.race([run, budget]);
      if (outcome === null) return { agent, status: "working", answer: null };
      return { agent, status: outcome.status, answer: outcome.answer };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Abort every in-flight send for one conversation (chat deleted). */
  disposeForChat(chatId: number): void {
    for (const [sendId, entry] of this.inFlight) {
      if (entry.chatId !== chatId) continue;
      entry.controller.abort();
      this.inFlight.delete(sendId);
    }
  }

  /**
   * Peer ids bound to these conversations. Read *before* the chats are
   * deleted, so no peer is left without its conversation.
   */
  peerIdsForChats(chatIds: number[]): number[] {
    return dbRemote.remoteAgentIdsForChats(chatIds);
  }

  /** Abort every in-flight send (app quit). Runs stay marked for resume. */
  disposeAll(): void {
    for (const entry of this.inFlight.values()) entry.controller.abort();
    this.inFlight.clear();
  }

  /**
   * Re-attach to a task whose stream ended early, and report whether it settled.
   * Failures are swallowed here: the caller decides what to tell the user.
   */
  private async recover(
    record: dbRemote.RemoteAgentRecord,
    taskId: string,
    collector: RemoteAnswerCollector,
    controller: AbortController,
  ): Promise<boolean> {
    try {
      const result = await recoverRemoteTask({
        card: record.card,
        token: tokenFor(record.id),
        taskId,
        collector,
        signal: controller.signal,
      });
      return result.terminal;
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(
          `[remote] could not recover task ${taskId} of peer ${record.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return false;
    }
  }

  /**
   * Keep watching a task that has not settled, in the background. The run stays
   * marked 'working', so a quit mid-watch still resumes at the next start.
   */
  private watchLater(peerId: number, chatId: number, employeeId: number): void {
    const record = dbRemote.getRemoteAgent(peerId);
    if (!record || record.lastTaskId === null || record.card === null) return;
    const controller = new AbortController();
    const sendId = this.nextSendId++;
    this.inFlight.set(sendId, { chatId, controller });
    const collector = new RemoteAnswerCollector({
      onContent: (body, files) => {
        const stored = this.storeFiles(chatId, files);
        if (body.length === 0 && stored.length === 0) return;
        this.post(chatId, employeeId, body, {
          kind: CONTENT_KIND,
          attachments: stored,
        });
      },
      onState: (state) => {
        const note = stateNote(state);
        if (note !== null) {
          this.note(chatId, employeeId, note, STATUS_KIND, false);
        }
      },
      onContext: (contextId) => {
        dbRemote.setRemoteAgentContextId(peerId, contextId);
      },
      onTask: () => undefined,
    });
    void this.recover(record, record.lastTaskId, collector, controller)
      .then((settled) => {
        if (settled)
          dbRemote.setRemoteAgentRun(peerId, "idle", record.lastTaskId);
      })
      .finally(() => {
        this.inFlight.delete(sendId);
      });
  }

  /**
   * Resume runs left 'working' by a previous process. There is no live stream
   * to inherit, so each one is recovered from its task id alone.
   */
  private resumeOrphanedRuns(): void {
    for (const record of dbRemote.listOrphanedRemoteAgentRuns()) {
      this.watchLater(record.id, record.chatId, record.employeeId);
    }
  }

  /**
   * Find a peer by id, exact name, or a unique fragment of its name. Ambiguity
   * is an error rather than a guess, so the assistant can ask for a precise
   * name instead of messaging the wrong company.
   */
  private resolvePeer(query: string): RemoteAgent {
    const agents = this.list();
    if (agents.length === 0) {
      throw new Error("No remote agents have been added yet.");
    }
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      throw new Error("A remote agent name or id is required.");
    }
    const byId = agents.find((agent) => String(agent.id) === needle);
    if (byId) return byId;
    const exact = agents.filter((agent) => agent.name.toLowerCase() === needle);
    if (exact.length === 1) return exact[0];
    const partial = agents.filter((agent) =>
      agent.name.toLowerCase().includes(needle),
    );
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(
        `"${query}" matches more than one remote agent: ` +
          `${partial.map((agent) => agent.name).join(", ")}. ` +
          "Use the exact name or the id.",
      );
    }
    throw new Error(
      `Unknown remote agent "${query}". Available: ` +
        `${agents.map((agent) => `${agent.name} (id ${agent.id})`).join(", ")}.`,
    );
  }

  /** Store files the peer sent as normal chat attachments. */
  private storeFiles(chatId: number, files: RemoteFile[]): MessageAttachment[] {
    const stored: MessageAttachment[] = [];
    for (const file of files) {
      if (file.data.length === 0 || file.data.length > MAX_REMOTE_FILE_BYTES) {
        continue;
      }
      try {
        stored.push(savePastedFile(chatId, file.name, file.mime, file.data));
      } catch (err) {
        console.error(
          `[remote] could not store "${file.name}" from a peer:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return stored;
  }

  /**
   * Read local attachments into A2A `raw` parts, subject to the bridge's caps.
   * Anything that cannot be uploaded (a folder, a missing file, a file over the
   * cap) is reported back as a name so the prompt can say so.
   */
  private collectOutgoing(attachments: MessageAttachment[] | undefined): {
    files: RemoteFile[];
    uploaded: string[];
    named: string[];
  } {
    const files: RemoteFile[] = [];
    const uploaded: string[] = [];
    const named: string[] = [];
    let total = 0;
    for (const attachment of attachments ?? []) {
      const name = attachment.name.trim();
      if (name.length === 0) continue;
      if (attachment.kind === "folder" || !attachment.path) {
        named.push(name);
        continue;
      }
      try {
        const stat = statSync(attachment.path);
        if (
          !stat.isFile() ||
          stat.size === 0 ||
          stat.size > MAX_REMOTE_FILE_BYTES ||
          total + stat.size > MAX_REMOTE_TOTAL_BYTES
        ) {
          named.push(name);
          continue;
        }
        const data = readFileSync(attachment.path);
        total += data.length;
        files.push({
          name,
          mime:
            attachment.type.length > 0
              ? attachment.type
              : "application/octet-stream",
          data,
        });
        uploaded.push(name);
      } catch {
        named.push(name);
      }
    }
    return { files, uploaded, named };
  }

  private post(
    chatId: number,
    employeeId: number,
    body: string,
    options: { kind: string; attachments?: MessageAttachment[] },
  ): void {
    const capped =
      body.length > MAX_CONTENT ? `${body.slice(0, MAX_CONTENT)}…` : body;
    try {
      dbMessages.appendMessage(chatId, employeeId, capped, {
        kind: options.kind,
        ...(options.attachments && options.attachments.length > 0
          ? {
              attachments: options.attachments,
              attachmentTotal: options.attachments.length,
            }
          : {}),
      });
    } catch (err) {
      console.error(
        `[remote] failed to store the peer's message in chat ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Post an app note about a peer (never carries attachments). */
  private note(
    chatId: number,
    employeeId: number,
    body: string,
    kind: string,
    silent: boolean,
  ): void {
    const capped =
      body.length > MAX_CONTENT ? `${body.slice(0, MAX_CONTENT)}…` : body;
    try {
      dbMessages.appendMessage(chatId, employeeId, capped, {
        kind,
        ...(silent ? { silent: true } : {}),
      });
    } catch (err) {
      console.error(
        `[remote] failed to store a peer note in chat ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** How a finished run should be described to the caller. */
function runStatus(
  lastState: RemoteTaskState | null,
  settled: boolean,
  produced: boolean,
): RemoteRunStatus {
  if (!settled) return "working";
  if (lastState === "failed") return "failed";
  if (lastState === "canceled" || lastState === "rejected") return "canceled";
  if (lastState === "completed" || lastState === "input-required") {
    return produced ? "completed" : "no-reply";
  }
  return produced ? "completed" : "no-reply";
}

/** A short, localized note for the states a chat should surface. */
function stateNote(state: RemoteTaskState): string | null {
  switch (state) {
    case "input-required":
      return t("The remote agent is waiting for your reply.");
    case "auth-required":
      return t("The remote agent requires authentication.");
    case "failed":
      return t("The remote agent reported a failure.");
    case "rejected":
      return t("The remote agent declined the request.");
    case "canceled":
      return t("The remote agent canceled the task.");
    default:
      // `submitted` / `working` / `completed` / `unknown` need no note: the
      // answer itself, or the no-reply fallback, already tells the story.
      return null;
  }
}

/**
 * Prompt sent to the peer: the user's text plus a note of what came with it.
 * Uploaded files are announced as uploaded (they travel as A2A `raw` parts);
 * anything that could not be uploaded is named so the peer knows it exists but
 * cannot read it, instead of silently pretending it arrived.
 */
function composePrompt(
  text: string,
  uploaded: string[],
  named: string[],
): string {
  const body = text.trim();
  const blocks: string[] = [];
  if (uploaded.length > 0) {
    blocks.push(`[Attached files: ${uploaded.join(", ")}]`);
  }
  if (named.length > 0) {
    blocks.push(
      `[Attached but not uploaded (too large or not a file): ${named.join(", ")}]`,
    );
  }
  if (blocks.length === 0) return body;
  const suffix = blocks.join("\n");
  return body.length > 0 ? `${body}\n\n${suffix}` : suffix;
}

export const remoteAgentManager = new RemoteAgentManager();
