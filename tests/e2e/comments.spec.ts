import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import {
  appendMessage,
  ASSISTANT_ID,
  createChat,
  listRows,
  readMessages,
  thread,
} from "./helpers/fixtures";
import { seedSessionTranscript } from "./helpers/session-fixture";

/**
 * Comments on a passage of an agent's (or the boss's own) message.
 *
 * The two directions are tested separately, because they are stored differently:
 *
 * - **writing one** needs only the renderer (selection → toolbar → panel → the
 *   pending bar above the composer), so the test never has to wake an agent;
 * - **a sent one** is seeded through `messages:append` with its comments, which
 *   is the shape `chat:send` stores, and then read back from disk after a reload.
 *
 * **Both surfaces are covered.** The chat thread and the agent-session transcript
 * render different DOM with different commentable roots (a session `text` entry is
 * *both* the commentable row and its content container), and that structural
 * difference is exactly what a chat-only test cannot catch — this file used to
 * miss a session-view bug for that reason.
 */

let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

/** One assistant message with two paragraphs to select from. */
const ANSWER =
  "The first paragraph explains the migration plan in detail, including the new column and how it is backfilled.\n\nThe second paragraph warns that rolling back needs a backup, which is not automatic.";

/**
 * A one-comment payload as `chat:send` stores it: a stored anchor (offsets plus
 * the quote) naming an earlier message of the same conversation.
 *
 * `textLength` is the *rendered* length, which a fixture cannot know exactly
 * (Markdown re-flows the stored source) — an approximate value is legitimate:
 * the resolver then falls back to the quote instead of the offsets, the same path
 * it takes after any re-render.
 */
function commentOn(
  messageId: number,
  start: number,
  end: number,
  quote: string,
) {
  return [
    {
      anchor: {
        target: { kind: "message", messageId },
        quote,
        start,
        end,
        occurrence: 0,
        textLength: ANSWER.length,
      },
      note: "Is the backfill batched?",
    },
  ];
}

/** How many ranges one CSS `Highlight` currently holds (0 when unregistered). */
async function highlightSize(
  window: LaunchedApp["window"],
  name: string,
): Promise<number> {
  return await window.evaluate((key: string) => {
    // `CSS.highlights` is the CSS Custom Highlight API registry. `Highlight` is
    // a `Set` of ranges, but `lib.dom` types the registry as a `HighlightRegistry`
    // whose iteration types do not line up with `Set<Range>`, so it is narrowed
    // by hand.
    const registry = (
      globalThis as unknown as { CSS?: { highlights?: unknown } }
    ).CSS?.highlights as
      { get(name: string): { size: number } | undefined } | undefined;
    return registry?.get(key)?.size ?? 0;
  }, name);
}

/**
 * The compose panel must appear **right next to the toolbar it replaced**, fully
 * inside the window.
 *
 * This is the geometry contract the boss reported broken ("the panel showed up
 * far below, half off screen"): no text assertion can see it, so it is asserted
 * from the real bounding boxes. `toolbarBox` is measured before the click.
 */
