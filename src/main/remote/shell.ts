import { imageMimeForPath } from "@shared/image-attachments";
import { ipcMain } from "electron";
import { setRemoteIncompatibility } from "../app-mode";

import { installDesktopBroadcaster } from "../desktop/broadcast";
import { installLocalSettingsStore } from "../desktop/local-settings";
import { installDesktopPlatform } from "../desktop/platform";
import { registerRemoteHandlers } from "../ipc";
import { registerLocalHandlers } from "../ipc/local";
import { registerRemoteImbFileHandler } from "../imb-file-protocol";
import { getFilePicker, getRevealer, getThemeApplier } from "../platform";
import { isBinaryTailChannel, splitBinaryArgs } from "../rpc/files-guard";
import { initLocale } from "../locale";
import { createMainWindow, initTray } from "../main-window";
import { webContentsSubscriber } from "../desktop/ipc";
import { basename, join } from "path";
import { tmpdir } from "os";
import { createCollectBinder } from "../rpc/binders";
import { sendToRenderer } from "../rpc/broadcast";
import { newClientId, RemoteClient, type RemoteInfo } from "../rpc/grpc-client";
import { IMBOSS_API_VERSION } from "../rpc/grpc-service";
import { initUpdater } from "../updater";
import { APP_VERSION } from "../version";
import { initWindowShortcut } from "../window-shortcut";
import type { Handler } from "../rpc/types";
import type { RemoteOptions } from "./args";

/**
 * The desktop shell of a remote setup.
 *
 * What stays here: the window, the tray, the global shortcut, OS notifications,
 * the clipboard, native dialogs, and the app's own updater — everything that is
 * *this machine*. What moves to the backend: the database, agent sessions, cron,
 * IM integrations, Mini Apps, backups and the data folder.
 *
 * The renderer cannot tell the difference: the channel table is registered here
 * as thin proxies that call the backend with the exact same name and positional
 * arguments (see `src/main/rpc/types.ts`), and the backend's events are pushed
 * into the window through the same broadcaster local mode uses.
 *
 * Deliberately skipped in this mode (documented degradations, see
 * `.pi/facts/grpc-remote-backend-research.md` §6.4): `initTheme` (the theme mode
 * lives with the backend's database and is applied by the renderer, the native
 * chrome follows the OS), window-bounds persistence and the global-shortcut
 * setting (both need a local settings store, a follow-up).
 */
