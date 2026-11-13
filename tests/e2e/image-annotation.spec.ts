import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { createChat, listRows, readMessages, thread } from "./helpers/fixtures";
import { clusterCentre, inkClusters, markGroups } from "./helpers/ink";

/**
 * Image annotation, end to end: a draft picture gets a mark and a note, the mark
 * joins the same batch a text comment would, and the send **bakes** the mark into a
 * derived copy that replaces the attachment.
 *
 * The picture is pasted into the composer (a real `ClipboardEvent` with a real PNG),
 * so the whole chain is exercised through the UI: paste → draft chip → lightbox →
 * annotation mode → click → note → pending row → send → stored records + baked file.
 *
 * What only this test can catch:
 * - the composer's paste path produces a chip the viewer can annotate at all;
 * - the lightbox's gesture layer turns a click into a normalized mark on a picture
 *   the app cannot read pixels from;
 * - the send replaces the chip's file with a marked copy **and** the stored
 *   annotation names that copy (the `[Comments]` `at:` line is covered by the
 *   equivalence harness, the pixels by the file comparison here).
 */

let app: LaunchedApp | undefined;

/**
 * Paste a picture into the composer, the way a screenshot arrives.
 *
 * The PNG is drawn in the page so it is guaranteed decodable (the bake decodes it
 * again), and the paste is a real `ClipboardEvent` with a real `File` — the composer
 * only ever sees OS/clipboard files, so a fixture that bypassed that path would not
 * be testing the feature it exists for.
 */
async function pastePicture(
  window: LaunchedApp["window"],
  name = "shot.png",
): Promise<void> {
  await window.evaluate(async (fileName: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("canvas unavailable");
    ctx.fillStyle = "#e8e8ea";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Deliberately **not** the mark colour: the ink finder in `helpers/ink.ts` looks
    // for the annotation red, and a red block of "content" would be indistinguishable
    // from a mark.
    ctx.fillStyle = "#3b6fd4";
    ctx.fillRect(20, 20, 40, 24);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/png"),
    );
    if (blob === null) throw new Error("png unavailable");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], fileName, { type: "image/png" }));
    const target = document.querySelector(".imb-chat-input-wrap");
    if (target === null) throw new Error("composer not found");
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, name);
}

/**
 * Annotate the picture currently open in the viewer: enter the mode, click at a
 * fraction of the picture, write the note, leave.
 *
 * Returns the click point so a test can compare what was drawn against what was
 * pressed — the one property the whole feature rests on.
 */
