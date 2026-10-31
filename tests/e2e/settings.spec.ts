import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { listRows, readTheme } from "./helpers/fixtures";

/**
 * A settings round trip: renderer → IPC → main (nativeTheme + SQLite) → push back
 * to the renderer, then a reload to prove it was persisted.
 *
 * Theme is picked because it is completely deterministic (no network, no model),
 * yet exercises the same channel machinery every settings page uses.
 */

let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

test("changing the theme mode is applied and persisted", async () => {
  const session = app!;
  const { window } = session;

  await window
    .getByRole("navigation", { name: "Modules" })
    .getByRole("button", { name: "Settings" })
    .click();
  // Settings › Theme. The row's accessible name is "Theme" + its description,
  // so filter on its text instead of matching the name exactly.
  await listRows(window).filter({ hasText: "Theme" }).first().click();
  await expect(
    window.getByRole("radiogroup", { name: "Accent color" }),
  ).toBeVisible();

  await window.getByRole("button", { name: "Dark", exact: true }).click();

  // Renderer painted it…
  await expect(window.locator("html")).toHaveAttribute(
    "data-theme-mode",
    "dark",
  );
  // …and the main process reports the persisted value.
  expect((await readTheme(window)).mode).toBe("dark");

  // Reload: the mode has to come back from disk, not from React state.
  await session.reload();
  await expect(window.locator("html")).toHaveAttribute(
    "data-theme-mode",
    "dark",
  );
});
