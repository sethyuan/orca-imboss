/**
 * Which mode the desktop process is in.
 *
 * Set once by the bootstrap that actually started (`index.ts`): the local mode
 * owns the data folder, the remote shell only proxies to a backend. A handful of
 * desktop modules need to know — the window adds `--remote-mode` for the
 * preload, and the startup log explains the remote-mode degradations.
 *
 * Deliberately a module-level flag rather than an argument threaded through the
 * call chain: these are process-wide facts, and passing them down would touch
 * every signature between `index.ts` and the window.
 */

let remote = false;

/**
 * Version handshake result when the shell and the backend disagree about the
 * channel contract. Passed to the window as a start-up argument (like `--locale`)
 * so the renderer knows it synchronously — a one-shot event could arrive before
 * the page subscribes and be lost.
 */
export interface RemoteIncompatibility {
  shell: number;
  backend: number;
  backendVersion: string;
}

let incompatibility: RemoteIncompatibility | null = null;

export function setRemoteMode(enabled: boolean): void {
  remote = enabled;
}

export function isRemoteMode(): boolean {
  return remote;
}

export function setRemoteIncompatibility(
  value: RemoteIncompatibility | null,
): void {
  incompatibility = value;
}

export function getRemoteIncompatibility(): RemoteIncompatibility | null {
  return incompatibility;
}