async function annotateOpenViewer(
  window: LaunchedApp["window"],
  at: { x: number; y: number },
  note: string,
): Promise<{ x: number; y: number }> {
  const lightbox = window.locator(".imb-lightbox");
  await expect(lightbox).toBeVisible();
  const annotate = lightbox.getByRole("button", { name: "Annotate" });
  if ((await annotate.count()) > 0) await annotate.click();
  const picture = lightbox.locator(".imb-lightbox-zoom");
  const box = await picture.boundingBox();
  if (box === null) throw new Error("the picture has no box");
  const point = { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
  await window.mouse.click(point.x, point.y);
  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("textbox").pressSequentially(note);
  await panel.getByRole("textbox").press("Enter");
  await expect(panel).toHaveCount(0);
  return point;
}

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

test("a marked draft picture is baked into the copy the message carries", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E image annotation");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E image annotation" }).click();

  await pastePicture(window);

  const chip = window.locator(".imb-attached-file-thumb");
  await expect(chip).toHaveCount(1);
  // The chip's thumbnail opens the viewer.
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  await expect(lightbox).toBeVisible();

  // Annotation has to be entered explicitly: dragging pans, so drawing needs a
  // mode (and the mode is what makes a click mean "mark this").
  const annotate = lightbox.getByRole("button", { name: "Annotate" });
  await expect(annotate).toBeVisible();
  await annotate.click();
  await expect(window.locator(".imb-annot-banner")).toBeVisible();
  await expect(window.locator(".imb-annot-list")).toBeVisible();

  // A click on the picture is a point. The mark needs a note, so the editor opens
  // with the mark already drawn (ordinal `#1`: the batch is empty).
  const picture = window.locator(".imb-lightbox-zoom");
  const box = await picture.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.click(
    box!.x + box!.width * 0.5,
    box!.y + box!.height * 0.5,
  );

  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".imb-annot-panel-ordinal")).toHaveText("#1");
  // The boss's call: the shape label stays, the 「图片标注」 prefix and the `at:`
  // readout are gone.
  const kindLabel = await panel.locator(".imb-annot-panel-kind").innerText();
  expect(["Point", "点"]).toContain(kindLabel);
  await expect(panel).not.toContainText("at:");
  await expect(panel).not.toContainText("Annotate");
  const field = panel.getByRole("textbox");
  await expect(field).toBeFocused();
  // A space must reach the field: in annotation mode Space is the pan modifier,
  // so it is only swallowed outside text fields.
  await field.pressSequentially("this corner is wrong");
  await expect(field).toHaveValue("this corner is wrong");
  await field.press("Enter");
  await expect(panel).toHaveCount(0);

  // The mark is on the picture, numbered, and listed on the side. (Scoped to the
  // viewer: the composer's pending row already shows a thumbnail of the same mark.)
  await expect(lightbox.locator(".imb-mark-badge")).toHaveCount(1);
  await expect(lightbox.locator(".imb-mark-badge")).toHaveText("1");
  await expect(lightbox.locator(".imb-annot-list-row")).toHaveCount(1);

  // **Screen geometry must be the geometry that gets baked** (that is the whole
  // premise of the feature: fact §2.5). The badge's bottom-right corner sits on the
  // marked pixel, and the ring is centred on it — measured from real boxes, because
  // a 16px offset here is invisible to every other assertion.
  const click = {
    x: box!.x + box!.width * 0.5,
    y: box!.y + box!.height * 0.5,
  };
  const badge = await lightbox.locator(".imb-mark-badge").boundingBox();
  expect(badge).not.toBeNull();
  expect(Math.abs(badge!.x + badge!.width - click.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(badge!.y + badge!.height - click.y)).toBeLessThanOrEqual(2);
  const ring = await lightbox.locator(".imb-mark-ring").boundingBox();
  expect(ring).not.toBeNull();
  expect(Math.abs(ring!.x + ring!.width / 2 - click.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(ring!.y + ring!.height / 2 - click.y)).toBeLessThanOrEqual(2);
  // The ring is about as wide as the badge (fact §3.6: radius ≈ half a badge), not
  // twice it — five rings in a column used to merge into one blob.
  expect(ring!.width).toBeLessThanOrEqual(badge!.width + 4);

  // The caption's actions are above the drawing surface: a magnified picture is
  // painted out of its own box, and it used to cover them, so a press meant for
  // 「Model view」 drew another mark instead. Zoomed on purpose — at the fitted size
  // the picture cannot overlap the caption, so an un-zoomed check would have
  // passed even with the bug.
  await window.mouse.move(click.x, click.y);
  await window.mouse.wheel(0, -600);
  await expect
    .poll(async () =>
      window.evaluate(() => {
        const level = document.querySelector(".imb-lightbox-zoom-level");
        return level?.textContent ?? "";
      }),
    )
    .not.toBe("100%");
  const hitsCaption = await window.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (element) => element.textContent === "Model view",
    );
    if (button === undefined) return "missing";
    const box = button.getBoundingClientRect();
    const at = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return at === button || button.contains(at) ? "ok" : (at?.className ?? "?");
  });
  expect(hitsCaption).toBe("ok");
  // …and the batch is one annotation, so the chip says so.
  await expect(window.locator(".imb-attached-file-marks")).toHaveText("1");

  // Leave the viewer and send: the annotation is the message's whole content.
  // One `Esc` per level (mode → framing → close), because the check above zoomed in.
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(window.locator(".imb-comment-pending-row")).toHaveCount(1);
  await window.getByRole("button", { name: "Send" }).click();

  // The stored message carries the annotation and the **marked copy**, not the
  // original file name — and the copy exists on disk.
  type StoredRow = {
    comments?: { anchor: unknown; note: string }[] | null;
    attachments?: { name: string; path?: string }[] | null;
  };
  const rowsWithComments = async (): Promise<StoredRow[]> => {
    const messages = (await readMessages(
      window,
      chatId,
    )) as unknown as StoredRow[];
    return messages.filter((message) => (message.comments?.length ?? 0) > 0);
  };
  // The send also stores an app-generated receipt, so the annotation is looked up
  // by what it carries rather than by position.
  await expect.poll(async () => (await rowsWithComments()).length).toBe(1);
  const stored = (await readMessages(window, chatId)) as unknown as {
    comments?: {
      anchor: {
        target: { kind: string; attachmentName?: string };
        mark?: { kind: string; x?: number; y?: number };
      };
      note: string;
    }[];
    attachments?: { name: string; path?: string }[] | null;
  }[];
  const message = stored.find((row) => (row.comments?.length ?? 0) > 0);
  if (message === undefined) throw new Error("no annotated message was stored");
  expect(message.comments?.length).toBe(1);
  const comment = message.comments![0]!;
  expect(comment.note).toBe("this corner is wrong");
  expect(comment.anchor.target.kind).toBe("image");
  expect(comment.anchor.mark?.kind).toBe("point");
  // The point was pressed in the middle of the picture: normalized ~0.5/0.5.
  expect(comment.anchor.mark?.x).toBeCloseTo(0.5, 1);
  expect(comment.anchor.mark?.y).toBeCloseTo(0.5, 1);
  const attachment = message.attachments?.[0];
  expect(attachment?.name.startsWith("annotated-")).toBe(true);
  expect(comment.anchor.target.attachmentName).toBe(attachment?.name);
  // The thread shows the marked copy's comment card.
  await expect(thread(window).locator(".imb-comment-card")).toHaveCount(1);

  // A copy this app already baked takes **no new annotations** (the boss's ruling:
  // instead of recording an original-path field on the attachment, the way in is
  // simply not offered). It is recognised by the name the app minted for it.
  // The generated `Attached: …` line is not printed: the copies and cards above it
  // already say what came with the message (the boss removed it).
  await expect(thread(window)).not.toContainText("Attached: annotated-");

  // The copy is shown the way the boss decided: a compact thumbnail with a label,
  // never at full size (two identical pictures in a row read as a duplicate).
  const copy = thread(window).locator(".imb-annot-copy");
  await expect(copy).toHaveCount(1);
  // The e2e app runs in the default locale, so the label is its English key.
  await expect(copy.locator(".imb-annot-copy-label")).toHaveText(
    "Annotated copy",
  );
  const copyBox = await copy.boundingBox();
  expect(copyBox).not.toBeNull();
  expect(Math.round(copyBox!.width)).toBe(96);
  expect(Math.round(copyBox!.height)).toBe(60);
  await copy.click();
  const viewer = window.locator(".imb-lightbox");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Annotate" })).toHaveCount(0);
  // The mark is still there — it is in the pixels of the copy, not in an overlay.
  await expect(viewer.locator(".imb-lightbox-zoom img").first()).toBeVisible();
});

test("a picture that was never baked still offers annotation", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E plain picture");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E plain picture" }).click();

  // Sent with no annotation: the attachment keeps its own name, so the picture is
  // *not* a baked copy — the way in must still be there (a rule that mistook a
  // normal screenshot for a copy would silently break the whole feature).
  await pastePicture(window);
  await expect(window.locator(".imb-attached-file-thumb")).toHaveCount(1);
  await window.getByRole("button", { name: "Send" }).click();
  await expect(thread(window).locator(".imb-image-card-front")).toBeVisible();
  await thread(window).locator(".imb-image-card-front").click();
  await expect(
    window.locator(".imb-lightbox").getByRole("button", { name: "Annotate" }),
  ).toBeVisible();
});

test("a dragged area is drawn where it was dragged", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E image region");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E image region" }).click();
  await pastePicture(window);
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  await lightbox.getByRole("button", { name: "Annotate" }).click();

  // A drag is an area, drawn where the pointer went. The screen rectangle used to
  // collapse to a 4×4px sliver (a percentage of a zero-size parent) while the baked
  // one was correct — that is why this asserts real boxes.
  const picture = lightbox.locator(".imb-lightbox-zoom");
  const box = await picture.boundingBox();
  expect(box).not.toBeNull();
  const from = { x: box!.x + box!.width * 0.2, y: box!.y + box!.height * 0.25 };
  const to = { x: box!.x + box!.width * 0.7, y: box!.y + box!.height * 0.65 };
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(to.x, to.y, { steps: 8 });
  await window.mouse.up();

  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".imb-annot-panel-kind")).toHaveText("Region");
  await panel.getByRole("textbox").pressSequentially("this block");
  await panel.getByRole("textbox").press("Enter");
  await expect(panel).toHaveCount(0);

  const region = await lightbox.locator(".imb-mark-region-box").boundingBox();
  expect(region).not.toBeNull();
  expect(Math.abs(region!.x - from.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(region!.y - from.y)).toBeLessThanOrEqual(3);
  expect(Math.abs(region!.width - (to.x - from.x))).toBeLessThanOrEqual(4);
  expect(Math.abs(region!.height - (to.y - from.y))).toBeLessThanOrEqual(4);
  // A visible outline, not a sliver.
  expect(region!.width).toBeGreaterThan(50);
});

