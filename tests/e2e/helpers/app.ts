import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

/**
 * Launch + teardown of the real app for one test case.
 *
 * Isolation is the whole point of this module, so it is enforced rather than
 * documented:
 *
 * - `IMBOSS_DATA_ROOT` points the app's *business* data (SQLite, avatars,
 *   attachments, agent env, mini apps, default workdir) at a throw-away folder.
 *   The boss's real `~/.imboss` is never opened.
 * - `--user-data-dir` points Electron's own state (cookies, caches, and the
 *   single-instance lock) at another throw-away folder. Without it the dev build
 *   would ask for the same lock as the installed `imboss.app` the boss usually
 *   has running, and would quit at startup.
 * - `--lang` pins the UI locale, because the app derives it from the OS
 *   (`app.getLocale()`), which would otherwise make assertions depend on the
 *   machine.
 * - `HOME` (and `USERPROFILE` on Windows) points at a throw-away home, because
 *   the app also *reads* the shared Agent Skills folder `~/.agents/skills`,
 *   which `IMBOSS_DATA_ROOT` does not cover. Without this a test would see
 *   whatever the developer happens to have there.
 *
 * All paths are asserted to live under `os.tmpdir()` and to be what the app
 * actually resolved, so a future refactor that breaks the isolation fails loudly
 * instead of silently writing to the boss's data folder.
 */

/** Repo root: this file lives in `<root>/tests/e2e/helpers`. */
export const PROJECT_ROOT = resolve(__dirname, "../../..");

/** Locale the UI is asserted in. Keeps role/text locators stable. */
const DEFAULT_LOCALE = "en-US";

const BOOT_TIMEOUT_MS = 30_000;

export interface LaunchedApp {
  readonly app: ElectronApplication;
  /** The main window (the app is single-window by design). */
  readonly window: Page;
  /** Business data root handed to the app through `IMBOSS_DATA_ROOT`. */
  readonly dataRoot: string;
  /** Electron's own user-data dir (isolates the single-instance lock). */
  readonly userDataDir: string;
  /** Throw-away `HOME` (holds `~/.agents/skills` for the app). */
  readonly homeDir: string;
  /** Uncaught renderer exceptions seen so far (asserted by the smoke test). */
  readonly rendererErrors: string[];
  /** Reload the renderer — the cheap way to prove a state came from disk. */
  reload(): Promise<void>;
  /** Close the app and delete the temp folders (keep them with `IMBOSS_E2E_KEEP=1`). */
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** BCP-47 locale the window should come up in. Defaults to `en-US`. */
  locale?: string;
  /**
   * Skills to seed into the shared `~/.agents/skills` folder before the app
   * starts (the read-only second skills source). Written as
   * `<home>/.agents/skills/<name>/SKILL.md` with minimal valid frontmatter.
   */
  agentsSkills?: ReadonlyArray<{ name: string; description?: string }>;
  /**
   * Skills to seed into the app's own skills folder
   * (`<dataRoot>/agent/skills/<name>/SKILL.md`), for collision cases.
   */
  ownSkills?: ReadonlyArray<{ name: string; description?: string }>;
}

