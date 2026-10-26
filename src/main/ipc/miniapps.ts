import { listMiniApps, openMiniApp, setMiniAppOrder } from "../mini-apps";
import { assertString } from "./helpers";
import type { Binder } from "../rpc/types";

/**
 * Mini Apps IPC. Mirrors `src/main/mini-apps.ts`: `list`/`setOrder` are pure
 * filesystem operations; `open` also lazily starts the app's supervised server
 * and resolves only once the entry URL is reachable.
 */
export function registerMiniAppHandlers(bind: Binder): void {
  bind("miniapps:list", () => listMiniApps());

  bind("miniapps:setOrder", (_ctx, ids: unknown) =>
    setMiniAppOrder(assertIdList(ids)),
  );

  bind("miniapps:open", (_ctx, id: unknown) =>
    openMiniApp(assertString(id, "mini app id")),
  );
}

/** Defensive validation of the reorder payload (bounded string array). */
function assertIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("mini app order must be an array.");
  }
  if (value.length > 1000) {
    throw new Error("Too many mini app ids.");
  }
  return value.map((id) => assertString(id, "mini app id"));
}