test("a small drag is an area, not a point — and it stays that size", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E tiny region");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E tiny region" }).click();
  await pastePicture(window, "tiny.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  await lightbox.getByRole("button", { name: "Annotate" }).click();

  const picture = lightbox.locator(".imb-lightbox-zoom");
  const box = await picture.boundingBox();
  expect(box).not.toBeNull();
  const from = { x: box!.x + box!.width * 0.4, y: box!.y + box!.height * 0.4 };
  // 6 × 5 screen px: past the click jitter, nowhere near "a box".
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(from.x + 6, from.y + 5, { steps: 4 });
  await window.mouse.up();

  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  // The shape is reported as drawn — no "small box becomes a point" conversion.
  await expect(panel.locator(".imb-annot-panel-kind")).toHaveText("Region");
  await panel.getByRole("textbox").pressSequentially("tiny one");
  await panel.getByRole("textbox").press("Enter");
  await expect(panel).toHaveCount(0);

  // The rectangle is drawn at its own size (and is still visible), and the badge has
  // shrunk to fit inside it instead of smothering it.
  const region = await lightbox.locator(".imb-mark-region-box").boundingBox();
  expect(region).not.toBeNull();
  expect(Math.abs(region!.width - 6)).toBeLessThanOrEqual(2);
  expect(Math.abs(region!.height - 5)).toBeLessThanOrEqual(2);
  const badge = await lightbox.locator(".imb-mark-badge").boundingBox();
  expect(badge).not.toBeNull();
  expect(badge!.width).toBeLessThanOrEqual(region!.width + 1);
  // A sub-digit badge carries no number, so it cannot render a garbled glyph.
  await expect(lightbox.locator(".imb-mark-badge")).toHaveText("");

  // Send: the stored record is a `region` whose two corners are ~6/5 px apart…
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Send" }).click();
  type Row = {
    comments?: {
      anchor: {
        target: { kind: string; attachmentName?: string };
        mark?: {
          kind: string;
          x?: number;
          y?: number;
          x2?: number;
          y2?: number;
        };
      };
    }[];
    attachments?: { name: string; path?: string }[] | null;
  };
  const annotated = async (): Promise<Row | undefined> => {
    const rows = (await readMessages(window, chatId)) as unknown as Row[];
    return rows.find((row) => (row.comments?.length ?? 0) > 0);
  };
  await expect.poll(async () => (await annotated()) !== undefined).toBe(true);
  const message = await annotated();
  if (message === undefined) throw new Error("the annotation never landed");
  const mark = message.comments![0]!.anchor.mark!;
  expect(mark.kind).toBe("region");
  // … and the delivered file has a mark of that same tiny size (not rounded up to a
  // minimum, not widened into a point).
  const ink = await inkClusters(window, message.attachments![0]!.path!, 6);
  const groups = markGroups(ink.clusters, 4);
  expect(groups.length).toBe(1);
  expect(groups[0]!.width).toBeLessThanOrEqual(14);
  expect(groups[0]!.height).toBeLessThanOrEqual(14);
});

test("an annotation of an already-sent picture survives the send", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E sent picture annotation");
  await session.reload();
  await listRows(window)
    .filter({ hasText: "E2E sent picture annotation" })
    .click();

  // First send a picture with no annotation: its attachment keeps its own name, so
  // the picture in the thread stays annotatable.
  await pastePicture(window, "shot.png");
  await window.getByRole("button", { name: "Send" }).click();
  const bubble = thread(window).locator(".imb-image-card-front");
  await expect(bubble).toBeVisible();
  const [first] = (await readMessages(window, chatId)) as unknown as {
    id: number;
    attachments?: { name: string }[] | null;
  }[];

  // Now annotate that picture from the thread. This is the path that used to fail
  // both ways: no readable source (so no marked copy) and a valtio proxy in the
  // payload (so the send itself threw) — while the batch had already been cleared,
  // losing the annotation for good.
  await bubble.click();
  const lightbox = window.locator(".imb-lightbox");
  await expect(
    lightbox.getByRole("button", { name: "Annotate" }),
  ).toBeVisible();
  await lightbox.getByRole("button", { name: "Annotate" }).click();
  const picture = lightbox.locator(".imb-lightbox-zoom");
  const box = await picture.boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.click(
    box!.x + box!.width * 0.3,
    box!.y + box!.height * 0.4,
  );
  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("textbox").pressSequentially("and here");
  await panel.getByRole("textbox").press("Enter");
  await expect(panel).toHaveCount(0);
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);

  await expect(window.locator(".imb-comment-pending-row")).toHaveCount(1);
  await window.getByRole("button", { name: "Send" }).click();

  type Row = {
    id: number;
    comments?: {
      anchor: {
        target: { kind: string; attachmentName?: string; source?: unknown };
        mark?: { kind: string };
      };
      note: string;
    }[];
    attachments?: { name: string }[] | null;
  };
  const annotated = async (): Promise<Row | undefined> => {
    const rows = (await readMessages(window, chatId)) as unknown as Row[];
    return rows.find((row) => (row.comments?.length ?? 0) > 0);
  };
  await expect.poll(async () => (await annotated()) !== undefined).toBe(true);
  const message = await annotated();
  if (message === undefined) throw new Error("the annotation never landed");
  const comment = message.comments![0]!;
  expect(comment.note).toBe("and here");
  expect(comment.anchor.mark?.kind).toBe("point");
  // It points back at the picture of the *earlier* message …
  expect(comment.anchor.target.kind).toBe("image");
  expect(comment.anchor.target.source).toEqual({
    kind: "message",
    messageId: first!.id,
  });
  // … and this message carries the marked copy, baked from that original.
  expect(message.attachments?.length).toBe(1);
  expect(message.attachments![0]!.name.startsWith("annotated-")).toBe(true);
});

test("a hand-typed Attached: line stays visible", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E blurb typing");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E blurb typing" }).click();
  await pastePicture(window, "shot.png");
  // The name the app minted for the pasted file, read off the chip.
  // The boss typing the *shape* of the generated line himself must stay visible. The
  // filter asks "did the app store these files and write this line", so a line that
  // names something else is his own words and is rendered.
  const line = "Attached: my-own-name.png";
  await window.locator(".imb-chat-input-textarea").fill(line);
  await window.getByRole("button", { name: "Send" }).click();
  await expect(thread(window)).toContainText(line);
});

