import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getAgentSkillsDir,
  getAgentsSkillsDir,
  getBuiltinSkillsDir,
  getMiniAppsDir,
} from "../data-dir";
import { getMcpConfigPath } from "../mcp-store";
import { getResolvedLocale } from "../locale";

/**
 * The app's built-in (code-shipped) Agent Skills.
 *
 * These are ordinary `SKILL.md` folders, but they live in a dedicated dir
 * (`~/.imboss/agent/builtin-skills`, see `getBuiltinSkillsDir`) instead of the
 * user skills dir, so Settings › Skills — which lists only
 * `~/.imboss/agent/skills` — never shows them. They are force-injected into the
 * assistant's session and cannot be uninstalled. They are generated on disk at
 * startup (and defensively before a session is built) because the Pi SDK
 * advertises a skill by its absolute `SKILL.md` path and the model loads it
 * with the `read` tool; an in-memory skill cannot be read back.
 *
 * Their content is instructions, not an integration: the assistant performs
 * the actual MCP/Skill changes with its existing `read`/`write`/`edit`/`bash`
 * tools, so no new tools are registered. Absolute paths are templated into the
 * bodies at generation time.
 *
 * Writes are best-effort and idempotent: a failure is logged and never throws,
 * and a file that already matches is left untouched.
 */

/** Folder name of a skill's entry file (Agent Skills standard). */
const SKILL_FILE = "SKILL.md";

/**
 * Names of the app's built-in skills, in the order they are advertised. They
 * are force-injected into the assistant's session and deliberately hidden from
 * the Settings › Skills page / employee picker: they are app-owned
 * capabilities, not user-managed skills.
 */
export const BUILTIN_SKILL_NAMES = [
  "mcp-management",
  "skills-management",
  "mini-app-development",
] as const;

export type BuiltinSkillName = (typeof BUILTIN_SKILL_NAMES)[number];

/** Whether `name` is one of the app's built-in skills. */
export function isBuiltinSkillName(name: string): name is BuiltinSkillName {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name);
}

/** Frontmatter `description` (single line; what makes the skill discoverable). */
const MCP_MANAGEMENT_DESCRIPTION =
  "View, add, edit, or remove this app's MCP server settings. " +
  "Use when the boss asks to manage, inspect, add, change, or delete MCP servers.";

const SKILLS_MANAGEMENT_DESCRIPTION =
  "View, add, edit, or delete this app's user-installed Skills. " +
  "Use when the boss asks to manage, inspect, add, change, or remove skills.";

const MINI_APP_DEVELOPMENT_DESCRIPTION =
  "Build, copy, or debug this app's Mini Apps (local web apps shown in the " +
  "sidebar). Use when asked to create, modify, run, or debug a mini app.";

interface BuiltinSkillFile {
  name: BuiltinSkillName;
  description: string;
  body: string;
}

/** Render one skill folder's `SKILL.md` (frontmatter + body). */
function renderSkillFile(skill: BuiltinSkillFile): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`;
}

function mcpManagementSkillBody(): string {
  const mcpPath = getMcpConfigPath();
  return `# MCP management

You manage this app's MCP (Model Context Protocol) server settings. The single
source of truth is this JSON file:

    ${mcpPath}

The app reads the file when it builds an agent session, so a change takes effect
the next time a session starts, not immediately.

## File format

The file is a JSON object with one top-level key, "mcpServers", whose value is an
object keyed by server name:

    {
      "mcpServers": {
        "local-tools": {
          "command": "npx",
          "args": ["-y", "some-mcp-server"],
          "env": { "API_KEY": "..." },
          "description": "optional text shown to the model"
        },
        "remote-tools": {
          "url": "https://example.com/mcp",
          "headers": { "Authorization": "Bearer ..." },
          "description": "optional text shown to the model"
        }
      }
    }

- A server with "command" is a stdio server. "args" must be a JSON array of
  strings, never a single string.
- A server with "url" is an HTTP (streamable HTTP) server. SSE is not supported.
- "env" (stdio) and "headers" (HTTP) are optional objects of string values.
- "description" is optional and is passed to the model as the server description.

## Constraints (entries that break these are dropped by the app)

- Server name: 1-200 characters, only letters, digits, underscore and dash.
- "command": non-empty, at most 2048 characters.
- "args": at most 8192 characters in total.
- "url": at most 2048 characters and must start with http:// or https://.
- "env" keys must match ^[A-Za-z_][A-Za-z0-9_]*$.
- "env" and "headers" hold at most 128 entries each.
- Keep any other per-server fields you find (for example "enabled" or "timeout");
  the app preserves them and relies on them.

## How to work

1. Always read the file first. If it does not exist, create it as
   { "mcpServers": {} }.
2. To view servers, read the file and summarize each server's name and transport.
3. To add a server, edit the file to add a new key under "mcpServers" while
   leaving the existing servers untouched.
