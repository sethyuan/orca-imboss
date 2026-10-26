import pkg from "../../package.json";

/**
 * The app's version, taken from `package.json`.
 *
 * Imported as JSON (both build paths inline it) rather than read at runtime:
 * the repo tree, the asar bundle and the remote zip all have different
 * `__dirname` depths, and a version lookup must never depend on that. The remote
 * backend reports this through `Info`, so a client can tell which side is older.
 */
export const APP_VERSION: string =
  typeof pkg.version === "string" && pkg.version.length > 0
    ? pkg.version
    : "0.0.0";
