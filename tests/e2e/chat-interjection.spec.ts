import { expect, test, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import {
  appendMessage,
  createDirectChat,
  createEmployee,
  detailPane,
  listRows,
  thread,
} from "./helpers/fixtures";
import {
  configureMockProvider,
  settleRun,
  startEmployeeRun,
  startMockModel,
  type MockModel,
} from "./helpers/mock-provider";

/**
 * The "sent, not yet in the transcript" row of an employee direct chat — the
 * only place a chat send is visible before Pi persists it, because that detail
 * pane renders the **session projection** instead of the conversation's
 * `messages`.
 *
 * Two bugs the boss reported, both about this row, both fixed here:
 * - sending while the employee is mid-turn used to show **two** rows for one
 *   message (the view's own placeholder plus the interjection main reported);
 * - a normal send used to flash a status line, because the placeholder said
 *   "waiting" immediately and the transcript caught up a moment later.
 *
 * The withdrawal case also has to take the **stored message** with it: the text
 * never reached the model, so a row left in `messages` would keep a message in
 * the list preview and in search that the conversation never contained.
 *
 * A run is a real Pi run against the local mock model (`helpers/mock-provider.ts`):
 * "is the employee streaming right now" is live state, and the duplicate only
 * exists in that window.
 */

let app: LaunchedApp | undefined;
let mock: MockModel | undefined;

test.beforeEach(async () => {
  app = await launchApp();
  // Long enough to stay streaming while the test sends, withdraws and settles;
  // `settleRun` ends it, so this is only a ceiling.
  mock = await startMockModel({ tokens: 600, delayMs: 200 });
  await configureMockProvider(app.window, mock.port);
  await app.reload();
});

test.afterEach(async () => {
  await mock?.close();
  await app?.close();
});

/** Placeholder of a conversation's composer (a direct chat offers no `@`/`#`). */
const COMPOSER_PLACEHOLDER = "What are your instructions?";

interface StoredMessage {
  content: string;
  attachments: Array<{ name: string }>;
}

interface SessionBridge {
  agentSession: {
    state(employeeId: number, chatId: number): Promise<{ streaming: boolean }>;
  };
  messages: { list(chatId: number): Promise<StoredMessage[]> };
}

/** The employee is streaming a run right now (a send would be a steer). */
async function isStreaming(
  window: Page,
  employeeId: number,
  chatId: number,
): Promise<boolean> {
  return await window.evaluate(
    async (payload: string) => {
      const [id, chat] = JSON.parse(payload) as [number, number];
      const api = (window as unknown as { imb: SessionBridge }).imb;
      const state = await api.agentSession.state(id, chat);
      return state.streaming;
    },
    JSON.stringify([employeeId, chatId]),
  );
}

/** The conversation's **stored** messages (`messages` table), as the app reads them. */
async function storedMessages(
  window: Page,
  chatId: number,
): Promise<StoredMessage[]> {
  return await window.evaluate(async (id: number) => {
    const api = (window as unknown as { imb: SessionBridge }).imb;
    return await api.messages.list(id);
  }, chatId);
}

/** Contents of the conversation's **stored** messages (`messages` table). */
async function storedContents(window: Page, chatId: number): Promise<string[]> {
  return (await storedMessages(window, chatId)).map(
    (message) => message.content,
  );
}

/** A direct chat with one stored boss message, opened in the chat module. */
async function openDirectChat(
  window: Page,
  name: string,
): Promise<{ employeeId: number; chatId: number }> {
  const employeeId = await createEmployee(window, name);
  const chatId = await createDirectChat(window, employeeId);
  // Gives the list row a title, so it can be clicked like the boss would.
  await appendMessage(window, chatId, null, "kick off");
  await app!.reload();
  await listRows(window).filter({ hasText: "kick off" }).click();
  await expect(detailPane(window).locator(".imb-session-thread")).toBeVisible();
  return { employeeId, chatId };
}

test("one steered chat send is one row, and withdrawing it deletes the stored message", async () => {
  const session = app!;
  const { window } = session;
  const { employeeId, chatId } = await openDirectChat(window, "Ada");

  // A live run: the next chat send is handed to it as a steering message, which
  // is exactly the state that used to produce two rows.
  await startEmployeeRun(window, chatId, employeeId);
  await expect.poll(() => isStreaming(window, employeeId, chatId)).toBe(true);

  const pane = detailPane(window);
  const composer = pane.getByPlaceholder(COMPOSER_PLACEHOLDER);
  await composer.fill("stop after the build");
  await composer.press("Enter");

  // One message, one bubble: the placeholder the view drew for the send becomes
  // the interjection main reports (matched on the send's own id), instead of
  // being joined by a second, separately-registered row.
  const rows = pane.locator(".imb-session-pending");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByText("stop after the build")).toHaveCount(1);
  // …and that single row is the withdrawable one (the merge used to leave the
  // plain "waiting" row next to a separate 「Withdraw」 row).
  const withdraw = rows.getByRole("button", { name: "Withdraw" });
  await expect(withdraw).toBeVisible();
  // The button *is* the state: no "waiting" line survives the upgrade.
  await expect(rows.getByText("Sent — waiting for the agent")).toHaveCount(0);

  await withdraw.click();
  await expect(rows).toHaveCount(0);

  // The text is handed back to the composer this view actually renders (the
  // chat composer's draft, not the agent-session composer's).
  await expect(composer).toHaveValue("stop after the build");

  // The withdrawal takes the stored message with it: the model never received
  // it, so nothing may keep it in the conversation (list preview, search).
  await expect
    .poll(() => storedContents(window, chatId))
    .not.toContain("stop after the build");

  await settleRun(window, employeeId, chatId);
});

