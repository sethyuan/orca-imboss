/**
 * Master switch for the vision bridge: an agent whose own model cannot see
 * pictures can look at an image through a separately configured vision model.
 *
 * The feature has three parts, all gated by this constant:
 * - the `imb_look_at_image` built-in tool (see
 *   `src/main/agent/builtin-tools.ts`);
 * - the app-owned vision client (`src/main/vision.ts`) and its setting;
 * - the model picker in Settings › General.
 *
 * The one-line hint in the agent-facing `[Attachments]` block (see
 * `src/main/ipc/chat.ts`) points at the tool and is gated by it too.
 *
 * Set it to `false` and the tool is never registered and the picker
 * disappears, so the app behaves exactly as it did before; revert the commit to
 * remove the feature entirely.
 */
export const VISION_BRIDGE_ENABLED = true;