test("the picture is never drawn under the caption (portrait picture)", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E portrait fit");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E portrait fit" }).click();
  // A tall picture: it is capped by the *picture area* now, not by the whole viewer.
  await window.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 1200;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("canvas unavailable");
    ctx.fillStyle = "#f2f2f5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#3b6fd4";
    ctx.fillRect(20, 20, 120, 80);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/png"),
    );
    if (blob === null) throw new Error("png unavailable");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "tall.png", { type: "image/png" }));
    const target = document.querySelector(".imb-chat-input-wrap");
    target?.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await window.locator(".imb-attached-file-open").click();
  await expect(window.locator(".imb-lightbox")).toBeVisible();
  // Measured with `poll`: the fitted box only exists once the picture has decoded, and
  // a single reading can catch the hand-over mid-flight.
  await expect
    .poll(async () =>
      window.evaluate(() => {
        const frame = document.querySelector(".imb-lightbox-zoom");
        const caption = document.querySelector(".imb-lightbox-caption");
        if (frame === null || caption === null) return -999;
        return (
          caption.getBoundingClientRect().top -
          frame.getBoundingClientRect().bottom
        );
      }),
    )
    .toBeGreaterThanOrEqual(4);
  // …and the picture is capped by the picture area, not by the whole window.
  const sizes = await window.evaluate(() => {
    const frame = document.querySelector(".imb-lightbox-zoom");
    return {
      picture: frame?.getBoundingClientRect().height ?? 0,
      viewer: globalThis.innerHeight,
    };
  });
  expect(sizes.picture).toBeGreaterThan(0);
  expect(sizes.picture).toBeLessThan(sizes.viewer);
});

/**
 * The whole gesture matrix, one assertion per combination.
 *
 * This is the test that was missing when a one-line change to the pointer gate quietly
 * broke left-drag panning (and `Space`+drag with it) while every other test stayed green:
 * the right-button cases had their own probes, the left button had none. Each row states
 * both directions — "what should move did move" and "what should not draw did not".
 */
test("the gesture matrix: every mode, every button", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E gesture matrix");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E gesture matrix" }).click();
  await pastePicture(window, "matrix.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  const frame = window.locator(".imb-lightbox-zoom");
  await expect(lightbox).toBeVisible();
  // The picture is measured once it has decoded; until then its box has no size.
  await expect
    .poll(async () => (await frame.boundingBox())?.width ?? 0)
    .toBeGreaterThan(50);

  const offset = async (): Promise<{ x: number; y: number }> =>
    window.evaluate(() => {
      const element = document.querySelector(".imb-lightbox-zoom");
      const transform =
        element === null ? "" : getComputedStyle(element).transform;
      const match = /matrix\(([^)]+)\)/.exec(transform);
      const parts = match?.[1]?.split(",").map((part) => Number(part)) ?? [];
      return { x: Math.round(parts[4] ?? 0), y: Math.round(parts[5] ?? 0) };
    });
  const scale = async (): Promise<number> =>
    window.evaluate(() => {
      const element = document.querySelector(".imb-lightbox-zoom");
      const transform =
        element === null ? "" : getComputedStyle(element).transform;
      const match = /matrix\(([^)]+)\)/.exec(transform);
      return Number(match?.[1]?.split(",")[0] ?? 1);
    });
  const markCount = (): Promise<number> =>
    lightbox.locator(".imb-mark").count();
  const panelCount = (): Promise<number> =>
    window.locator(".imb-annot-panel").count();
  // Back to the fitted framing. Deliberately **not** a click on the backdrop: that
  // closes the viewer (and would end the test early).
  const reset = async (): Promise<void> => {
    await window.mouse.move(400, 300);
    await window.keyboard.press("0");
    await expect.poll(offset).toEqual({ x: 0, y: 0 });
  };
  /** Drag the picture by (dx, dy) with one pointer shape, from its centre. */
  const drag = async (
    dx: number,
    dy: number,
    options: {
      button?: "left" | "right" | "middle";
      space?: boolean;
      control?: boolean;
    } = {},
  ): Promise<{ x: number; y: number }> => {
    const box = await frame.boundingBox();
    if (box === null) throw new Error("no picture box");
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (options.space === true) await window.keyboard.down("Space");
    if (options.control === true) await window.keyboard.down("Control");
    await window.mouse.move(from.x, from.y);
    await window.mouse.down({ button: options.button ?? "left" });
    await window.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
    await window.mouse.up({ button: options.button ?? "left" });
    if (options.control === true) await window.keyboard.up("Control");
    if (options.space === true) await window.keyboard.up("Space");
    return from;
  };
  /** One pan expectation: the picture moved by the drag and nothing was drawn. */
  const expectPan = async (
    label: string,
    run: () => Promise<void>,
    dx: number,
    dy: number,
  ): Promise<void> => {
    const before = await markCount();
    await run();
    const moved = await offset();
    expect(`${label}: dx ${moved.x}`).toBe(`${label}: dx ${dx}`);
    expect(`${label}: dy ${moved.y}`).toBe(`${label}: dy ${dy}`);
    expect(await markCount()).toBe(before);
    expect(await panelCount()).toBe(0);
    await reset();
  };

  // --- browsing ---------------------------------------------------------------
  await expectPan(
    "browse left",
    () => drag(60, 40).then(() => undefined),
    60,
    40,
  );
  await expectPan(
    "browse space+left",
    () => drag(60, 40, { space: true }).then(() => undefined),
    60,
    40,
  );
  await expectPan(
    "browse right",
    () => drag(60, 40, { button: "right" }).then(() => undefined),
    60,
    40,
  );
  await expectPan(
    "browse middle",
    () => drag(60, 40, { button: "middle" }).then(() => undefined),
    60,
    40,
  );
  // The wheel zooms — it must never be read as a **pan**: the scale grows and the
  // picture is not being dragged (no grab cursor). (Zoomy offsets are expected and
  // correct: the zoom is anchored on the pointer, so the picture slides to keep that
  // point under it.)
  await window.mouse.move(400, 300);
  await window.mouse.wheel(0, -300);
  await expect.poll(scale).toBeGreaterThan(1);
  await expect(frame).not.toHaveClass(/imb-lightbox-grabbing/);
  await reset();

  // --- annotation mode --------------------------------------------------------
  await lightbox.getByRole("button", { name: "Annotate" }).click();

  // Left drag draws an area: the panel opens and the picture does not move.
  await drag(80, 60);
  expect(await panelCount()).toBe(1);
  await expect(window.locator(".imb-annot-panel-kind")).toHaveText("Region");
  expect(await offset()).toEqual({ x: 0, y: 0 });
  await window.keyboard.press("Escape");
  await expect(window.locator(".imb-annot-panel")).toHaveCount(0);
  expect(await markCount()).toBe(0);

  // Left click marks a point, again without moving the picture.
  const box = await frame.boundingBox();
  if (box === null) throw new Error("no picture box");
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await panelCount()).toBe(1);
  await expect(window.locator(".imb-annot-panel-kind")).toHaveText("Point");
  expect(await offset()).toEqual({ x: 0, y: 0 });
  await window.keyboard.press("Escape");
  await expect(window.locator(".imb-annot-panel")).toHaveCount(0);

  await expectPan(
    "annotate space+left",
    () => drag(60, 40, { space: true }).then(() => undefined),
    60,
    40,
  );
  await expectPan(
    "annotate right",
    () => drag(60, 40, { button: "right" }).then(() => undefined),
    60,
    40,
  );
  await expectPan(
    "annotate ctrl+drag",
    () => drag(60, 40, { control: true }).then(() => undefined),
    60,
    40,
  );
  // macOS's ctrl+click is a right click: it pans and must not paint a point.
  await expectPan(
    "annotate ctrl+click",
    async () => {
      const current = await frame.boundingBox();
      if (current === null) throw new Error("no picture box");
      await window.keyboard.down("Control");
      await window.mouse.click(
        current.x + current.width / 2,
        current.y + current.height / 2,
      );
      await window.keyboard.up("Control");
    },
    0,
    0,
  );

  // A press the side list covers does nothing at all — the click must not land on the
  // picture behind it (silently marking the wrong place would be worse than no reaction).
  const covered = await window.evaluate(() => {
    const panel = document.querySelector(".imb-annot-list");
    if (panel === null) return null;
    const box = panel.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  expect(covered).not.toBeNull();
  await window.mouse.click(covered!.x, covered!.y);
  expect(await markCount()).toBe(0);
  expect(await panelCount()).toBe(0);
  expect(await offset()).toEqual({ x: 0, y: 0 });

  // --- model view -------------------------------------------------------------
  await lightbox.getByRole("button", { name: "Model view" }).click();
  await expectPan(
    "model view left",
    () => drag(60, 40).then(() => undefined),
    60,
    40,
  );
  await expectPan(
    "model view right",
    () => drag(60, 40, { button: "right" }).then(() => undefined),
    60,
    40,
  );
});