4. To edit a server, make a targeted edit. Keep only the fields of its transport;
   never leave both "command" and "url" on the same server.
5. To remove a server, delete that one key; do not remove the others.

Never write invalid JSON and never overwrite the file in a way that drops servers
you did not intend to change. When done, tell the boss what changed and that it
applies from the next session.
`;
}

function skillsManagementSkillBody(): string {
  const skillsDir = getAgentSkillsDir();
  const agentsSkillsDir = getAgentsSkillsDir();
  const builtinDir = getBuiltinSkillsDir();
  return `# Skills management

You manage this app's user-installed Skills. A Skill is a folder containing a
SKILL.md file (the Agent Skills standard). User Skills live under:

    ${skillsDir}

Each skill is ${skillsDir}/<name>/SKILL.md, optionally with supporting files such
as scripts/, references/ or assets/ next to it. The app lists these skills in its
Skills module, and any employee that has selected a skill sees its name and
description.

Sessions pick up skills when they are built, so a new or changed skill applies on
the next turn of an employee session.

## Skills shared by other tools

The app also *reads* the shared Agent Skills folder:

    ${agentsSkillsDir}

Skills from there appear in the Skills module and employees can select them, but
that folder belongs to other agent tools and is read-only here: never write,
edit, move or delete anything inside it, and never "fix" a skill by copying it
out of there unless the boss explicitly asks for that. The app's own folder wins
when both contain the same skill name.

## SKILL.md format

    ---
    name: my-skill
    description: What the skill does and when to use it.
    ---

    # My skill

    Step-by-step instructions for the model.

- "name" must be lowercase letters, digits and hyphens (^[a-z0-9-]+$), at most 64
  characters, and must not start or end with a hyphen or contain two hyphens in a
  row.
- "description" is required (1-1024 characters). It is what makes the skill
  discoverable, so state both what the skill does and when it applies.
- Keep the folder name identical to the frontmatter name.
- Relative paths inside a skill resolve against the skill folder.

## How to work

1. To view skills, list the folders under ${skillsDir} (and under
   ${agentsSkillsDir}) that contain a SKILL.md and read each SKILL.md. The folder
   name is the skill name and the frontmatter "description" is its description.
2. To add a skill, write ${skillsDir}/<name>/SKILL.md with the frontmatter and
   instructions above. Use the write tool; it creates the parent folders. Add any
   supporting files under the same folder.
3. To edit a skill, read its SKILL.md and make a targeted edit; update the
   description if the skill's scope changed.
4. To delete a skill, remove exactly its folder, for example:
   rm -rf "${skillsDir}/<name>"
   Never delete ${skillsDir} itself.

## Built-in skills

The app also ships built-in skills under:

    ${builtinDir}

Those (currently mcp-management, skills-management and mini-app-development)
belong to the app. Never edit, move or delete them. They are intentionally not
listed in the Skills module.
`;
}

/**
 * Whether `locale` denotes Simplified Chinese (the boss's locale). Accepts the
 * BCP-47/underscore spellings Electron may return ("zh-CN", "zh-Hans-CN",
 * "zh_CN") and treats only Traditional-Chinese markers as false, so an
 * unknown `zh-*` variant still falls back to the mainland mirror.
 */
function isSimplifiedChineseLocale(locale: string): boolean {
  const l = locale.trim().toLowerCase().replaceAll("_", "-");
  if (!l.startsWith("zh")) return false;
  return !/^(zh-(hant|cht)|zh-(tw|hk|mo)(-|$))/.test(l);
}

function miniAppDevelopmentSkillBody(): string {
  const miniAppsDir = getMiniAppsDir();
  // The default Playwright CDN is often unreachable/slow from mainland China,
  // so the boss's locale decides which install command the skill advertises.
  const zhCn = isSimplifiedChineseLocale(getResolvedLocale());
  const installChromium = zhCn
    ? 'PLAYWRIGHT_DOWNLOAD_HOST="https://npmmirror.com/mirrors/playwright/" ' +
      "npx playwright install chromium"
    : "npx playwright install chromium";
  const installChromiumNote = zhCn
    ? "The mirror host is required here (the default Playwright CDN is " +
      "unreachable from the boss's network); run the command exactly as " +
      "written."
    : "Run the command exactly as written.";
  return `# Mini app development

A mini app is a self-contained folder under:

    ${miniAppsDir}

The main app scans that folder at startup, reads each mini app's metadata.json,
and shows every valid mini app in the sidebar. Clicking one opens its entry URL
in an embedded frame.

## Folder layout

One folder per mini app, named with the app id (only letters, digits, dot,
underscore and dash, at most 64 characters):

    ${miniAppsDir}/<id>/metadata.json
    ${miniAppsDir}/<id>/icon.png          (optional)
    ${miniAppsDir}/<id>/...               (your source files)

