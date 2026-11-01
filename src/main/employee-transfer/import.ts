import { randomUUID } from "crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BUILTIN_MCP_MARKER_PREFIX,
  EMPLOYEE_AVATAR_DIR,
  EMPLOYEE_EXPORT_FORMAT,
  EMPLOYEE_EXPORT_FORMAT_VERSION,
  EMPLOYEE_MANIFEST_PATH,
  EMPLOYEE_SKILLS_DIR,
} from "@shared/constants/employee_transfer";
import {
  isThinkingLevel,
  type ThinkingLevel,
} from "@shared/constants/thinking";
import { t } from "@shared/l10n";
import type {
  Employee,
  EmployeeExportManifest,
  EmployeeImportApplyOptions,
  EmployeeImportPreview,
  EmployeeImportPreviewMcpServer,
  EmployeeImportPreviewSkill,
  EmployeeImportResult,
} from "@shared/types";
import { isValidSkillName, resolveSkillDir } from "../agent/skills";
import { listAvailableModels } from "../agent/model-runtime";
import { saveAvatar } from "../avatars";
import { getAgentRoot, getAgentSkillsDir } from "../data-dir";
import * as dbEmployees from "../db/employees";
import {
  importMcpEntries,
  readMcpRawEntries,
  restoreMcpConfig,
  snapshotMcpConfig,
} from "../mcp-store";
import { sendToRenderer } from "../notifications";
import { IMPORT_LIMITS, readArchiveFile, stageArchive } from "./archive";
import {
  avatarExtensionOf,
  detectImageExtension,
  isSafeEntryPath,
  resolveInside,
  skillNameOfMember,
} from "./paths";

/**
 * Package → employee, in two steps.
 *
 * `inspectEmployeeExport` picks a file, validates it and unpacks it into a
 * temporary staging folder — **no app state is touched** — and returns a
 * preview plus a token. `applyEmployeeImport(token, …)` then performs the
 * writes. Cancelling (or never confirming) simply drops the staging folder, so
 * a rejected package can never leave partial data behind.
 *
 * Write order and rollback: skills first, then `mcp.json`, then the employee
 * row, then the avatar. Any failure removes the skill folders it created,
 * restores the previous `mcp.json` bytes and deletes a just-created row.
 */

const IMPORT_TTL_MS = 10 * 60 * 1000;
/** Prefix of staging folders; also used to sweep leftovers from older runs. */
const STAGING_PREFIX = "imboss-employee-import-";
/** Swap area for skill overwrites, next to (never inside) the skills folder. */
const SWAP_DIR = ".import-swap";
/** Cap of the manifest member (it is pure JSON metadata). */
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
/** Mirror of the DB layer's definition of these fields. */
const MAX_NAME_LENGTH = 200;
const MAX_ROLE_LENGTH = 200;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_REF_ENTRIES = 256;
const MAX_REF_LENGTH = 256;
const MAX_MCP_SERVERS = 100;
/** Preview images are inlined into the IPC payload; keep them small. */
const MAX_PREVIEW_AVATAR_BYTES = 2 * 1024 * 1024;
/** Image types the avatar store accepts, keyed by sniffed extension. */
const AVATAR_MIME_TYPES: Record<string, string | undefined> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

/** One skill folder extracted from a package. */
interface SkillPackage {
  name: string;
  /** Staging folder of that skill. */
  dir: string;
  files: number;
  bytes: number;
  /** Why the folder cannot be installed, `null` when it can. */
  invalidReason: string | null;
}

interface PendingImport {
  token: string;
  /** Staging folder (already unpacked, nothing applied yet). */
  dir: string;
  sourcePath: string;
  manifest: EmployeeExportManifest;
  skills: SkillPackage[];
  preview: EmployeeImportPreview;
  expiresAt: number;
}

const pending = new Map<string, PendingImport>();

