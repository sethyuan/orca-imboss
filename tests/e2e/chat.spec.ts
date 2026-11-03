import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import {
  appendMessage,
  ASSISTANT_ID,
  createChat,
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

  // The composer belongs to the selected conversation.
  await expect(
    window.getByPlaceholder("What are your instructions?"),
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
