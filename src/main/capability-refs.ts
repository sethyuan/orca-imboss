import { BUILTIN_TOOL_OPTIONS } from "@shared/constants/agent_tools";
import { BUILTIN_MCP_MARKER_PREFIX } from "@shared/constants/employee_transfer";
import { SettingKeys } from "@shared/constants/settings";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BUILTIN_SKILL_NAMES } from "./agent/builtin-skills";
import { isValidSkillName } from "./agent/skills";
import {
  getAgentSkillsDir,
  getAgentsSkillsDir,
  getAuthPath,
  getModelsPath,
} from "./data-dir";
import { getDB } from "./db";
import { parseJsonObject, parseStringArray, stringifyArray } from "./db/json";
import { getSetting, setSetting } from "./db/settings";
import { readMcpRawEntries } from "./mcp-store";

/**
 * Capability reference hygiene — the single source of truth for
 * "does this stored employee value still point at something that exists?".
 *
 * Employees persist capability *references* in SQLite (`employees.mcp`,
 * `employees.skills`, `employees.model_id`), while the capabilities themselves
 * live outside the database:
 *
 * - MCP servers: `~/.imboss/agent/mcp.json` (keys are the identities);
 * - user skills: `~/.imboss/agent/skills/<name>/SKILL.md`, plus the shared
 *   read-only `~/.agents/skills/<name>/SKILL.md`;
 * - built-in skills: `BUILTIN_SKILL_NAMES` (code-shipped, never on the user
 *   skills dir);
 * - models: configured providers (`auth.json` / `models.json`).
 *
 * Nothing enforces that consistency: deleting a server, uninstalling a skill,
 * removing a provider — or editing those files directly (the assistant does
 * exactly that via its `mcp-management` / `skills-management` built-in skills,
 * which tell it to `edit` `mcp.json` and `rm -rf` a skill folder) — leaves
 * "ghost" references behind. The renderer never shows them either: the
 * employee chip selectors render `options ∩ value`, so a value with no option
 * is invisible *and* unremovable, while every patch keeps re-saving it.
 *
 * This module closes that gap with one validity oracle plus three call sites:
 *
 * - **write path** (`db/employees.ts`): references are sanitised before they
 *   are stored, so a ghost can never be (re)persisted — this is what stops a
 *   stale renderer form from writing one back;
 * - **read path** (`employees:list*`, `models:list` IPC): one throttled,
 *   idempotent reconcile pass repairs whatever an out-of-band edit created, so
 *   the data is clean the next time the UI looks at it;
 * - **mutation path** (`mcp:delete`, `mcp:update` rename, `skills:uninstall`,
 *   `providers:remove`): an immediate scoped sweep, so the effect is visible
 *   right after the action and can be reported to the boss.
 *
 * Rules that must not be broken (each one is a deliberate decision):
 * - built-in skills and *current* `builtin:*` markers are never removed;
 * - an `mcp.json` key is "known" regardless of the entry's shape, so a
 *   half-edited/broken entry keeps its employees instead of silently unlinking
 *   them (only a *missing key* means the server is gone);
 * - a rename is remapped, never dropped (`remapEmployeeMcpRef`);
 * - soft-deleted employees (`disabled = 1`) are included — they can be revived
 *   and their references must stay consistent;
 * - purging is skipped entirely when the truth side is unreadable (a corrupt
 *   `auth.json` must never wipe employee model choices);
 * - nothing here throws: a hygiene failure is logged and leaves the data as-is.
 */

/** Direct child of the user skills dir that makes a folder an installed skill. */
const SKILL_FILE = "SKILL.md";

/**
 * Read-path throttle. The reconcile pass runs on every `employees:list*` /
 * `models:list`, and a burst of them (list + listPage + model list on module
 * entry) must not re-scan the same rows repeatedly.
 */
const READ_RECONCILE_THROTTLE_MS = 1000;

export type CapabilityRefKind = "mcp" | "skills";

/** Result of filtering one reference list. */
export interface SanitizedRefs {
  kept: string[];
  removed: string[];
}

/** What one reconcile pass repaired (drive the renderer refresh + UI notice). */
export interface CapabilityReconcileReport {
  /** Employees whose row was rewritten. */
  employeeIds: number[];
  /** Distinct MCP references dropped (deduped). */
  removedMcp: string[];
  /** Distinct skill references dropped (deduped). */
  removedSkills: string[];
  /** Employees whose dangling `model_id` was cleared (they follow the default). */
  clearedModelIds: number[];
  /** `true` when the app-wide default model pointed at a removed provider. */
  clearedDefaultModel: boolean;
}

