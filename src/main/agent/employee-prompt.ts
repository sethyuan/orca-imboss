import {
  ASSISTANT_REPORT_PROMPT,
  buildEmployeeRolePrompt,
  EMPLOYEE_DIRECT_CHAT_PROMPT,
  EMPLOYEE_REPORT_PROMPT,
  MENTION_HANDLING_PROMPT,
  NEVER_BLOCK_WAITING_PROMPT,
  RESPONSE_LANGUAGE_PROMPT,
} from "@shared/constants/prompts";
import { BuildEmployeeSystemPromptArgs } from "@shared/types";

/**
 * Assemble an employee-session's system prompt under the app's own
 * `systemPromptOverride` (the Pi SDK customPrompt branch). Because the SDK
 * appends `<project_context>`, `[skills]` and a trailing
 * `Current working directory` line after the override, this function emits
 * the leading identity block, the role, persona, `[builtinSkills]`,
 * response-language rule, the `[tools]` block and the `Today` line (in that
 * order). The exact template shape:
 *
 * ```
 * This is your working session as employee {ID}[( {name}) — assistant only] in chat {chatId}[, the boss's chat][, your direct conversation with the boss — direct chat only].
 * [This task group chat was created from chat {fromChatId}, the boss's chat.  — only when fromChatId is set]
 * [role: generated for non-assistants; baked into ASSISTANT_SYSTEM_PROMPT for the assistant]
 * [employeePrompt: persona]
 * [report skill: assistant aggregation/progress/summary OR employee result report
 *  OR — in an employee direct chat — the "your final text is the reply" rule]
 * [@-mention handling]
 * [never block waiting]
 * [builtinSkills]
 * [response language]
 * [tools]
 * Today is {yyyy-MM-dd}
 * ```
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

  const sections = [
    identityBlock,
    roleBlock,
    persona,
    reportBlock,
    MENTION_HANDLING_PROMPT,
    NEVER_BLOCK_WAITING_PROMPT,
    RESPONSE_LANGUAGE_PROMPT,
    toolsBlock,
  ];

  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}
