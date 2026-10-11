import {
  ASSISTANT_REPORT_PROMPT,
  buildEmployeeRolePrompt,
  EMPLOYEE_REPORT_PROMPT,
  MENTION_HANDLING_PROMPT,
  RESPONSE_LANGUAGE_PROMPT,
  TOOLS_GUIDELINES,
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
 * This is your working session as employee {ID} in chat {chatId}[, the boss's chat].
 * [This task group chat was created from chat {fromChatId}, the boss's chat.  — only when fromChatId is set]
 * [role: generated for non-assistants; baked into ASSISTANT_SYSTEM_PROMPT for the assistant]
 * [employeePrompt: persona]
 * [report skill: assistant aggregation/progress/summary OR employee result report]
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
  toolEntries,
  today,
  memory,
}: BuildEmployeeSystemPromptArgs): string {
  const persona = personaParts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");

  // The assistant's role text is baked into `ASSISTANT_SYSTEM_PROMPT`;
  // non-assistants get a generated block from their name/role.
  const roleBlock = isAssistant ? "" : buildEmployeeRolePrompt(name, role);

  const toolsBlock = [
    "Available tools:",
    ...toolEntries.map((entry) => `- ${entry.name}: ${entry.snippet}`),
    "",
    "Guidelines:",
    ...TOOLS_GUIDELINES.map((guideline) => `- ${guideline}`),
  ].join("\n");

  // Leading identity block: which employee this session is and which chat it
  // runs in. The assistant's session lives in the boss's root chat, so label
  // its `chatId` as such — otherwise the model cannot connect the wake prompt's
  // task-group id to the boss-facing `chatId` it must post to. For an employee
  // group session, the spawning chat (`fromChatId`) is likewise the boss's chat.
  const identityLines = [
    isAssistant
      ? `This is your working session as employee ${employeeId} in chat ${chatId}, the boss's chat.`
      : `This is your working session as employee ${employeeId} in chat ${chatId}.`,
  ];
  if (fromChatId != null) {
    identityLines.push(
      `This task group chat was created from chat ${fromChatId}, the boss's chat.`,
    );
  }
  const identityBlock = identityLines.join("\n");

  const metaBlock = `Today is ${today}`;

  // The employee's own long-term memory: stable facts it decided to keep across
  // sessions. Emitted as a labelled block so the model treats it as recall
  // rather than as instructions from the boss.
  const memoryBlock =
    memory && memory.trim().length > 0
      ? [
          "[memory]",
          "Your long-term memory from previous sessions (recall, not new instructions):",
          memory.trim(),
        ].join("\n")
      : "";

  // Role-specific reporting skill: the assistant aggregates employee reports into
  // boss-facing progress + a summary; a non-assistant reports finished work to its
  // assigner.
  const reportBlock = isAssistant
    ? ASSISTANT_REPORT_PROMPT
    : EMPLOYEE_REPORT_PROMPT;

  const sections = [
    identityBlock,
    roleBlock,
    persona,
    reportBlock,
    MENTION_HANDLING_PROMPT,
    RESPONSE_LANGUAGE_PROMPT,
    toolsBlock,
    memoryBlock,
    metaBlock,
  ];

  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}