export interface ReconcileOptions {
  /**
   * Restrict the sweep to these MCP names (fast path after a delete/rename).
   * Other stored names are left exactly as they are, and — because a scoped
   * sweep only looks at the kinds it was given — the skills list and the
   * employee's model reference are not examined either.
   */
  mcp?: readonly string[];
  /** Restrict the sweep to these skill names (fast path after an uninstall). */
  skills?: readonly string[];
  /**
   * Ignore the read-path throttle. Mutation-triggered sweeps set this so the
   * cleanup can never be skipped because a list happened to load 200 ms ago.
   */
  force?: boolean;
}

/**
 * Snapshot of everything a reference can point at. Built once per pass so a
 * sweep over N employees does not re-read the config files N times.
 */
export interface KnownCatalog {
  /** Keys present in `mcp.json`, whatever their shape. */
  mcpKeys: Set<string>;
  /** Current built-in tool opt-in markers (`builtin:*`). */
  builtinMcp: Set<string>;
  /** Code-shipped skills, always present regardless of the skills dir. */
  builtinSkills: Set<string>;
  /** Skills roots in priority order (the app's own folder, then the shared one). */
  skillRoots: readonly string[];
  /** Per-pass `SKILL.md` existence memo (skill names are cheap but repeated). */
  skillExistence: Map<string, boolean>;
  /**
   * Ids of providers that are still configured, or `null` when that cannot be
   * determined (no `auth.json` yet / unreadable). `null` disables model-ref
   * purging for this pass — never guess.
   */
  providerIds: Set<string> | null;
}

interface EmployeeRefRow {
  id: number;
  mcp: string;
  skills: string;
  model_id: string | null;
}

/** Read the truth side once. Never throws. */
export function loadKnownCatalog(): KnownCatalog {
  let mcpKeys: Set<string>;
  try {
    mcpKeys = new Set(Object.keys(readMcpRawEntries()));
  } catch (err) {
    // Defensive: an unreadable `mcp.json` must not make refs look "unknown"
    // (that would unlink every server from every employee).
    console.error(
      "[capability-refs] failed to read mcp.json:",
      err instanceof Error ? err.message : err,
    );
    mcpKeys = new Set<string>();
  }
  return {
    mcpKeys,
    builtinMcp: new Set(BUILTIN_TOOL_OPTIONS.map((option) => option.value)),
    builtinSkills: new Set<string>(BUILTIN_SKILL_NAMES),
    skillRoots: [getAgentSkillsDir(), getAgentsSkillsDir()],
    skillExistence: new Map<string, boolean>(),
    providerIds: readConfiguredProviderIds(),
  };
}

/**
 * True when `name` still names an MCP capability: either a current built-in
 * tool marker or a key in `mcp.json`.
 *
 * `builtin:` is reserved for markers — real server names cannot contain `:`
 * (see `NAME_RE` in `mcp-store.ts`), so the two spaces never collide. A marker
 * that a future version stops shipping stops being known, which is exactly the
 * intent (it is a dangling opt-in, same as a deleted server).
 */
export function isKnownMcpRef(
  name: string,
  catalog: KnownCatalog = loadKnownCatalog(),
): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.startsWith(BUILTIN_MCP_MARKER_PREFIX)) {
    return catalog.builtinMcp.has(name);
  }
  return catalog.mcpKeys.has(name);
}

/**
 * True when `name` still names a skill: a built-in skill, or a folder that
 * contains a `SKILL.md` in **any** skills root (the app's own folder or the
 * shared read-only `~/.agents/skills`), because both are listable and
 * selectable.
 *
 * The folder name is validated before it is used as a path (`SAFE_NAME_RE`),
 * and `.`/`..` are rejected explicitly — that regex accepts them, and a
 * reference must never be able to probe outside the skills dir.
 */
export function isKnownSkillRef(
  name: string,
  catalog: KnownCatalog = loadKnownCatalog(),
): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (catalog.builtinSkills.has(name)) return true;
  if (!isValidSkillName(name) || name === "." || name === "..") return false;
  const cached = catalog.skillExistence.get(name);
  if (cached !== undefined) return cached;
  const exists = catalog.skillRoots.some((root) =>
    existsSync(join(root, name, SKILL_FILE)),
  );
  catalog.skillExistence.set(name, exists);
  return exists;
}