/** Pick-a-file → preview. Throws with a user-facing message on any problem. */
export async function inspectEmployeeExport(
  sourcePath: string,
): Promise<EmployeeImportPreview> {
  sweepPending();
  sweepStaleStagingDirs();

  const archive = readArchiveFile(sourcePath, IMPORT_LIMITS);
  const token = randomUUID();
  const dir = join(tmpdir(), `${STAGING_PREFIX}${token}`);
  let handoff = false;
  try {
    const staged = stageArchive(archive, dir, IMPORT_LIMITS);
    for (const member of staged.members) {
      // Defence in depth: the archive layer already validated every name.
      if (!isSafeEntryPath(member.name)) {
        throw new Error(
          t(
            "The file contains an unsafe path (${path}) and was not imported.",
            {
              path: member.name,
            },
          ),
        );
      }
    }

    const manifest = parseManifest(dir);
    const skills = collectSkillPackages(dir, staged.members);
    const preview = await buildPreview({
      token,
      sourcePath,
      stagingRoot: dir,
      manifest,
      skills,
      expiresAt: Date.now() + IMPORT_TTL_MS,
    });

    pending.set(token, {
      token,
      dir,
      sourcePath,
      manifest,
      skills,
      preview,
      expiresAt: preview.expiresAt,
    });
    handoff = true;
    return preview;
  } finally {
    // Never leave a staging folder behind when the package is rejected.
    if (!handoff) rmSync(dir, { recursive: true, force: true });
  }
}

/** Drop a staging copy the user declined (safe to call with an unknown token). */
export function cancelEmployeeImport(token: string): void {
  const entry = pending.get(token);
  if (entry) {
    pending.delete(token);
    rmSync(entry.dir, { recursive: true, force: true });
  }
}

/**
 * Apply a previewed package. `overwrite` replaces locally existing skills and
 * MCP servers of the same name; the caller is expected to have confirmed that
 * explicitly.
 */
