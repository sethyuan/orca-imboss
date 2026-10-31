# E2E tests (Playwright + the real Electron app)

These tests launch the **actual desktop app** (the `out/` build) and drive it like
the boss would: click, type, read the screen. They exist so a development task can
verify "the app still works" without asking the boss to click through it by hand.

```bash
pnpm test:e2e          # builds out/ (~2 s) then runs every case — ~10 s total
pnpm test:e2e:only     # skips the build: use while iterating on ONE test
pnpm exec playwright test tests/e2e/chat.spec.ts        # one file
pnpm exec playwright test -g "search"                   # one test by title
```

Requires a prior `pnpm install` (Playwright is a devDependency) and a built app;
`test:e2e` builds it for you.

## When to run them

- You changed anything the user can see or click (`src/renderer/**`).
- You changed a channel's shape or an IPC handler the UI depends on
  (`src/preload/index.ts`, `src/main/ipc/**`).
- You touched window/shell behaviour (`src/main/main-window.ts`, `src/main/index.ts`).
- Before reporting a UI task as done — this is the "self-check" that used to be
  `pnpm dev` + manual clicking.

Node-only logic (db, agent, integrations, rpc) is covered by
`pnpm test:remote` (the equivalence harness) instead; E2E is not the tool for it.

## What "isolated" means here (why this never touches the boss's data)

`tests/e2e/helpers/app.ts` launches the app with two throw-away folders:

| Env / flag                       | What it isolates                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `IMBOSS_DATA_ROOT=<tmp>/data`    | the business data: SQLite, avatars, attachments, agent env (`auth.json`, skills, sessions), mini apps, the default workdir |
| `--user-data-dir=<tmp>/userdata` | Electron's own state, **including the single-instance lock**                                                               |
| `--lang=en-US`                   | the UI locale (the app otherwise derives it from the OS)                                                                   |

Both paths are asserted to live under `os.tmpdir()` _and_ to be what the app
actually resolved, so the suite fails loudly if isolation ever breaks. That is why
tests can run while the installed `imboss.app` is open, and why they never read or
write `~/.imboss`.

The folders are deleted when the app closes. Keep them for debugging with:

```bash
IMBOSS_E2E_KEEP=1 pnpm exec playwright test -g "search"
```

## When a test fails: read the trace first

A failure leaves artefacts in `test-results/<test-name>/`:

```
trace.zip            ← DOM snapshot timeline + console + network (open this first)
test-failed-1.png    ← the window at the moment of failure
error-context.md     ← the accessibility tree Playwright matched against
```

```bash
pnpm exec playwright show-trace test-results/<test-name>/trace.zip
```

`playwright-report/index.html` (written after every run) groups the same per test.
The trace usually answers "what did the app actually show" in seconds — that is the
whole point of the suite; do not paste screenshots to each other before looking at
it.

## Writing a test

- `tests/e2e/*.spec.ts` — one file per area (`smoke`, `chat`, `navigation`,
  `settings`). Only `*.spec.ts` is collected; `helpers/**` is not.
- Start with `launchApp()` (`helpers/app.ts`) and always `close()` it in
  `afterEach`, even if a test throws.
- Build fixtures through the app's own IPC with `helpers/fixtures.ts`
  (`createChat`, `appendMessage`, …) and then `await session.reload()`: the
  assertions then describe what the app reads back **from disk**, not React state.
- Locators, in order of preference: `getByRole(...)` with the accessible name,
  then text, then a stable structural anchor (`section[aria-label="List"]`,
  `.imb-thread`). Avoid CSS-class chains that only encode styling.
  The UI is English here because `--lang=en-US` is pinned — write the assertions
  against the English strings.
- Scope text assertions to the narrowest container (`.imb-thread` for the
  transcript): the detail pane also renders a "my messages" jump list that repeats
  message text, and an unscoped locator fails on strict mode.

## Known limits (deliberate scope)

- **No agent turn.** `chat:send` wakes the Pi agent, which needs a configured model
  provider (and spends tokens). Fixtures therefore append stored messages only. A
  deterministic model (local fake OpenAI-compatible server) is the follow-up if
  agent behaviour ever needs coverage.
- **No native UI.** Tray menu, native file dialogs and OS notifications cannot be
  clicked by Playwright. Dialogs/notifications _can_ be stubbed from the main
  process (`electronApp.evaluate(({ dialog }) => …)`); the tray can only be
  verified indirectly.
- **No packaged build.** Tests run the `electron-vite build` output, not the asar
  bundle; packaging is still verified by `pnpm dist:local` + a manual pass.
- **Not in CI.** The tests pop a real window for 1–2 s per case (macOS has no
  headless Electron). They are a local, developer-driven check by decision.
- **Single worker.** Each case boots a whole Electron app; `workers: 1` keeps it
  predictable. A full run is ~10 s, so there is nothing to gain from parallelism.
