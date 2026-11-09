import {
  ASSISTANT_COMMENT_RESPONSE_PROMPT,
  ASSISTANT_REPORT_PROMPT,
  buildEmployeeRolePrompt,
  COMMENT_RESPONSE_PROMPT,
  EMPLOYEE_DIRECT_CHAT_PROMPT,
  EMPLOYEE_REPORT_PROMPT,
  MENTION_HANDLING_PROMPT,
  NEVER_BLOCK_WAITING_PROMPT,
  RESPONSE_LANGUAGE_PROMPT,
} from "@shared/constants/prompts";
import { BuildEmployeeSystemPromptArgs } from "@shared/types";

/**
 * Assemble an employee-session's system prompt under the app's own
 * `systemPromptOverride` (the Pi SDK customPrompt branch). The SDK renders this
 * override as the **`preamble` section** of the prompt and appends its own
 * sections after it (`<project_context>`, `[skills]`, `Current working
 * directory`). The exact template shape:
 *
 * ```
 * This is your working session as employee {ID}[( {name}) — assistant only] in chat {chatId}[, the boss's chat][, your direct conversation with the boss — direct chat only].
 * [This task group chat was created from chat {fromChatId}, the boss's chat.  — only when fromChatId is set]
 * [role: generated for non-assistants; baked into ASSISTANT_SYSTEM_PROMPT for the assistant]
 * [employeePrompt: persona]
 * [report skill: assistant aggregation/progress/summary OR employee result report
 *  OR — in an employee direct chat — the "your final text is the reply" rule]
 * [@-mention handling]
 * [comments handling: employee answers them OR the assistant routes + relays]
 * [never block waiting]
 * [response language]
 * [tools]
 * ```
 *
 * **Nothing volatile may go in here.** Pi persists the prompt as *sections* and
 * appends a `system` message whenever a section's text differs from the one the
 * transcript already carries — so a date, a timestamp, a turn counter or any
 * other per-run value would make every turn write a full new `preamble` (the
 * whole system prompt) into the session file, and would break provider prompt
 * caching. Per-turn information belongs in the prompt **payload** the turn
 * carries (the boss's text, `[Comments]`, `[Attachments]`, the boss-direct hint),
 * never in this function's output. `scripts/tests/equivalence-harness.ts`
 * asserts the determinism.
 */
export function buildEmployeeSystemPrompt({
  personaParts,
  isAssistant,
  name,
  role,
  employeeId,
  chatId,
  fromChatId,
  directChat,
  toolEntries,
  toolsGuidelines,
}: BuildEmployeeSystemPromptArgs): string {
  const persona = personaParts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");

  // The assistant's role text is baked into `ASSISTANT_SYSTEM_PROMPT`;
  // non-assistants get a generated block from their name/role.
  const roleBlock = isAssistant ? "" : buildEmployeeRolePrompt(name, role);

  const toolsBlock = [
    "## Available tools",
    ...toolEntries.map((entry) => `- ${entry.name}: ${entry.snippet}`),
    "",
    "## Guidelines",
    ...toolsGuidelines.map((guideline) => `- ${guideline}`),
  ].join("\n");

  // Leading identity block: which employee this session is and which chat it
  // runs in. The assistant's session lives in the boss's root chat, so label
  // its `chatId` as such — otherwise the model cannot connect the wake prompt's
  // task-group id to the boss-facing `chatId` it must post to. For an employee
  // group session, the spawning chat (`fromChatId`) is likewise the boss's chat.
  //
  // The assistant also gets its own name in parentheses: its session has no
  // generated role block (that text is baked into `ASSISTANT_SYSTEM_PROMPT`),
  // so this is the only place the model learns what it is called. The name is
  // boss-editable and may be blank (`validateName` allows an empty string), in
  // which case the parenthetical is omitted and the line stays as before.
  const assistantName = isAssistant ? name.trim() : "";
  const assistantNameSuffix = assistantName ? ` (${assistantName})` : "";
  // A direct chat is the boss's own conversation with this employee: name that
  // explicitly, since it is what makes the delivery rule below mean "answer
  // here" instead of "post a message".
  const directSuffix = directChat
    ? ", your direct conversation with the boss"
    : "";
  const identityLines = [
    isAssistant
      ? `This is your working session as employee ${employeeId}${assistantNameSuffix} in chat ${chatId}, the boss's chat.`
      : `This is your working session as employee ${employeeId} in chat ${chatId}${directSuffix}.`,
  ];
  if (fromChatId != null) {
    identityLines.push(
      `This task group chat was created from chat ${fromChatId}, the boss's chat.`,
    );
  }
  const identityBlock = identityLines.join("\n");

  // Role-specific reporting skill: the assistant aggregates employee reports into
  // boss-facing progress + a summary; a non-assistant reports finished work to its
  // assigner. In an employee direct chat the boss is the one being answered, so
  // "post your result with imb_send_message" would be the wrong rule there — the
  // employee's final text IS the reply and replaces that block.
  const reportBlock = isAssistant
    ? ASSISTANT_REPORT_PROMPT
    : directChat
      ? EMPLOYEE_DIRECT_CHAT_PROMPT
      : EMPLOYEE_REPORT_PROMPT;
  // Comments: an employee answers them (it does the work); the assistant routes
  // each comment to whoever produced the annotated passage and relays the
  // answers, answering only the ones about its own output. Chosen by role, which
  // is fixed per session — never per turn (see `prompts.ts`).
  const commentBlock = isAssistant
    ? ASSISTANT_COMMENT_RESPONSE_PROMPT
    : COMMENT_RESPONSE_PROMPT;

  const sections = [
    identityBlock,
    roleBlock,
    persona,
    reportBlock,
    MENTION_HANDLING_PROMPT,
    commentBlock,
    NEVER_BLOCK_WAITING_PROMPT,
    RESPONSE_LANGUAGE_PROMPT,
    toolsBlock,
  ];

  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}
