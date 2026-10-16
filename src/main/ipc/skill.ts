import { SKILL_IMPORT_ENABLED } from "@shared/constants/skills";
import { t } from "@shared/l10n";
import { ipcMain } from "electron";
import {
  installSkillsFromFolders,
  listSkills,
  listSkillsPage,
  uninstallSkill,
} from "../agent/skills";
import {
  commitSkillInstall,
  discardSkillInstall,
  fetchSkillUrl,
  previewSkillArchiveFile,
} from "../skill-import";
import { showOpenDialog } from "./dialog";
import { assertString, parsePageQuery } from "./helpers";

async function pickSkillFolders(): Promise<string[] | null> {
  return showOpenDialog({
    title: t("Select skill folders"),
    properties: ["openDirectory", "multiSelections"],
  });
}

async function pickSkillArchive(): Promise<string | null> {
  const paths = await showOpenDialog({
    title: t("Select a skill archive"),
    properties: ["openFile"],
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  return paths?.[0] ?? null;
}

export function registerSkillHandlers(): void {
  ipcMain.handle("skills:list", () => listSkills());

  ipcMain.handle("skills:listPage", (_event, page: unknown) =>
    listSkillsPage(parsePageQuery(page)),
  );

  ipcMain.handle("skills:install", async () => {
    const paths = await pickSkillFolders();
    if (paths === null) return null;
    const imported = await installSkillsFromFolders(paths);
    return imported;
  });

  ipcMain.handle("skills:uninstall", async (_event, name: unknown) => {
    await uninstallSkill(assertString(name, "skill name"));
  });

  // Pluggable feature: importing from a link or an archive, reviewed before
  // anything is written (see `SKILL_IMPORT_ENABLED`).
  if (SKILL_IMPORT_ENABLED) {
    ipcMain.handle("skills:inspectUrl", (_event, url: unknown) =>
      fetchSkillUrl(assertString(url, "link")),
    );

    ipcMain.handle("skills:inspectArchive", async () => {
      const path = await pickSkillArchive();
      if (path === null) return null;
      return previewSkillArchiveFile(path);
    });

    ipcMain.handle("skills:commitInstall", (_event, ids: unknown) =>
      commitSkillInstall(assertStringArray(ids, "skill ids")),
    );

    ipcMain.handle("skills:discardInstall", (_event, ids: unknown) => {
      discardSkillInstall(assertStringArray(ids, "skill ids"));
    });
  }
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry) => assertString(entry, field));
}