test("a drag on the backdrop pans; only a click dismisses", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E backdrop press");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E backdrop press" }).click();
  await pastePicture(window, "backdrop.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  const frame = window.locator(".imb-lightbox-zoom");
  await expect(lightbox).toBeVisible();
  await expect
    .poll(async () => (await frame.boundingBox())?.width ?? 0)
    .toBeGreaterThan(50);

  const offset = async (): Promise<{ x: number; y: number }> =>
    window.evaluate(() => {
      const element = document.querySelector(".imb-lightbox-zoom");
      const transform =
        element === null ? "" : getComputedStyle(element).transform;
      const match = /matrix\(([^)]+)\)/.exec(transform);
      const parts = match?.[1]?.split(",").map((part) => Number(part)) ?? [];
      return { x: Math.round(parts[4] ?? 0), y: Math.round(parts[5] ?? 0) };
    });

  // Pushing the picture fully out of the window is what makes the backdrop the only
  // thing under the pointer — and the cursor there says "grabbable", so a drag must pan
  // (it used to close the viewer, because the press alone closed it).
  for (let pass = 0; pass < 2; pass += 1) {
    const current = await frame.boundingBox();
    if (current === null) throw new Error("no picture box");
    const y = current.y + current.height / 2;
    await window.mouse.move(120, y);
    await window.mouse.down({ button: "right" });
    await window.mouse.move(600, y, { steps: 10 });
    await window.mouse.up({ button: "right" });
  }
  const pushed = await frame.boundingBox();
  expect(pushed).not.toBeNull();
  const before = await offset();

  // Drag on the backdrop: pans, and the viewer stays open.
  await window.mouse.move(40, 40);
  await window.mouse.down();
  await window.mouse.move(160, 120, { steps: 6 });
  await window.mouse.up();
  await expect(lightbox).toBeVisible();
  const afterDrag = await offset();
  expect(afterDrag.x - before.x).toBe(120);
  expect(afterDrag.y - before.y).toBe(80);

  // A click on the backdrop still dismisses (that is the long-standing way out).
  await window.mouse.click(40, 40);
  await expect(lightbox).toHaveCount(0);
});

test("the window losing focus releases a held Space (main-process signal)", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E window blur");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E window blur" }).click();
  await pastePicture(window, "blur.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  const frame = window.locator(".imb-lightbox-zoom");
  await expect(lightbox).toBeVisible();
  await expect
    .poll(async () => (await frame.boundingBox())?.width ?? 0)
    .toBeGreaterThan(50);
  await lightbox.getByRole("button", { name: "Annotate" }).click();

  const cursor = async (): Promise<string> =>
    window.evaluate(
      () =>
        getComputedStyle(document.querySelector(".imb-lightbox") as Element)
          .cursor,
    );

  await window.keyboard.down("Space");
  expect(await cursor()).toBe("grab");

  // The **real** path: the main process sees the window lose focus and tells the
  // renderer. (The renderer's own `blur` never arrives in Electron for Cmd+Tab /
  // hide / minimize, which is why a synthetic event is not enough.)
  await session.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit("blur");
  });
  await expect.poll(cursor).toBe("crosshair");
  await window.keyboard.up("Space");

  // And the stuck state really is gone: a plain click draws again.
  const box = await frame.boundingBox();
  if (box === null) throw new Error("no picture box");
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(window.locator(".imb-annot-panel")).toBeVisible();
  await expect(lightbox.locator(".imb-mark")).toHaveCount(1);
});

