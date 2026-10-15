/**
 * Master switch for chat handoff: the boss hands a conversation (or part of
 * one) to another conversation as reference, background or a follow-up.
 *
 * A handoff is what the agents already do to each other (`imb_read_chat` +
 * `imb_send_message`), except the boss initiates it and picks both ends.
 *
 * This follows the same shape as `SPEND_STATS_ENABLED`: one shared constant
 * that both processes read, so the feature can be dropped by flipping it. When
 * it is `false`:
 * - main registers no `handoff:*` channel (see `src/main/ipc/index.ts`);
 * - the renderer renders no entry point (see
 *   `src/renderer/components/modules/chat/chat-handoff/`).
 *
 * Nothing else depends on the feature: a handoff writes an ordinary
 * `kind="chat"` message with a JSON attachment into the target conversation, so
 * with the switch off the app behaves exactly as it did before.
 */
export const CHAT_HANDOFF_ENABLED = true;
