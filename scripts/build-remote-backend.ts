#!/usr/bin/env node
/**
 * Build the headless remote backend and pack it as a zip.
 *
 * Output (`dist/imboss-backend-<version>.zip`):
 *
 * ```
 * imboss-backend-<version>/
 *   main.cjs                    # bundled backend (no Electron, no sources)
 *   main.cjs.map
 *   package.json                # runtime dependencies only, no postinstall
 *   proto/imboss.proto          # the wire contract, for reference/other clients
 *   README.md                   # install / run / upgrade / risk notes
 *   imboss-server.example.json  # config template
 *   systemd/imboss-backend.service
 * ```
 *
 * Deliberate choices (see `.pi/facts/grpc-remote-backend-research.md` §5):
 * - **No `node_modules` in the zip.** The deployment installs its own, which is
 *   the only way a native dependency (`better-sqlite3`) can match the target
 *   platform. `better-sqlite3@13` ships prebuilds for the common platforms, so
 *   `npm install` needs no compiler there.
 * - **Our code is bundled, dependencies stay external** — the same policy as
 *   `electron.vite.config.ts` (`externalizeDeps`), so behaviour and
 *   troubleshooting match the desktop build.
 * - **`package.json` is generated, not copied.** The repo's own `postinstall`
 *   runs `electron-builder install-app-deps`, which would fail on a server.
 * - **Electron is a build error, not a runtime surprise**: a plugin rejects any
 *   `import … from "electron"` reachable from the server entry, and the bundle
 *   text is scanned afterwards as a second guard.
 *
 * Usage:
 *   node scripts/build-remote-backend.ts            # build + zip
 *   node scripts/build-remote-backend.ts --no-zip   # build the folder only
 */

import { build } from "esbuild";
import { zipSync } from "fflate";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "dist-remote");
const ZIP_DIR = join(ROOT, "dist");
const SERVER_ENTRY = join(ROOT, "src/main/server/main.ts");
const PROTO_FILE = join(ROOT, "src/main/rpc/imboss.proto");

/** Dependencies the backend genuinely needs at runtime. */
const EXCLUDED_DEPENDENCIES = new Set([
  // Electron-only: there is no app to update on a headless backend.
  "electron-updater",
]);

const { values: options } = parseArgs({
  options: { "no-zip": { type: "boolean", default: false } },
  allowPositionals: true,
});

interface PackageJson {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as PackageJson;
const version = pkg.version ?? "0.0.0";
const runtimeDependencies: Record<string, string> = {};
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (EXCLUDED_DEPENDENCIES.has(name)) continue;
  runtimeDependencies[name] = range;
}

