import { parseCommonProjects } from "@shared/constants/projects";
import { SettingKeys } from "@shared/constants/settings";
import { getSetting } from "../db/settings";
import type { Binder } from "../rpc/types";

/**
 * Common-project IPC. `projects:list` reads the `app.commonProjects` setting
 * and re-normalizes it (stored values are never trusted): invalid entries and
 * duplicates are dropped, path fields must be absolute. Writes go through the
 * generic `settings:set` channel, mirroring `agent.userEnv`.
 */
export function registerProjectHandlers(bind: Binder): void {
  bind("projects:list", () =>
    parseCommonProjects(getSetting(SettingKeys.CommonProjects)),
  );
}
