/**
 * The line a user message stores when the send carried **only files**.
 *
 * `userMessageContent()` (main) writes `Attached: a.png, b.png` (or `Attached files`)
 * into the message row so the row is never empty and the conversation list has
 * something to preview. The thread should not print it: the attachments are already
 * shown as thumbnails/chips right above, so the line is a duplicate in a translated
 * UI (it is English baked into the database). The boss asked for it to be gone
 * (`.pi/facts/image-annotation.md` §8.16) — it used to be visible mainly on
 * picture-only sends, which is exactly the image-annotation flow.
 *
 * Recognised by **shape + provenance**, never by a flag: the row cannot be migrated
 * cheaply, and the generator may truncate a long name (it caps at
 * `MAX_PROMPT_ATTACH_NAME_LENGTH` and appends `…`). Anything that does not match keeps
 * being rendered — a message the boss really typed must never disappear.
 */
import { isAppMintedFileName } from "./attachment-names";

/** Same whitespace normalisation the prompt field sanitiser applies. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** `true` when `content` is only the generated attachment blurb. */
export function isAttachmentOnlyBlurb(
  content: string,
  attachments: readonly { name: string }[] | null | undefined,
): boolean {
  if (attachments === null || attachments === undefined) return false;
  if (attachments.length === 0) return false;
  // **Provenance, not just shape.** The blurb is only ever written for files the app
  // itself stored, so a text that merely *looks* like one (the boss typing
  // `Attached: a.png` next to a file he attached) must stay visible. Requiring every
  // name to be app-minted is what separates the two: the boss's own files keep their
  // own names (`我的截图.png`, `a.png`), while every path in the image-annotation flow
  // produces `pasted-*` / `annotated-*`.
  if (!attachments.every((attachment) => isAppMintedFileName(attachment.name))) {
    return false;
  }
  const text = normalize(content);
  if (text.length === 0) return false;
  if (text === "Attached files") return true;
  const prefix = "Attached: ";
  if (!text.startsWith(prefix)) return false;
  const parts = text.slice(prefix.length).split(", ");
  const names = attachments.map((attachment) => normalize(attachment.name));
  if (parts.length !== names.length) return false;
  return parts.every((part, index) => {
    const name = names[index] ?? "";
    if (part === name) return true;
    // The stored copy may be truncated, so a shortened name still counts as the
    // same name (and only then — a different name is the boss's own words).
    return part.endsWith("…") && name.startsWith(part.slice(0, -1));
  });
}
