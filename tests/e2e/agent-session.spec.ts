import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import {
  appendMessage,
  ASSISTANT_ID,
  createChat,
  createEmployee,
  detailPane,
  thread,
} from "./helpers/fixtures";
import { seedSessionTranscript } from "./helpers/session-fixture";

/**
 * The agent-session composer (`SessionComposer`), now the same
 * `ComposerCard` as the chat composer: attachments included, common projects
 * excluded.
 *
 * What is asserted here is only what the UI can prove without sending a message
 * — `chat:send` / `agentSession:send` wake a Pi agent, which needs a configured
 * model provider (see `tests/e2e/README.md`). So: the attach controls exist, a
 * file becomes a chip (and can be removed), the send button follows the draft,
 * and the attach menu offers exactly File / Folder / Conversation with no
 * common-project rows — even when a common project **is** configured, which is
 * what makes that assertion meaningful.
 *
 * The main-process half (prompt composition + the shared attachment validation
 * `agentSession:send` applies) is covered headlessly by `pnpm test`
 * (`scripts/tests/unit-checks.ts`).
 */

let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

/** A PNG payload; only its bytes matter (the chip never decodes it). */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Seed one assistant message and open that sender's agent session. */
async function openAssistantSession(
  window: LaunchedApp["window"],
): Promise<void> {
  const chatId = await createChat(window, "E2E session");
  await appendMessage(window, chatId, ASSISTANT_ID, "assistant says hello");
  await app!.reload();
  await thread(window).getByRole("button", { name: "Assistant" }).click();
  await expect(
    window.getByPlaceholder("Message Assistant directly"),
  ).toBeVisible();
}

/** Store one common project (tags only — no folder, no filesystem access). */
async function seedCommonProject(window: LaunchedApp["window"]): Promise<void> {
  await window.evaluate(async () => {
    const imb = (
      window as unknown as {
        imb: {
          settings: { set(key: string, value: string): Promise<void> };
        };
      }
    ).imb;
    await imb.settings.set(
      "app.commonProjects",
      JSON.stringify([{ name: "E2E project", tags: ["e2e"] }]),
    );
  });
}

test("the agent-session composer attaches a file and removes the chip", async () => {
  const session = app!;
  const { window } = session;
  await openAssistantSession(window);

  const composer = window.locator(".imb-session-composer");
  await expect(composer.getByRole("button", { name: "Attach" })).toBeVisible();

  // Empty draft → the send button is off; a file alone is enough to send.
  const send = composer.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();

  await composer.locator('input[type="file"]').setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });

  const chip = composer.locator(".imb-attached-file-thumb");
  await expect(chip).toHaveCount(1);
  await expect(send).toBeEnabled();

  await chip.getByRole("button", { name: /Remove/ }).click();
  await expect(chip).toHaveCount(0);
  await expect(send).toBeDisabled();
});

test("the session attach menu has no common projects", async () => {
  const session = app!;
  const { window } = session;
  await seedCommonProject(window);
  await openAssistantSession(window);

  const composer = window.locator(".imb-session-composer");
  await composer.getByRole("button", { name: "Attach" }).click();

  const rows = window.locator('[role="menu"] [role="menuitem"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveText("File");
  await expect(rows.nth(1)).toHaveText("Folder");
  await expect(rows.nth(2)).toHaveText("Conversation");
  await expect(
    window.getByRole("menuitem", { name: /E2E project/ }),
  ).toHaveCount(0);
});

test("the chat composer still offers attachments and the common projects", async () => {
  const session = app!;
  const { window } = session;
  await seedCommonProject(window);
  const chatId = await createChat(window, "E2E composer");
  await appendMessage(window, chatId, null, "a question from the boss");
  await session.reload();

  await window
    .locator('section[aria-label="List"] .imb-list-row')
    .first()
    .click();
  const pane = detailPane(window);
  await expect(
    pane.getByPlaceholder("What are your instructions?"),
  ).toBeVisible();

  // Attach + remove still work on the chat side (the card was extracted).
  const send = pane.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await pane.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(pane.locator(".imb-attached-file-thumb")).toHaveCount(1);
  await expect(send).toBeEnabled();
  await pane
    .locator(".imb-attached-file-thumb")
    .getByRole("button", { name: /Remove/ })
    .click();
  await expect(pane.locator(".imb-attached-file-thumb")).toHaveCount(0);
  await expect(send).toBeDisabled();

  // The common project is listed here (the session composer above is not).
  await pane.getByRole("button", { name: "Attach" }).click();
  const rows = window.locator('[role="menu"] [role="menuitem"]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toContainText("E2E project");
});

/**
 * The per-turn boss hint a session-view send carries must be invisible in the
 * transcript: the projection peels it off (byte-exactly) and keeps the boss's
 * own words, while the attachment block still becomes chips.
 *
 * `chat:send` / `agentSession:send` need a model, so the transcript is written
 * directly in the Pi session format (see `helpers/session-fixture.ts`). The
 * hint text below is `BOSS_DIRECT_HINT` from
 * `src/main/agent/boss-direct-prompt.ts` — the fixture is deliberately literal:
 * if that constant changes, this test keeps seeding the old one, the projection
 * no longer recognizes it, and the assertion fails loudly instead of passing
 * silently.
 */
test("a boss prompt typed in the session view hides the per-turn hint", async () => {
  const session = app!;
  const { window } = session;
  const name = "Ada";
  const employeeId = await createEmployee(window, name, "Researcher");
  const chatId = await createChat(window, "E2E hint chat");
  // Gives the thread an avatar to open this employee's session from.
  await appendMessage(window, chatId, employeeId, "assistant placeholder");

  const typed = "帮我把这份草稿整理成 SRT";
  const hint =
    "[This message was typed by the boss directly in this session. " +
    "Answer him with your final response — he reads it right here, so that text IS the reply. " +
    "Do not re-post the same answer with `imb_send_message` in this turn. " +
    "Anything you owe another assigner in a task group still goes to that group as before, " +
    "and if this reply is itself the deliverable, treat it the same way.]";
  const attachmentPath = `${session.dataRoot}/workdir/draft.md`;
  await seedSessionTranscript(session, employeeId, chatId, [
    {
      role: "user",
      text: `${typed}\n\n${hint}\n\n[Attachments]\n- draft.md (text/markdown, 2.0 KB): ${attachmentPath}`,
    },
    { role: "assistant", text: "调研完成：可行。" },
  ]);
  await session.reload();

  await thread(window).getByRole("button", { name }).click();

  // The session opens as its own single-pane module (the Nav entry appears), so
  // the transcript is scoped by its own container rather than the list/detail
  // pane the chat module uses.
  const transcript = window.locator(".imb-session-thread");
  // The boss's words, in full, and nothing else.
  await expect(transcript.locator(".imb-session-user-text")).toHaveText(typed);
  await expect(transcript).not.toContainText("typed by the boss directly");
  await expect(transcript).toContainText("调研完成：可行。");
  // The attachment block is still parsed into a chip.
  await expect(
    transcript.locator(".imb-session-attachments .imb-bubble-chip-name"),
  ).toHaveText("draft.md");
});
