import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { createChat } from "./helpers/fixtures";

/**
 * The notification beep policy of a message arriving in the boss's own chat.
 *
 * The beep is decided in exactly one place — the `messages:changed` handler in
 * `src/renderer/app-store.ts` — and this file drives that handler through the
 * **real IPC event** the main process sends on every append (`webContents.send`
 * from the main process, fired here instead of by a DB write, because appending
 * through `messages:append` cannot carry a `kind` and must not wake an agent).
 *
 * What it pins down:
 * - `chat` link cards (posted by `imb_create_chat` when a task group is created)
 *   and `progress` cards are silent — they still bump the unread badge, but the
 *   boss hears nothing;
 * - every other kind keeps ringing (`report` / `ask` / plain `text`), and the
 *   existing gates still hold (no beep for `silent` app notices, for a muted
 *   conversation, or outside the boss's own chat).
 *
 * Sound itself is stubbed (see `stubAudio`): `src/renderer/sound.ts` builds
 * `new Audio(...)` and calls `play()`, so wrapping the prototype records the
 * decision without needing an audio device — and without the suite beeping at
 * whoever runs it.
 */

let app: LaunchedApp | undefined;
let chatId = 0;

/** The `messages:changed` payload, with the common case (the boss's chat) defaulted. */
interface ChangedPayload {
  chatId: number;
  senderEmployeeId: number | null;
  kind: string;
  silent: boolean;
  root: boolean;
  muted: boolean;
}

function rootChatMessage(kind: string): ChangedPayload {
  return {
    chatId,
    senderEmployeeId: 0,
    kind,
    silent: false,
    root: true,
    muted: false,
  };
}

/** One `messages:changed` event, sent by the main process like `appendMessage` does. */
async function emitChanged(
  payload: Partial<ChangedPayload> = {},
): Promise<void> {
  const session = app!;
  await session.app.evaluate(
    ({ BrowserWindow }, full: ChangedPayload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        "messages:changed",
        full,
      );
    },
    { ...rootChatMessage("text"), ...payload },
  );
}

/** How many beeps the renderer tried to play so far. */
async function beepCount(): Promise<number> {
  return await app!.window.evaluate(
    () => (window as unknown as { __beeps?: number }).__beeps ?? 0,
  );
}

/** Record `play()` calls on the DOM's media elements instead of making noise. */
async function stubAudio(page: LaunchedApp["window"]): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as { __beeps?: number };
    win.__beeps = 0;
    HTMLMediaElement.prototype.play = function play() {
      win.__beeps = (win.__beeps ?? 0) + 1;
      return Promise.resolve();
    };
  });
}

/** Node-side pause; the renderer handler runs on its own once the event lands. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give a deliberately not-beeping event time to (not) beep.
 *
 * The event crosses an IPC boundary, so a synchronous assertion would pass even
 * if the handler beeped a tick later; this is the quiet window that makes the
 * negative case meaningful.
 */
async function expectNoBeep(): Promise<void> {
  await sleep(300);
  expect(await beepCount()).toBe(0);
}

/**
 * Spend the beep throttle before a case that must ring: `playNotificationSound()`
 * drops a call within 1 s of the previous one, so a back-to-back case would look
 * silent for the wrong reason.
 */
async function spendThrottle(): Promise<void> {
  await app!.window.evaluate(() => {
    (window as unknown as { __beeps?: number }).__beeps = 0;
  });
  await sleep(1_100);
}

test.beforeEach(async () => {
  app = await launchApp();
  chatId = await createChat(app.window, "Beep policy");
  await stubAudio(app.window);
});

test.afterEach(async () => {
  await app?.close();
});

test("a chat link card is silent", async () => {
  // `imb_create_chat` posts this card into the chat it was created from; the
  // run it starts reports back through `report`, which is what rings.
  await emitChanged({ kind: "chat" });
  await expectNoBeep();

  // The card is not a special case of "the chat is not the boss's": a progress
  // card in the same chat stays silent for its own (older) reason, unchanged.
  await emitChanged({ kind: "progress" });
  await expectNoBeep();

  // Same kind in a muted conversation, and as an app-supplied silent notice.
  await emitChanged({ kind: "chat", muted: true });
  await expectNoBeep();
  await emitChanged({ kind: "chat", silent: true });
  await expectNoBeep();
});

test("every other kind in the boss's chat still rings", async () => {
  for (const kind of ["report", "ask", "text"]) {
    await spendThrottle();
    await emitChanged({ kind });
    await expect.poll(beepCount, { timeout: 3_000 }).toBeGreaterThan(0);
  }

  // Gates that are not about the kind: a task group never rings, and neither
  // does a silent notice.
  await spendThrottle();
  await emitChanged({ kind: "text", root: false });
  await expectNoBeep();
  await emitChanged({ kind: "text", silent: true });
  await expectNoBeep();
});
