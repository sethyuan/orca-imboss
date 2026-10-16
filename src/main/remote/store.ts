import { getRemoteAgentsPath } from "../data-dir";

/**
 * Persistence for remote A2A peer secrets.
 *
 * Lives in a dedicated 0600 `~/.imboss/remote-agents.json` (atomic temp-file +
 * rename), deliberately separate from the database and the CSV-exported
 * `settings` table so peer bearer tokens are never included in an export.
 * Only the main process ever reads this file.
 */

interface RemoteAgentSecretsFile {
  /** Bearer tokens keyed by remote agent id (as a string). */
  tokens?: Record<string, string>;
}

let cache: RemoteAgentSecretsFile | null = null;

/** Read the secrets file once, then serve the cached object. */
export async function loadRemoteAgentSecrets(): Promise<void> {
  if (cache) return;
  cache = await readFileSafe(getRemoteAgentsPath());
}

/** Stored bearer token for a peer, or null when it has none. */
export function tokenFor(id: number): string | null {
  const value = cache?.tokens?.[String(id)];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Set (or clear, with `null`/empty) a peer's bearer token and persist. */
export async function setToken(
  id: number,
  token: string | null,
): Promise<void> {
  cache ??= {};
  const tokens = (cache.tokens ??= {});
  if (token === null || token.length === 0) {
    delete tokens[String(id)];
  } else {
    tokens[String(id)] = token;
  }
  await writeFileAtomic(getRemoteAgentsPath(), cache);
}

async function readFileSafe(filePath: string): Promise<RemoteAgentSecretsFile> {
  const { readFile, stat } = await import("fs/promises");
  try {
    await stat(filePath);
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return sanitize(parsed);
  } catch {
    // A corrupt secrets file must never brick the feature; treat as empty and
    // let the next write recreate it.
    return {};
  }
}

async function writeFileAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const { writeFile, rename, chmod } = await import("fs/promises");
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, filePath);
  if (process.platform !== "win32") {
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Best-effort hardening only.
    }
  }
}

/** Defensive shape check: keep only string token values. */
function sanitize(value: unknown): RemoteAgentSecretsFile {
  if (typeof value !== "object" || value === null) return {};
  const tokens = (value as Record<string, unknown>)["tokens"];
  if (typeof tokens !== "object" || tokens === null) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.length > 0) out[key] = raw;
  }
  return { tokens: out };
}
