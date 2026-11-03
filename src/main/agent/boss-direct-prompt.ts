/**
 * The **per-turn** "the boss is talking to you right now" hint.
 *
 * Why per turn and not a system prompt: `buildEmployeeSystemPrompt()` is
 * assembled once per agent session (its arguments are the `(employee, chat)`
 * pair), so it cannot express "this particular message was typed by the boss
 * into this very session". It is also part of the composition signature, so
 * changing it per turn would rebuild the warm Pi session and break provider
 * caching. A suffix on the prompt text is the only per-turn channel Pi offers.
 *
 * Who carries the hint: **only** the boss's own typing in an agent-session view
 * (`agentSession:send`). Everything else stays exactly as it was, because each
 * of those ingress paths has different delivery semantics:
 *
 * | ingress | why no hint |
 * | --- | --- |
 * | `chat:send` in a direct chat | the conversation-level `EMPLOYEE_DIRECT_CHAT_PROMPT` already says "your final text is the reply" |
 * | `imb_send_message` notify / `imb_interrupt` | internal dispatch — the boss reads the chat, not this session |
 * | `imb_ask` answers | closes a question card; the workflow expects a posted follow-up |
 * | cron ticks | scheduled work, not a conversation |
 * | IM inbound (`integrations`) | an external user on WeChat/QQ/Telegram; the bridge only forwards stored `messages` rows, so a final-text answer would vanish |
 * | the assistant (id 0) | its static prompt owns the "post with `imb_send_message`" contract for the boss's chat |
 *
 * The hint is appended **before** the `[Attachments]` block (see
 * `agentPrompt()`), so that block stays the trailing suffix the projection
 * already knows how to split off. `splitBossDirectHint()` is its byte-exact
 * inverse: anything it cannot rebuild is returned untouched, so the boss's own
 * words are never lost.
 */

/** Separator between the boss's text and the hint (a blank line). */
const HINT_JOINER = "\n\n";

/**
 * Model-facing English, like every other prompt constant: it is text the model
 * reads, never localized UI.
 *
 * It has to carry the whole rule — a session opened from the sidebar may belong
 * to a task group chat as well as to a direct chat, and there the static
 * "post your result" block is still in the system prompt.
 */
export const BOSS_DIRECT_HINT = [
  "[This message was typed by the boss directly in this session.",
  "Answer him with your final response — he reads it right here, so that text IS the reply.",
  "Do not re-post the same answer with `imb_send_message` in this turn.",
  "Anything you owe another assigner in a task group still goes to that group as before, and if this reply is itself the deliverable, treat it the same way.]",
].join(" ");

/**
 * Add the hint to one turn's prompt text.
 *
 * Idempotent by construction (a text that already ends with the hint is
 * returned as is), so a caller cannot accidentally stack two copies.
 */
export function withBossDirectHint(text: string): string {
  if (text.endsWith(`${HINT_JOINER}${BOSS_DIRECT_HINT}`)) return text;
  if (text.length === 0) return BOSS_DIRECT_HINT;
  return `${text}${HINT_JOINER}${BOSS_DIRECT_HINT}`;
}

/**
 * The exact inverse of `withBossDirectHint()`: split one trailing hint off a
 * persisted user prompt.
 *
 * Round-trip safe, and deliberately conservative:
 * - the hint is only reported when re-composing the remaining text with
 *   `withBossDirectHint()` reproduces the input **byte for byte**, so a prompt
 *   that merely contains the hint text (e.g. the boss pasted it) is left alone;
 * - `direct` tells the caller whether this turn carried the rule at all.
 *
 * A prompt without a hint, an empty prompt and anything that fails the
 * round-trip all come back unchanged — the projection never loses text.
 */
export function splitBossDirectHint(text: string): {
  text: string;
  direct: boolean;
} {
  const suffix = `${HINT_JOINER}${BOSS_DIRECT_HINT}`;
  const unchanged = { text, direct: false };
  if (!text.endsWith(suffix)) {
    // The whole prompt being just the hint (a file-only turn with an empty
    // text field) is not something this app composes, but `withBossDirectHint`
    // can produce it, so recognize it symmetrically.
    return text === BOSS_DIRECT_HINT ? { text: "", direct: true } : unchanged;
  }
  const rest = text.slice(0, text.length - suffix.length);
  return withBossDirectHint(rest) === text
    ? { text: rest, direct: true }
    : unchanged;
}
