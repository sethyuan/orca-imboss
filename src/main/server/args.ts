/**
 * Command-line parsing for the headless backend.
 *
 * Hand-rolled (not `node:util.parseArgs`) because the app ships as a bundle
 * whose only required argument shape is "a handful of `--name value` /
 * `--name=value` / `--flag` pairs", and an unknown option must be a hard error:
 * a typo such as `--prot 8080` silently binding the default port would be worse
 * than refusing to start.
 */

export interface ServerArgs {
  help: boolean;
  version: boolean;
  init: boolean;
  config?: string;
  dataRoot?: string;
  listen?: string;
  token?: string;
  tokenFile?: string;
}

const FLAGS = new Set(["help", "version", "init"]);
const VALUED = new Set([
  "config",
  "data-root",
  "listen",
  "token",
  "token-file",
]);

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export function parseServerArgs(argv: string[]): ServerArgs {
  const args: ServerArgs = { help: false, version: false, init: false };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) {
      throw new ArgsError(`unexpected argument: ${raw}`);
    }

    const withoutDashes = raw.slice(2);
    const equals = withoutDashes.indexOf("=");
    const name = equals >= 0 ? withoutDashes.slice(0, equals) : withoutDashes;
    const inlineValue =
      equals >= 0 ? withoutDashes.slice(equals + 1) : undefined;

    if (!FLAGS.has(name) && !VALUED.has(name)) {
      throw new ArgsError(`unknown option: --${name}`);
    }
    if (FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        throw new ArgsError(`--${name} does not take a value`);
      }
      if (name === "help") args.help = true;
      if (name === "version") args.version = true;
      if (name === "init") args.init = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined) {
        throw new ArgsError(`--${name} needs a value`);
      }
    }
    if (value.length === 0) {
      throw new ArgsError(`--${name} needs a non-empty value`);
    }

    switch (name) {
      case "config":
        args.config = value;
        break;
      case "data-root":
        args.dataRoot = value;
        break;
      case "listen":
        args.listen = value;
        break;
      case "token":
        args.token = value;
        console.warn(
          "[server] --token puts the secret in the process list; prefer --token-file.",
        );
        break;
      case "token-file":
        args.tokenFile = value;
        break;
    }
  }

  return args;
}
