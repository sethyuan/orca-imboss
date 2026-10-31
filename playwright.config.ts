import { defineConfig } from "@playwright/test";

/**
 * E2E configuration for the desktop app.
 *
 * The tests drive the **real Electron app** (built by `electron-vite build` into
 * `out/`), not a browser: every case launches `out/main/index.js` through
 * Playwright's `_electron` support and talks to it like the boss would.
 *
 * Deliberate choices:
 * - `workers: 1` — each case launches a whole Electron app (+ its own SQLite
 *   database and Chromium user data). One at a time keeps runs predictable and
 *   the machine responsive; a full suite is well under a minute anyway.
 * - `trace: "retain-on-failure"` — a failure leaves
 *   `test-results/<test>/trace.zip`, which contains the DOM snapshot timeline,
 *   console and network. `npx playwright show-trace <file>` opens it. This is
 *   the primary diagnostic artefact: read the trace before anything else.
 * - No retries locally: a flaky check should be fixed, not hidden.
 * - `testDir` matches only `*.spec.ts`, so `tests/e2e/helpers/**` is never
 *   collected as a test file.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Video of a desktop window adds no information over the trace and slows
    // every case down; keep it off.
    video: "off",
  },
});