export async function applyEmployeeImport(
  token: string,
  options: EmployeeImportApplyOptions,
): Promise<EmployeeImportResult> {
  sweepPending();
  const entry = pending.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    if (entry) cancelEmployeeImport(token);
    throw new Error(t("This import has expired. Please pick the file again."));
  }

  const { manifest, skills: packages } = entry;
  const overwrite = options.overwrite === true;
  const skillsRoot = getAgentSkillsDir();
  const swapRoot = join(getAgentRoot(), SWAP_DIR, token);
  const warnings = [...manifest.warnings];

  const skillsOutcome: EmployeeImportResult["skills"] = {
    installed: [],
    overwritten: [],
    kept: [],
    skipped: [],
  };
  const mcpOutcome: EmployeeImportResult["mcp"] = {
    added: [],
    overwritten: [],
    kept: [],
    missing: [],
  };
  const secretsToFill: Record<string, string[]> = {};

  // Local state captured up front for the link lists and the rollback.
  const localServerNames = new Set(Object.keys(readMcpRawEntries()));
  const mcpSnapshot = snapshotMcpConfig();
  const createdSkillDirs: string[] = [];
  const replacedSkills: Array<{ dest: string; oldDir: string }> = [];
  let mcpTouched = false;
  let createdEmployee: Employee | null = null;

  try {
    // ---------------------------------------------------------------- skills
    mkdirSync(skillsRoot, { recursive: true });
    for (const pkg of packages) {
      if (pkg.invalidReason !== null) {
        skillsOutcome.skipped.push(pkg.name);
        warnings.push(
          t("Skill “${name}” was skipped: ${reason}", {
            name: pkg.name,
            reason: pkg.invalidReason,
          }),
        );
        continue;
      }
      const dest = join(skillsRoot, pkg.name);
      if (!existsSync(dest)) {
        // `cpSync` refuses to merge into an existing folder by default
        // (`errorOnExist`), so a race cannot silently mix two skills.
        cpSync(pkg.dir, dest, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        createdSkillDirs.push(dest);
        skillsOutcome.installed.push(pkg.name);
        continue;
      }
      if (!overwrite) {
        skillsOutcome.kept.push(pkg.name);
        continue;
      }
      // Overwrite through a swap: the new copy is completed first, then the
      // old folder is moved aside and the new one renamed into place, so a
      // failure never leaves a half-copied skill behind.
      mkdirSync(swapRoot, { recursive: true });
      const nextDir = join(swapRoot, `next-${pkg.name}`);
      const oldDir = join(swapRoot, `old-${pkg.name}`);
      rmSync(nextDir, { recursive: true, force: true });
      rmSync(oldDir, { recursive: true, force: true });
      cpSync(pkg.dir, nextDir, { recursive: true });
      renameSync(dest, oldDir);
      try {
        renameSync(nextDir, dest);
      } catch (error) {
        renameSync(oldDir, dest);
        throw error;
      }
      replacedSkills.push({ dest, oldDir });
      skillsOutcome.overwritten.push(pkg.name);
    }

    // ------------------------------------------------------------------- MCP
    const mcpResult = importMcpEntries(manifest.mcpServers, { overwrite });
    mcpTouched = true;
    mcpOutcome.added = mcpResult.added;
    mcpOutcome.overwritten = mcpResult.overwritten;
    mcpOutcome.kept = mcpResult.kept;
    for (const name of mcpResult.invalid) {
      warnings.push(
        t("MCP server “${name}” is not valid and was skipped.", { name }),
      );
    }

    // ------------------------------------------------------- link lists/员工
    const includedServers = new Set([
      ...mcpResult.added,
      ...mcpResult.overwritten,
      ...mcpResult.kept,
    ]);
    const mcpLinks: string[] = [];
    for (const name of manifest.employee.mcp) {
      if (name.startsWith(BUILTIN_MCP_MARKER_PREFIX)) {
        // Code-shipped tool markers travel as-is.
        mcpLinks.push(name);
        continue;
      }
      if (includedServers.has(name) || localServerNames.has(name)) {
        mcpLinks.push(name);
        continue;
      }
      mcpOutcome.missing.push(name);
      warnings.push(
        t(
          "MCP server “${name}” is not configured on this machine and was unlinked.",
          {
            name,
          },
        ),
      );
    }

    const availableSkills = new Set([
      ...skillsOutcome.installed,
      ...skillsOutcome.overwritten,
      ...skillsOutcome.kept,
    ]);
    const skillLinks: string[] = [];
    for (const name of manifest.employee.skills) {
      if (availableSkills.has(name)) {
        skillLinks.push(name);
        continue;
      }
      // A skill the package does not carry stays linked when *either* skills
      // root provides it (the app's own folder or the shared read-only one),
      // which is the same set the UI lists.
      if (resolveSkillDir(name) !== null) {
        skillLinks.push(name);
        continue;
      }
      warnings.push(
        t(
          "Skill “${name}” is not installed on this machine and was unlinked.",
          {
            name,
          },
        ),
      );
    }

    // --------------------------------------------------------------- modelId
    let modelId = manifest.employee.modelId;
    if (modelId !== null) {
      const available = await listAvailableModels();
      const refs = new Set(
        available.map((model) => `${model.provider}/${model.id}`),
      );
      if (!refs.has(modelId)) {
        warnings.push(
          t(
            "The model “${model}” does not exist on this machine; the employee follows the default model.",
            { model: modelId },
          ),
        );
        modelId = null;
      }
    }

    // ------------------------------------------------------------- employee
    createdEmployee = dbEmployees.createEmployee({
      name: manifest.employee.name,
      role: manifest.employee.role,
      systemPrompt: manifest.employee.systemPrompt,
      mcp: mcpLinks,
      skills: skillLinks,
      modelId,
      thinkingLevel: manifest.employee.thinkingLevel,
    });

    // --------------------------------------------------------------- avatar
    if (manifest.employee.avatar !== null) {
      applyAvatar(entry, createdEmployee.id, warnings);
      const refreshed = dbEmployees.getEmployee(createdEmployee.id);
      if (refreshed) createdEmployee = refreshed;
    }

    // Which servers still need credentials filled in (kept ones kept theirs).
    for (const name of [...mcpResult.added, ...mcpResult.overwritten]) {
      const keys = secretKeysOf(manifest.mcpServers[name]);
      if (keys.length > 0) secretsToFill[name] = keys;
    }

    sendToRenderer("employees:changed", { ids: [createdEmployee.id] });
    return {
      employee: createdEmployee,
      skills: skillsOutcome,
      mcp: mcpOutcome,
      secretsToFill,
      warnings,
    };
  } catch (error) {
    rollback({
      createdSkillDirs,
      replacedSkills,
      mcpTouched,
      mcpSnapshot,
      createdEmployeeId: createdEmployee?.id ?? null,
    });
    const message = error instanceof Error ? error.message : String(error);
    console.error("[employee-transfer] import failed:", message);
    throw new Error(
      t("The employee could not be imported (${error}).", { error: message }),
    );
  } finally {
    pending.delete(token);
    rmSync(entry.dir, { recursive: true, force: true });
    rmSync(swapRoot, { recursive: true, force: true });
  }
}

