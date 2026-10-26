import { SettingKeys } from "@shared/constants/settings";
import { getSetting, setSetting } from "../db/settings";
import { applyHttpProxy, normalizeProxyUrl } from "../http-proxy";
import { assertString } from "./helpers";
import type { Binder } from "../rpc/types";

/**
 * Settings → Network handlers. The proxy value is stored in the app's SQLite
 * settings table and applied to the main process immediately (no restart).
 */
export function registerNetworkHandlers(bind: Binder): void {
  bind("network:getProxy", () => getSetting(SettingKeys.HttpProxy) ?? "");

  bind("network:setProxy", (_ctx, value: unknown) => {
    const raw = assertString(value, "proxy");
    // Validate before persisting so an invalid value is never stored.
    const url = normalizeProxyUrl(raw);
    setSetting(SettingKeys.HttpProxy, url ?? "");
    applyHttpProxy(url);
  });
}
