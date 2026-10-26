import { SettingKeys } from "@shared/constants/settings";
import type {
  ProviderLoginEvent,
  ProviderModelsQuery,
  ProviderUpsert,
} from "@shared/types";
import type { Subscriber } from "../rpc/types";
import type { Binder } from "../rpc/types";
import { listAvailableModels, refreshModelStore } from "../agent/model-runtime";
import { reconcileCapabilityRefs } from "../capability-refs";
import {
  notifyEmployeesChanged,
  reconcileEmployeeRefsOnRead,
} from "../employee-events";
import {
  loginProviderSubscription,
  submitLoginCode,
} from "../agent/provider-login";
import {
  listModels,
  listProviders,
  listProvidersPage,
  removeProvider,
  revealProviderKey,
  upsertProvider,
} from "../agent/providers";
import { setSetting } from "../db/settings";
import { getImageModelRef } from "../image-gen";
import { getClipboard, getExternalOpener } from "../platform";
import { assertString, parsePageQuery } from "./helpers";

/** One in-flight subscription sign-in. A second click is rejected. */
let activeLogin: {
  controller: AbortController;
  sender: Subscriber;
} | null = null;

// --- providers / skills ---
export function registerProviderHandlers(bind: Binder): void {
  bind("providers:list", () => listProviders());

  bind("providers:listPage", (_ctx, page: unknown) =>
    listProvidersPage(parsePageQuery(page)),
  );

  bind("providers:upsert", async (_ctx, input: ProviderUpsert) => {
    // Persist the provider first, then refresh the app's model store so the
    // newly added/updated provider is immediately available. Best-effort:
    // a refresh failure is logged and never fails the save.
    await upsertProvider(input);
    await refreshModelStore(new AbortController().signal);
  });

  bind("providers:remove", async (_ctx, id: unknown) => {
    // Removal cascades into every stored reference to that provider: the
    // app-wide image model (cleared here, its own single trigger) and — via the
    // shared capability-reference sweep — employee `model_id`s plus the default
    // model, which would otherwise be refs that can never resolve again.
    const providerId = assertString(id, "provider id");
    await removeProvider(providerId);
    clearImageModelIfProviderRemoved(providerId);
    await refreshModelStore(new AbortController().signal);
    const report = reconcileCapabilityRefs({ force: true });
    notifyEmployeesChanged(report.employeeIds);
  });

  bind("providers:listModels", (_ctx, input: unknown) =>
    listModels(input as ProviderModelsQuery),
  );

  // Full usable-model list from the shared ModelRuntime (built-in + custom,
  // auth-configured only) — backs the default-model / employee model selects.
  bind("models:list", () => {
    // Read-path self-heal for model references (employee `model_id` + the
    // app-wide default model) and, in the same pass, for capability refs: a
    // provider or server removed outside the app is repaired the next time the
    // UI reads a list. Throttled and never throws.
    reconcileEmployeeRefsOnRead();
    return listAvailableModels();
  });

  bind("providers:login", async (ctx, id: unknown) => {
    if (activeLogin) {
      throw new Error("A sign-in is already in progress.");
    }
    const providerId = assertString(id, "provider id");
    const controller = new AbortController();
    const sender = ctx.subscriber;
    activeLogin = { controller, sender };
    // A caller that goes away must not leave a sign-in running forever.
    const offGone = sender.onClose(() => controller.abort());
    try {
      await loginProviderSubscription(
        providerId,
        (payload) => deliverLoginEvent(sender, payload),
        controller.signal,
      );
      await refreshModelStore(controller.signal);
    } finally {
      offGone();
      if (activeLogin?.controller === controller) activeLogin = null;
    }
  });

  bind("providers:cancelLogin", () => {
    activeLogin?.controller.abort();
  });

  bind("providers:submitLogin", (_ctx, value: unknown) => {
    submitLoginCode(assertString(value, "authorization code"));
  });

  bind("providers:copyKey", async (_ctx, id: unknown) => {
    const key = await revealProviderKey(assertString(id, "provider id"));
    if (!key) throw new Error("No API key set for this provider.");
    getClipboard().writeText(key);
    return true;
  });
}

/**
 * The image-generation model is one app-wide setting stored as
 * `"<provider>/<modelId>"`. Once its provider is deleted that ref can never
 * resolve, so the setting is cleared at this single point where the removal has
 * actually succeeded — otherwise the dangling value would keep breaking
 * `imb_generate_image` with a confusing "not configured" failure. Only a ref
 * whose `<provider>` equals the removed id is cleared; removing any other
 * provider leaves the setting untouched.
 */
function clearImageModelIfProviderRemoved(providerId: string): void {
  const ref = getImageModelRef();
  if (ref !== null && ref.provider === providerId) {
    setSetting(SettingKeys.ImageModel, "");
  }
}

/** Pi already requires https. Re-check before handing the URL to the OS. */
function deliverLoginEvent(
  sender: Subscriber,
  payload: ProviderLoginEvent,
): void {
  if (sender.alive) sender.send("providers:loginEvent", payload);
  const url = loginUrl(payload);
  if (!url || !isHttpsUrl(url)) return;
  getExternalOpener().openExternal(url);
}

function loginUrl(payload: ProviderLoginEvent): string | undefined {
  if (payload.type === "device_code" || payload.type === "auth_url") {
    return payload.verificationUri;
  }
  return undefined;
}

function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}
