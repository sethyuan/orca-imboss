import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { detailPane, listRows, readTheme } from "./helpers/fixtures";

/**
 * Theme round trips: renderer → IPC → main (nativeTheme + SQLite) → push back to
 * the renderer, then a reload to prove it was persisted.
 *
 * Theme is picked because it is completely deterministic (no network, no model),
 * yet exercises the same channel machinery every settings page uses. Both entry
 * points are covered: the settings page's text segmented control and the chrome
 * band's icon-only switch (which must land on the *same* stored value).
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

  // Scoped to the pane: the chrome band carries a second Light/Dark/System
  // control, whose segments have the same accessible names.
  await detailPane(window)
    .getByRole("button", { name: "Dark", exact: true })
    .click();

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

test("the titlebar theme switch applies and persists the mode", async () => {
  const session = app!;
  const { window } = session;

  // The band's switch is the only segmented group with an accessible name (the
  // settings page's has none), and it is icon-only — the labels are its
  // `aria-label`s, which is what makes it clickable here at all.
  const titlebarSwitch = window.getByRole("group", { name: "Theme mode" });
  await expect(titlebarSwitch).toBeVisible();

  await titlebarSwitch.getByRole("button", { name: "Dark" }).click();

  await expect(window.locator("html")).toHaveAttribute(
    "data-theme-mode",
    "dark",
  );
  expect((await readTheme(window)).mode).toBe("dark");

  // Still in the band after a reload, and showing the restored selection: the
  // thumb offset and `aria-pressed` both come from the persisted value.
  await session.reload();
  await expect(window.locator("html")).toHaveAttribute(
    "data-theme-mode",
    "dark",
  );
  await expect(
    window
      .getByRole("group", { name: "Theme mode" })
      .getByRole("button", { name: "Dark" }),
  ).toHaveAttribute("aria-pressed", "true");
});
