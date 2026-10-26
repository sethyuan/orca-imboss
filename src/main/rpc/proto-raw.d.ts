/**
 * Type shim for the `.proto` text import.
 *
 * The contract lives in `imboss.proto` (so it is reviewable and shippable) and
 * is inlined into the bundle as a string by both build paths:
 * - electron-vite/Vite: the built-in `?raw` suffix,
 * - `scripts/build-remote-backend.ts`: a tiny esbuild onLoad plugin.
 *
 * Inlining avoids resolving a `.proto` path at runtime, which would otherwise
 * break in three different layouts (dev, inside the asar, and the remote zip).
 */
declare module "*.proto?raw" {
  const content: string;
  export default content;
}
