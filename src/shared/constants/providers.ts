/** Providers offered in the settings dropdown in addition to "Custom". */
export const CURATED_PROVIDERS = [
  "anthropic",
  "deepseek",
  "github-copilot",
  "google",
  "groq",
  "minimax-cn",
  "minimax",
  "moonshotai-cn",
  "moonshotai",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
  "zai",
] as const;

/** Names for the providers to display in UI */
export const CURATED_PROVIDERS_LABELS = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  groq: "Groq",
  "minimax-cn": "MiniMax (CN)",
  minimax: "MiniMax",
  "moonshotai-cn": "Moonshot AI (CN)",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  xai: "xAI",
  xiaomi: "Xiaomi",
  "xiaomi-token-plan-cn": "Xiaomi Token Plan (CN)",
  "xiaomi-token-plan-ams": "Xiaomi Token Plan (AMS)",
  "xiaomi-token-plan-sgp": "Xiaomi Token Plan (SGP)",
  zai: "Z.ai",
} as const;

/**
 * Built-in providers whose Pi auth is a subscription OAuth login that this
 * app can drive. xAI is device code. Anthropic is Pi's browser loopback
 * flow (Claude Pro/Max), with a paste step when the callback does not
 * return. Other Pi OAuth flows that ask for a secret stay API-key only.
 */
export const SUBSCRIPTION_LOGIN_PROVIDERS = ["anthropic", "xai"] as const;

export type SubscriptionLoginProvider =
  (typeof SUBSCRIPTION_LOGIN_PROVIDERS)[number];

/** Button label for each subscription provider. */
export const SUBSCRIPTION_LOGIN_LABELS: Record<
  SubscriptionLoginProvider,
  string
> = {
  anthropic: "Sign in with Claude Pro or Max",
  xai: "Sign in with SuperGrok or X Premium",
};

/** Status line once that provider's OAuth credential is stored. */
export const SUBSCRIPTION_SIGNED_IN_LABELS: Record<
  SubscriptionLoginProvider,
  string
> = {
  anthropic: "Signed in with Claude Pro or Max",
  xai: "Signed in with SuperGrok or X Premium",
};

/**
 * i18n key shown when the xAI device-code request never connects (timeout,
 * DNS failure, connection refused). HTTP responses from auth.x.ai are a
 * different failure and keep their own message.
 */
export const XAI_UNREACHABLE =
  "Could not connect to auth.x.ai. Check that the proxy in Settings → Network is usable.";

export function isSubscriptionLoginProvider(
  id: string,
): id is SubscriptionLoginProvider {
  return (SUBSCRIPTION_LOGIN_PROVIDERS as readonly string[]).includes(id);
}

/** API protocol flavors supported for custom providers (`models.json` `api`). */
export const PROVIDER_API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

/**
 * Input (modality) capabilities a model can declare (`models.json` `input`).
 *
 * This list is NOT a product choice: Pi validates `models.json` against a
 * TypeBox schema whose `input` is exactly `("text" | "image")[]`, and a single
 * unknown value invalidates the WHOLE file (every custom provider's models
 * disappear from the runtime). Keep it in lockstep with the SDK — verify in
 * `pi-coding-agent/dist/core/model-config.js` (`ModelDefinitionSchema`) before
 * adding a value. Audio / video / PDF are not supported by the SDK today.
 */
export const MODEL_INPUT_TYPES = ["text", "image"] as const;

/** Fallback for models that declare no (or unreadable) input types. */
export const DEFAULT_MODEL_INPUT_TYPES: readonly ModelInputType[] = ["text"];

export type ModelInputType = (typeof MODEL_INPUT_TYPES)[number];

export function isModelInputType(value: unknown): value is ModelInputType {
  return (
    typeof value === "string" &&
    (MODEL_INPUT_TYPES as readonly string[]).includes(value)
  );
}