test("a send into a warm session shows no status line before the transcript catches up", async () => {
  const session = app!;
  const { window } = session;
  const { employeeId, chatId } = await openDirectChat(window, "Grace");

  // Warm the session with one run, so the send under test reaches the
  // transcript within moments — the case the status line used to flash in.
  await startEmployeeRun(window, chatId, employeeId);
  await expect.poll(() => isStreaming(window, employeeId, chatId)).toBe(true);
  await settleRun(window, employeeId, chatId);
  await expect.poll(() => isStreaming(window, employeeId, chatId)).toBe(false);

  const pane = detailPane(window);
  const composer = pane.getByPlaceholder(COMPOSER_PLACEHOLDER);
  await composer.fill("no insertion line please");
  await composer.press("Enter");

  // The "waiting" line is delayed past the moment the projection normally
  // carries the message, so a plain send never shows it (this is the line the
  // boss saw flash under the bubble).
  await expect(pane.locator(".imb-session-pending-hint")).toHaveCount(0);
  // The message itself lands as a normal transcript row.
  await expect(thread(window)).toContainText("no insertion line please");

  await settleRun(window, employeeId, chatId);
});

/** A PNG payload; only its bytes matter (the chip never decodes it). */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

test("withdrawing a chat send puts its attachment chips back, and they can be sent again", async () => {
  const session = app!;
  const { window } = session;
  const { employeeId, chatId } = await openDirectChat(window, "Ada");

  await startEmployeeRun(window, chatId, employeeId);
  await expect.poll(() => isStreaming(window, employeeId, chatId)).toBe(true);

  const pane = detailPane(window);
  const composer = pane.getByPlaceholder(COMPOSER_PLACEHOLDER);
  const attachInput = pane.locator('.imb-chat-input-wrap input[type="file"]');
  const chips = pane.locator(".imb-attached-file-thumb");

  await composer.fill("check the diagram");
  await attachInput.setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(chips).toHaveCount(1);

  await composer.press("Enter");
  const rows = pane.locator(".imb-session-pending");
  await expect(rows).toHaveCount(1);
  // The placeholder row carries the chip while the message waits.
  await expect(rows).toContainText("diagram.png");

  await rows.getByRole("button", { name: "Withdraw" }).click();
  await expect(rows).toHaveCount(0);

  // Text **and** chips come back together, so the boss can fix the message and
  // send it again instead of re-attaching the file by hand.
  await expect(composer).toHaveValue("check the diagram");
  await expect(chips).toHaveCount(1);
  await expect(
    chips.getByRole("button", { name: "Remove diagram.png" }),
  ).toBeVisible();

  // The restored chip is an ordinary chip: it can be dropped again.
  await chips.getByRole("button", { name: /Remove/ }).click();
  await expect(chips).toHaveCount(0);
  await expect(composer).toHaveValue("check the diagram");

  // Re-attaching and re-sending works, and the new message carries exactly one
  // attachment — the restored metadata is reused, nothing is uploaded twice.
  await attachInput.setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(chips).toHaveCount(1);
  await composer.press("Enter");

  await expect
    .poll(async () => {
      const messages = await storedMessages(window, chatId);
      return messages.filter(
        (message) => message.content === "check the diagram",
      );
    })
    .toHaveLength(1);
  const resent = (await storedMessages(window, chatId)).filter(
    (message) => message.content === "check the diagram",
  );
  expect(resent[0].attachments.map((attachment) => attachment.name)).toEqual([
    "diagram.png",
  ]);

  await settleRun(window, employeeId, chatId);
});
