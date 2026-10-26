import { isPreviewableImagePath } from "@shared/image-attachments";
import { parseImbFilePath } from "@shared/imb-file";
import { net, protocol } from "electron";
import { statSync } from "fs";
import { isAbsolute } from "path";
import { pathToFileURL } from "url";

/** Scheme served by {@link registerImbFileHandler}. */
const SCHEME = "imb-file";

/**
 * Register the `imb-file:` scheme as standard + secure + streamable.
 *
 * Must run before the `app` `ready` event (Electron requirement) — this project
 * calls it from the top level of `src/main/index.ts`.
 *
 * Deliberately NOT granted: `bypassCSP` (the page CSP still governs the scheme;
 * `imb-file:` is added to `img-src` explicitly), `supportFetchAPI` (only `<img>`
 * may use it, no `fetch()` from the renderer) and `corsEnabled` (keeps a
 * cross-origin canvas from reading the served image's pixels).
 */
export function registerImbFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, stream: true },
    },
  ]);
}

/**
 * Serve an `imb-file:` URL from disk.
 *
 * Trust model: the URL carries an arbitrary absolute path — there is no path
 * whitelist. The exposure is bounded by (a) `imb-file:` being allowed in
 * `img-src` only, (b) the guard below refusing anything that is not a regular
 * file with a previewable-image extension, so non-image files (e.g. an SSH key)
 * are never read into the renderer, and (c) the scheme privileges defined in
 * {@link registerImbFileScheme}.
 */
export function registerImbFileHandler(): void {
  protocol.handle(SCHEME, (request) => {
    const path = parseImbFilePath(request.url);
    if (!path || !isAbsolute(path)) {
      return new Response(null, { status: 400 });
    }
    // Reject disallowed extensions before touching the filesystem, so a
    // non-image path is never even stat'ed.
    if (!isPreviewableImagePath(path)) {
      return new Response(null, { status: 403 });
    }
    try {
      if (!statSync(path).isFile()) return new Response(null, { status: 404 });
    } catch {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(path).toString());
  });
}

/** Reads one file from the remote backend as a streamed `Response`. */
export type RemoteFileFetcher = (
  path: string,
  version: string,
) => Response | Promise<Response>;

/**
 * Serve `imb-file:` from the remote backend.
 *
 * In a remote setup the file an `<img>` wants lives in the backend's data folder,
 * so the handler streams it over the gRPC `Download` channel and hands the bytes
 * back as a `Response`. The trust model is unchanged and stays server-side
 * (`rpc/files-guard.ts`): absolute path, previewable image extension, regular
 * file. Nothing about the renderer, the URL shape or the page CSP changes.
 */
export function registerRemoteImbFileHandler(
  fetchRemote: RemoteFileFetcher,
): void {
  protocol.handle(SCHEME, async (request) => {
    const path = parseImbFilePath(request.url);
    if (!path || !isAbsolute(path)) {
      return new Response(null, { status: 400 });
    }
    // Same extension gate as the local handler: a non-image path is never even
    // asked for, so the backend never has to refuse it.
    if (!isPreviewableImagePath(path)) {
      return new Response(null, { status: 403 });
    }
    let version = "";
    try {
      version = new URL(request.url).searchParams.get("v") ?? "";
    } catch {
      version = "";
    }
    try {
      return await fetchRemote(path, version);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.toLowerCase().includes("does not exist")
        ? 404
        : 502;
      if (status === 502) {
        console.error(`[imb-file] remote fetch failed for ${path}: ${message}`);
      }
      return new Response(null, { status });
    }
  });
}