main().catch((error: unknown) => {
  console.error(
    `[build:remote] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`server entry not found: ${SERVER_ENTRY}`);
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  await bundle();
  assertNoElectron();
  writePackageJson();
  writeProto();
  writeExampleConfig();
  writeReadme();
  writeServiceUnit();

  const folderBytes = directorySize(OUT_DIR);
  console.log(
    `[build:remote] backend v${version} → ${relative(ROOT, OUT_DIR)} (${formatBytes(folderBytes)})`,
  );

  if (options["no-zip"]) return;
  const zipPath = writeZip(version);
  console.log(
    `[build:remote] packed ${relative(ROOT, zipPath)} (${formatBytes(statSync(zipPath).size)})`,
  );
  console.log(
    "[build:remote] deploy: unzip → npm install --omit=dev → node main.cjs --init → node main.cjs",
  );
}

async function bundle(): Promise<void> {
  const result = await build({
    entryPoints: [SERVER_ENTRY],
    outfile: join(OUT_DIR, "main.cjs"),
    bundle: true,
    platform: "node",
    // Electron 44 ships Node 22; the remote box may be newer (better-sqlite3 and
    // undici both require >= 22).
    target: "node22",
    format: "cjs",
    // Keep the bundle readable: a stack trace in a support log is worth more
    // than a few hundred kilobytes.
    minify: false,
    sourcemap: true,
    legalComments: "none",
    logLevel: "warning",
    metafile: true,
    // Same policy as the desktop build: our sources are bundled, third-party
    // packages are resolved at runtime from the deployment's node_modules.
    external: Object.keys(runtimeDependencies),
    alias: { "@shared": join(ROOT, "src/shared") },
    plugins: [rawTextPlugin(), forbidElectronPlugin()],
  });

  const warnings = result.warnings ?? [];
  for (const warning of warnings) {
    console.warn(`[build:remote] esbuild: ${warning.text}`);
  }
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  console.log(
    `[build:remote] bundled ${inputs.length} source files, ${Object.keys(runtimeDependencies).length} runtime deps external`,
  );
}

/**
 * `import proto from "./imboss.proto?raw"`.
 *
 * Vite supports `?raw` natively (the desktop build uses it); esbuild does not, so
 * the same suffix is handled here instead of duplicating the contract in a `.ts`
 * template string.
 */
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

/** The backend must never reach Electron; fail the build, not the deployment. */
function forbidElectronPlugin(): import("esbuild").Plugin {
  return {
    name: "forbid-electron",
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, (args) => ({
        errors: [
          {
            text: `"${relative(ROOT, args.importer)}" imports Electron, which the remote backend cannot use. Move the Electron call behind src/main/platform.`,
          },
        ],
      }));
    },
  };
}

/** Second guard: the emitted bundle must not contain a runtime Electron import. */
function assertNoElectron(): void {
  const bundlePath = join(OUT_DIR, "main.cjs");
  const text = readFileSync(bundlePath, "utf8");
  const match = /require\("electron"\)/.exec(text);
  if (match) {
    const index = Math.max(0, match.index - 200);
    throw new Error(
      `the bundle still requires Electron near:\n…${text.slice(index, match.index + 40)}…`,
    );
  }
  // `require("electron-updater")` would pull the whole updater stack in.
  if (/require\("electron-updater"\)/.test(text)) {
    throw new Error("the bundle still requires electron-updater.");
  }
}

function writePackageJson(): void {
  const body = {
    name: "imboss-backend",
    version,
    private: true,
    description: "imboss headless backend (gRPC)",
    main: "main.cjs",
    license: "SEE LICENSE IN LICENSE",
    engines: { node: ">=22" },
    // NO scripts section: a `postinstall` here would run on the server and the
    // repo's one (`electron-builder install-app-deps`) cannot work there.
    dependencies: runtimeDependencies,
  };
  writeFileSync(
    join(OUT_DIR, "package.json"),
    `${JSON.stringify(body, null, 2)}\n`,
  );
}

function writeProto(): void {
  if (!existsSync(PROTO_FILE)) {
    throw new Error(`missing proto contract: ${PROTO_FILE}`);
  }
  mkdirSync(join(OUT_DIR, "proto"), { recursive: true });
  writeFileSync(
    join(OUT_DIR, "proto/imboss.proto"),
    readFileSync(PROTO_FILE, "utf8"),
  );
}

function writeExampleConfig(): void {
  const body = {
    listen: "0.0.0.0:47810",
    token: "<run `node main.cjs --init` to generate server.json with a token>",
    dataRoot: "~/.imboss",
  };
  writeFileSync(
    join(OUT_DIR, "imboss-server.example.json"),
    `${JSON.stringify(body, null, 2)}\n`,
  );
}

function writeReadme(): void {
  writeFileSync(join(OUT_DIR, "README.md"), readme(version));
}

function writeServiceUnit(): void {
  mkdirSync(join(OUT_DIR, "systemd"), { recursive: true });
  writeFileSync(
    join(OUT_DIR, "systemd/imboss-backend.service"),
    `[Unit]
Description=imboss backend (gRPC)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Adjust User / paths to the deployment.
User=imboss
WorkingDirectory=/opt/imboss-backend
ExecStart=/usr/bin/node /opt/imboss-backend/main.cjs
# A staged backup restore makes the backend exit on purpose; always bring it back.
Restart=always
RestartSec=2
StateDirectory=.imboss

[Install]
WantedBy=multi-user.target
`,
  );
}

/** Depth-first file map of the staging folder, ready for `zipSync`. */
function writeZip(versionTag: string): string {
  const files: Record<string, Uint8Array> = {};
  const prefix = `imboss-backend-${versionTag}`;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const name = `${prefix}/${relative(OUT_DIR, absolute).split(sep).join("/")}`;
      files[name] = readFileSync(absolute);
    }
  };
  walk(OUT_DIR);

  const zipped = zipSync(files, { level: 9 });
  mkdirSync(ZIP_DIR, { recursive: true });
  const zipPath = join(ZIP_DIR, `imboss-backend-${versionTag}.zip`);
  writeFileSync(zipPath, zipped);
  return zipPath;
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    total += entry.isDirectory()
      ? directorySize(absolute)
      : statSync(absolute).size;
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readme(versionTag: string): string {
  return `# imboss backend ${versionTag}

Headless backend for imboss: the same data layer, agent runtime, cron, IM
integrations, Mini Apps and backups the desktop app uses, served over gRPC so a
desktop app on another machine can drive it.

## Requirements

- Node.js >= 22 (24 LTS recommended)
- A writable data folder (default \`~/.imboss\`)
- **A supervisor** (systemd / pm2): a staged backup restore restarts the process,
  and in remote mode the desktop app expects the backend to come back.

## Install

\`\`\`bash
unzip imboss-backend-${versionTag}.zip
cd imboss-backend-${versionTag}
npm install --omit=dev
node main.cjs --init          # creates ~/.imboss/server.json and prints the token
\`\`\`

\`--init\` prints the token **once**. Store it where the desktop app can read it
(see below); \`server.json\` is created with mode 0600 and is never overwritten.

\`better-sqlite3\` ships prebuilt binaries for linux-x64/arm64, linux-musl,
darwin-x64/arm64 and win32-x64/arm64, so no compiler is needed there. On an
unusual platform (e.g. armv7) run \`npm rebuild better-sqlite3\` with
\`python3\`, \`make\` and a C++ toolchain installed.

## Run

\`\`\`bash
node main.cjs                 # reads ~/.imboss/server.json
node main.cjs --help
\`\`\`

Flags (all optional):

| Flag | Meaning |
| --- | --- |
| \`--config <path>\` | config file (default: \`<data-root>/server.json\`) |
| \`--data-root <path>\` | data folder (default: \`~/.imboss\`) |
| \`--listen <host:port>\` | bind address (default: \`0.0.0.0:47810\`) |
| \`--token-file <path>\` | read the token from a file |
| \`--token <token>\` | inline token — **debugging only**, visible in \`ps\` |
| \`--init\` | create the config + token |
| \`--version\`, \`--help\` | — |

The token can also come from \`IMBOSS_TOKEN\` / \`IMBOSS_TOKEN_FILE\`.

## Security — read this

- **The transport is plaintext gRPC.** TLS is not served in this version. The
  shared token is the only authentication, and it is sent on every request.
- **The default bind address is \`0.0.0.0\`**, because a remote backend is
  pointless if only localhost can reach it. That means anyone who can reach the
  port can attempt requests, and anyone who learns the token owns every
  conversation in the data folder.
- Recommended deployments, in order: a private network (Tailscale / WireGuard),
  an SSH tunnel (\`ssh -L 47810:127.0.0.1:47810 host\` with \`--listen
  127.0.0.1:47810\` on the server), or a firewall that admits only your IP.
  Do not port-forward it to the open internet.
- Rotate the token by editing \`server.json\` (or its token file) and restarting
  the backend; clients use the new value on their next launch.

## Connect the desktop app

On the client machine, start imboss with:

\`\`\`bash
imboss --remote=<host>:47810 --remote-token-file=/path/to/token
\`\`\`

| Flag | Meaning |
| --- | --- |
| \`--remote=<host:port>\` | enable remote mode; without it the app stays fully local |
| \`--remote-token-file=<path>\` | recommended |
| \`--remote-token-env=<NAME>\` | read the token from an environment variable |
| \`--remote-token=<token>\` | debugging only: visible in the process list |

No \`--remote\` flag → the app behaves exactly as before (local data folder, no
network).

## Supported / degraded in remote mode

- **One client at a time.** A second client is rejected with an explicit error.
- **No self-update for the backend** — replace the folder and restart (below).
  The desktop app keeps updating itself.
- **No OS notifications from the backend** (the unread badge still updates).
- **Mini Apps are hidden**, and image/attachment previews need the file-transfer
  work that is not in this version yet.
- **Reveal in file manager** and **copy provider key** act on the backend side and
  are being reworked into download-then-open.
- **Shell settings** (window position, global shortcut, UI locale) live in a local
  file on the client (\`<userData>/local-settings.json\`), not in the backend's
  database: two desktops pointing at one backend remember their own window
  geometry and shortcut.
- **Event stream**: a short disconnect is replayed seamlessly; if the gap is too
  large (backend restart, long outage, or a slow client) the client is told to
  refetch its snapshots instead of showing a silently stale view.
- **Large imports are streamed to disk**: a backup or employee package of any
  size up to 2 GiB is written to the backend's temp folder and read from there, so
  it never has to fit in memory on either side.

## Transfer limits (files between the app and the backend)

| Limit | Value | Where enforced |
| --- | --- | --- |
| Single upload (in memory) | 50 MiB | backend, while streaming (a client that lies about the size is stopped too) |
| Single upload (streamed to disk) | 2 GiB | backend; used for backup/employee imports |
| Transfer temp retention | 7 days (exports), 1 hour (abandoned \`.partial\` uploads) | backend startup sweep |
| Concurrent uploads per client | 4 streams (backend), 2 in flight (client) | backend + client |
| Upload retries | 3 attempts, 1 s / 2 s backoff, transport failures only | client |
| Download chunk | 64 KiB, with backpressure | backend |
| Downloadable paths | inside the data folder, or a previewable image | backend |

An interrupted upload leaves **nothing** behind: the bytes are only handed to a
channel handler once the stream completes, so there is no partial file to clean
up and a retry is always safe.

The backend also writes exports into \`<data-folder>/tmp/<id>/\` for the client to
download; those directories are per-request (so two exports or a retry never
collide) and are the only place \`files:tempPath\` can mint a path.

## Upgrade

\`\`\`bash
node main.cjs --help > /dev/null        # sanity: the binary still runs
systemctl stop imboss-backend           # or: pm2 stop imboss-backend
tar -czf imboss-backup-$(date +%F).tgz -C ~ .imboss   # DB + sessions + skills
# unzip the new version next to the old one, then repoint the symlink used by
# ExecStart (or the pm2 cwd) and start it again:
systemctl start imboss-backend
\`\`\`

Database migrations run automatically at startup. They are one-way: keep the
archive above until the new version has been verified.

The desktop app and the backend negotiate \`api_version\` on connect; a mismatch is
reported instead of failing silently, so upgrade both when the app asks for it.
`;
}
