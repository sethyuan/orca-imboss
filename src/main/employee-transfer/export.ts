import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { join } from "path";
import { ASSISTANT_ID } from "@shared/constants/employees";
import {
  BUILTIN_MCP_MARKER_PREFIX,
  EMPLOYEE_AVATAR_DIR,
  EMPLOYEE_EXPORT_FORMAT,
  EMPLOYEE_EXPORT_FORMAT_VERSION,
  EMPLOYEE_MANIFEST_PATH,
  EMPLOYEE_SKILLS_DIR,
} from "@shared/constants/employee_transfer";
import { t } from "@shared/l10n";
import type {
  Employee,
  EmployeeExportManifest,
  EmployeeExportRecord,
  EmployeeExportResult,
  EmployeeExportSkillInfo,
} from "@shared/types";
import { isValidSkillName } from "../agent/skills";
import { getAgentSkillsDir } from "../data-dir";
import { readMcpRawEntries } from "../mcp-store";
import { getAppInfo } from "../platform";
import { writeZipArchive, type ZipWriteEntry } from "./archive";
import {
  avatarExtensionOf,
  detectImageExtension,
  isSafeEntryPath,
  sanitizeFileNamePart,
} from "./paths";

/**
 * Employee → zip. The package carries the employee's own fields, the
 * `mcp.json` entries of the servers it links (credential **values** blanked,
 * keys kept) and the folders of the skills it links.
 *
 * Nothing else travels: no conversations, no cron jobs, no provider
 * credentials. The archive is written under `<destination>.partial` and only
 * renamed into place once complete, so an interrupted export never leaves a
 * half-written file under the chosen name.
 */

/** Refuse to build absurdly large packages; a skill folder is not a data dump. */
const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
/** Mirror of the avatar store's cap (`src/main/avatars.ts`). */
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

/** Suggested file name: `imboss-employee-<name>-YYYYMMDD-HHmm.zip`. */
export function defaultEmployeeExportFileName(employee: Employee): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const name = sanitizeFileNamePart(employee.name, "employee");
  return `imboss-employee-${name}-${date}-${time}.zip`;
}

