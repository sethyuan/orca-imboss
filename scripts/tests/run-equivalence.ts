#!/usr/bin/env node
/**
 * Run the headless equivalence harness (`scripts/tests/equivalence-harness.ts`).
 *
 * The harness has to be *bundled* before it can run: the app sources use
 * extensionless ESM imports and the `@shared` alias, neither of which plain Node
 * resolves. Bundling it here — with the same externals and the same
 * "no Electron" guard as `scripts/build-remote-backend.ts` — keeps the check
 * honest: it exercises exactly the code the packaged backend ships.
 *
 * Usage:
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     scripts/tests/run-equivalence.ts [--suite handlers|events|transfer|all] [--keep]
 *
 * Exit code 0 = every check passed.
 */

import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT_DIR = join(ROOT, "dist-remote");
const HARNESS_ENTRY = join(ROOT, "scripts/tests/equivalence-harness.ts");
const BUNDLE = join(OUT_DIR, "equivalence-harness.cjs");

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "all" },
    keep: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (
  !["all", "handlers", "events", "transfer"].includes(values.suite as string)
) {
  console.error(`unknown --suite: ${String(values.suite)}`);
  process.exitCode = 2;
  process.exit();
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

main().catch((error: unknown) => {
  console.error(
    `\n[equivalence] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (!existsSync(HARNESS_ENTRY)) {
    throw new Error(`harness not found: ${HARNESS_ENTRY}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  await build({
    entryPoints: [HARNESS_ENTRY],
    outfile: BUNDLE,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: false,
    logLevel: "warning",
    external: Object.keys(pkg.dependencies ?? {}),
    alias: { "@shared": join(ROOT, "src/shared") },
    plugins: [rawTextPlugin(), forbidElectronPlugin()],
  });

  const code = await run([BUNDLE, "--suite", values.suite as string]);

  if (!values.keep) rmSync(BUNDLE, { force: true });
  process.exitCode = code;
}

function run(argv: string[]): Promise<number> {
  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Same `?raw` support the remote build uses (see the note there). */
function rawTextPlugin(): import("esbuild").Plugin {
  return {
    name: "raw-text",
    setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
        namespace: "raw-text",
      }));
      builder.onLoad({ filter: /.*/, namespace: "raw-text" }, (args) => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, "utf8"))};`,
        loader: "js",
      }));
    },
  };
}

/** The harness proves a *headless* property; Electron must not sneak in. */
function forbidElectronPlugin(): import("esbuild").Plugin {
  return {
    name: "forbid-electron",
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, (args) => ({
        errors: [
          {
            text: `"${relative(ROOT, args.importer)}" imports Electron; the equivalence harness must run headless.`,
          },
        ],
      }));
    },
  };
}
