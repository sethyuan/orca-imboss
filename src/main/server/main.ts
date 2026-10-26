import { runServer } from "./bootstrap";

/**
 * Process entry of the packaged backend (`node main.cjs …`).
 *
 * Kept separate from `bootstrap.ts` so the startup sequence stays a plain
 * function: testable in principle, and free of "importing this module starts a
 * server" surprises.
 */
void runServer(process.argv.slice(2)).catch((error: unknown) => {
  console.error(
    "[server] fatal:",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
