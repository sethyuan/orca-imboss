import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import {
  appendMessage,
  ASSISTANT_ID,
  CHAT_COMPOSER_PLACEHOLDER,
  createChat,
  createEmployee,
  detailPane,
  listRows,
  thread,
} from "./helpers/fixtures";

/**
 * The chat trunk the boss uses every day: the conversation list (previews,
 * ordering), opening a conversation, reading its thread, and searching it.
 *
 * Fixtures are written through the app's own `window.imb` IPC channels (see
 * `helpers/fixtures.ts`), then the renderer is reloaded — so every assertion is
 * about what the app reads back *from disk*, not about a component's local state.
 */

let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

/** Two conversations with distinct last messages, oldest first. */
async function seedTwoChats(window: LaunchedApp["window"]): Promise<void> {
  const alpha = await createChat(window, "E2E alpha");
  await appendMessage(window, alpha, null, "alpha question from the boss");
  await appendMessage(
    window,
    alpha,
    ASSISTANT_ID,
    "alpha answer from the assistant",
  );

  const beta = await createChat(window, "E2E beta");
  await appendMessage(window, beta, null, "beta question from the boss");
}

test("lists conversations newest first with their latest message as preview", async () => {
  const session = app!;
  await seedTwoChats(session.window);
  await session.reload();

  const rows = listRows(session.window);
  await expect(rows).toHaveCount(2);

  // Newest activity sorts to the top; the preview is the last message.
  await expect(rows.nth(0)).toContainText("E2E beta");
  await expect(rows.nth(0)).toContainText("beta question from the boss");
  await expect(rows.nth(1)).toContainText("E2E alpha");
  await expect(rows.nth(1)).toContainText("alpha answer from the assistant");
});

test("a conversation with the assistant shows the assistant's avatar", async () => {
  const session = app!;
  const { window } = session;
  await seedTwoChats(window);
  // An untitled conversation is still a conversation with the assistant.
  await createChat(window, "");
  await session.reload();

  const rows = listRows(window);
  await expect(rows).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    // The bundled assistant image, not a letter block taken from the title.
    await expect(rows.nth(index).locator(".imb-avatar img")).toHaveAttribute(
      "alt",
      "Assistant",
    );
  }
});

test("opens a conversation and renders both sides of the thread", async () => {
  const session = app!;
  const { window } = session;
  await seedTwoChats(window);
  await session.reload();

  await listRows(window).filter({ hasText: "E2E alpha" }).click();

  const header = detailPane(window);
  // The detail pane shows the selected conversation, not just any transcript.
  await expect(header.locator(".imb-chat-title")).toHaveText("E2E alpha");

  const transcript = thread(window);
  await expect(
    transcript.getByText("alpha question from the boss"),
  ).toBeVisible();
  await expect(
    transcript.getByText("alpha answer from the assistant"),
  ).toBeVisible();
  await expect(transcript.locator("[data-message-id]")).toHaveCount(2);

  // The composer belongs to the selected conversation, and its placeholder
  // advertises both reference triggers.
  await expect(
    window.getByPlaceholder(CHAT_COMPOSER_PLACEHOLDER),
  ).toBeVisible();
});

test("filters the list by search text", async () => {
  const session = app!;
  const { window } = session;
  await seedTwoChats(window);
  await session.reload();
  await expect(listRows(window)).toHaveCount(2);

  await window.getByPlaceholder("Search chats").fill("beta");

  // Message-text search runs in the main process (SQLite FTS); only the
  // matching conversation survives.
  await expect(listRows(window)).toHaveCount(1);
  await expect(listRows(window).first()).toContainText("E2E beta");
});

/**
 * The composer's two reference triggers. Both only open a candidate list; what
 * lands in the message is the picked name as inline code (`` `名字` ``), with no
 * trigger character and with spaces intact.
 * Nothing is sent here (`chat:send` wakes the assistant, which needs a model —
 * see `tests/e2e/README.md`), so the assertions are about the popup contract and
 * the inserted text only.
 *
 * A task group cannot be created through the preload bridge (`chats:create` is
 * root-only), so the `#` list is exercised as empty here: that is exactly the
 * "this conversation spawned no task group" state, and it must not look broken
 * nor swallow the boss's typing. The group-insertion path shares all of its
 * machinery with the `@` case asserted below.
 */
test("the composer references employees with `@` and task groups with `#`", async () => {
  const session = app!;
  const { window } = session;
  const employeeId = await createEmployee(window, "Ada", "Researcher");
  const chatId = await createChat(window, "E2E refs");
  await appendMessage(window, chatId, employeeId, "assistant placeholder");
  await session.reload();

  await listRows(window).first().click();
  const pane = detailPane(window);
  const composer = pane.getByPlaceholder(CHAT_COMPOSER_PLACEHOLDER);
  await expect(composer).toBeVisible();
  const popup = pane.locator(".imb-ref-popup");

  // `#` at the start of a line opens the task-group list. This conversation has
  // none, so the popup says so instead of rendering an empty box.
  await composer.click();
  await composer.press("#");
  await expect(popup).toBeVisible();
  await expect(pane.locator(".imb-ref-empty")).toHaveText(
    "No task groups found",
  );

  // Escape closes it and keeps what was typed (a `#` the boss may still want).
  await composer.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(composer).toHaveValue("#");

  // A `#` inside a word is prose, not a reference.
  await composer.fill("abc#d");
  await expect(popup).toHaveCount(0);
  await expect(composer).toHaveValue("abc#d");

  // `@` still lists employees; what it writes is the name **alone**, wrapped in
  // inline code (the trigger character only opened the popup). Backticks are
  // what keep a name with spaces one token.
  await composer.fill("");
  await composer.press("@");
  await expect(popup).toBeVisible();
  await popup.getByRole("option", { name: /Ada/ }).click();
  await expect(composer).toHaveValue("`Ada` ");
  await expect(popup).toHaveCount(0);

  // Inserted mid-sentence: the trigger character is consumed, and no second
  // space is added when the text already continues with one.
  await composer.fill("see  you");
  for (let step = 0; step < 4; step += 1) await composer.press("ArrowLeft");
  await composer.press("@");
  await expect(popup).toBeVisible();
  await popup.getByRole("option", { name: /Ada/ }).click();
  await expect(composer).toHaveValue("see `Ada` you");
});

/**
 * Risk guard for the **legacy** `#名字` form (messages sent before references
 * became inline code, and anything the boss types by hand): `#` starts a
 * Markdown ATX heading **only when a space follows it**, so `#群名` must render
 * as the plain text it is — never as a heading in the bubble.
 */
test("a `#group` reference renders as plain text, not a heading", async () => {
  const session = app!;
  const { window } = session;
  const chatId = await createChat(window, "E2E hash text");
  await appendMessage(window, chatId, null, "#E2E alpha 后续指示发到这里");
  await session.reload();

  await listRows(window).first().click();
  const transcript = thread(window);
  await expect(
    transcript.getByText("#E2E alpha 后续指示发到这里"),
  ).toBeVisible();
  await expect(transcript.locator("h1, h2, h3")).toHaveCount(0);
});
