import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { createChat, listRows } from "./helpers/fixtures";

/**
 * Typing in the annotation note must stay in the note.
 *
 * The viewer owns `=`, `+`, `-`, `_`, `0`, `←`, `→` and the wheel at the document
 * level, and the note editor is opened *by* the viewer — so without a guard every one
 * of those leaks: `3x5 = 15` zoomed the picture mid-sentence, and an arrow key flipped
 * to another picture. (QA found the zoom leak by watching the percentage jump while
 * typing; the arrow flip and the wheel scroll were fixed with the same guard.)
 */
let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

/** A picture with rows, so a zoom is visible and there is something to annotate. */
async function pastePicture(window: LaunchedApp["window"]): Promise<void> {
  await window.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("canvas unavailable");
    ctx.fillStyle = "#f6f6f8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let row = 0; row < 14; row += 1) {
      ctx.fillStyle = row % 2 === 0 ? "#ffffff" : "#fafafc";
      ctx.fillRect(48, 96 + row * 48, 1104, 40);
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/png"),
    );
    if (blob === null) throw new Error("png unavailable");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "shot.png", { type: "image/png" }));
    const target = document.querySelector(".imb-chat-input-wrap");
    if (target === null) throw new Error("composer not found");
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

test("typing =, -, + or 0 in the annotation note does not zoom the picture", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E annotate typing");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E annotate typing" }).click();
  await pastePicture(window);
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  await lightbox.getByRole("button", { name: "Annotate" }).click();
  const frame = window.locator(".imb-lightbox-zoom");
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.click(
    box!.x + box!.width * 0.5,
    box!.y + box!.height * 0.5,
  );

  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  // A mark drawn but not yet written has no note: its accessible name is the ordinal
  // alone (`"1"`), never `"1: "` (a screen reader announced "one colon").
  const badge = lightbox.locator(".imb-mark-badge").first();
  await expect(badge).toHaveAttribute("aria-label", "1");
  const zoomPercent = async (): Promise<string> =>
    (await window.locator(".imb-lightbox-zoom-level").innerText()).trim();
  const before = await zoomPercent();

  const field = panel.getByRole("textbox");
  await field.pressSequentially("3x5 = 15");
  await field.pressSequentially(" - ");
  await field.pressSequentially(" 0 ");
  await field.pressSequentially(" + ");
  await expect(field).toHaveValue("3x5 = 15 -  0  + ");
  // Every one of those characters is a viewer shortcut outside a text field.
  expect(await zoomPercent()).toBe(before);

  // The arrows are the viewer's "previous / next picture" keys; in the note they
  // move the caret.
  await field.press("ArrowLeft");
  await field.press("ArrowLeft");
  await expect(lightbox.locator(".imb-lightbox-count")).toHaveCount(0);
  expect(await zoomPercent()).toBe(before);

  // …and the wheel scrolls the note instead of zooming.
  const fieldBox = await field.boundingBox();
  await window.mouse.move(
    fieldBox!.x + fieldBox!.width / 2,
    fieldBox!.y + fieldBox!.height / 2,
  );
  await window.mouse.wheel(0, -400);
  expect(await zoomPercent()).toBe(before);

  // Saving gives the badge its note back in the accessible name (the draft had none).
  await field.press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(badge).toHaveAttribute("aria-label", "1: 3x5 = 15 -  0  +");
});
