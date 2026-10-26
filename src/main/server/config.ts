import { randomBytes } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { getDataRoot } from "../data-dir";

/**
 * Backend runtime configuration (`~/.imboss/server.json`, mode 0600).
 *
 * Everything a deployment needs to decide lives in the file rather than in code,
 * so a deployment never needs a rebuild for a port change. There is no
 * "unauthenticated" mode: without a token the server refuses to start.
 *
 * Token precedence (highest first): `--token` → `--token-file` → `IMBOSS_TOKEN` →
 * `IMBOSS_TOKEN_FILE` → `server.json`. The file is the documented default,
 * because a token in `argv` is visible to every local user through `ps`.
 *
 * `--init` writes a fresh file with a random token and prints it once; nothing
 * is ever generated silently, so an operator always knows where the secret is.
 */

/** Minimum accepted token length: short enough to paste, long enough to matter. */
const MIN_TOKEN_LENGTH = 16;

export interface ServerConfig {
  /** `host:port` to bind. Defaults to every interface (see the README risk note). */
  listen: string;
  /** Shared secret every request must present. Never empty. */
  token: string;
  /** Absolute data folder; defaults to `~/.imboss`. */
  dataRoot: string;
  /** Accepted and validated for forward compatibility; TLS is not served in v1. */
  tls: { cert: string; key: string } | null;
}

