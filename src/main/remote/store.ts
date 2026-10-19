import { getRemoteAgentsPath } from "../data-dir";

/**
 * Persistence for remote A2A secrets, in both directions.
 *
 * Lives in a dedicated 0600 `~/.imboss/remote-agents.json` (atomic temp-file +
 * rename), deliberately separate from the database and the CSV-exported
 * `settings` table so bearer tokens are never included in an export. Tokens are
 * stored in the clear because they must be readable back: the UI shows an
 * inbound token so the boss can hand it to a partner, and rotating it means
 * seeing what it is now. Only the main process ever reads this file.
 */

interface RemoteSecretsFile {
  /** Bearer tokens we send, keyed by remote agent id (as a string). */
  tokens?: Record<string, string>;
  /** Bearer tokens partners send us, keyed by remote caller id (as a string). */
  inbound?: Record<string, string>;
}

let cache: RemoteSecretsFile | null = null;

/** Read the secrets file once, then serve the cached object. */
export async function loadRemoteAgentSecrets(): Promise<void> {
  if (cache) return;
  cache = await readFileSafe(getRemoteAgentsPath());
}

/** Stored bearer token for a peer, or null when it has none. */
export function tokenFor(id: number): string | null {
  return readToken(cache?.tokens, id);
}

/** Set (or clear, with `null`/empty) a peer's bearer token and persist. */
export async function setToken(
  id: number,
  token: string | null,
): Promise<void> {
  cache ??= {};
  cache.tokens = applyToken(cache.tokens, id, token);
  await writeFileAtomic(getRemoteAgentsPath(), cache);
}

/** Bearer token issued to an inbound caller, or null when it has none. */
export function callerTokenFor(id: number): string | null {
  return readToken(cache?.inbound, id);
}

/** Set (or clear) an inbound caller's bearer token and persist. */
export async function setCallerToken(
  id: number,
  token: string | null,
): Promise<void> {
  cache ??= {};
  cache.inbound = applyToken(cache.inbound, id, token);
  await writeFileAtomic(getRemoteAgentsPath(), cache);
}

/**
 * The caller a presented token belongs to, or null. Comparison is exact: a
 * token is a secret, not a username, so there is nothing to normalize.
 */
export function callerIdForToken(token: string): number | null {
  if (token.length === 0) return null;
  for (const [key, value] of Object.entries(cache?.inbound ?? {})) {
    if (value !== token) continue;
    const id = Number(key);
    if (Number.isSafeInteger(id)) return id;
  }
  return null;
}

function readToken(
  map: Record<string, string> | undefined,
  id: number,
): string | null {
  const value = map?.[String(id)];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function applyToken(
  map: Record<string, string> | undefined,
  id: number,
  token: string | null,
): Record<string, string> {
  const next = { ...(map ?? {}) };
  if (token === null || token.length === 0) {
    delete next[String(id)];
  } else {
    next[String(id)] = token;
  }
  return next;
}

async function readFileSafe(filePath: string): Promise<RemoteSecretsFile> {
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
function sanitize(value: unknown): RemoteSecretsFile {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: RemoteSecretsFile = {};
  const tokens = sanitizeMap(record["tokens"]);
  if (tokens) out.tokens = tokens;
  const inbound = sanitizeMap(record["inbound"]);
  if (inbound) out.inbound = inbound;
  return out;
}

function sanitizeMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.length > 0) out[key] = raw;
  }
  return out;
}
