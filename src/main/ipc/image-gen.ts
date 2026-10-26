import { rerollImageMessage } from "../image-gen";
import { assertInteger } from "./helpers";
import type { Binder } from "../rpc/types";

/**
 * Image generation — registered only while `IMAGE_GENERATION_ENABLED` is set
 * (see `src/main/ipc/index.ts`).
 *
 * The renderer only ever asks to redraw an existing image message: the prompt
 * and the target conversation live on that row, so nothing about either crosses
 * IPC. The agent's own path is the `imb_generate_image` tool, not this channel.
 */
export function registerImageGenHandlers(bind: Binder): void {
  bind("imageGen:reroll", (_ctx, messageId: unknown) =>
    rerollImageMessage(assertInteger(messageId, "message id")),
  );
}
