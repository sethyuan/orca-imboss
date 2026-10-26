import { materializeBuiltinSkills } from "../agent/builtin-skills";
import { disposeAll } from "../agent/session-queue";
import { refreshModelStore } from "../agent/model-runtime";
import { applyPendingRestore } from "../backup";
import * as cron from "../cron";
import { ensureDataDir } from "../data-dir";
import { sweepTransferTempRoot } from "../file-browser";
import { initDatabase } from "../db";
import { applyStoredHttpProxy } from "../http-proxy";
import { registerRemoteHandlers } from "../ipc";
import { initLocale } from "../locale";
import { stopAllMiniAppServers, syncMiniAppIndex } from "../mini-apps";
import type { Handler } from "../rpc/types";
import { APP_VERSION } from "../version";
import { createMapBinder } from "../rpc/binders";
import { setEventBroadcaster } from "../rpc/broadcast";
import { parseServerArgs, type ServerArgs } from "./args";
import {
  configPathFor,
  initializeConfigFile,
  loadServerConfig,
  resolveDataRoot,
  ConfigError,
  type ServerConfig,
} from "./config";
import { startRpcServer, type RpcServerHandle } from "./rpc-server";
import { subscribers } from "./subscribers";

/**
 * Headless backend entry (`node main.cjs`).
 *
 * This is the same business layer the desktop app runs, driven through gRPC
 * instead of Electron IPC — nothing here may import `electron`. Startup mirrors
 * the desktop's `app.whenReady()` sequence minus the window: database →
 * proxy → locale → handlers → services → gRPC listener.
 *
 * Data folder ownership: `~/.imboss` (or `--data-root`). Two backends on one
 * data folder would double-fire cron and fight over SQLite, so the listener port
 * is the runtime guard and a pidfile is written for operators.
 */

export async function runServer(argv: string[]): Promise<void> {
  let args: ServerArgs;
  try {
    args = parseServerArgs(argv);
  } catch (error) {
    console.error(`[server] ${describe(error)}`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.version) {
    console.log(APP_VERSION);
    return;
  }

  const dataRoot = resolveDataRoot(args.dataRoot);
  const configPath = configPathFor(dataRoot, args.config);

  if (args.init) {
    try {
      const created = initializeConfigFile({
        path: configPath,
        dataRoot,
        ...(args.listen !== undefined ? { listen: args.listen } : {}),
      });
      console.log(`[server] wrote ${created.path}`);
      console.log(`[server] token: ${created.token}`);
      console.log(
        "[server] keep this token: the desktop app needs it via --remote-token-file.",
      );
    } catch (error) {
      console.error(`[server] ${describe(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  let config: ServerConfig;
  try {
    config = loadServerConfig({
      dataRoot,
      path: configPath,
      overrides: {
        ...(args.listen !== undefined ? { listen: args.listen } : {}),
        ...(args.token !== undefined ? { token: args.token } : {}),
        ...(args.tokenFile !== undefined ? { tokenFile: args.tokenFile } : {}),
        ...(args.dataRoot !== undefined ? { dataRoot: args.dataRoot } : {}),
      },
    });
  } catch (error) {
    console.error(`[server] ${describe(error)}`);
    if (error instanceof ConfigError) {
      console.error(`\n${usage()}`);
    }
    process.exitCode = 2;
    return;
  }

  // The data folder may be relocated; every path helper in the app derives from
  // `getDataRoot()`, which reads this variable on each call.
  process.env["IMBOSS_DATA_ROOT"] = dataRoot;
  ensureDataDir();

  // A restore staged from the desktop app replaces the whole data folder, so it
  // is applied before anything reads it (mirrors `main/index.ts`).
  const restored = applyPendingRestore();
  if (restored) {
    console.log(
      `[backup] restored ${restored.restoredFrom}` +
        (restored.keptAt ? ` (previous data kept at ${restored.keptAt})` : ""),
    );
  }

  initDatabase();
  applyStoredHttpProxy();
  // Leftover export folders and half-finished uploads from a previous run.
  const swept = sweepTransferTempRoot();
  if (swept.removedDirs > 0 || swept.removedPartials > 0) {
    console.log(
      `[server] swept transfer temp: ${swept.removedDirs} export dir(s), ${swept.removedPartials} partial upload(s)`,
    );
  }
  initLocale();
  materializeBuiltinSkills();

  // Every business event goes to the subscribed clients.
  setEventBroadcaster((channel, payload) => {
    subscribers.broadcast(channel, payload, payload !== undefined);
  });

  const handlers = new Map<string, Handler>();
  registerRemoteHandlers(createMapBinder(handlers));
  const channels = [...handlers.keys()].sort();

  const rpc = await startListening({ config, handlers, channels });
  if (!rpc) return;

  console.log(`[server] data folder: ${config.dataRoot}`);
  console.log(
    "[server] listening on " +
      config.listen +
      " — plaintext gRPC protected by the shared token only. Do not expose it to" +
      " the internet without a tunnel or firewall.",
  );

  // Long-running services, in the desktop's order.
  void syncMiniAppIndex();
  cron.initCron();
  void refreshModelStore(new AbortController().signal);

  installShutdown(async () => {
    cron.stopAll();
    stopAllMiniAppServers();
    await disposeAll();
    await rpc.close();
  });
}

async function startListening(options: {
  config: ServerConfig;
  handlers: Map<string, Handler>;
  channels: string[];
}): Promise<RpcServerHandle | null> {
  try {
    return await startRpcServer(options);
  } catch (error) {
    console.error(`[server] failed to listen: ${describe(error)}`);
    console.error(
      "[server] is another imboss backend already running on this port/folder?",
    );
    process.exitCode = 1;
    return null;
  }
}

function installShutdown(cleanup: () => Promise<void>): void {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal} received, shutting down`);
    const finish = (): void => {
      process.exit(0);
    };
    void cleanup().then(finish, (error: unknown) => {
      console.error(`[server] shutdown failed: ${describe(error)}`);
      finish();
    });
    // A wedged handler must not block the restart a restore needs.
    setTimeout(finish, 10_000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return [
    "Usage: node main.cjs [options]",
    "",
    "  --init                  create ~/.imboss/server.json with a new token and print it",
    "  --config <path>         config file (default: <data-root>/server.json)",
    "  --data-root <path>      data folder (default: ~/.imboss)",
    "  --listen <host:port>    bind address (default: 0.0.0.0:47810)",
    "  --token <token>         shared token (debugging only: visible in `ps`)",
    "  --token-file <path>     file holding the shared token",
    "  --version               print the backend version",
    "  --help                  show this help",
    "",
    "The token is also read from IMBOSS_TOKEN / IMBOSS_TOKEN_FILE.",
  ].join("\n");
}