test("the cursor says whether the view can be grabbed", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E pan cursor");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E pan cursor" }).click();
  await pastePicture(window, "cursor.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  const frame = window.locator(".imb-lightbox-zoom");
  await expect(lightbox).toBeVisible();
  await expect
    .poll(async () => (await frame.boundingBox())?.width ?? 0)
    .toBeGreaterThan(50);

  /** Computed cursor of the viewer (the whole view shares one — see the CSS block). */
  const cursor = async (): Promise<string> =>
    window.evaluate(
      () =>
        getComputedStyle(document.querySelector(".imb-lightbox") as Element)
          .cursor,
    );
  const box = await frame.boundingBox();
  if (box === null) throw new Error("no picture box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // Browsing: a plain drag pans, so the surface already says "grabbable".
  expect(await cursor()).toBe("grab");

  // Dragging (any button) shows the grip, and releasing restores it.
  await window.mouse.move(centre.x, centre.y);
  await window.mouse.down();
  await window.mouse.move(centre.x + 30, centre.y + 20, { steps: 3 });
  expect(await cursor()).toBe("grabbing");
  await window.mouse.up();
  expect(await cursor()).toBe("grab");

  // Annotation mode at rest draws, so the cursor is a crosshair …
  await lightbox.getByRole("button", { name: "Annotate" }).click();
  expect(await cursor()).toBe("crosshair");

  // … and holding `Space` is the one signal that panning is available now.
  await window.keyboard.down("Space");
  expect(await cursor()).toBe("grab");
  const annotatedBox = await frame.boundingBox();
  if (annotatedBox === null) throw new Error("no picture box");
  const spacePanFrom = {
    x: annotatedBox.x + annotatedBox.width / 2,
    y: annotatedBox.y + annotatedBox.height / 2,
  };
  await window.mouse.move(spacePanFrom.x, spacePanFrom.y);
  await window.mouse.down();
  await window.mouse.move(spacePanFrom.x + 20, spacePanFrom.y, { steps: 3 });
  expect(await cursor()).toBe("grabbing");
  await window.mouse.up();
  expect(await cursor()).toBe("grab");
  await window.keyboard.up("Space");
  expect(await cursor()).toBe("crosshair");

  // A space typed into the note belongs to the note: the picture must not turn
  // grabbable, and the field keeps its own text cursor.
  await window.mouse.click(spacePanFrom.x + 40, spacePanFrom.y + 30);
  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  const field = panel.getByRole("textbox");
  await field.pressSequentially("a b");
  await expect(field).toHaveValue("a b");
  expect(await cursor()).toBe("crosshair");
  const fieldCursor = await window.evaluate(
    () =>
      getComputedStyle(
        document.querySelector(".imb-annot-panel textarea") as Element,
      ).cursor,
  );
  expect(fieldCursor).not.toBe("grab");
  await field.press("Escape");
  await expect(panel).toHaveCount(0);

  // Losing the window mid-press must not leave the view stuck in "ready to pan"
  // (a keyup outside the window never reaches us).
  await window.keyboard.down("Space");
  expect(await cursor()).toBe("grab");
  await window.evaluate(() => globalThis.dispatchEvent(new Event("blur")));
  expect(await cursor()).toBe("crosshair");
  await window.keyboard.up("Space");

  // Switching the mode while `Space` is held keeps the cursor honest.
  await window.keyboard.down("Space");
  expect(await cursor()).toBe("grab");
  await lightbox.getByRole("button", { name: "Model view" }).click();
  expect(await cursor()).toBe("grab");
  await lightbox.getByRole("button", { name: "Model view" }).click();
  expect(await cursor()).toBe("grab");
  await window.keyboard.up("Space");
  expect(await cursor()).toBe("crosshair");
});

test("the right button pans in every mode and never opens a menu", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E right drag pan");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E right drag pan" }).click();
  await pastePicture(window, "pan.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  const frame = window.locator(".imb-lightbox-zoom");
  await expect(lightbox).toBeVisible();

  /** Current pan offset (the frame's transform is `translate(x, y) scale(s)`). */
  const offset = async (): Promise<{ x: number; y: number }> =>
    window.evaluate(() => {
      const element = document.querySelector(".imb-lightbox-zoom");
      const transform =
        element === null ? "" : getComputedStyle(element).transform;
      const match = /matrix\(([^)]+)\)/.exec(transform);
      const parts = match?.[1]?.split(",").map((part) => Number(part)) ?? [];
      return { x: parts[4] ?? 0, y: parts[5] ?? 0 };
    });

  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  const from = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

  // Browsing mode: right-drag moves the picture and raises no context menu.
  // The event still reaches the document (Electron dispatches it), so the assertion is
  // that it was **suppressed** — a native menu would mean `defaultPrevented` stayed
  // false.
  await window.evaluate(() => {
    (globalThis as { __ctx?: boolean[] }).__ctx = [];
    document.addEventListener(
      "contextmenu",
      (event) => {
        globalThis.setTimeout(
          () =>
            (globalThis as { __ctx?: boolean[] }).__ctx?.push(
              event.defaultPrevented,
            ),
          0,
        );
      },
      { capture: true },
    );
  });
  await window.mouse.move(from.x, from.y);
  await window.mouse.down({ button: "right" });
  await window.mouse.move(from.x + 80, from.y + 40, { steps: 6 });
  await window.mouse.up({ button: "right" });
  const moved = await offset();
  expect(Math.abs(moved.x - 80)).toBeLessThanOrEqual(2);
  expect(Math.abs(moved.y - 40)).toBeLessThanOrEqual(2);
  const suppressed = await window.evaluate(
    () => (globalThis as { __ctx?: boolean[] }).__ctx ?? [],
  );
  expect(suppressed.length).toBeGreaterThan(0);
  expect(suppressed.every((prevented) => prevented)).toBe(true);

  // Back to the fitted framing, then the same gesture **in annotation mode**: it pans
  // and draws nothing (the left button is the one that draws).
  await window.keyboard.press("0");
  await expect.poll(offset).toEqual({ x: 0, y: 0 });
  await lightbox.getByRole("button", { name: "Annotate" }).click();
  // Entering the mode re-fits the picture (the side list takes room), so the press
  // point has to be measured again.
  const annotatedBox = await frame.boundingBox();
  expect(annotatedBox).not.toBeNull();
  const annotatedFrom = {
    x: annotatedBox!.x + annotatedBox!.width / 2,
    y: annotatedBox!.y + annotatedBox!.height / 2,
  };
  await window.mouse.move(annotatedFrom.x, annotatedFrom.y);
  await window.mouse.down({ button: "right" });
  await window.mouse.move(annotatedFrom.x - 60, annotatedFrom.y - 30, {
    steps: 6,
  });
  await window.mouse.up({ button: "right" });
  const annotated = await offset();
  expect(Math.abs(annotated.x + 60)).toBeLessThanOrEqual(2);
  expect(Math.abs(annotated.y + 30)).toBeLessThanOrEqual(2);
  await expect(window.locator(".imb-annot-panel")).toHaveCount(0);
  await expect(window.locator(".imb-mark")).toHaveCount(0);

  // macOS's ctrl+click is a right click to the OS but a primary press to the DOM: it
  // must pan, not paint a mark.
  await window.keyboard.press("0");
  await expect.poll(offset).toEqual({ x: 0, y: 0 });
  await window.keyboard.down("Control");
  await window.mouse.move(annotatedFrom.x, annotatedFrom.y);
  await window.mouse.down();
  await window.mouse.move(annotatedFrom.x + 50, annotatedFrom.y, { steps: 5 });
  await window.mouse.up();
  await window.keyboard.up("Control");
  expect(Math.abs((await offset()).x - 50)).toBeLessThanOrEqual(2);
  await expect(window.locator(".imb-mark")).toHaveCount(0);
});