/**
 * True when a stored model reference is still usable.
 *
 * Only the *provider* segment is checked (`"<provider>/<model…>"`, which is
 * what the UI stores via `modelRef()`): the model catalog is a network-refreshed
 * cache, so a model id can be temporarily missing while its provider is fine —
 * purging on that would destroy a valid choice offline. `null`/empty means
 * "follow the app default" and is always fine; a ref without a `/` cannot be
 * verified cheaply and is kept.
 */
export function isKnownModelRef(
  ref: string | null | undefined,
  catalog: KnownCatalog = loadKnownCatalog(),
): boolean {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (trimmed.length === 0) return true;
  const providerIds = catalog.providerIds;
  if (providerIds === null) return true;
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return true;
  return providerIds.has(trimmed.slice(0, slash));
}

/**
 * Filter one reference list: keep what still resolves (deduplicated, original
 * order) and report what was dropped.
 */
export function sanitizeRefs(
  kind: CapabilityRefKind,
  values: readonly string[],
  catalog: KnownCatalog = loadKnownCatalog(),
): SanitizedRefs {
  const kept: string[] = [];
  const removed: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    const known =
      kind === "mcp"
        ? isKnownMcpRef(value, catalog)
        : isKnownSkillRef(value, catalog);
    if (!known) {
      removed.push(value);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    kept.push(value);
  }
  return { kept, removed };
}

let reconciling = false;
let lastReadReconcileAt = 0;

/**
 * Repair stored capability references in one idempotent pass: drop MCP/skill
 * references that no longer resolve, and clear employee `model_id`s (plus the
 * app-wide default model) whose provider is gone.
 *
 * Used from three kinds of call sites (see the module doc). Never throws; a
 * failed pass leaves the data untouched. Concurrent calls are skipped (the
 * renderer refresh this triggers reloads the lists that call it).
 */
