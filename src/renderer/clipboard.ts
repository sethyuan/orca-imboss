/**
 * Renderer-side clipboard write, shared by every "copy" affordance in the app
 * (code blocks, chat messages).
 *
 * `navigator.clipboard` needs a focused, secure document, so on the paths where
 * it is unavailable or rejects we fall back to the legacy `<textarea>` +
 * `execCommand("copy")` trick instead of failing the user's click. Failures
 * still reject (the old path can fail too); callers treat that as non-fatal.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(area);
  }
}
