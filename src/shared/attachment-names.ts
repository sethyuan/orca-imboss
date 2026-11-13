/**
 * The file-name prefixes **this app** mints for files it stores itself.
 *
 * One list, because two very different rules hang off it and they must agree:
 *
 * 1. **ownership** — `deletePastedFile()` refuses to remove anything that does not
 *    start with one of these, so a chip dropped from the composer can never delete a
 *    file the boss picked from their own disk (`src/main/attachments.ts`);
 * 2. **provenance** — the thread hides the generated `Attached: a.png, b.png` blurb
 *    only when *every* attachment is one the app minted (`isAttachmentOnlyBlurb`),
 *    which is what keeps a sentence the boss typed by hand visible
 *    (`.pi/facts/image-annotation.md` §8.16).
 *
 * **A new entry point that mints files must add its prefix here**, or the two rules
 * silently stop matching: the composer's paste path (`pasted-`), the remote client's
 * upload (`upload-`), and the annotated copies the image-annotation bake writes
 * (`annotated-`).
 */
export const APP_MINTED_FILE_PREFIXES = [
  "pasted-",
  "upload-",
  "annotated-",
] as const;

/** `true` when this file name is one the app minted (case-insensitive). */
export function isAppMintedFileName(name: string): boolean {
  const value = name.trim().toLowerCase();
  return APP_MINTED_FILE_PREFIXES.some((prefix) => value.startsWith(prefix));
}