export function reconcileCapabilityRefs(
  options: ReconcileOptions = {},
): CapabilityReconcileReport {
  const report: CapabilityReconcileReport = {
    employeeIds: [],
    removedMcp: [],
    removedSkills: [],
    clearedModelIds: [],
    clearedDefaultModel: false,
  };
  if (reconciling) return report;
  if (
    !options.force &&
    Date.now() - lastReadReconcileAt < READ_RECONCILE_THROTTLE_MS
  ) {
    return report;
  }
  reconciling = true;
  try {
    const catalog = loadKnownCatalog();
    reconcileEmployeeRows(report, options, catalog);
    reconcileDefaultModel(report, catalog);
  } catch (err) {
    console.error(
      "[capability-refs] reconcile failed:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    reconciling = false;
    lastReadReconcileAt = Date.now();
  }
  return report;
}

/**
 * Rewrite every employee's stored references from `oldName` to `newName`.
 *
 * An MCP server can be renamed (`mcp-store.updateMcpServer`); the employees
 * that selected it must follow the key instead of losing the link. Returns the
 * ids of the employees that were rewritten (empty when nobody linked it).
 */
export function remapEmployeeMcpRef(
  oldName: string,
  newName: string,
): number[] {
  if (!oldName || !newName || oldName === newName) return [];
  try {
    const db = getDB();
    const rows = db.prepare("SELECT id, mcp FROM employees").all() as Array<{
      id: number;
      mcp: string;
    }>;
    const update = db.prepare("UPDATE employees SET mcp = ? WHERE id = ?");
    const changed: number[] = [];
    db.transaction(() => {
      for (const row of rows) {
        const values = parseStringArray(row.mcp);
        if (!values.includes(oldName)) continue;
        const seen = new Set<string>();
        const next: string[] = [];
        for (const value of values) {
          const mapped = value === oldName ? newName : value;
          if (seen.has(mapped)) continue; // renaming onto a name already linked
          seen.add(mapped);
          next.push(mapped);
        }
        update.run(stringifyArray(next), row.id);
        changed.push(row.id);
      }
    })();
    return changed;
  } catch (err) {
    console.error(
      "[capability-refs] rename remap failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** One row's worth of repair; shared by the full sweep and the scoped fast path. */
function reconcileEmployeeRows(
  report: CapabilityReconcileReport,
  options: ReconcileOptions,
  catalog: KnownCatalog,
): void {
  const db = getDB();
  // Includes the built-in assistant (id 0, whose `mcp` is always empty) and
  // soft-deleted employees (a disabled employee can be revived).
  const rows = db
    .prepare("SELECT id, mcp, skills, model_id FROM employees")
    .all() as EmployeeRefRow[];
  // A scoped sweep (a delete/rename follow-up) only looks at the kinds it was
  // told about: pruning an unrelated dangling reference there would make the
  // mutation path's reach unpredictable.
  const scoped = options.mcp !== undefined || options.skills !== undefined;
  const sweepMcp = !scoped || options.mcp !== undefined;
  const sweepSkills = !scoped || options.skills !== undefined;
  const mcpFilter = options.mcp ? new Set(options.mcp) : null;
  const skillFilter = options.skills ? new Set(options.skills) : null;
  const removedMcp = new Set<string>();
  const removedSkills = new Set<string>();
  const update = db.prepare(
    "UPDATE employees SET mcp = ?, skills = ?, model_id = ? WHERE id = ?",
  );

  db.transaction(() => {
    for (const row of rows) {
      const storedMcp = parseStringArray(row.mcp);
      const storedSkills = parseStringArray(row.skills);
      const mcp = sweepMcp
        ? filterRefs("mcp", storedMcp, catalog, mcpFilter, removedMcp)
        : storedMcp;
      const skills = sweepSkills
        ? filterRefs(
            "skills",
            storedSkills,
            catalog,
            skillFilter,
            removedSkills,
          )
        : storedSkills;
      let modelId = row.model_id;
      let modelCleared = false;
      if (!scoped && !isKnownModelRef(modelId, catalog)) {
        modelId = null;
        modelCleared = true;
      }
      // `filterRefs` only ever drops entries (it never substitutes), so an
      // identical length means an identical list.
      const refsChanged =
        mcp.length !== storedMcp.length ||
        skills.length !== storedSkills.length;
      if (!refsChanged && !modelCleared) continue;
      update.run(stringifyArray(mcp), stringifyArray(skills), modelId, row.id);
      report.employeeIds.push(row.id);
      if (modelCleared) report.clearedModelIds.push(row.id);
    }
  })();

  report.removedMcp = [...removedMcp];
  report.removedSkills = [...removedSkills];
}

/**
 * Keep/drop one stored list. `filter` (scoped pass) limits *which* names are
 * examined: anything outside it is copied through untouched, so a targeted
 * sweep after "MCP `foo` was deleted" can never touch an unrelated reference.
 */
function filterRefs(
  kind: CapabilityRefKind,
  values: readonly string[],
  catalog: KnownCatalog,
  filter: Set<string> | null,
  removedOut: Set<string>,
): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (filter !== null && !filter.has(value)) {
      if (!seen.has(value)) {
        seen.add(value);
        kept.push(value);
      }
      continue;
    }
    const known =
      kind === "mcp"
        ? isKnownMcpRef(value, catalog)
        : isKnownSkillRef(value, catalog);
    if (!known) {
      removedOut.add(value);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    kept.push(value);
  }
  return kept;
}

/**
 * Clear the app-wide default model when its provider is gone. Same rule as the
 * employee refs (and the same single trigger the reset writes happen at):
 * otherwise the setting keeps a ref that can never resolve.
 */
function reconcileDefaultModel(
  report: CapabilityReconcileReport,
  catalog: KnownCatalog,
): void {
  const current = getSetting(SettingKeys.DefaultModel);
  if (isKnownModelRef(current, catalog)) return;
  setSetting(SettingKeys.DefaultModel, "");
  report.clearedDefaultModel = true;
}

/**
 * Ids of providers that are still configured (`auth.json` keys + custom
 * `models.json` providers), or `null` when `auth.json` does not exist yet — a
 * missing file means "cannot tell", and a hygiene pass must never wipe model
 * choices on a guess. `removeProvider` always leaves the file in place (`{}`
 * when the last provider goes), so removal is still detected.
 */
function readConfiguredProviderIds(): Set<string> | null {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return null;
  const auth = readJsonObject(authPath);
  const models = readJsonObject(getModelsPath());
  if (auth === null || models === null) return null;
  const ids = new Set<string>(Object.keys(auth));
  const providers = models["providers"];
  if (
    typeof providers === "object" &&
    providers !== null &&
    !Array.isArray(providers)
  ) {
    for (const id of Object.keys(providers)) ids.add(id);
  }
  return ids;
}

/** Defensive JSON-object read: missing file → `{}`, unreadable/corrupt → `null`. */
function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    return parseJsonObject(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