test("the picture can be pushed out of the viewport and `0` brings it back", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E free pan");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E free pan" }).click();
  await pastePicture(window, "free.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  const frame = window.locator(".imb-lightbox-zoom");
  await expect(lightbox).toBeVisible();
  await lightbox.getByRole("button", { name: "Annotate" }).click();

  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  const from = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  // Push it right until only a slice is left (the old clamp stopped at the window edge;
  // the boss wants the detail he is annotating to reach the middle). Pushed just far
  // enough that the slice stays inside the window, so the click below is a real one.
  const viewWidth = await window.evaluate(() => globalThis.innerWidth);
  const push = viewWidth - 60 - box!.x;
  await window.mouse.move(from.x, from.y);
  await window.mouse.down({ button: "right" });
  await window.mouse.move(from.x + push, from.y, { steps: 10 });
  await window.mouse.up({ button: "right" });
  const pushed = await frame.boundingBox();
  expect(pushed).not.toBeNull();
  expect(pushed!.x).toBeGreaterThan(box!.x + 100);
  // Most of the picture is now outside the window — that is the point of the change.
  expect(pushed!.x + pushed!.width).toBeGreaterThan(viewWidth);

  // Annotations stay accurate: a click on the visible part is a mark under the pointer.
  // The point is chosen inside the 60px slice *and* clear of the side panel, which
  // covers the right-hand side of the viewer.
  const click = { x: viewWidth - 10, y: pushed!.y + 40 };
  await window.mouse.click(click.x, click.y);
  const panel = window.locator(".imb-annot-panel");
  await expect(panel).toBeVisible();
  const badge = await lightbox.locator(".imb-mark-badge").boundingBox();
  expect(badge).not.toBeNull();
  expect(Math.abs(badge!.x + badge!.width - click.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(badge!.y + badge!.height - click.y)).toBeLessThanOrEqual(2);
  await panel.getByRole("textbox").press("Escape");

  // Zooming cannot lose it either: with the anchor at the viewport centre, `+` on a
  // picture pushed off screen would otherwise push it further away — the one gesture that
  // must not be able to strand it (the way back is a key, and it should not be the only
  // thing keeping the picture findable).
  for (let press = 0; press < 3; press += 1) {
    await window.keyboard.press("+");
    const visible = await window.evaluate(() => {
      const frame = document.querySelector(".imb-lightbox-zoom");
      if (frame === null) return false;
      const box = frame.getBoundingClientRect();
      return (
        box.right > 0 &&
        box.left < globalThis.innerWidth &&
        box.bottom > 0 &&
        box.top < globalThis.innerHeight
      );
    });
    expect(visible).toBe(true);
  }

  // `0` still returns to the fitted framing — from a picture of which only a slice is
  // visible (`Esc` does too: it steps the framing back before it closes the viewer).
  await window.keyboard.press("0");
  await expect
    .poll(async () => (await frame.boundingBox())?.x ?? -1)
    .toBeLessThan(300);
  const fitted = await frame.boundingBox();
  expect(Math.abs(fitted!.x - box!.x)).toBeLessThanOrEqual(2);
});

test("the caption is pinned to the viewer's bottom and the side panel is flush", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E viewer layout");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E viewer layout" }).click();
  await pastePicture(window, "layout.png");
  await window.locator(".imb-attached-file-open").click();
  const lightbox = window.locator(".imb-lightbox");
  await expect(lightbox).toBeVisible();

  /** Distance from the caption's bottom edge to the window's, and the same for the panel. */
  const gaps = async (): Promise<{ caption: number; panel: number }> =>
    window.evaluate(() => {
      const caption = document.querySelector(".imb-lightbox-caption");
      const panel = document.querySelector(".imb-annot-list");
      return {
        caption:
          globalThis.innerHeight -
          (caption?.getBoundingClientRect().bottom ?? 0),
        panel:
          globalThis.innerHeight - (panel?.getBoundingClientRect().bottom ?? 0),
      };
    });

  // Plain viewing: the caption belongs to the viewer, not to the picture, so it sits
  // on the viewer's own padding (48px) instead of floating under a short picture.
  expect((await gaps()).caption).toBeCloseTo(48, 0);

  // Annotation mode: the panel is a full-height column (flush with the bottom edge,
  // 16px in), and the caption still holds its place beside it.
  await lightbox.getByRole("button", { name: "Annotate" }).click();
  const annotated = await gaps();
  expect(annotated.caption).toBeCloseTo(48, 0);
  expect(annotated.panel).toBeCloseTo(16, 0);

  // Zooming, panning and the model view must not move either: both are positioned
  // against the viewer, not against the picture's transform.
  const box = await window.locator(".imb-lightbox-zoom").boundingBox();
  expect(box).not.toBeNull();
  await window.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await window.mouse.wheel(0, -400);
  await window.mouse.down();
  await window.mouse.move(
    box!.x + box!.width / 2 + 40,
    box!.y + box!.height / 2 + 20,
    { steps: 5 },
  );
  await window.mouse.up();
  expect((await gaps()).caption).toBeCloseTo(48, 0);
  await lightbox.getByRole("button", { name: "Model view" }).click();
  expect((await gaps()).caption).toBeCloseTo(48, 0);
  await lightbox.getByRole("button", { name: "Model view" }).click();
  expect((await gaps()).caption).toBeCloseTo(48, 0);
});

test("a pending annotation row sizes its thumbnail cell to the thumbnail", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E pending row width");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E pending row width" }).click();
  await pastePicture(window, "row.png");
  await window.locator(".imb-attached-file-open").click();
  await annotateOpenViewer(window, { x: 0.4, y: 0.4 }, "a note");
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await expect(window.locator(".imb-lightbox")).toHaveCount(0);

  // The reference cell hugs its content (the 40×25 thumbnail) and is only *capped* at
  // 45% — it used to be a fixed 45% column, leaving an empty block before the note.
  const thumb = await window.locator(".imb-mark-thumb").last().boundingBox();
  const row = await window
    .locator(".imb-comment-pending-row")
    .last()
    .boundingBox();
  const note = await window
    .locator(".imb-comment-pending-note")
    .last()
    .boundingBox();
  expect(thumb).not.toBeNull();
  expect(row).not.toBeNull();
  expect(note).not.toBeNull();
  // The note starts right after the thumbnail (plus the row's gap), not after 45% of it.
  expect(note!.x - (thumb!.x + thumb!.width)).toBeLessThan(40);
  expect(thumb!.width).toBeLessThan(row!.width * 0.45);
});