/** Undo every write performed by a failed import (best effort, in reverse). */
function rollback(state: {
  createdSkillDirs: string[];
  replacedSkills: Array<{ dest: string; oldDir: string }>;
  mcpTouched: boolean;
  mcpSnapshot: string | null;
  createdEmployeeId: number | null;
}): void {
  if (state.createdEmployeeId !== null) {
    try {
      dbEmployees.deleteEmployee(state.createdEmployeeId);
    } catch (error) {
      console.error(
        "[employee-transfer] rollback: employee delete failed",
        error,
      );
    }
  }
  if (state.mcpTouched) {
    try {
      restoreMcpConfig(state.mcpSnapshot);
    } catch (error) {
      console.error(
        "[employee-transfer] rollback: mcp.json restore failed",
        error,
      );
    }
  }
  for (const { dest, oldDir } of [...state.replacedSkills].reverse()) {
    try {
      rmSync(dest, { recursive: true, force: true });
      renameSync(oldDir, dest);
    } catch (error) {
      console.error(
        `[employee-transfer] rollback: skill restore failed for ${dest}`,
        error,
      );
    }
  }
  for (const dir of state.createdSkillDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `[employee-transfer] rollback: skill removal failed for ${dir}`,
        error,
      );
    }
  }
}

/** Write the package's avatar for a freshly created employee (never fatal). */
function applyAvatar(
  entry: PendingImport,
  employeeId: number,
  warnings: string[],
): void {
  const rel = entry.manifest.employee.avatar;
  if (rel === null) return;
  try {
    const abs = resolveInside(entry.dir, rel);
    if (!existsSync(abs)) {
      warnings.push(t("The avatar image is missing from the package."));
      return;
    }
    if (statSync(abs).size > 10 * 1024 * 1024) {
      warnings.push(t("The avatar image is too large and was not imported."));
      return;
    }
    const data = readFileSync(abs);
    const ext = detectImageExtension(data) ?? avatarExtensionOf(rel);
    if (ext === null) {
      warnings.push(
        t("The avatar format is not supported and was not imported."),
      );
      return;
    }
    const path = saveAvatar(employeeId, ext, data);
    dbEmployees.updateEmployeeAvatar(employeeId, path);
  } catch (error) {
    console.error("[employee-transfer] avatar import failed:", error);
    warnings.push(t("The avatar image could not be imported."));
  }
}

