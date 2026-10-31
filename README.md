[简体中文](README.zh.md) · [Website](https://orca-studio.com/imboss/)

# imboss

**Run a one-man company with AI employees — from a single chat window.**

imboss is a desktop app where you chat with an AI **Assistant** who acts as your chief of staff. Tell it what you need, and it assembles a team of AI **Employees**, hands out the work in group chats, keeps you posted on progress, and reports back with the result.

<img width="1938" height="1412" alt="imboss" src="https://github.com/user-attachments/assets/e785e2e1-145a-436b-a1e6-975710ffbd24" />

## Intro Video

[imboss intro video](https://www.bilibili.com/video/BV1e3po6rET6/?share_source=copy_web&vd_source=89506ada1738e6a7900dc6eb24d24da5)

## How it works

1. **You talk to the Assistant.** Chat naturally, like messaging a colleague — no prompt engineering required.
2. **The Assistant plans and staffs the job.** It breaks your request into tasks, checks who is already on the team, recruits specialists when the right expertise is missing, and opens a task group chat.
3. **Employees do the work.** Each employee has its own role, persona, model, tools, skills and MCP servers. They research, write, run commands and produce real deliverables.
4. **The team coordinates itself.** Employees @-mention each other, ask questions and report results, while the Assistant keeps the task moving and unblocks them.
5. **You stay in control.** Follow progress in the chat, answer questions when a decision is genuinely needed, and receive the finished result.

## Features

### Chat-first workspace

- A WeChat-style messaging UI: conversation list, message bubbles, avatars, unread badges and read state.
- Attachments (images and files), rich Markdown rendering with syntax highlighting and KaTeX math.
- Dedicated **ask cards** collect structured answers from you, while **progress cards** show the live step-by-step status of a task.
- One window, one instance — always.

### An Assistant that manages the team

- A built-in Assistant (the team's orchestrator) plots the plan, recruits employees, creates task chats, assigns work and reports to you.
- You can edit its persona and system prompt, and tune how it works, from the assistant's detail page.

### A team of employees

- **Recruit** specialists with a name, role and persona; pick an avatar and a system prompt that defines who they are and how they work.
- Give each employee their own **model** and **thinking level**, or let them follow the app default.
- Equip employees with **skills**, **MCP servers**, and optional **scheduled tasks**.
- Employees reply in the same language you use, and report their results back to whoever assigned the task.

### Task group chats

- The Assistant opens a **group chat** per task and @-mentions the employees who own each part.
- Group chats are readable from your chat list, showing the full back-and-forth between your employees.
- Questions, answers and reports flow through the same messaging model, so you can audit how any result was produced.

### Model providers

- Connect providers through a curated list (Anthropic, OpenAI, DeepSeek, Google, Groq, MiniMax, Moonshot AI, OpenRouter, OpenCode Zen, OpenCode Go, xAI, Xiaomi, Xiaomi Token Plan (CN/AMS/SGP), Z.ai, GitHub Copilot, and more) or add a **custom** provider.
- Supports OpenAI-compatible completions/responses, Anthropic Messages and Google Generative AI APIs.
- Fetch available models with one click, and keep API keys masked behind an explicit reveal.

### MCP servers

- Register [Model Context Protocol](https://modelcontextprotocol.io) servers over **stdio** or **streamable HTTP**.
- Assign servers per employee, so each session only connects the tools it actually needs.
- Per-server environment variables, plus app-wide environment variables shared with tools and servers.

### Skills

- Install [Agent Skills](https://agentskills.io) from local folders (`SKILL.md` is the source of truth) and uninstall them when done.
- Choose exactly which skills each employee can use.
- The Assistant ships with built-in skills that let it manage MCP servers, manage skills and build mini apps on your behalf.

### Mini Apps

- Run local web apps directly in the sidebar next to your chats.
- A mini app is just a folder with a `metadata.json`; it can be a static page or a process you start (with command, args, cwd and env).
- Mini apps keep running while you move between modules, and the Assistant can create and debug them for you.

### Scheduled tasks

- Give an employee a cron schedule to wake it up automatically — e.g. a daily digest or a periodic check.
- See the next run time and toggle tasks on or off per employee.
- Tasks run while the app is open (in-process scheduler, not an OS service).

### Messaging integrations

- Bridge imboss to your real messaging apps so you can work from your phone:
  - **WeChat** via the official iLink Bot (QR-code login).
  - **QQ** via the official QQ Bot platform.
  - **Telegram** via a @BotFather bot.
- Owner accounts are whitelisted: messages you send are treated as yours, and the Assistant's replies are delivered back to that conversation.
- Inbound images and files are imported into the chat; outbound messages are forwarded natively.

### Notifications

- Native desktop notifications when an agent posts while the window is in the background — click to jump straight to the chat.
- Unread counters and a notification sound keep you aware of new activity.

### Appearance and language

- Light, dark and system themes with **18 accent colors**.
- English and Simplified Chinese, defaulting to your system locale.

### Private and local by design

- Everything lives in a single folder in your home directory: **`~/.imboss`** — database, avatars, agent environment, sessions and mini apps.
- imboss manages its own isolated Pi agent environment, so it never touches a system-wide Pi installation.
- API keys are stored locally with restrictive file permissions.

### Remote mode

- Run the **backend on a remote server** as a plain Node.js package and connect the desktop app to it from your machine. Started without flags, imboss behaves exactly as before: everything local, no network.
- Chats, agents, scheduled tasks, integrations and your data live on the server; the desktop keeps the window, tray, shortcut, notifications and its own updates.
- The two sides talk over gRPC with a shared token. Files you attach are uploaded to the server, and images in the history are fetched from it on demand.

**Server** (Node.js >= 22, a writable home directory; build the zip with `pnpm run build:remote`, see [Building](#building)):

```bash
unzip imboss-backend-<version>.zip && cd imboss-backend-<version>
npm install --omit=dev      # the zip ships no node_modules; better-sqlite3 has prebuilt binaries
node main.cjs --init        # writes ~/.imboss/server.json (mode 0600) and prints the token
node main.cjs               # run under systemd/pm2 — see systemd/imboss-backend.service
```

**Desktop**:

```bash
imboss --remote=<host>:47810 --remote-token-file=$HOME/.imboss-token
```

| Flag                                     | Meaning                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `--remote=<host:port>`                   | Connect to a backend instead of running locally.                                       |
| `--remote-token-file=<path>`             | Read the token from a file (recommended).                                              |
| `--remote-token-env=<NAME>`              | Read the token from an environment variable.                                           |
| `--remote-token=<token>`                 | Inline token — debugging only, it is visible in the process list.                      |
| `--remote-ca=<pem>`, `--remote-insecure` | Accepted for forward compatibility; this version speaks plaintext gRPC and only warns. |

Server side: `--init`, `--config <path>`, `--data-root <path>`, `--listen <host:port>` (default `0.0.0.0:47810`), `--token-file <path>`, `--token <token>` (debugging only), `--version`, `--help`. The token is also read from `IMBOSS_TOKEN` / `IMBOSS_TOKEN_FILE`.

**Security.** The transport is plaintext gRPC and the shared token is the only authentication. Do not expose the port to the open internet: put it behind a firewall, or use an SSH tunnel (`ssh -L 47810:127.0.0.1:47810 host` together with `--listen 127.0.0.1:47810`) or a private network such as Tailscale or WireGuard.

**Known limits.** One client per backend (a second one is rejected with a clear message), Mini Apps are hidden in remote mode, the backend has no self-update (replace the folder and restart). Attachments are capped at 50 MiB; imports (backup and employee packages) are streamed to disk and capped at 2 GiB.

### Automatic updates

- Built-in updates from GitHub releases: get notified, download and restart to apply.

## Getting started

**Prerequisites**

- Node.js >= 22
- pnpm >= 9
- Build tools for native modules (Xcode CLT on macOS, MSVC on Windows, `build-essential` on Linux)

**Install and run**

```bash
pnpm install            # install deps and rebuild native modules for Electron
pnpm dev                # start the app with hot reload
```

On first launch, add a model provider in **Providers**, then say hello to your Assistant in **Chats**.

## Building

```bash
pnpm build              # typecheck + build
pnpm run build:remote   # headless backend → dist/imboss-backend-<version>.zip
pnpm dist:mac           # macOS (DMG + ZIP)
pnpm dist:win           # Windows (NSIS installer)
pnpm dist:linux         # Linux (AppImage)
```

`build:remote` bundles the backend entry into `main.cjs`, writes a `package.json` with runtime dependencies only (no `postinstall`) and packs it with a `proto/` contract, a README and a systemd unit. **No `node_modules` is shipped** — the server installs its own, which is what lets the native `better-sqlite3` binary match the server's platform.

## License

imboss is **dual-licensed**:

- **Open source — GPL-3.0.** Free for personal use. The full text is in [LICENSE](LICENSE).
- **Commercial license.** Required for **any use by or within an enterprise, including purely internal use**. See [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) and contact [kefroth@outlook.com](mailto:kefroth@outlook.com) for details.

If you use imboss under GPL-3.0 you must comply with all of its terms, including making your derivative work available under the same license. Note that GPL-3.0 compliance alone does **not** grant enterprise use: any use by or within an enterprise requires a commercial license. If you cannot or do not want to comply with GPL-3.0, or if you need enterprise use, a commercial license is required.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Contributor License Agreement](CLA.md).

## Under the hood

- **Runtime** — Electron 44, React 19 + TypeScript, `electron-vite`.
- **Data** — `better-sqlite3` in WAL mode. In local mode it stays in the main process behind IPC; in remote mode a plain Node.js backend owns it and the desktop reaches it over gRPC.
- **Agent** — the [Pi SDK](https://github.com/earendil-works/pi-coding-agent), isolated under `~/.imboss/agent`.
- **Updates & packaging** — `electron-updater` and `electron-builder`.

## Buy me a coffee

If you think the software I have developed is helpful to you and would like to give recognition and support, you may buy me a coffee using following link. Thank you for your support and attention.

<a href='https://ko-fi.com/R5R213X8MC' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi1.png?v=3' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