test("readImageBytes refuses a symlink dressed as an image", async () => {
  const session = app!;
  const window = session.window;
  await createChat(window, "E2E image bytes guard");
  // A link named like an image, pointing at a file that is not one. `stat` follows
  // links, so only an `lstat`/`realpath` check keeps its bytes out of the renderer.
  const dir = await mkdtemp(join(tmpdir(), "imboss-annot-guard-"));
  const link = join(dir, "linked.png");
  await symlink("/etc/hosts", link);
  const outcome = await window.evaluate(async (path: string) => {
    const imb = (window as unknown as { imb: { files: unknown } }).imb as {
      files: { readImageBytes(target: string): Promise<unknown> };
    };
    try {
      await imb.files.readImageBytes(path);
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, link);
  expect(outcome).not.toBe("allowed");
  await rm(dir, { recursive: true, force: true });
});

test("an older batch's mark on a shared picture is grey, unnumbered and inert", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E two batches");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E two batches" }).click();

  // The picture that both batches will point at.
  await pastePicture(window, "shared.png");
  await window.getByRole("button", { name: "Send" }).click();
  const bubble = thread(window).locator(".imb-image-card-front");
  await expect(bubble).toBeVisible();

  // Batch 1 …
  await bubble.click();
  await annotateOpenViewer(window, { x: 0.3, y: 0.3 }, "first batch");
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(async () => {
      const rows = (await readMessages(window, chatId)) as unknown as {
        comments?: unknown[] | null;
      }[];
      return rows.filter((row) => (row.comments?.length ?? 0) > 0).length;
    })
    .toBe(1);

  // … and batch 2, on the same original picture.
  await bubble.click();
  await annotateOpenViewer(window, { x: 0.65, y: 0.6 }, "second batch");
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(async () => {
      const rows = (await readMessages(window, chatId)) as unknown as {
        comments?: unknown[] | null;
      }[];
      return rows.filter((row) => (row.comments?.length ?? 0) > 0).length;
    })
    .toBe(2);

  // Decision ③, on the shared picture: the newest batch stays red and numbered
  // (`#1` of its own cards), the older one becomes a grey dashed mark with no
  // number — two batches can never both be `#1`.
  await bubble.click();
  const lightbox = window.locator(".imb-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".imb-mark")).toHaveCount(2);
  await expect(lightbox.locator(".imb-mark-history")).toHaveCount(1);
  await expect(
    lightbox.locator(".imb-mark-history .imb-mark-badge"),
  ).toHaveCount(0);
  await expect(lightbox.locator(".imb-mark-badge")).toHaveCount(1);
  await expect(lightbox.locator(".imb-mark-badge")).toHaveText("1");

  // The structural promise, checked in pixels: each batch composed its copy from the
  // **original**, so each delivered file carries exactly one blob of ink — at the
  // place that batch was drawn. Stacking (baking on top of the previous copy) would
  // leave two blobs in the second file.
  const rows = (await readMessages(window, chatId)) as unknown as {
    attachments?: { name: string; path?: string }[] | null;
    comments?: unknown[] | null;
  }[];
  const copies = rows
    .filter((row) => (row.comments?.length ?? 0) > 0)
    .map((row) =>
      row.attachments?.find((item) => item.name.startsWith("annotated-")),
    );
  expect(copies.length).toBe(2);
  const first = await inkClusters(window, copies[0]!.path!);
  const second = await inkClusters(window, copies[1]!.path!);
  // One mark is a ring *and* a badge (the badge's white outline cuts them apart), so
  // blobs within a few pixels are grouped before counting.
  const firstMarks = markGroups(first.clusters, 12);
  const secondMarks = markGroups(second.clusters, 12);
  expect(firstMarks.length).toBe(1);
  expect(secondMarks.length).toBe(1);
  // The mark sits where that batch was drawn — not where the other one was, and not
  // both (which is what stacking would look like).
  const tolerance = 0.12;
  const firstCentre = clusterCentre(firstMarks[0]!, first);
  const secondCentre = clusterCentre(secondMarks[0]!, second);
  expect(Math.abs(firstCentre.x - 0.3)).toBeLessThan(tolerance);
  expect(Math.abs(firstCentre.y - 0.3)).toBeLessThan(tolerance);
  expect(Math.abs(secondCentre.x - 0.65)).toBeLessThan(tolerance);
  expect(Math.abs(secondCentre.y - 0.6)).toBeLessThan(tolerance);

  // The grey one is visual only: pressing it must not open an editor, add a mark or
  // touch the batch.
  const grey = await lightbox
    .locator(".imb-mark-history .imb-mark-ring")
    .boundingBox();
  expect(grey).not.toBeNull();
  await window.mouse.click(
    grey!.x + grey!.width / 2,
    grey!.y + grey!.height / 2,
  );
  await expect(window.locator(".imb-annot-panel")).toHaveCount(0);
  await expect(window.locator(".imb-comment-pending-row")).toHaveCount(0);
});

test("hovering a comment card lights up the mark it talks about", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E mark hover");
  await session.reload();
  await listRows(window).filter({ hasText: "E2E mark hover" }).click();

  // A picture, then an annotation of it: the card ends up on the second message and
  // the mark on the first, which is the arrangement the linkage has to cross.
  await pastePicture(window, "hover.png");
  await window.getByRole("button", { name: "Send" }).click();
  const bubble = thread(window).locator(".imb-image-card-front");
  await expect(bubble).toBeVisible();
  await bubble.click();
  await annotateOpenViewer(window, { x: 0.4, y: 0.5 }, "this one");
  await window.keyboard.press("Escape");
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(async () => {
      const rows = (await readMessages(window, chatId)) as unknown as {
        comments?: unknown[] | null;
      }[];
      return rows.filter((row) => (row.comments?.length ?? 0) > 0).length;
    })
    .toBe(1);

  // The mark is on the picture of the *first* message; hovering the card of the
  // *second* one focuses it (one shared `#n` axis is the whole mechanism).
  const markBadge = thread(window).locator(
    ".imb-image-card-front .imb-mark-badge",
  );
  await expect(markBadge).toHaveCount(1);
  await expect(markBadge).not.toHaveText("");
  const card = thread(window).locator(".imb-comment-card").first();
  await expect(card).toBeVisible();
  await card.hover();
  const focused = await window.evaluate(() => {
    const marks = Array.from(
      document.querySelectorAll(".imb-image-card-front .imb-mark"),
    );
    return marks.some((mark) => mark.classList.contains("imb-mark-focus"));
  });
  expect(focused).toBe(true);
});
