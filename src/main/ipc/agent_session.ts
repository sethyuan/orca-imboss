import { ASSISTANT_ID } from "@shared/constants/employees";
import type {
  AgentSessionRunState,
  AgentSessionSendResult,
  AgentSessionSteerRevokeResult,
  MessageAttachment,
} from "@shared/types";
import type { Binder } from "../rpc/types";
import {
  bind as bindSession,
  deliver,
  interruptChat,
  interruptTurn,
  readRunState,
  revokeSteer,
  unbind,
} from "../agent/session-queue";
import { getChat, getRootChatId } from "../db/chats";
import { getEmployee } from "../db/employees";
import { validateMessageAttachments } from "../db/messages";
import { agentPrompt, validateAttachmentsPayload } from "../attachment-prompt";
import { validateCommentsPayload, withComments } from "../comment-prompt";
import { withBossDirectHint } from "../agent/boss-direct-prompt";
import { assertInteger, assertString } from "./helpers";

/**
 * Mirrors the `messages.content` limit. A session prompt is not stored there,
 * but one bound keeps an unbounded string from ever reaching the model.
 */
const MAX_MESSAGE_LENGTH = 100_000;

/**
 * Hard bound on the **composed** prompt (typed text + the `[Attachments]`
 * block). The per-field caps already bound each attachment (≤16 entries, name
 * ≤256, path ≤4096), so this is a belt-and-braces ceiling on what a single
 * steer/injection may carry.
 */
const MAX_PROMPT_LENGTH = 200_000;

/**
 * Mirrors the app-generated interjection ids (`st<N>`): a bound keeps an
 * arbitrary renderer string from reaching the queue lookup.
 */
const MAX_STEER_ID_LENGTH = 64;

/**
 * Renderer ↔ main binding for live agent sessions.
 *
 * `agentSession:bind` registers `event.sender` to receive the `(employee,
 * chat)` session's streamed events over `agentSession:event`. The session
 * itself is created lazily on the first `deliver(...)` (chat send / cron), so
 * binding a chat does not build a Pi session. `agentSession:unbind` removes the
 * registration.
 */
