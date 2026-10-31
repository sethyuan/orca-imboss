import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { listRows } from "./helpers/fixtures";

/**
 * The floor of the suite: the built app starts, shows the shell, and can create
 * its very first conversation (which writes to SQLite and reads it back).
 *
 * If this file fails, nothing else in the suite is worth reading.
 */

let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

test("boots the real app into an isolated, empty Chat module", async () => {
  const session = app!;
  const { window } = session;

  const nav = window.getByRole("navigation", { name: "Modules" });
  await expect(nav.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const name of ["Employees", "Scheduled tasks", "Settings"]) {
    await expect(nav.getByRole("button", { name })).toBeVisible();
  }

  // First run: no conversations, and the list pane says so.
  await expect(window.getByText("No conversations yet")).toBeVisible();

  // The run really is sandboxed: both folders live under the OS temp dir, so
  // the boss's `~/.imboss` and the installed app were never touched.
  expect(session.dataRoot).toContain("imboss-e2e-");
  expect(session.userDataDir).toContain("imboss-e2e-");

  // A renderer crash can leave an empty shell that still paints the nav rail.
  expect(session.rendererErrors).toEqual([]);
});

test("creates a conversation that survives a reload", async () => {
  const session = app!;
  const { window } = session;

  await window.getByRole("button", { name: "New Chat", exact: true }).click();

  await expect(listRows(window)).toHaveCount(1);
  // The new chat is selected, so its thread and composer are on screen.
  await expect(
    window.getByPlaceholder("What are your instructions?"),
  ).toBeVisible();

  // Reload: an empty list here would mean the chat only ever lived in memory.
  await session.reload();
  await expect(listRows(window)).toHaveCount(1);
  await expect(listRows(window).first()).toContainText("New Chat");
});