/** Group the staged `skills/<name>/…` members into skill folders. */
function collectSkillPackages(
  stagingRoot: string,
  members: Array<{ name: string; size: number }>,
): SkillPackage[] {
  const grouped = new Map<string, { files: number; bytes: number }>();
  for (const member of members) {
    const name = skillNameOfMember(member.name);
    if (name === null) continue;
    const current = grouped.get(name) ?? { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += member.size;
    grouped.set(name, current);
  }

  const packages: SkillPackage[] = [];
  for (const [name, stats] of grouped) {
    const dir = join(stagingRoot, EMPLOYEE_SKILLS_DIR, name);
    let invalidReason: string | null = null;
    if (!isValidSkillName(name)) {
      invalidReason = t("the folder name is not a valid skill name");
    } else if (!existsSync(join(dir, "SKILL.md"))) {
      invalidReason = t("the folder has no SKILL.md");
    }
    packages.push({
      name,
      dir,
      files: stats.files,
      bytes: stats.bytes,
      invalidReason,
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildPreview(args: {
  token: string;
  sourcePath: string;
  /** Folder the package was unpacked into (read-only here). */
  stagingRoot: string;
  manifest: EmployeeExportManifest;
  skills: SkillPackage[];
  expiresAt: number;
}): Promise<EmployeeImportPreview> {
  const { token, sourcePath, stagingRoot, manifest, skills, expiresAt } = args;
  const skillsRoot = getAgentSkillsDir();
  const localServers = readMcpRawEntries();

  const avatarDataUrl = readPreviewAvatar(
    stagingRoot,
    manifest.employee.avatar,
  );

  const previewSkills: EmployeeImportPreviewSkill[] = skills.map((pkg) => ({
    name: pkg.name,
    files: pkg.files,
    bytes: pkg.bytes,
    exists: existsSync(join(skillsRoot, pkg.name)),
    invalidReason: pkg.invalidReason,
  }));

  const previewMcp: EmployeeImportPreviewMcpServer[] = [];
  for (const [name, raw] of Object.entries(manifest.mcpServers)) {
    previewMcp.push({
      name,
      transport:
        typeof (raw as Record<string, unknown>)?.["command"] === "string"
          ? "stdio"
          : "http",
      target: endpointSummary(raw),
      exists: Object.prototype.hasOwnProperty.call(localServers, name),
      secretKeys: secretKeysOf(raw),
    });
  }
  previewMcp.sort((a, b) => a.name.localeCompare(b.name));

  const packageServers = new Set(Object.keys(manifest.mcpServers));
  const missingMcp: string[] = [];
  for (const name of manifest.employee.mcp) {
    if (name.startsWith(BUILTIN_MCP_MARKER_PREFIX)) continue;
    if (packageServers.has(name)) continue;
    if (Object.prototype.hasOwnProperty.call(localServers, name)) continue;
    missingMcp.push(name);
  }

  const packageSkills = new Set(
    skills.filter((pkg) => pkg.invalidReason === null).map((pkg) => pkg.name),
  );
  const missingSkills: string[] = [];
  for (const name of manifest.employee.skills) {
    if (packageSkills.has(name)) continue;
    if (resolveSkillDir(name) !== null) {
      continue;
    }
    missingSkills.push(name);
  }

  // Resolved against the local provider catalog so the dialog can say
  // "follows the default model" up front (the apply step re-checks it).
  let modelFallback: { from: string } | null = null;
  if (manifest.employee.modelId !== null) {
    const available = await listAvailableModels();
    const refs = new Set(
      available.map((model) => `${model.provider}/${model.id}`),
    );
    if (!refs.has(manifest.employee.modelId)) {
      modelFallback = { from: manifest.employee.modelId };
    }
  }

  const hasConflicts =
    previewSkills.some((skill) => skill.exists) ||
    previewMcp.some((server) => server.exists);

  return {
    token,
    sourceName: sourcePath.split(/[\\/]/).pop() ?? sourcePath,
    expiresAt,
    manifest: {
      formatVersion: manifest.formatVersion,
      appVersion: manifest.appVersion,
      createdAt: manifest.createdAt,
      platform: manifest.platform,
      sourceEmployeeId: manifest.sourceEmployeeId,
      warnings: manifest.warnings,
    },
    employee: {
      name: manifest.employee.name,
      role: manifest.employee.role,
      mcp: manifest.employee.mcp,
      skills: manifest.employee.skills,
      modelId: manifest.employee.modelId,
      thinkingLevel: manifest.employee.thinkingLevel,
      avatarDataUrl,
    },
    skills: previewSkills,
    mcpServers: previewMcp,
    missingMcp,
    missingSkills,
    modelFallback,
    hasConflicts,
  };
}

/**
 * Data URL of the package avatar for the confirmation dialog.
 *
 * Deliberately limited: the preview gets at most 2 MB of image and only the
 * MIME types the avatar store accepts, resolved from the **magic bytes** (the
 * member name is never trusted). Anything else returns `null`, and the dialog
 * falls back to the name initial. The import itself still reads the original
 * file from the staging folder, so a large avatar is not lost.
 */
function readPreviewAvatar(
  stagingRoot: string,
  rel: string | null,
): string | null {
  if (rel === null) return null;
  try {
    const abs = resolveInside(stagingRoot, rel);
    if (!existsSync(abs)) return null;
    if (statSync(abs).size > MAX_PREVIEW_AVATAR_BYTES) return null;
    const data = readFileSync(abs);
    const extension = detectImageExtension(data);
    if (extension === null) return null;
    const mime = AVATAR_MIME_TYPES[extension];
    if (mime === undefined) return null;
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

/** `env`/`headers` keys of a raw MCP entry, e.g. `env.GITHUB_TOKEN`. */
function secretKeysOf(raw: unknown): string[] {
  const entry =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const keys: string[] = [];
  for (const field of ["env", "headers"] as const) {
    const record = entry[field];
    if (
      typeof record !== "object" ||
      record === null ||
      Array.isArray(record)
    ) {
      continue;
    }
    for (const key of Object.keys(record as Record<string, unknown>)) {
      keys.push(`${field}.${key}`);
    }
  }
  return keys.sort();
}

/** Short human summary of an MCP entry: its command line or its URL. */
function endpointSummary(raw: unknown): string {
  const entry =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const command = entry["command"];
  if (typeof command === "string") {
    const args = Array.isArray(entry["args"])
      ? entry["args"].filter((arg): arg is string => typeof arg === "string")
      : [];
    return [command, ...args].join(" ").slice(0, 300);
  }
  const url = entry["url"];
  return typeof url === "string" ? url.slice(0, 300) : "";
}

/**
 * Read and validate `imboss-employee.json` from the staging folder. Values are
 * clamped to the limits the DB layer enforces (with a warning) rather than
 * letting a hostile manifest abort the import deeper in.
 */
function parseManifest(stagingRoot: string): EmployeeExportManifest {
  const abs = resolveInside(stagingRoot, EMPLOYEE_MANIFEST_PATH);
  if (!existsSync(abs)) {
    throw new Error(t("This file is not an employee export."));
  }
  if (statSync(abs).size > MAX_MANIFEST_BYTES) {
    throw new Error(
      t("The employee description inside the file is too large."),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    throw new Error(t("The file is damaged and cannot be read."));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(t("This file is not an employee export."));
  }
  const record = parsed as Record<string, unknown>;
  if (record["format"] !== EMPLOYEE_EXPORT_FORMAT) {
    throw new Error(t("This file is not an employee export."));
  }
  const formatVersion = readInt(record["formatVersion"], 0);
  if (formatVersion <= 0) {
    throw new Error(t("This file is not an employee export."));
  }
  if (formatVersion > EMPLOYEE_EXPORT_FORMAT_VERSION) {
    throw new Error(
      t("This employee export was created by a newer version of imboss."),
    );
  }

  const employeeRaw = record["employee"];
  if (
    typeof employeeRaw !== "object" ||
    employeeRaw === null ||
    Array.isArray(employeeRaw)
  ) {
    throw new Error(t("The file is damaged and cannot be read."));
  }
  const employee = employeeRaw as Record<string, unknown>;
  const warnings: string[] = readStringArray(record["warnings"]);

  const name = clampText(
    employee["name"],
    MAX_NAME_LENGTH,
    warnings,
    t("name"),
  );
  const role = clampText(
    employee["role"],
    MAX_ROLE_LENGTH,
    warnings,
    t("role"),
  );
  const systemPrompt = clampText(
    employee["systemPrompt"],
    MAX_PROMPT_LENGTH,
    warnings,
    t("system prompt"),
  );

  const avatarRaw = employee["avatar"];
  const avatar =
    typeof avatarRaw === "string" &&
    isSafeEntryPath(avatarRaw) &&
    avatarRaw.startsWith(`${EMPLOYEE_AVATAR_DIR}/`)
      ? avatarRaw
      : null;

  const mcpServersRaw = record["mcpServers"];
  const mcpServers: Record<string, unknown> = {};
  if (
    typeof mcpServersRaw === "object" &&
    mcpServersRaw !== null &&
    !Array.isArray(mcpServersRaw)
  ) {
    for (const [key, value] of Object.entries(mcpServersRaw).slice(
      0,
      MAX_MCP_SERVERS,
    )) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        continue;
      mcpServers[key] = value;
    }
  }

  const clearedSecretsRaw = record["clearedSecrets"];
  const clearedSecrets: Record<string, string[]> = {};
  if (
    typeof clearedSecretsRaw === "object" &&
    clearedSecretsRaw !== null &&
    !Array.isArray(clearedSecretsRaw)
  ) {
    for (const [key, value] of Object.entries(clearedSecretsRaw)) {
      clearedSecrets[key] = readStringArray(value);
    }
  }

  const skillsInfo = Array.isArray(record["skills"])
    ? record["skills"].flatMap((value) => {
        if (typeof value !== "object" || value === null) return [];
        const info = value as Record<string, unknown>;
        if (typeof info["name"] !== "string") return [];
        return [
          {
            name: info["name"],
            files: readInt(info["files"], 0),
            bytes: readInt(info["bytes"], 0),
          },
        ];
      })
    : [];

  const thinkingLevelRaw = employee["thinkingLevel"];
  const thinkingLevel: ThinkingLevel | null = isThinkingLevel(thinkingLevelRaw)
    ? thinkingLevelRaw
    : null;

  return {
    format: EMPLOYEE_EXPORT_FORMAT,
    formatVersion,
    appVersion: readText(record["appVersion"], 64),
    createdAt: readInt(record["createdAt"], Date.now()),
    platform: readText(record["platform"], 32),
    sourceEmployeeId: readInt(record["sourceEmployeeId"], 0),
    employee: {
      name,
      role,
      systemPrompt,
      mcp: readStringList(employee["mcp"]),
      skills: readStringList(employee["skills"]),
      modelId: readOptionalText(employee["modelId"], 256),
      thinkingLevel,
      avatar,
    },
    mcpServers,
    skills: skillsInfo,
    clearedSecrets,
    warnings,
  };
}

/** Drop expired staging copies and folders left behind by earlier runs. */
function sweepPending(): void {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.expiresAt > now) continue;
    pending.delete(token);
    rmSync(entry.dir, { recursive: true, force: true });
  }
}

/**
 * Remove staging folders whose token is no longer pending (app restart, crash,
 * an abandoned dialog). Only folders matching our prefix and older than the TTL
 * are touched, so a concurrent import is never disturbed.
 */
function sweepStaleStagingDirs(): void {
  const root = tmpdir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  const live = new Set([...pending.values()].map((entry) => entry.dir));
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const dir = join(root, name);
    if (live.has(dir)) continue;
    try {
      if (now - statSync(dir).mtimeMs < IMPORT_TTL_MS) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a folder in use (or already gone) is not an error.
    }
  }

  // Skill-swap folders can outlive a crashed import; they live outside the
  // skills root (so they never show up as skills) and are dropped here once
  // stale.
  const swapRoot = join(getAgentRoot(), SWAP_DIR);
  let swapNames: string[] = [];
  try {
    swapNames = readdirSync(swapRoot);
  } catch {
    return;
  }
  const liveTokens = new Set(pending.keys());
  for (const token of swapNames) {
    if (liveTokens.has(token)) continue;
    const dir = join(swapRoot, token);
    try {
      if (now - statSync(dir).mtimeMs < IMPORT_TTL_MS) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

function readText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readOptionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function readInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Unique, length-capped reference names (`mcp` / `skills` lists). */
function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value.slice(0, MAX_REF_ENTRIES)) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name.length === 0 || name.length > MAX_REF_LENGTH) continue;
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function clampText(
  value: unknown,
  maxLength: number,
  warnings: string[],
  field: string,
): string {
  const text = typeof value === "string" ? value : "";
  if (text.length <= maxLength) return text;
  warnings.push(
    t("The ${field} was shortened to fit the local limit.", { field }),
  );
  return text.slice(0, maxLength);
}
