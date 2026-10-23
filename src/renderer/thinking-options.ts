import { CURATED_PROVIDERS_LABELS } from "@shared/constants/providers";
import {
  isThinkingLevel,
  THINKING_LEVELS,
  THINKING_LEVEL_LABEL_KEYS,
  type ThinkingLevel,
} from "@shared/constants/thinking";
import { t } from "@shared/l10n";
import type { ModelOption } from "@shared/types";
import type { SelectOption } from "./components/select";

export function modelRef(model: ModelOption): string {
  return `${model.provider}/${model.id}`;
}

function providerMenuLabel(provider: string): string {
  if (
    Object.prototype.hasOwnProperty.call(CURATED_PROVIDERS_LABELS, provider)
  ) {
    return CURATED_PROVIDERS_LABELS[
      provider as keyof typeof CURATED_PROVIDERS_LABELS
    ];
  }
  return provider;
}

/**
 * One model menu: `leading` stays a normal row (Default, None). Each provider
 * is then a heading, and each row shows the model id. The closed control
 * keeps `provider/id` via `label`.
 */
export function groupedModelSelectOptions(
  models: readonly ModelOption[],
  leading: SelectOption,
): SelectOption[] {
  const ordered = [...models].sort(
    (a, b) =>
      providerMenuLabel(a.provider).localeCompare(
        providerMenuLabel(b.provider),
      ) || a.id.localeCompare(b.id),
  );
  return [
    leading,
    ...ordered.map((model) => ({
      value: modelRef(model),
      label: modelRef(model),
      menuLabel: model.id,
      group: providerMenuLabel(model.provider),
    })),
  ];
}

/**
 * Gloss beside an employee's "Default" model choice. Names the app default
 * only while that model is still listed; otherwise says where to set one.
 */
export function defaultModelSelectNote(
  defaultModel: string,
  models: readonly ModelOption[],
): string {
  const ref = defaultModel.trim();
  if (ref.length > 0 && models.some((model) => modelRef(model) === ref)) {
    return ref;
  }
  return t("Set a default model in Settings → General → Default model");
}

/**
 * Levels to offer for `modelId`. An empty id uses `fallbackModelId` (the app
 * default). When neither model is known, the union of every configured
 * model's levels is used, still in Pi's order.
 */
export function thinkingLevelsFor(
  models: readonly ModelOption[],
  modelId: string,
  fallbackModelId = "",
): ThinkingLevel[] {
  const target = modelId || fallbackModelId;
  if (target) {
    const match = models.find((model) => modelRef(model) === target);
    if (match && match.thinkingLevels.length > 0) return match.thinkingLevels;
  }
  const present = new Set(models.flatMap((model) => model.thinkingLevels));
  const union = THINKING_LEVELS.filter((level) => present.has(level));
  return union.length > 0 ? [...union] : [...THINKING_LEVELS];
}

/**
 * Level the agent actually ends up with when `requested` is clamped onto
 * `levels`. Mirrors Pi's `clampThinkingLevel`: walk up to the nearest stronger
 * level, then down, and only then fall back to the weakest one available.
 */
function clampToLevels(
  levels: readonly ThinkingLevel[],
  requested: ThinkingLevel,
): ThinkingLevel {
  if (levels.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  if (requestedIndex === -1) return levels[0] ?? "off";
  for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
    const candidate = THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? "off";
}

/**
 * Gloss beside an employee's "Default" thinking level. Empty while the app
 * default is unset (the row then reads as a plain "Default"); otherwise names
 * the level the agent really uses, i.e. the app default clamped to the levels
 * the employee's model accepts.
 */
export function defaultThinkingSelectNote(
  defaultThinking: string,
  models: readonly ModelOption[],
  modelId: string,
  fallbackModelId = "",
): string {
  // Unset/corrupt stored values are not an error: the SDK picks its own
  // default then, so there is nothing this row can name.
  const requested = defaultThinking.trim();
  if (!isThinkingLevel(requested)) return "";
  const levels = thinkingLevelsFor(models, modelId, fallbackModelId);
  if (levels.length === 0) return t(THINKING_LEVEL_LABEL_KEYS[requested]);
  return t(THINKING_LEVEL_LABEL_KEYS[clampToLevels(levels, requested)]);
}

/** Select rows for `levels`, keeping a stored value visible even if this model rejects it. */
export function thinkingSelectOptions(
  levels: readonly ThinkingLevel[],
  current: string,
): SelectOption[] {
  const values: ThinkingLevel[] = [...levels];
  if (isThinkingLevel(current) && !values.includes(current)) {
    values.push(current);
  }
  return values.map((level) => ({
    value: level,
    label: t(THINKING_LEVEL_LABEL_KEYS[level]),
  }));
}
