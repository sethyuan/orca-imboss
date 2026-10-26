import { getSetting, setSetting } from "../db/settings";
import type { Binder } from "../rpc/types";
import { assertString } from "./helpers";

/**
 * Settings KV — the database-backed half, served by whichever process owns the
 * data folder (local: this one, remote: the backend).
 *
 * The desktop app version is *not* here: it is a property of the shell, so it
 * stays local in `./local` (see `registerAppInfoHandlers`).
 */
export function registerSettingsHandlers(bind: Binder): void {
  bind("settings:get", (_ctx, key: unknown) =>
    getSetting(assertString(key, "key")),
  );

  bind("settings:set", (_ctx, key: unknown, value: unknown) => {
    setSetting(assertString(key, "key"), assertString(value, "value"));
  });
}
