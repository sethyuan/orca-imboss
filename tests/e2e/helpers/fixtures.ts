import type { Page } from "@playwright/test";

/**
 * Fixtures built through the app's own preload bridge.
 *
 * Everything a test needs to set up is created by calling the same IPC channels
 * the UI calls (`window.imb.*` from inside the page), so the database ends up in
 * a state the app itself could have produced — no direct SQLite writes, no
 * second schema definition to drift.
 *
 * Deliberately *not* included: `chat:send`. Sending a real message wakes the
 * assistant agent, which needs a configured model provider (and would spend
 * tokens). Fixtures therefore only append stored messages; the agent path is out
 * of scope for this suite (see `tests/e2e/README.md`).
 */

/** The assistant employee row every new database is seeded with. */
export const ASSISTANT_ID = 0;

/**
 * The parts of the preload bridge these fixtures use. Kept local and minimal on
 * purpose: the real contract lives in `src/preload/index.ts`, and a test that
 * needs a new channel should add it here (which is also a reminder to check the
 * shape in the preload types).
 */
interface TestBridge {
  chats: {
    create(
      title: string,
      participants: number[],
    ): Promise<{ id: number; title: string }>;
    createDirect(
      employeeId: number,
    ): Promise<{ id: number; title: string; directEmployeeId: number | null }>;
    summaries(): Promise<
      Array<{ id: number; directEmployeeId: number | null }>
    >;
  };
  employees: {
    create(input: {
      name: string;
      role: string;
      systemPrompt: string;
    }): Promise<{ id: number; name: string }>;
  };
  messages: {
    append(
      chatId: number,
      senderEmployeeId: number | null,
      content: string,
    ): Promise<unknown>;
  };
  theme: {
    get(): Promise<{ mode: string; color: string }>;
  };
}

/** How `window` looks from inside `page.evaluate`. */
type PageWindow = { imb: TestBridge };

/** Create a conversation and return its id. */
export async function createChat(window: Page, title: string): Promise<number> {
  return await window.evaluate(async (chatTitle: string) => {
    const imb = (window as unknown as PageWindow).imb;
    const chat = await imb.chats.create(chatTitle, []);
    return chat.id;
  }, title);
}

/**
 * Create an employee direct chat (a root chat whose conversation partner is one
 * employee) and return its id.
 */
export async function createDirectChat(
  window: Page,
  employeeId: number,
): Promise<number> {
  return await window.evaluate(async (id: number) => {
    const imb = (window as unknown as PageWindow).imb;
    const chat = await imb.chats.createDirect(id);
    return chat.id;
  }, employeeId);
}

/** Create one regular employee (never the assistant) and return its id. */
export async function createEmployee(
  window: Page,
  name: string,
  role = "Researcher",
): Promise<number> {
  return await window.evaluate(
    async (input: { name: string; role: string }) => {
      const imb = (window as unknown as PageWindow).imb;
      const employee = await imb.employees.create({
        name: input.name,
        role: input.role,
        systemPrompt: "",
      });
      return employee.id;
    },
    { name, role },
  );
}

/** Append one stored message; `senderEmployeeId: null` means the boss. */
export async function appendMessage(
  window: Page,
  chatId: number,
  senderEmployeeId: number | null,
  content: string,
): Promise<void> {
  await window.evaluate(
    async (input: {
      chatId: number;
      senderEmployeeId: number | null;
      content: string;
    }) => {
      const imb = (window as unknown as PageWindow).imb;
      await imb.messages.append(
        input.chatId,
        input.senderEmployeeId,
        input.content,
      );
    },
    { chatId, senderEmployeeId, content },
  );
}

/** The current (persisted) theme state as the main process reports it. */
export async function readTheme(
  window: Page,
): Promise<{ mode: string; color: string }> {
  return await window.evaluate(async () => {
    const imb = (window as unknown as PageWindow).imb;
    return await imb.theme.get();
  });
}

/** Rows of the list pane — the shared list shell every module renders into. */
export function listRows(window: Page) {
  return window.locator('section[aria-label="List"] .imb-list-row');
}

/** Rows of the detail pane (the module's right-hand side). */
export function detailPane(window: Page) {
  return window.locator('section[aria-label="Detail"]');
}

/**
 * The transcript of the open conversation.
 *
 * Scoped separately from the detail pane because the pane also hosts the
 * "my messages" jump list, whose entries repeat message text — an unscoped text
 * assertion matches twice and fails on strict mode.
 */
export function thread(window: Page) {
  return window.locator(".imb-thread");
}
