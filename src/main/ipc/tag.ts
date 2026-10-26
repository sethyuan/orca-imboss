import { listTags } from "../db/tags";
import type { Binder } from "../rpc/types";

/**
 * Conversation tag IPC. `tags:list` returns the candidate tags — every tag
 * currently in use, derived from `chat_tags` (there is no separate tag
 * dictionary). Assigning tags to a chat lives on `chats:setTags`.
 */
export function registerTagHandlers(bind: Binder): void {
  bind("tags:list", () => listTags());
}