export function registerAgentSessionHandlers(rpc: Binder): void {
  rpc(
    "agentSession:bind",
    (ctx, employeeId: unknown, chatId: unknown): void => {
      bindSession(
        assertInteger(employeeId, "employee id"),
        assertInteger(chatId, "chat id"),
        ctx.subscriber,
      );
    },
  );

  rpc(
    "agentSession:unbind",
    (ctx, employeeId: unknown, chatId: unknown): void => {
      unbind(
        assertInteger(employeeId, "employee id"),
        assertInteger(chatId, "chat id"),
        ctx.subscriber,
      );
    },
  );

  // Halt: interrupt every agent session belonging to a chat — its non-assistant
  // employee participants plus the assistant's root-chat orchestration session.
  // Returns the number of session states acted on.
  rpc("agentSession:interruptChat", (_ctx, chatId: unknown): Promise<number> =>
    interruptChat(assertInteger(chatId, "chat id")),
  );

  // Interrupt the **current turn** of exactly one `(employee, chat)` session
  // (the agent-session view's button). Queued messages are kept and the session
  // stays alive. Returns whether a streaming run was actually interrupted.
  rpc(
    "agentSession:interruptTurn",
    (_ctx, employeeId: unknown, chatId: unknown): Promise<boolean> =>
      interruptTurn(
        assertInteger(employeeId, "employee id"),
        assertInteger(chatId, "chat id"),
      ),
  );

  // Cosmetic run state for the same view: labels (`Send` vs `Interject`) and the
  // interrupt chip's enabled state. Never used to route a message — `deliver()`
  // re-checks the live session.
  rpc(
    "agentSession:state",
    (_ctx, employeeId: unknown, chatId: unknown): AgentSessionRunState =>
      readRunState(
        assertInteger(employeeId, "employee id"),
        assertInteger(chatId, "chat id"),
      ),
  );

  /**
   * Send a message into exactly one `(employee, chat)` agent session — the
   * agent-session view's composer.
   *
   * The text (plus an optional attachment list, exactly like `chat:send`) is
   * injected into that employee's Pi session **only**: nothing is written to the
   * conversation and no `read_cursors` row moves, so the chat transcript stays
   * untouched (boss's explicit decision). Attachments therefore travel the same
   * way they do for a chat send — as absolute paths described to the model by
   * `agentPrompt()` — instead of as stored rows.
   *
   * `deliver()` decides between steering the live run and queueing, and never
   * throws for a run failure (those surface as `error` events on the bound
   * windows), so a rejection here only ever means the request itself was
   * invalid. The interjection records what the boss typed as its display copy
   * (`displayText`) while Pi's queue and every withdrawal / interrupt path keep
   * the composed prompt.
   *
   * `comments` are annotations of **earlier entries of this same session** (see
   * `comment-prompt.ts`). Nothing is written to `messages` here, so the prompt's
   * `[Comments]` block is their only storage: the projection reads it back
   * (`splitCommentPrompt`) to render the quoted cards and the highlights. A
   * comment-only send (no text, no files) is legitimate.
   */
  rpc(
    "agentSession:send",
    async (
      _event,
      employeeId: unknown,
      chatId: unknown,
      text: unknown,
      attachments: unknown,
      comments: unknown,
    ): Promise<AgentSessionSendResult> => {
      const safeEmployee = assertInteger(employeeId, "employee id");
      const safeChat = assertInteger(chatId, "chat id");
      const safeText = assertString(text, "message");
      // One definition of what an attachment may contain, shared with the stored
      // message path (`validateMessageAttachments`). A session prompt is never
      // stored, but the same trust boundary applies to what reaches the model.
      const safeAttachments: MessageAttachment[] | undefined =
        validateMessageAttachments(validateAttachmentsPayload(attachments));
      const hasAttachments =
        safeAttachments !== undefined && safeAttachments.length > 0;
      // Session-entry anchors name transcript entries, which live in the Pi
      // session file — there is nothing to check them against here, so only the
      // shared shape rules apply.
      const safeComments = validateCommentsPayload(comments);
      const hasComments = safeComments !== undefined && safeComments.length > 0;
      // A file-only (or comment-only) send is legitimate (chat's composer allows
      // it too); only an entirely empty request is rejected.
      if (safeText.trim().length === 0 && !hasAttachments && !hasComments) {
        throw new Error("Message must not be empty.");
      }
      if (safeText.length > MAX_MESSAGE_LENGTH) {
        throw new Error("Message is too long.");
      }
      // The boss typing here is *the boss talking to this employee*: mark the
      // turn so the answer comes back as the employee's final text instead of a
      // posted chat message (see `boss-direct-prompt.ts` for why this is a
      // per-turn suffix and for every ingress that deliberately does not get it).
      // The assistant keeps its own contract ("post into the boss's chat").
      //
      // Composition order is fixed: text → `[Comments]` → boss hint →
      // `[Attachments]`. The attachment block must stay the trailing suffix the
      // session projection splits off first (see `comment-prompt.ts`).
      const textWithComments = withComments(safeText, safeComments);
      const prompt =
        safeEmployee === ASSISTANT_ID
          ? agentPrompt(textWithComments, safeAttachments)
          : agentPrompt(withBossDirectHint(textWithComments), safeAttachments);
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new Error("Message is too long.");
      }

      // Defensive guards: never materialize a session for a pair that cannot
      // legitimately own one (deleted employee/chat, a removed participant) —
      // `deliver()` would happily create one. The assistant is exempt from the
      // participant check: its session lives in the chat's root chat, which it
      // always belongs to, and a legacy root chat may lack the row.
      if (!getEmployee(safeEmployee)) {
        throw new Error("Employee not found.");
      }
      const chat = getChat(safeChat);
      if (!chat) {
        throw new Error("Conversation not found.");
      }
      if (
        safeEmployee !== ASSISTANT_ID &&
        !chat.participants.includes(safeEmployee)
      ) {
        throw new Error(
          "The employee is not a participant of this conversation.",
        );
      }
      // The assistant has no session in a task group chat (it runs in the root
      // chat); `openAgentSession` always resolves this, so a mismatch is a bug.
      if (
        safeEmployee === ASSISTANT_ID &&
        getRootChatId(safeChat) !== safeChat
      ) {
        throw new Error(
          "The assistant's session only exists in its root chat.",
        );
      }

      return await deliver(safeEmployee, safeChat, prompt, {
        mode: "steer",
        // The interjection is displayed (and handed back on withdrawal) as what
        // the boss typed, never as the composed prompt.
        displayText: safeText,
      });
    },
  );

  /**
   * Withdraw one interjection of exactly one `(employee, chat)` session — the
   * reverse of `agentSession:send` for the text that has not been injected yet.
   *
   * `withdrawn: false` is a normal answer, not a failure: a text Pi already
   * turned into a transcript user message cannot be taken back (`delivered`),
   * and a text that is no longer pending cannot either (`gone`). Only invalid
   * parameters throw, mirroring `agentSession:send`.
   */
  rpc(
    "agentSession:revokeSteer",
    async (
      _event,
      employeeId: unknown,
      chatId: unknown,
      steerId: unknown,
    ): Promise<AgentSessionSteerRevokeResult> => {
      const safeEmployee = assertInteger(employeeId, "employee id");
      const safeChat = assertInteger(chatId, "chat id");
      const safeSteerId = assertString(steerId, "interjection id");
      if (safeSteerId.length > MAX_STEER_ID_LENGTH) {
        throw new Error("Interjection id is too long.");
      }
      return revokeSteer(safeEmployee, safeChat, safeSteerId);
    },
  );
}