/** Assemble the archive payload of one employee (no filesystem writes). */
function buildExportPayload(employee: Employee): {
  entries: ZipWriteEntry[];
  manifest: EmployeeExportManifest;
} {
  if (employee.id === ASSISTANT_ID) {
    throw new Error(t("The built-in assistant cannot be exported."));
  }

  const warnings: string[] = [];
  const sourceEmployeeId = employee.id;

  // --- MCP servers the employee links ------------------------------------
  const localServers = readMcpRawEntries();
  const mcpServers: Record<string, unknown> = {};
  const clearedSecrets: Record<string, string[]> = {};
  const includedMcp: string[] = [];
  for (const name of employee.mcp) {
    // `builtin:*` markers are code-shipped tools, not mcp.json entries.
    if (name.startsWith(BUILTIN_MCP_MARKER_PREFIX)) continue;
    if (!Object.prototype.hasOwnProperty.call(localServers, name)) {
      warnings.push(
        t(
          "MCP server “${name}” is linked but not configured; it was skipped.",
          {
            name,
          },
        ),
      );
      continue;
    }
    const { entry, cleared } = stripMcpSecrets(localServers[name]);
    mcpServers[name] = entry;
    clearedSecrets[name] = cleared;
    includedMcp.push(name);
  }

  // --- Skill folders ------------------------------------------------------
  const skillsRoot = getAgentSkillsDir();
  const entries: ZipWriteEntry[] = [];
  const skills: EmployeeExportSkillInfo[] = [];
  const includedSkills: string[] = [];
  let totalBytes = 0;
  for (const name of employee.skills) {
    if (!isValidSkillName(name)) {
      warnings.push(
        t("Skill “${name}” has an invalid name; it was skipped.", { name }),
      );
      continue;
    }
    const dir = join(skillsRoot, name);
    if (!existsSync(join(dir, "SKILL.md"))) {
      warnings.push(
        t("Skill “${name}” is linked but not installed; it was skipped.", {
          name,
        }),
      );
      continue;
    }
    const files: Array<{ rel: string; abs: string; bytes: number }> = [];
    walkSkillDir(dir, "", files);
    let skillBytes = 0;
    let skippedFiles = 0;
    for (const file of files) {
      const memberName = `${EMPLOYEE_SKILLS_DIR}/${name}/${file.rel}`;
      // The importer rejects non-portable member names; skip them here (with a
      // warning) instead of exporting a package we would refuse to read.
      if (!isSafeEntryPath(memberName)) {
        skippedFiles += 1;
        continue;
      }
      totalBytes += file.bytes;
      skillBytes += file.bytes;
      if (totalBytes > MAX_EXPORT_BYTES) {
        throw new Error(
          t("This employee's skills are too large to export (max ${size}).", {
            size: formatBytes(MAX_EXPORT_BYTES),
          }),
        );
      }
      entries.push({ name: memberName, data: readFileSync(file.abs) });
    }
    if (skippedFiles > 0) {
      warnings.push(
        t(
          "${count} file(s) of skill “${name}” have names that cannot be exported and were skipped.",
          {
            count: String(skippedFiles),
            name,
          },
        ),
      );
    }
    if (files.length === 0 || files.length === skippedFiles) {
      warnings.push(
        t("Skill “${name}” has no exportable files; it was skipped.", { name }),
      );
      continue;
    }
    skills.push({
      name,
      files: files.length - skippedFiles,
      bytes: skillBytes,
    });
    includedSkills.push(name);
  }

  // --- Avatar (machine-local path → archive bytes) ------------------------
  let avatarRel: string | null = null;
  if (employee.avatar) {
    try {
      const stat = statSync(employee.avatar);
      if (stat.size > MAX_AVATAR_BYTES) {
        warnings.push(t("The avatar is too large and was not exported."));
      } else {
        const data = readFileSync(employee.avatar);
        const ext =
          detectImageExtension(data) ??
          avatarExtensionOf(employee.avatar) ??
          null;
        if (ext === null) {
          warnings.push(
            t("The avatar format is not supported and was not exported."),
          );
        } else {
          avatarRel = `${EMPLOYEE_AVATAR_DIR}/avatar.${ext}`;
          entries.push({ name: avatarRel, data });
        }
      }
    } catch {
      warnings.push(
        t("The avatar file could not be read and was not exported."),
      );
    }
  }

  const record: EmployeeExportRecord = {
    name: employee.name,
    role: employee.role,
    systemPrompt: employee.systemPrompt,
    mcp: [...employee.mcp],
    skills: [...employee.skills],
    modelId: employee.modelId,
    thinkingLevel: employee.thinkingLevel,
    avatar: avatarRel,
  };

  const manifest: EmployeeExportManifest = {
    format: EMPLOYEE_EXPORT_FORMAT,
    formatVersion: EMPLOYEE_EXPORT_FORMAT_VERSION,
    appVersion: getAppInfo().getVersion(),
    createdAt: Date.now(),
    platform: process.platform,
    sourceEmployeeId,
    employee: record,
    mcpServers,
    skills,
    clearedSecrets,
    warnings,
  };

  // The manifest is written first so a package is parseable from the start.
  entries.unshift({
    name: EMPLOYEE_MANIFEST_PATH,
    data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  return { entries, manifest };
}

/** Write the package of `employee` to `destination`. */
export async function exportEmployeeToFile(
  employee: Employee,
  destination: string,
): Promise<EmployeeExportResult> {
  const { entries, manifest } = buildExportPayload(employee);
  const partial = `${destination}.partial`;
  rmSync(partial, { force: true });
  try {
    await writeZipArchive(partial, entries);
  } catch (error) {
    rmSync(partial, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    console.error("[employee-transfer] export failed:", message);
    throw new Error(
      t("The employee could not be exported (${error}).", { error: message }),
    );
  }
  renameSync(partial, destination);

  const bytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  return {
    path: destination,
    sizeBytes: statSync(destination).size,
    files: entries.length,
    bytes,
    included: {
      mcp: Object.keys(manifest.mcpServers),
      skills: manifest.skills.map((skill) => skill.name),
    },
    clearedSecrets: manifest.clearedSecrets,
    warnings: manifest.warnings,
  };
}

/**
 * Copy a raw `mcp.json` entry with `env`/`headers` **values** replaced by empty
 * strings. Keys survive so the importer can tell the user exactly what to fill
 * in; everything else (command, args, url, description, unknown fields) is
 * kept verbatim.
 */
function stripMcpSecrets(raw: unknown): {
  entry: Record<string, unknown>;
  cleared: string[];
} {
  const source =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const entry: Record<string, unknown> = { ...source };
  const cleared: string[] = [];
  for (const field of ["env", "headers"] as const) {
    const record = source[field];
    if (
      typeof record !== "object" ||
      record === null ||
      Array.isArray(record)
    ) {
      continue;
    }
    const blanked: Record<string, string> = {};
    for (const key of Object.keys(record as Record<string, unknown>)) {
      blanked[key] = "";
      cleared.push(`${field}.${key}`);
    }
    entry[field] = blanked;
  }
  return { entry, cleared };
}

/**
 * Recursively collect a skill folder's files. Symbolic links are skipped: a
 * link can point outside the skills folder (or loop), and an export must never
 * pull in unrelated data.
 */
function walkSkillDir(
  absDir: string,
  relDir: string,
  out: Array<{ rel: string; abs: string; bytes: number }>,
): void {
  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = join(absDir, name);
    const rel = relDir.length === 0 ? name : `${relDir}/${name}`;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkSkillDir(abs, rel, out);
    } else if (stat.isFile()) {
      out.push({ rel, abs, bytes: stat.size });
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
