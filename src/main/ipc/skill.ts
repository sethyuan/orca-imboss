import { t } from "@shared/l10n";
import { isAbsolute } from "path";
import type { CapabilityUnlinkResult } from "@shared/types";
import {
  installSkillsFromFolders,
  listSkills,
  listSkillsPage,
  uninstallSkill,
} from "../agent/skills";
import { reconcileCapabilityRefs } from "../capability-refs";
import { notifyEmployeesChanged } from "../employee-events";
import { sendToRenderer } from "../notifications";
import { showOpenDialog } from "./dialog";
import { assertString, parsePageQuery } from "./helpers";
import type { Binder } from "../rpc/types";

async function pickSkillFolders(): Promise<string[] | null> {
  return showOpenDialog({
    title: t("Select skill folders"),
    properties: ["openDirectory", "multiSelections"],
  });
}

/** Absolute-path list from a remote client (no traversal, bounded count). */
function validateSkillPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("skills:install expects an array of folder paths.");
  }
  if (value.length === 0) {
    throw new Error("At least one folder is required.");
  }
  if (value.length > 50) {
    throw new Error("Too many folders.");
  }
  return value.map((entry) => {
    const path = assertString(entry, "skill folder");
    if (!isAbsolute(path)) {
      throw new Error("Skill folders must be absolute paths.");
    }
    return path;
  });
}

export function registerSkillHandlers(bind: Binder): void {
  bind("skills:list", () => listSkills());

  bind("skills:listPage", (_ctx, page: unknown) =>
    listSkillsPage(parsePageQuery(page)),
  );

  /**
   * Install skill folders. With no argument the native picker runs (local mode);
   * a remote client passes the folders it chose with the backend's path browser,
   * because a dialog on a headless backend cannot be answered.
   */
  bind("skills:install", async (_ctx, chosen?: unknown) => {
    const paths =
      chosen === undefined
        ? await pickSkillFolders()
        : validateSkillPaths(chosen);
    if (paths === null) return null;
    const imported = await installSkillsFromFolders(paths);
    // Skills live on disk and can also change outside the app; the renderer
    // caches them per module visit, so announce the change (the preload hook
    // `skills.onChanged` existed without a sender before this).
    if (imported.length > 0) sendToRenderer("skills:changed");
    return imported;
  });

  /**
   * Uninstall a skill *and* unlink it from the employees that selected it.
   *
   * The folder is the skill; `employees.skills` holds names, so removing the
   * folder without this sweep would leave a reference the renderer can never
   * show or remove again. The ids come back so the UI can report the count.
   */
  bind(
    "skills:uninstall",
    async (_ctx, name: unknown): Promise<CapabilityUnlinkResult> => {
      const safeName = assertString(name, "skill name");
      await uninstallSkill(safeName);
      const report = reconcileCapabilityRefs({
        skills: [safeName],
        force: true,
      });
      notifyEmployeesChanged(report.employeeIds);
      sendToRenderer("skills:changed");
      return { removed: true, unlinkedEmployeeIds: report.employeeIds };
    },
  );
}
