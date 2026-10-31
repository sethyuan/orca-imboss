import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { detailPane, listRows } from "./helpers/fixtures";

/**
 * Module switching — the one interaction that touches every module's lazy
 * loader. Each module loads its data on first visit (`app-store.ensure*`), so a
 * broken IPC channel or a bad render surfaces here immediately, without any
 * fixture setup.
 */

let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

test("switches modules and lazy-loads each pane", async () => {
  const session = app!;
  const { window } = session;
  const nav = window.getByRole("navigation", { name: "Modules" });

  // Employees: a fresh database already holds the assistant (id 0).
  await nav.getByRole("button", { name: "Employees" }).click();
  await expect(nav.getByRole("button", { name: "Employees" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(listRows(window).first()).toContainText("Assistant");

  // Scheduled tasks: empty state copy from the cron module.
  await nav.getByRole("button", { name: "Scheduled tasks" }).click();
  await expect(
    window.getByText("No scheduled tasks yet. Ask an employee to create one."),
  ).toBeVisible();

  // Settings: the section list is the module's list pane, General is default.
  await nav.getByRole("button", { name: "Settings" }).click();
  for (const section of ["General", "Theme", "About"]) {
    await expect(
      listRows(window).filter({ hasText: section }).first(),
    ).toBeVisible();
  }
  await expect(detailPane(window)).toContainText("General");

  // …and back to Chat, whose empty state is the module's own.
  await nav.getByRole("button", { name: "Chats" }).click();
  await expect(window.getByText("No conversations yet")).toBeVisible();
});
