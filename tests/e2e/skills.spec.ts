import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { detailPane, listRows } from "./helpers/fixtures";

/**
 * Settings › Skills reads **two** folders: the app's own
 * (`<dataRoot>/agent/skills`) and the shared, read-only `~/.agents/skills`
 * (the Agent Skills convention, also auto-discovered by the Pi SDK). The list is
 * their union, the app's own copy winning a name collision.
 *
 * `launchApp()` moves `HOME` into the throw-away root, so `~/.agents/skills` is
 * the seeded one and never the developer's real folder.
 */

let app: LaunchedApp | undefined;

test.afterEach(async () => {
  await app?.close();
});

/** Open Settings › Skills and return the nested skill list (not the sections). */
async function openSkills(session: LaunchedApp) {
  const { window } = session;
  await window
    .getByRole("navigation", { name: "Modules" })
    .getByRole("button", { name: "Settings" })
    .click();
  await listRows(window).filter({ hasText: "Skills" }).first().click();
  const rows = detailPane(window).locator(
    ".imb-settings-split-list .imb-list-row",
  );
  await expect(rows.first()).toBeVisible();
  return rows;
}

test("a skill from the shared ~/.agents/skills folder is listed and read-only", async () => {
  app = await launchApp({
    agentsSkills: [{ name: "shared-skill", description: "Lives in ~/.agents" }],
  });
  const session = app;

  const rows = await openSkills(session);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("shared-skill");

  // The detail pane names the source and offers no Uninstall button (the folder
  // belongs to another tool).
  const split = detailPane(session.window).locator(
    ".imb-settings-split-detail",
  );
  await expect(split).toContainText("Read from ~/.agents/skills");
  await expect(
    split.getByRole("button", { name: "Uninstall", exact: true }),
  ).toHaveCount(0);
});

test("the app's own skills folder wins a name collision and stays uninstallable", async () => {
  app = await launchApp({
    agentsSkills: [{ name: "dup-skill", description: "external copy" }],
    ownSkills: [{ name: "dup-skill", description: "app copy" }],
  });
  const session = app;

  const rows = await openSkills(session);
  // One row, not two: names are unioned, the app's own folder winning.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("app copy");

  const split = detailPane(session.window).locator(
    ".imb-settings-split-detail",
  );
  await expect(split).toContainText("Installed in ~/.imboss/agent/skills");
  await expect(
    split.getByRole("button", { name: "Uninstall", exact: true }),
  ).toBeVisible();
});