/** Launch the built app with fully isolated state. */
export async function launchApp(
  options: LaunchOptions = {},
): Promise<LaunchedApp> {
  const binary = electronBinary();
  const root = await mkdtemp(join(tmpdir(), "imboss-e2e-"));
  const dataRoot = join(root, "data");
  const userDataDir = join(root, "userdata");
  const homeDir = join(root, "home");
  await mkdir(homeDir, { recursive: true });
  await seedSkills(
    join(homeDir, ".agents", "skills"),
    options.agentsSkills ?? [],
  );
  await seedSkills(join(dataRoot, "agent", "skills"), options.ownSkills ?? []);

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  // A leftover dev-server URL would make the window load the Vite dev server
  // instead of the freshly built `out/renderer` — never what a test wants.
  delete env["ELECTRON_RENDERER_URL"];
  env["IMBOSS_DATA_ROOT"] = dataRoot;
  // `~/.agents/skills` is outside the data root; move `home` too. Windows
  // derives the home directory from `USERPROFILE`, POSIX from `HOME`.
  env["HOME"] = homeDir;
  env["USERPROFILE"] = homeDir;

  const app = await electron.launch({
    executablePath: binary,
    args: [
      ".",
      `--user-data-dir=${userDataDir}`,
      `--lang=${options.locale ?? DEFAULT_LOCALE}`,
    ],
    cwd: PROJECT_ROOT,
    env,
    timeout: BOOT_TIMEOUT_MS,
  });

  try {
    await assertIsolation(app, { dataRoot, userDataDir, homeDir });
  } catch (error) {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  const window = await app.firstWindow({ timeout: BOOT_TIMEOUT_MS });
  const rendererErrors: string[] = [];
  window.on("pageerror", (error) => {
    rendererErrors.push(error.message);
  });

  await waitForBoot(window);

  const session: LaunchedApp = {
    app,
    window,
    dataRoot,
    userDataDir,
    homeDir,
    rendererErrors,
    reload: async () => {
      await window.reload();
      await waitForBoot(window);
    },
    close: async () => {
      // A crashed app must not turn into a teardown failure of its own.
      await app.close().catch(() => undefined);
      if (process.env["IMBOSS_E2E_KEEP"] !== "1") {
        await rm(root, { recursive: true, force: true });
      } else {
        console.log(`[e2e] kept temp dir: ${root}`);
      }
    },
  };
  return session;
}

/**
 * The path of the Electron binary `electron-vite`/electron-builder would run.
 *
 * Read from the package's own `path.txt` (relative to `dist/`) instead of
 * `require("electron")` so this works regardless of how the test file is
 * transpiled, and fails with a readable message when dependencies are missing.
 */
function electronBinary(): string {
  const packageDir = join(PROJECT_ROOT, "node_modules", "electron");
  const relative = readFileSync(join(packageDir, "path.txt"), "utf8").trim();
  if (relative.length === 0) {
    throw new Error(`electron: empty path.txt in ${packageDir}`);
  }
  return join(packageDir, "dist", relative);
}

async function assertIsolation(
  app: ElectronApplication,
  expected: { dataRoot: string; userDataDir: string; homeDir: string },
): Promise<void> {
  const actualUserData = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData"),
  );
  const actualDataRoot = await app.evaluate(
    () => process.env["IMBOSS_DATA_ROOT"] ?? "",
  );
  // The app resolves `~/.agents/skills` from `os.homedir()`; if that still
  // pointed at the developer's home, the suite would read their real skills.
  const actualHome = await app.evaluate(() => process.env["HOME"] ?? "");

  if (realpath(actualUserData) !== realpath(expected.userDataDir)) {
    throw new Error(
      `e2e isolation broken: userData is ${actualUserData}, expected ${expected.userDataDir}`,
    );
  }
  if (realpath(actualDataRoot) !== realpath(expected.dataRoot)) {
    throw new Error(
      `e2e isolation broken: IMBOSS_DATA_ROOT is ${actualDataRoot}, expected ${expected.dataRoot}`,
    );
  }
  if (realpath(actualHome) !== realpath(expected.homeDir)) {
    throw new Error(
      `e2e isolation broken: HOME is ${actualHome}, expected ${expected.homeDir}`,
    );
  }

  const tmp = realpath(tmpdir());
  for (const [label, dir] of [
    ["IMBOSS_DATA_ROOT", actualDataRoot],
    ["userData", actualUserData],
    ["HOME", actualHome],
  ] as const) {
    // Defence in depth: even if both values somehow matched, writing outside
    // the OS temp dir would mean the boss's data folder is at risk.
    if (!realpath(dir).startsWith(tmp)) {
      throw new Error(
        `e2e isolation broken: ${label} (${dir}) is not in ${tmp}`,
      );
    }
  }
}

/**
 * Symlinks resolved: macOS hands out `/var/folders/…` but Electron reports the
 * resolved `/private/var/folders/…`, and comparing the raw strings would fail
 * for a reason that has nothing to do with isolation.
 */
/**
 * Write one `<dir>/<name>/SKILL.md` per entry (minimal valid frontmatter).
 * Seeded through the filesystem on purpose: these are folders the app *reads*
 * but never writes, so no IPC can create them.
 */
async function seedSkills(
  dir: string,
  skills: ReadonlyArray<{ name: string; description?: string }>,
): Promise<void> {
  for (const skill of skills) {
    const skillDir = join(dir, skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: ${skill.description ?? ""}\n---\n\nSeeded by the e2e suite.\n`,
      "utf8",
    );
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Wait until the shell (nav rail) is on screen — i.e. the app really booted. */
async function waitForBoot(window: Page): Promise<void> {
  await window
    .getByRole("navigation", { name: "Modules" })
    .waitFor({ state: "visible", timeout: BOOT_TIMEOUT_MS });
}
