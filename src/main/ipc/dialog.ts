import { getFilePicker } from "../platform";
import type { OpenDialogOptions, SaveDialogOptions } from "../platform";

/**
 * Native pickers, routed through the platform seam.
 *
 * Kept as thin wrappers (rather than calling `getFilePicker()` at every call
 * site) so the five picker-driven channels read the same as before the split.
 * On a headless backend the picker rejects with a readable
 * `UnsupportedOnHostError` — the remote-mode flows that need a picker are
 * redesigned in the file-transfer phase (see
 * `.pi/facts/grpc-remote-backend-research.md` §3.4.2).
 */
export async function showOpenDialog(
  options: OpenDialogOptions,
): Promise<string[] | null> {
  return await getFilePicker().showOpenDialog(options);
}

export async function showSaveDialog(
  options: SaveDialogOptions,
): Promise<string | null> {
  return await getFilePicker().showSaveDialog(options);
}
