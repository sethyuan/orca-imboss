import { INTEGRATION_PLATFORMS } from "@shared/constants/integrations";
import type {
  IntegrationConfigPatch,
  IntegrationPlatform,
} from "@shared/types";
import { integrationManager } from "../integrations";
import { assertObject, assertString } from "./helpers";
import type { Binder } from "../rpc/types";

/**
 * Renderer ↔ main IPC for the Settings → Integrations page. Secrets are never
 * returned: `getState` masks them, and `setConfig` only accepts a patch.
 */
export function registerIntegrationHandlers(bind: Binder): void {
  bind("integrations:getState", () => integrationManager.getState());

  bind(
    "integrations:setConfig",
    async (_ctx, platform: unknown, patch: unknown) => {
      const safePlatform = assertPlatform(platform);
      const safePatch = assertObject(patch, "patch") as IntegrationConfigPatch;
      await integrationManager.setConfig(safePlatform, safePatch);
      return integrationManager.getState();
    },
  );

  bind(
    "integrations:setEnabled",
    async (_ctx, platform: unknown, enabled: unknown) => {
      const safePlatform = assertPlatform(platform);
      if (typeof enabled !== "boolean") {
        throw new Error("enabled must be a boolean.");
      }
      await integrationManager.setEnabled(safePlatform, enabled);
      return integrationManager.getState();
    },
  );

  bind("integrations:login", async (_ctx, platform: unknown) => {
    await integrationManager.login(assertPlatform(platform));
    return integrationManager.getState();
  });

  bind("integrations:logout", async (_ctx, platform: unknown) => {
    await integrationManager.logout(assertPlatform(platform));
    return integrationManager.getState();
  });

  bind("integrations:clearContacts", async (_ctx, platform: unknown) => {
    await integrationManager.clearContacts(assertPlatform(platform));
    return integrationManager.getState();
  });
}

function assertPlatform(value: unknown): IntegrationPlatform {
  const platform = assertString(value, "platform");
  if (!(INTEGRATION_PLATFORMS as string[]).includes(platform)) {
    throw new Error("Unknown integration platform.");
  }
  return platform as IntegrationPlatform;
}
