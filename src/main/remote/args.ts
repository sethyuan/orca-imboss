import { readFileSync } from "fs";
import { isAbsolute, resolve } from "path";

/**
 * Desktop start-up switches that decide *where the backend is*.
 *
 * No `--remote` means today's behaviour: everything in this process over
 * Electron IPC. With `--remote`, the business layer is served by a backend and
 * this process only proxies to it (see `remote/shell.ts`).
 *
 * Token sources, in order of preference:
 * - `--remote-token-file=<path>` (default; a token in `argv` is visible to every
 *   local user through `ps` and lands in crash reports),
 * - `--remote-token-env=NAME` (containers, CI, shells that already export it),
 * - `--remote-token=<raw>` (kept for quick debugging; logs a warning).
 */

const MIN_TOKEN_LENGTH = 16;

export interface RemoteOptions {
  /** `host:port` of the backend. */
  target: string;
  /** Shared secret; stays in this process, never reaches the renderer. */
  token: string;
  /** Where the token came from (for the startup log only). */
  tokenSource: string;
}

/** Thrown for a `--remote` setup that cannot work; the caller shows it. */
export class RemoteArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteArgsError";
  }
}

/** `null` when the app should run fully locally. */
export function parseRemoteArgs(argv: string[]): RemoteOptions | null {
  const target = readArg(argv, "remote");
  if (target === null || target.trim().length === 0) {
    // A token without a target is almost certainly a typo; refuse rather than
    // silently starting in local mode (which would look like "nothing happened").
    const stray = [
      "remote-token",
      "remote-token-file",
      "remote-token-env",
    ].filter((name) => readArg(argv, name) !== null);
    if (stray.length > 0) {
      throw new RemoteArgsError(
        `--${stray[0]} needs --remote=<host:port> to have any effect.`,
      );
    }
    return null;
  }

  const resolved = resolveToken(argv);

  if (readArg(argv, "remote-ca") !== null) {
    console.warn(
      "[remote] --remote-ca is accepted but ignored: this build speaks plaintext gRPC.",
    );
  }
  if (readArg(argv, "remote-insecure") !== null) {
    console.warn(
      "[remote] TLS is not served by this backend version; the token is the only protection.",
    );
  }

  return {
    target: normalizeTarget(target),
    token: resolved.token,
    tokenSource: resolved.source,
  };
}

function resolveToken(argv: string[]): { token: string; source: string } {
  const explicit = readArg(argv, "remote-token");
  const tokenFile = readArg(argv, "remote-token-file");
  const tokenEnv = readArg(argv, "remote-token-env");

  if (tokenFile !== null) {
    const path = isAbsolute(tokenFile) ? tokenFile : resolve(tokenFile);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      throw new RemoteArgsError(
        `--remote-token-file could not be read (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { token: validateToken(raw), source: `file ${path}` };
  }

  if (tokenEnv !== null) {
    const value = process.env[tokenEnv];
    if (value === undefined || value.trim().length === 0) {
      throw new RemoteArgsError(
        `--remote-token-env=${tokenEnv} is empty or unset in this environment.`,
      );
    }
    return { token: validateToken(value), source: `env ${tokenEnv}` };
  }

  if (explicit !== null) {
    console.warn(
      "[remote] --remote-token is visible in the process list; prefer --remote-token-file.",
    );
    return { token: validateToken(explicit), source: "--remote-token" };
  }

  throw new RemoteArgsError(
    "--remote needs a token: pass --remote-token-file=<path> (recommended), --remote-token-env=<NAME>, or --remote-token=<token>.",
  );
}

function validateToken(raw: string): string {
  const token = raw.replace(/^\s+|\s+$/g, "");
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new RemoteArgsError(
      `The remote token must be at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  if (/[\u0000-\u001f]/.test(token)) {
    throw new RemoteArgsError(
      "The remote token must not contain control characters.",
    );
  }
  return token;
}

/** Accept `host:port`, `[v6]:port` and the `host/port` form Electron passes. */
function normalizeTarget(raw: string): string {
  const value = raw.trim();
  const match =
    /^\[([0-9a-fA-F:.]+)\]:(\d+)$/.exec(value) ??
    /^([a-zA-Z0-9._\-]+):(\d+)$/.exec(value);
  if (!match) {
    throw new RemoteArgsError(
      `--remote must be "host:port" (got ${JSON.stringify(raw)}).`,
    );
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RemoteArgsError(
      `--remote port is out of range (got ${match[2]}).`,
    );
  }
  return match[1].includes(":")
    ? `[${match[1]}]:${port}`
    : `${match[1]}:${port}`;
}

/** `--name=value` on the raw argv (`process.argv` includes the executable). */
function readArg(argv: string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (const entry of argv) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return null;
}