async function expectPanelAnchoredToToolbar(
  window: LaunchedApp["window"],
  toolbarBox: { x: number; y: number; width: number; height: number } | null,
): Promise<void> {
  const panel = window.locator(".imb-comment-panel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  // `globalThis` (not `window`): inside `evaluate` the closure's `window` is the
  // Playwright `Page`, not the page's own window object.
  const view = await window.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  const MARGIN = 8;
  // 1. The whole panel is on screen (a half-visible panel is unusable).
  expect(box!.y).toBeGreaterThanOrEqual(MARGIN - 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(view.height - MARGIN + 0.5);
  expect(box!.x).toBeGreaterThanOrEqual(MARGIN - 0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(view.width - MARGIN + 0.5);
  // 2. It is actually rendered (not a collapsed sliver).
  expect(box!.height).toBeGreaterThan(60);
  // 3. And it sits at the toolbar: either directly below it or directly above it,
  //    never hundreds of pixels away (`<= 16` covers the 8px gap plus rounding).
  if (toolbarBox !== null) {
    const toolbarBottom = toolbarBox.y + toolbarBox.height;
    const toolbarTop = toolbarBox.y;
    const below = box!.y - toolbarBottom;
    const above = toolbarTop - (box!.y + box!.height);
    expect(Math.min(Math.abs(below), Math.abs(above))).toBeLessThanOrEqual(16);
    expect(below).toBeLessThanOrEqual(16);
  }
}

test("a selected passage becomes a pending comment that waits for the next send", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E comments");
  await appendMessage(window, chatId, ASSISTANT_ID, ANSWER);
  await session.reload();
  await listRows(window).filter({ hasText: "E2E comments" }).click();

  const paragraph = thread(window).locator(".imb-msg .imb-markdown p").first();
  await expect(paragraph).toBeVisible();
  // A triple-click is a real, single user gesture that selects the paragraph —
  // and, unlike a synthetic drag, it does not depend on pixel-precise mousemove
  // timing, so the anchor this test exercises is reproducible.
  await paragraph.click({ clickCount: 3 });

  // The toolbar offers the only action the selection has.
  // Scoped by class: the list row of "E2E comments" also matches `Comment` by
  // accessible-name substring.
  const toolbar = window.locator(".imb-comment-toolbar-btn");
  await expect(toolbar).toBeVisible();
  const toolbarBox = await toolbar.boundingBox();
  await toolbar.click();

  const panel = window.locator(".imb-comment-panel");
  await expectPanelAnchoredToToolbar(window, toolbarBox);
  await expect(panel).toHaveAttribute("aria-label", "Write a comment");
  // The quoted passage is shown back, so the boss can check what is annotated.
  await expect(panel.locator(".imb-comment-panel-quote")).toContainText(
    "migration plan",
  );
  const field = panel.getByRole("textbox");
  // The caret is in the field the moment the panel opens — no extra click. (The
  // panel is measured at `visibility: hidden` for one layout pass, so a
  // `focus()` that ignores that fact silently does nothing.)
  await expect(field).toBeFocused();
  await window.keyboard.type("Is the backfill batched?");
  await expect(field).toHaveValue("Is the backfill batched?");
  // Same key contract as the chat composer: `Enter` saves, `Shift+Enter` breaks
  // the line (and an Enter that belongs to an IME candidate does neither).
  await field.press("Shift+Enter");
  await field.pressSequentially("one or two?");
  await expect(field).toHaveValue("Is the backfill batched?\none or two?");
  await expect(panel).toBeVisible();
  await field.press("Enter");
  await expect(panel).toHaveCount(0);

  // The passage the comment points at is tinted (CSS Custom Highlight API — the
  // same mechanism in-thread find uses, no DOM is inserted into the Markdown).
  await expect.poll(() => highlightSize(window, "imb-comment-pending")).toBe(1);

  // The comment waits in the composer (one row, ordinal `#1`); nothing was
  // written to the thread yet.
  const pendingRows = window.locator(".imb-comment-pending-row");
  await expect(pendingRows).toHaveCount(1);
  await expect(
    pendingRows.first().locator(".imb-comment-pending-ordinal"),
  ).toHaveText("#1");
  await expect(thread(window).locator(".imb-comment-card")).toHaveCount(0);
  // A comment-only send is legitimate: the send button is enabled with an empty
  // textarea and no attachments.
  await expect(window.getByRole("button", { name: "Send" })).toBeEnabled();

  // And it can be taken back before it is sent.
  await window.getByRole("button", { name: "Remove comment" }).click();
  await expect(pendingRows).toHaveCount(0);
  await expect(window.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("a sent comment renders its quote and note on the message that carried it", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E sent comment");
  await appendMessage(window, chatId, ASSISTANT_ID, ANSWER);
  const [answer] = await readMessages(window, chatId);
  await appendMessage(
    window,
    chatId,
    null,
    "Tighten paragraph two.",
    commentOn(
      answer.id,
      ANSWER.indexOf("The second paragraph"),
      ANSWER.indexOf("The second paragraph") + 18,
      "The second paragraph",
    ),
  );
  await session.reload();
  await listRows(window).filter({ hasText: "E2E sent comment" }).click();

  const card = thread(window).locator(".imb-comment-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".imb-comment-card-quote")).toHaveText(
    "The second paragraph",
  );
  await expect(card.locator(".imb-comment-card-note")).toHaveText(
    "Is the backfill batched?",
  );
  // The passage the sent comment points at is tinted again after the reload.
  await expect.poll(() => highlightSize(window, "imb-comment")).toBe(1);
  // Ordinal the agent answers with.
  await expect(card.locator(".imb-comment-card-ordinal")).toHaveText("#1");
  // The annotated message is still there, untouched.
  await expect(thread(window).getByText("The first paragraph")).toBeVisible();
});

// --- Agent-session transcript ------------------------------------------------
//
// The session view addresses rows by Pi entry id (`CommentTarget.kind: "entry"`)
// and its prose rows are laid out differently from a chat bubble, so it gets its
// own cases. A session prompt is never written to `messages`, so a **sent**
// comment here is seeded the only way it can exist: inside the prompt text.

/**
 * A stored session prompt carrying one comment on an earlier entry.
 *
 * The block is payload only (`src/main/comment-prompt.ts`): a `[Comments]` header
 * and one three-line record per comment — no prose of its own, which is what the
 * system prompt states once. Written by hand on purpose: the test drives the
 * *stored format*, so a wording change must fail here (the projection refuses to
 * split a block it cannot rebuild byte for byte) rather than silently keep
 * passing.
 */
function sessionPromptWithComment(
  text: string,
  entryId: string,
  quote: string,
  note: string,
): string {
  return [
    text,
    "",
    "[Comments]",
    `#1 on session entry ${entryId}`,
    `quote: ${quote}`,
    `note: ${note}`,
  ].join("\n");
}

/**
 * Seed a two-turn transcript for the assistant in a fresh chat and open that
 * session from the thread's assistant avatar (the same route the boss uses).
 */
async function openAssistantSessionTranscript(
  window: LaunchedApp["window"],
  title: string,
  prompts: readonly [string, string],
): Promise<void> {
  const chatId = await createChat(window, title);
  // The stored message is what renders the thread row whose avatar opens the
  // session; the transcript itself is what the session view reads.
  await appendMessage(window, chatId, ASSISTANT_ID, "assistant says hello");
  await seedSessionTranscript(app!, ASSISTANT_ID, chatId, [
    { role: "user", text: prompts[0] },
    { role: "assistant", text: ANSWER },
    { role: "user", text: prompts[1] },
  ]);
  await app!.reload();
  await listRows(window).filter({ hasText: title }).click();
  await thread(window).getByRole("button", { name: "Assistant" }).click();
  await expect(
    window.getByPlaceholder("Message Assistant directly"),
  ).toBeVisible();
}

test("a settled assistant block and the boss's own prompt can both be commented in the session view", async () => {
  const session = app!;
  const window = session.window;
  await openAssistantSessionTranscript(window, "E2E session comments", [
    "please summarise the migration",
    "",
  ]);

  // (1) The assistant's finished text block — the row is its own content root.
  const assistantText = window
    .locator(".imb-session-text .imb-markdown p")
    .first();
  await expect(assistantText).toBeVisible();
  await assistantText.click({ clickCount: 3 });
  const toolbar = window.locator(".imb-comment-toolbar-btn");
  await expect(toolbar).toBeVisible();
  const toolbarBox = await toolbar.boundingBox();
  await toolbar.click();
  const panel = window.locator(".imb-comment-panel");
  // Same geometry contract as the chat thread: the panel replaces the toolbar
  // and stays fully on screen (a session transcript scrolls too).
  await expectPanelAnchoredToToolbar(window, toolbarBox);
  await expect(panel).toBeVisible();
  await expect(panel.locator(".imb-comment-panel-quote")).toContainText(
    "migration plan",
  );
  // Same contract in the session transcript: the field has the caret on open and
  // typed keys land in it without clicking first.
  const sessionField = panel.getByRole("textbox");
  await expect(sessionField).toBeFocused();
  await window.keyboard.type("Split this into two sentences.");
  await expect(sessionField).toHaveValue("Split this into two sentences.");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(window.locator(".imb-comment-pending-row")).toHaveCount(1);
  await expect.poll(() => highlightSize(window, "imb-comment-pending")).toBe(1);

  // (2) The boss's own prompt row (a different row shape, same flow).
  const userText = window.locator(".imb-session-user-text").first();
  await userText.click({ clickCount: 3 });
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  await expect(panel).toBeVisible();
  await expect(sessionField).toBeFocused();
  await window.keyboard.type("And answer this one properly.");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(window.locator(".imb-comment-pending-row")).toHaveCount(2);
  await expect.poll(() => highlightSize(window, "imb-comment-pending")).toBe(2);
});

test("a sent comment on a session entry survives a reload and keeps its highlight", async () => {
  const session = app!;
  const window = session.window;
  await openAssistantSessionTranscript(window, "E2E session sent comment", [
    sessionPromptWithComment(
      "",
      // Ids come from the fixture (e2e000000 = the first prompt, e2e000001 = the
      // assistant's answer). An assistant message is projected as one entry **per
      // content block**, so the row the renderer anchors on is `<entryId>:t<n>`
      // (`#t0` = the first text block) — the same id `data-message-id` carries.
      "e2e000001:t0",
      "The second paragraph warns",
      "Too vague",
    ),
    "",
  ]);

  // The block is stripped from the prompt text and projected as a card.
  const row = window.locator(".imb-session-user").first();
  const card = row.locator(".imb-comment-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".imb-comment-card-quote")).toHaveText(
    "The second paragraph warns",
  );
  await expect(card.locator(".imb-comment-card-note")).toHaveText("Too vague");
  await expect(card.locator(".imb-comment-card-ordinal")).toHaveText("#1");
  // A prompt that carried nothing but comments is still a rendered turn, and its
  // text is empty (the block was recognized byte-for-byte and removed).
  await expect(row.locator(".imb-session-user-text")).toHaveCount(0);
  // The annotated passage is tinted in the assistant's block.
  await expect.poll(() => highlightSize(window, "imb-comment")).toBe(1);
});

test("a send that carried only comments stores no text and reads back localized", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E comment only");
  await appendMessage(window, chatId, ASSISTANT_ID, ANSWER);
  const [answer] = await readMessages(window, chatId);
  // Exactly what `chat:send` stores for a comment-only send: no text at all, the
  // comments are the content (`appendMessage` allows empty content for them).
  await appendMessage(window, chatId, null, "", [
    {
      anchor: {
        target: { kind: "message", messageId: answer.id },
        quote: "The first paragraph",
        start: 0,
        end: 19,
        occurrence: 0,
        textLength: ANSWER.length,
      },
      note: "Say this in one sentence.",
    },
  ]);
  await session.reload();

  // The list preview is built by the renderer from the count, so it is a
  // localized label instead of any English baked into the database.
  const row = listRows(window).filter({ hasText: "E2E comment only" });
  await expect(row).toContainText("Comment (1 comment)");
  await expect(row).not.toContainText("comment on earlier messages");
  // And the thread shows the comment card, not an empty bubble.
  await row.click();
  await expect(thread(window).locator(".imb-comment-card")).toHaveCount(1);
});

test("closing the comment panel with Escape returns focus to the transcript", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E comment focus");
  await appendMessage(window, chatId, ASSISTANT_ID, ANSWER);
  await session.reload();
  await listRows(window).filter({ hasText: "E2E comment focus" }).click();

  const paragraph = thread(window).locator(".imb-msg .imb-markdown p").first();
  await expect(paragraph).toBeVisible();
  await paragraph.click({ clickCount: 3 });
  const toolbar = window.locator(".imb-comment-toolbar-btn");
  await expect(toolbar).toBeVisible();
  await toolbar.click();
  const panel = window.locator(".imb-comment-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("textbox")).toBeFocused();

  await window.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  // Focus is handed back to the transcript instead of being left on the removed
  // panel (or falling to `<body>`, which would make the boss click to resume).
  const active = await window.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return element === null
      ? "none"
      : `${element.tagName}.${element.className}`;
  });
  expect(active).toBe("DIV.imb-thread");
});

test("a pending comment can be edited in place, and the edit is what gets sent", async () => {
  const session = app!;
  const window = session.window;
  const chatId = await createChat(window, "E2E comment edit");
  await appendMessage(window, chatId, ASSISTANT_ID, ANSWER);
  await session.reload();
  await listRows(window).filter({ hasText: "E2E comment edit" }).click();

  const paragraph = thread(window).locator(".imb-msg .imb-markdown p").first();
  await expect(paragraph).toBeVisible();
  await paragraph.click({ clickCount: 3 });
  await window.locator(".imb-comment-toolbar-btn").click();
  await expect(window.locator(".imb-comment-panel")).toBeVisible();
  await window.keyboard.type("first draft");
  await window.keyboard.press("Enter");

  const rows = window.locator(".imb-comment-pending-row");
  const note = window.locator(".imb-comment-pending-note");
  const editor = window.locator(".imb-comment-pending-editor");
  await expect(rows).toHaveCount(1);
  await expect(note).toHaveText("first draft");
  // No native tooltips on the row's texts (they are not this app's design
  // language, and the visible text already carries the meaning).
  await expect(
    window.locator(".imb-comment-pending-quote"),
  ).not.toHaveAttribute("title", /.*/);
  await expect(note).not.toHaveAttribute("title", /.*/);

  // --- the whole row is the trigger: clicking the quoted passage edits too ---
  await window.locator(".imb-comment-pending-quote").click();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  // Clicking inside the field keeps its caret where the click put it (the row
  // handler must ignore clicks while editing).
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);

  // --- edit in place: the note is the trigger, the editor takes its place ---
  await note.click();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("first draft");
  // An empty comment is not a comment: `Enter` is refused and nothing is saved.
  await editor.fill("");
  await editor.press("Enter");
  await expect(editor).toBeVisible();
  await editor.fill("edited note");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  // Still one comment, same ordinal, same highlight: only the text changed.
  await expect(rows).toHaveCount(1);
  await expect(window.locator(".imb-comment-pending-ordinal")).toHaveText("#1");
  await expect(note).toHaveText("edited note");
  await expect.poll(() => highlightSize(window, "imb-comment-pending")).toBe(1);

  // --- Esc discards the edit and restores the stored note -------------------
  await note.click();
  await expect(editor).toHaveValue("edited note");
  await window.keyboard.type(" — discarded");
  await expect(editor).toHaveValue("edited note — discarded");
  await window.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(note).toHaveText("edited note");

  // --- the remove button only removes (it must not open the editor) ---------
  // Add a second comment, then delete it from the row button.
  await paragraph.click({ clickCount: 3 });
  await window.locator(".imb-comment-toolbar-btn").click();
  await expect(window.locator(".imb-comment-panel")).toBeVisible();
  await window.keyboard.type("to be deleted");
  await window.keyboard.press("Enter");
  await expect(rows).toHaveCount(2);
  await rows.nth(1).locator(".imb-comment-pending-remove").click();
  await expect(rows).toHaveCount(1);
  await expect(editor).toHaveCount(0);
  await expect(note).toHaveText("edited note");

  // --- and the edited text is what the send carries -------------------------
  // A comment-only send wakes the agent like any other; with no model provider
  // configured the run fails and says so, but the message — and its comments —
  // are stored exactly as the renderer sent them.
  await window.getByRole("button", { name: "Send" }).click();
  const card = thread(window).locator(".imb-comment-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".imb-comment-card-note")).toHaveText(
    "edited note",
  );
  await expect(card.locator(".imb-comment-card-ordinal")).toHaveText("#1");
  await expect(window.locator(".imb-comment-pending-row")).toHaveCount(0);
});