export async function startRemoteShell(options: RemoteOptions): Promise<void> {
  const client = new RemoteClient({
    target: options.target,
    token: options.token,
    clientId: newClientId(),
    appVersion: APP_VERSION,
  });

  // Host capabilities first: a channel handler must never see a half-installed
  // platform (dialogs, clipboard, notifications all run on this machine).
  installDesktopPlatform();
  installDesktopBroadcaster();
  // Window geometry, the global shortcut and the locale are properties of *this*
  // machine; with no local database they go to `<userData>/local-settings.json`.
  installLocalSettingsStore();

  registerLocalHandlers();

  const channels = collectRemoteChannels();
  logConnection(await handshake(client), options.target);

  // One generic proxy per channel: identical names, identical positional
  // arguments, identical thrown messages as the in-process implementation.
  // Two kinds need more than a forward — see `registerTransferProxies` and
  // `registerDialogProxies`.
  const overrides = dialogProxies(client);
  for (const channel of channels) {
    const override = overrides[channel];
    if (override !== undefined) {
      ipcMain.handle(channel, (event, ...args: unknown[]) =>
        override({ subscriber: webContentsSubscriber(event.sender) }, ...args),
      );
      continue;
    }
    if (isBinaryTailChannel(channel)) {
      // Thousands of JSON numbers would be a terrible way to send a file: these
      // channels go over the dedicated `Upload` stream instead.
      ipcMain.handle(channel, (_event, ...args: unknown[]) => {
        const { args: plainArgs, bytes } = splitBinaryArgs(channel, args);
        return client.upload(channel, plainArgs, bytes ?? new Uint8Array(), "");
      });
      continue;
    }
    ipcMain.handle(channel, (_event, ...args: unknown[]) =>
      client.invoke(channel, args),
    );
  }

  // `imb-file:` serves images out of the backend's data folder over `Download`;
  // the renderer, the URL shape and the page CSP are untouched.
  registerRemoteImbFileHandler((path, version) => {
    const response = client.downloadResponse(path, version);
    // Re-wrap so the content type is declared: a body-only Response has none.
    return new Response(response.body, {
      headers: { "content-type": imageMimeForPath(path) },
    });
  });

  // Events: the backend pushes the same channel names the renderer already
  // subscribes to through the preload bridge. When the backend could not replay
  // the gap (restart, long outage, backpressure), the renderer is told to
  // refetch its snapshots — a stale UI is worse than a refetch.
  client.startEvents(
    (channel, payload) => {
      sendToRenderer(channel, payload);
    },
    (reason) => {
      console.warn(`[remote] resync required (${reason})`);
      sendToRenderer("remote:resync", { reason });
    },
  );

  initLocale();
  // The theme lives in the backend's settings; apply its mode to this window's
  // native chrome too (the renderer colours itself from the same value).
  void client
    .invoke("theme:get", [])
    .then((state) => {
      const mode = (state as { mode?: unknown } | null)?.mode;
      if (mode === "light" || mode === "dark" || mode === "system") {
        getThemeApplier().applyMode(mode);
      }
    })
    .catch(() => {
      // Cosmetic only: the renderer still themes itself.
    });
  createMainWindow();
  initTray();
  initWindowShortcut();
  initUpdater();

  // A failed subscription is not fatal (every request is independent), but the
  // user should see *why* nothing refreshes.
  void client
    .waitForSubscription()
    .then(() => console.log("[remote] event stream established"))
    .catch((error: unknown) => {
      console.error(
        `[remote] event stream unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
}

/**
 * Channels whose local half is a *dialog* plus a server-side file operation.
 *
 * The dialog belongs on this machine (the user is here), the file belongs to the
 * backend. So the shell orchestrates: pick locally → put the bytes on the backend
 * (`files:stageUpload`) or mint a backend destination (`files:tempPath`) → run
 * the real channel → pull the result down (`Download`). The renderer keeps
 * calling the same channel with the same signature and the same return type.
 */
function dialogProxies(client: RemoteClient): Record<string, Handler> {
  return {
    // Export: local save dialog first (so cancelling costs nothing), then let the
    // backend write into a temp path it minted, then download it.
    "backup:export": async () => {
      const target = await pickLocalSavePath("imboss-backup.zip", [
        { name: "imboss backup", extensions: ["imbossbackup", "zip"] },
      ]);
      if (target === null) return null;
      const serverPath = await readString(
        client.invoke("files:tempPath", [basename(target)]),
      );
      const info = await client.invoke("backup:export", [serverPath]);
      if (info === null || info === undefined) return null;
      await client.downloadToFile(serverPath, target);
      return info;
    },

    // Import: pick locally, hand the bytes to the backend, then let the channel
    // that understands archives read them from there.
    "backup:inspect": async () => {
      const local = await pickLocalOpenPath([
        { name: "imboss backup", extensions: ["imbossbackup", "zip"] },
      ]);
      if (local === null) return null;
      const staged = await stageLocalFile(client, local);
      return await client.invoke("backup:inspect", [staged.path]);
    },

    "employees:export": async (_ctx, id: unknown) => {
      const target = await pickLocalSavePath("employee-export.zip", [
        {
          name: "imboss employee export",
          extensions: ["imbossemployee", "zip"],
        },
      ]);
      if (target === null) return null;
      const serverPath = await readString(
        client.invoke("files:tempPath", [basename(target)]),
      );
      const result = await client.invoke("employees:export", [id, serverPath]);
      if (result === null || result === undefined) return null;
      await client.downloadToFile(serverPath, target);
      return result;
    },

    // Reveal: bytes must come here first — the file lives on the backend, and a
    // headless server has no file manager to open it in. Fetched into the OS temp
    // folder under a per-file directory so repeated reveals cannot collide.
    "messages:revealAttachment": async (_ctx, messageId: unknown, index: unknown) => {
      const record = (await client.invoke("messages:attachmentFile", [
        messageId,
        index,
      ])) as { name?: string; path?: string | null; kind?: string };

      if (record.kind === "folder") {
        // A folder is a backend location: there is nothing to copy down.
        throw new Error(
          `The folder lives on the backend and cannot be opened here: ${record.path ?? ""}`,
        );
      }
      const remotePath = record.path;
      if (typeof remotePath !== "string" || remotePath.length === 0) {
        throw new Error("Attachment location is unavailable.");
      }

      const dir = join(tmpdir(), "imboss-attachments", String(messageId));
      const target = join(dir, `${index}-${sanitizeName(record.name ?? "file")}`);
      await client.downloadToFile(remotePath, target);
      const opened = await getRevealer().openPath(target);
      if (opened) throw new Error(opened);
    },

    "employees:importInspect": async () => {
      const local = await pickLocalOpenPath([
        {
          name: "imboss employee export",
          extensions: ["imbossemployee", "zip"],
        },
      ]);
      if (local === null) return null;
      const staged = await stageLocalFile(client, local);
      return await client.invoke("employees:importInspect", [staged.path]);
    },
  };
}

/** Local save dialog; `null` when the user cancels. */
async function pickLocalSavePath(
  defaultName: string,
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<string | null> {
  return await getFilePicker().showSaveDialog({
    title: "Save file from the imboss backend",
    defaultPath: defaultName,
    filters,
  });
}

/** Local open dialog; `null` when the user cancels. */
async function pickLocalOpenPath(
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<string | null> {
  const paths = await getFilePicker().showOpenDialog({
    title: "Open a file for the imboss backend",
    properties: ["openFile"],
    filters,
  });
  return paths === null ? null : (paths[0] ?? null);
}

/**
 * Put a local file on the backend and return its backend path.
 *
 * Streamed from disk (not read into memory): the user may be importing a backup
 * archive far larger than any sane buffer.
 */
async function stageLocalFile(
  client: RemoteClient,
  localPath: string,
): Promise<{ path: string }> {
  const staged = await client.uploadFile("files:stageUpload", [
    basename(localPath),
  ], localPath);
  const record = (staged ?? {}) as { path?: unknown };
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error("The backend did not accept the uploaded file.");
  }
  return { path: record.path };
}

/** Keep a user-supplied file name usable as one path segment. */
function sanitizeName(name: string): string {
  const base = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return base.slice(0, 120) || "file";
}

function readString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The backend returned no file path.");
  }
  return value;
}

async function handshake(client: RemoteClient): Promise<RemoteInfo | Error> {
  try {
    return await client.info();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The channel table of the backend, derived from the shared registrations. */
function collectRemoteChannels(): string[] {
  const channels = new Set<string>();
  registerRemoteHandlers(createCollectBinder(channels));
  return [...channels].sort();
}

function logConnection(info: RemoteInfo | Error, target: string): void {
  if (info instanceof Error) {
    // Still start the window: every call will fail with this message, which is
    // far more useful than an app that silently does nothing.
    console.error(
      `[remote] cannot reach ${target}: ${info.message} — starting anyway; every request fails until the backend is reachable.`,
    );
    return;
  }
  console.log(
    `[remote] connected to ${target} (backend v${info.appVersion}, api v${info.apiVersion}, ${info.channels.length} channels, data ${info.dataRoot})`,
  );
  if (info.apiVersion !== IMBOSS_API_VERSION) {
    console.error(
      `[remote] API version mismatch: shell v${IMBOSS_API_VERSION} vs backend v${info.apiVersion}. Upgrade one side; requests may fail.`,
    );
    // The renderer shows a banner (and keeps working read-only) instead of
    // failing every interaction with an unexplained error.
    setRemoteIncompatibility({
      shell: IMBOSS_API_VERSION,
      backend: info.apiVersion,
      backendVersion: info.appVersion,
    });
  }
  const served = new Set(info.channels);
  const missing = collectRemoteChannels().filter((c) => !served.has(c));
  if (missing.length > 0) {
    console.warn(
      `[remote] the backend does not serve ${missing.length} channel(s) this shell knows: ${missing.join(", ")}`,
    );
  }
  if (!info.singleClient) {
    console.warn(
      "[remote] the backend reports multi-client support; this shell assumes a single client.",
    );
  }
}
