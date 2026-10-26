import { appStore } from "./app-store";

/**
 * Renderer-side helpers for the one thing that changes when the backend is
 * remote: **which machine a path belongs to**.
 *
 * Locally, "choose a folder" is a native dialog and the resulting absolute path
 * is something the agent can read. Remotely that dialog would hand out a path on
 * *this* machine, which the backend cannot see — so the same button opens the
 * backend's own folder browser instead (see `components/path-browser`).
 */

/** True when this window drives a remote backend (`--remote=…`). */
export function isRemoteMode(): boolean {
  return imb.remote.enabled === true;
}

/**
 * Pending choice, kept outside the valtio store: a resolver function has no
 * business being proxied, and only one browser can be open at a time.
 */
let pending: {
  resolve: (path: string | null) => void;
  multiple: boolean;
  picked: string[];
} | null = null;

/**
 * Ask the user for a directory **on the backend**. Resolves to its absolute path,
 * or `null` when the browser is dismissed.
 */
export function chooseRemoteDirectory(title: string): Promise<string | null> {
  if (!isRemoteMode()) {
    return Promise.reject(new Error("The remote path browser is unavailable."));
  }
  return new Promise((resolve) => {
    // A second request while one is open cancels the first (its flow was clearly
    // abandoned); otherwise the old resolver would never settle.
    pending?.resolve(null);
    pending = {
      resolve,
      multiple: false,
      picked: [],
    };
    appStore.pathBrowser = { open: true, title };
  });
}

/** True while the browser is showing (used by the modal component). */
export function isPathBrowserOpen(): boolean {
  return appStore.pathBrowser.open;
}

/**
 * Finish the pending choice. Called by the modal only.
 * `path` = the folder the user settled on, or `null` for "dismissed".
 */
export function settlePathBrowser(path: string | null): void {
  const current = pending;
  pending = null;
  appStore.pathBrowser = { open: false, title: "" };
  current?.resolve(path);
}