The folder may contain any tech stack. Add a local web server and point the
metadata at it.

## metadata.json

    {
      "name": "World Map",
      "icon": "icon.png",
      "entry": "http://127.0.0.1:5173",
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": ".",
      "env": { "PORT": "5173" }
    }

- "name" (required): display label, 1-100 characters.
- "entry" (required): the URL the app opens. Must be http(s) and a loopback host
  (localhost or 127.0.0.1) — mini apps run locally.
- "icon" (optional): a path relative to the folder. png/jpg/jpeg/gif/webp/svg/
  ico, at most 256 KB. The app reads it and shows it in the sidebar.
- "command" (optional): the server executable to run (for example "npm",
  "node" or "npx"). The app starts it the first time the mini app is opened in
  a session and keeps it running until the app quits. It is started without a
  shell, so pass arguments via "args".
- "args" (optional): a JSON array of strings passed to "command".
- "cwd" (optional): working directory for "command", relative to the mini app
  folder (defaults to the folder itself).
- "env" (optional): extra environment variables for the server process.

A mini app without "command" is still allowed; the app then only embeds
"entry" (the server must already be running somewhere).

## Sidebar order: index.json

    ${miniAppsDir}/index.json
    { "order": ["world-map", "another-app"] }

The app maintains this file: a new mini app is appended and a removed one is
dropped. You may add the id yourself to control placement; otherwise the app
appends it on the next start. Never list a folder that does not exist.

## Build workflow

1. Pick a short id and create ${miniAppsDir}/<id>/.
2. Write the app (any stack). Make sure it serves over http on a loopback port.
3. Write metadata.json as above.
4. If it needs a server, define "command"/"args" so the app can start it.
5. Test it with Playwright before reporting done (see Debugging below).
6. Tell the boss the mini app will appear in the sidebar after hitting \`Cmd/Ctrl+R\`.

## Debugging

A mini app is a normal web app served on a loopback URL. Debug it directly at
that URL with Playwright (or any browser automation): you run and inspect it
yourself, not through the app window.

### Run the server for testing

The app starts the "command" server the first time the mini app is opened, and
reuses it when the port is already serving. For your own testing, start it
yourself:

1. Install dependencies in the mini app folder (for example "npm install").
2. Start the server in the background and wait until its entry URL answers
   (for example "npm run dev &"). Only one process can bind the port; stop your
   server when you are done, otherwise the app will reuse it when opened.
3. Quick health check:

       curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173

### Drive it with Playwright

Install the Chromium browser once if it is not present:

    ${installChromium}

${installChromiumNote}

Write a small headless script and run it with "node". Capture console output
and failed requests first — they usually expose the bug before any DOM check:

    const { chromium } = require("playwright");

    (async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      page.on("console", (m) => console.log("console:", m.type(), m.text()));
      page.on("pageerror", (e) => console.log("pageerror:", e.message));
      page.on("requestfailed", (r) =>
        console.log("requestfailed:", r.url(), r.failure() && r.failure().errorText),
      );
      await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
      await page.screenshot({ path: "screenshot.png", fullPage: true });
      // Interact and assert, for example:
      // await page.getByRole("button", { name: "Go" }).click();
      // await page.waitForSelector("#result");
      await browser.close();
    })();

- Use role/text/test-id locators ("page.getByRole", "page.getByText",
  "page.getByTestId") for stable checks.
- "page.screenshot(...)" gives you a visual look; the console and requestfailed
  listeners surface errors.
- Fix the app, restart or reload the server as needed, and run the script again.
- Stop any server you started before reporting the work as done.
`;
}

function builtinSkillFiles(): BuiltinSkillFile[] {
  return [
    {
      name: "mcp-management",
      description: MCP_MANAGEMENT_DESCRIPTION,
      body: mcpManagementSkillBody(),
    },
    {
      name: "skills-management",
      description: SKILLS_MANAGEMENT_DESCRIPTION,
      body: skillsManagementSkillBody(),
    },
    {
      name: "mini-app-development",
      description: MINI_APP_DEVELOPMENT_DESCRIPTION,
      body: miniAppDevelopmentSkillBody(),
    },
  ];
}

/**
 * Write the built-in skills onto disk. Idempotent (a current file is left
 * untouched) and best-effort (a failure is logged, never thrown), so a broken
 * skill can never block startup or an assistant session.
 */
export function materializeBuiltinSkills(): void {
  const root = getBuiltinSkillsDir();
  for (const skill of builtinSkillFiles()) {
    const dir = join(root, skill.name);
    const file = join(dir, SKILL_FILE);
    const content = renderSkillFile(skill);
    try {
      if (existsSync(file) && readFileSync(file, "utf8") === content) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, content, "utf8");
    } catch (err) {
      console.error(
        `[builtin-skills] failed to write ${skill.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