/** Values already taken from the CLI/environment. */
export interface ConfigOverrides {
  listen?: string;
  token?: string;
  tokenFile?: string;
  dataRoot?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

interface RawConfigFile {
  listen?: unknown;
  token?: unknown;
  tokenFile?: unknown;
  dataRoot?: unknown;
  tls?: unknown;
}

/** Where the config lives by default: next to the data folder it configures. */
export function defaultConfigPath(): string {
  return resolve(getDataRoot(), "server.json");
}

/** Resolve the data folder from overrides/environment (before reading a file). */
export function resolveDataRoot(override?: string): string {
  const env = process.env["IMBOSS_DATA_ROOT"];
  if (override !== undefined && override.trim().length > 0) {
    return resolve(override.trim());
  }
  if (env !== undefined && env.trim().length > 0) {
    return resolve(env.trim());
  }
  return resolve(getDataRoot());
}

/** Path of the config file that belongs to `dataRoot`. */
export function configPathFor(dataRoot: string, override?: string): string {
  return override !== undefined && override.trim().length > 0
    ? resolve(override.trim())
    : resolve(dataRoot, "server.json");
}

/**
 * Load and validate the configuration.
 *
 * Throws {@link ConfigError} with an actionable message for every "you cannot
 * start like this" case: unreadable/invalid file, missing token, bad listen
 * address, half-specified TLS.
 */
export function loadServerConfig(options: {
  dataRoot: string;
  path: string;
  overrides: ConfigOverrides;
}): ServerConfig {
  const { path, overrides } = options;
  const file = existsSync(path) ? readConfigFile(path) : {};

  const listen = resolveListen(
    overrides.listen ?? asString(file.listen) ?? DEFAULT_LISTEN,
  );

  const token = resolveToken({
    explicit: overrides.token,
    tokenFile: overrides.tokenFile,
    configToken: asString(file.token),
    configTokenFile: asString(file.tokenFile),
    path,
  });

  const fileDataRoot = asString(file.dataRoot);

  return {
    listen,
    token,
    // An explicit `--data-root` / environment wins over the file, so the same
    // config can be reused for a staging copy of the data folder.
    dataRoot: resolveDataRoot(overrides.dataRoot ?? fileDataRoot),
    tls: parseTls(file.tls),
  };
}

/**
 * Create the config file (mode 0600) and return the token that was written.
 *
 * Refuses to overwrite: rotating a token silently would lock out every client.
 */
export function initializeConfigFile(options: {
  path: string;
  dataRoot: string;
  listen?: string;
}): { path: string; token: string } {
  const { path, dataRoot } = options;
  if (existsSync(path)) {
    throw new ConfigError(`${path} already exists; refusing to overwrite it.`);
  }
  const token = randomToken();
  mkdirSync(dirname(path), { recursive: true });
  const body = {
    listen: resolveListen(options.listen ?? DEFAULT_LISTEN),
    token,
    dataRoot,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  hardenPermissions(path);
  return { path, token };
}

/**
 * Bind to every interface by default: the point of a remote backend is that the
 * client runs on another machine, and a loopback-only default would defeat it.
 * Protection is the token, plus a firewall or tunnel for anything public — see
 * the risk note printed at startup and in the packaged README.
 */
export const DEFAULT_LISTEN = "0.0.0.0:47810";

/** `host:port` (also accepts `[v6]:port`); throws on anything unusable. */
export function resolveListen(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) throw new ConfigError("listen address is empty.");

  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/.exec(value);
  const v4 = /^([0-9a-zA-Z.\-]*):(\d+)$/.exec(value);
  const match = v6 ?? v4;
  if (!match) {
    throw new ConfigError(
      `listen must be "host:port" (got ${JSON.stringify(raw)}).`,
    );
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`listen port is out of range (got ${match[2]}).`);
  }
  const host = match[1] ?? "";
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** A fresh 32-byte token, hex encoded (64 characters). */
export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function resolveToken(input: {
  explicit?: string;
  tokenFile?: string;
  configToken?: string;
  configTokenFile?: string;
  path: string;
}): string {
  const fromFile = (path: string, what: string): string => {
    const absolute = resolve(path);
    if (!existsSync(absolute)) {
      throw new ConfigError(`${what} does not exist: ${absolute}`);
    }
    return validateToken(readFileSync(absolute, "utf8"), what);
  };

  if (input.explicit !== undefined) {
    return validateToken(input.explicit, "--token");
  }
  if (input.tokenFile !== undefined) {
    return fromFile(input.tokenFile, "--token-file");
  }

  const envToken = process.env["IMBOSS_TOKEN"];
  if (envToken !== undefined && envToken.trim().length > 0) {
    return validateToken(envToken, "IMBOSS_TOKEN");
  }
  const envTokenFile = process.env["IMBOSS_TOKEN_FILE"];
  if (envTokenFile !== undefined && envTokenFile.trim().length > 0) {
    return fromFile(envTokenFile, "IMBOSS_TOKEN_FILE");
  }

  if (input.configToken !== undefined) {
    return validateToken(input.configToken, "server.json token");
  }
  if (input.configTokenFile !== undefined) {
    return fromFile(input.configTokenFile, "server.json tokenFile");
  }

  throw new ConfigError(
    `No token configured. Create one with "--init" (writes ${input.path}), or pass --token-file / IMBOSS_TOKEN.`,
  );
}

/** Trim surrounding whitespace (`echo > token` leaves a newline) only. */
function trimToken(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, "");
}

function validateToken(raw: string, what: string): string {
  const token = trimToken(raw);
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `${what} must be at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  if (/[\u0000-\u001f]/.test(token)) {
    throw new ConfigError(`${what} must not contain control characters.`);
  }
  return token;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseTls(value: unknown): { cert: string; key: string } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("tls must be an object with cert/key paths.");
  }
  const record = value as Record<string, unknown>;
  const cert = asString(record["cert"]);
  const key = asString(record["key"]);
  if (!cert || !key) {
    throw new ConfigError("tls requires both cert and key paths.");
  }
  for (const [name, path] of [
    ["cert", cert],
    ["key", key],
  ] as const) {
    if (!isAbsolute(path)) {
      throw new ConfigError(`tls.${name} must be an absolute path.`);
    }
    if (!existsSync(path)) {
      throw new ConfigError(`tls.${name} does not exist: ${path}`);
    }
  }
  return { cert, key };
}

function readConfigFile(path: string): RawConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object.`);
  }
  return parsed as RawConfigFile;
}

function hardenPermissions(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort hardening (mirrors `data-dir.ts`).
  }
}
