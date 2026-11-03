import { expect, test } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import {
  appendMessage,
  createChat,
  createDirectChat,
  createEmployee,
  detailPane,
  listRows,
} from "./helpers/fixtures";

/**
 * Employee direct chats — a root conversation whose partner is one employee.
 *
 * The promise the feature was asked for: "New chat" on an employee's detail page
 * opens a conversation with that employee, and that conversation shows the
 * employee's **agent session** instead of the stored messages — with the
 * interrupt chip in the header and the employee's avatar everywhere the
 * conversation appears.
 *
 * Everything here is asserted on what the app reads back from disk: fixtures go
 * through the real IPC channels and the window is reloaded afterwards. `chat:send`
 * is never called (it would wake the employee and needs a model provider), so the
 * session transcript is legitimately empty — which is exactly what proves the
 * session view is rendered.
 */

let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  app = await launchApp();
});

test.afterEach(async () => {
  await app?.close();
});

/** The letter an employee without an uploaded picture shows in its avatar. */
function initial(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

test("new chat on an employee's detail page opens it with the caret in the composer", async () => {
  const session = app!;
  const { window } = session;
  const name = "Ada";
  const employeeId = await createEmployee(window, name);
  await session.reload();

  const nav = window.getByRole("navigation", { name: "Modules" });
  await nav.getByRole("button", { name: "Employees" }).click();
  await listRows(window).filter({ hasText: name }).first().click();
  await detailPane(window)
    .getByRole("button", { name: "New Chat", exact: true })
    .click();

  // The chat module is active, the fresh (untitled) conversation is selected,
  // its header avatar is this employee's, and the composer has the caret.
  await expect(nav.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(detailPane(window)).toContainText("New Chat");
  await expect(
    detailPane(window).locator(".imb-chat-header-avatar .imb-avatar"),
  ).toHaveText(initial(name));
  await expect(
    detailPane(window).locator(".imb-chat-input-wrap textarea"),
  ).toBeFocused();

  // A *new* direct conversation was created for exactly this employee (the
  // assistant chat from the fresh database is not one of them).
  const directPartnerIds = await window.evaluate(async () => {
    const imb = (
      window as unknown as {
        imb: {
          chats: {
            summaries(): Promise<
              Array<{ id: number; directEmployeeId: number | null }>
            >;
          };
        };
      }
    ).imb;
    const summaries = await imb.chats.summaries();
    return summaries
      .filter((chat) => chat.directEmployeeId !== null)
      .map((chat) => chat.directEmployeeId);
  });
  expect(directPartnerIds).toEqual([employeeId]);
});

test("a direct chat renders the employee's agent session, not the conversation's messages", async () => {
  const session = app!;
  const { window } = session;
  const name = "Grace";
  const employeeId = await createEmployee(window, name);
  const chatId = await createDirectChat(window, employeeId);
  await appendMessage(window, chatId, null, "how is the build going?");
  await session.reload();

  // The list row shows the employee's avatar (not the title's initial)…
  const row = listRows(window).filter({ hasText: "how is the build going?" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".imb-avatar").first()).toHaveText(initial(name));
  await row.click();

  const detail = detailPane(window);
  // …and the detail pane is the session view (the same component the
  // agent-session module renders), not the message thread.
  await expect(detail.locator(".imb-session-thread")).toBeVisible();
  await expect(detail).toContainText("No session content yet");
  await expect(detail.locator(".imb-chat-thread-wrap")).toHaveCount(0);
  // The header carries the interrupt chip (idle ⇒ disabled) and this employee's
  // avatar, not the assistant's.
  await expect(
    detail.getByRole("button", { name: "Interrupt current turn" }),
  ).toBeDisabled();
  await expect(
    detail.locator(".imb-chat-header-avatar .imb-avatar"),
  ).toHaveText(initial(name));
});

test("an employee reply in a direct chat drives the list preview and unread badge", async () => {
  const session = app!;
  const { window } = session;
  const name = "Alan";
  const employeeId = await createEmployee(window, name);
  const chatId = await createDirectChat(window, employeeId);
  await appendMessage(window, chatId, null, "please check the log");
  // A second, newer conversation, so the direct chat is **not** the open one:
  // an open conversation is always read (that is the existing root-chat rule),
  // and the badge is what is under test here.
  await createChat(window, "Later conversation");
  await session.reload();

  // The reply main mirrors into `messages` once the employee's run settles (see
  // `session-queue.recordDirectChatReply`); the row shape is identical, so this
  // is the preview/unread machinery a real conversation relies on.
  await appendMessage(window, chatId, employeeId, "the log is clean");

  const row = listRows(window).filter({ hasText: "the log is clean" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".imb-unread")).toHaveText("1");
  await expect(row.locator(".imb-avatar").first()).toHaveText(initial(name));
});

test("the list picker filters by name and role and opens that employee's chat", async () => {
  const session = app!;
  const { window } = session;
  await createEmployee(window, "Ada", "Researcher");
  await createEmployee(window, "Bo", "Engineer");
  await session.reload();

  const picker = window.getByRole("combobox", { name: "Chat with employee" });
  await expect(picker).toBeEnabled();

  // It sits to the RIGHT of the New Chat button and reads as a borderless
  // disclosure control (transparent surface, upward caret), not as a form field.
  const newChatBox = await window
    .getByRole("button", { name: "New Chat" })
    .boundingBox();
  const pickerBox = await picker.boundingBox();
  expect(newChatBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox!.x).toBeGreaterThan(newChatBox!.x + newChatBox!.width - 1);
  const triggerStyle = await picker.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
    };
  });
  expect(triggerStyle.borderColor).toBe("rgba(0, 0, 0, 0)");
  expect(triggerStyle.background).toBe("rgba(0, 0, 0, 0)");
  await expect(picker.locator("svg")).toHaveClass(/imb-is-up/);
  // Icon-only trigger: no text, the accessible name carries the action, the
  // caret is 14x14 inside a full 30px hit area.
  await expect(picker).toHaveAttribute("aria-label", "Chat with employee");
  await expect(picker).toHaveText("");
  expect(pickerBox!.width).toBeGreaterThanOrEqual(29);
  expect(pickerBox!.height).toBeGreaterThanOrEqual(29);
  const caretBox = await picker.locator("svg").boundingBox();
  expect(caretBox!.width).toBe(14);
  expect(caretBox!.height).toBe(14);

  await picker.click();

  // The assistant is not chattable this way — it is the New Chat button.
  const options = window.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(window.getByRole("option", { name: /Assistant/ })).toHaveCount(
    0,
  );

  // Filter by role: only the engineer is left.
  const search = window.getByPlaceholder("Search employees");
  await search.fill("engineer");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Bo");
  await expect(options.first()).toContainText("Engineer");

  // Filter by name (case-insensitive) as well.
  await search.fill("AD");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Ada");

  // Esc closes without picking, and nothing is remembered as "selected".
  await search.press("Escape");
  await expect(window.getByRole("option")).toHaveCount(0);

  // Keyboard: reopen, clear the filter, arrow down to the second employee and
  // press Enter — that picks it and lands in the new conversation.
  await picker.click();
  const search2 = window.getByPlaceholder("Search employees");
  await expect(window.getByRole("option")).toHaveCount(2);
  await search2.press("ArrowDown");
  await search2.press("Enter");
  const nav = window.getByRole("navigation", { name: "Modules" });
  await expect(nav.getByRole("button", { name: "Chats" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(detailPane(window)).toContainText("New Chat");
  await expect(
    detailPane(window).locator(".imb-chat-header-avatar .imb-avatar"),
  ).toHaveText("B");
  await expect(
    detailPane(window).locator(".imb-chat-input-wrap textarea"),
  ).toBeFocused();
});

test("the list picker says so when there is nobody to chat with", async () => {
  const session = app!;
  const { window } = session;
  // A fresh database holds only the assistant, which is not offered here. With
  // no text on the trigger, the reason is its accessible name (and tooltip).
  const picker = window.getByRole("combobox", {
    name: "No employees to chat with",
  });
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute(
    "aria-label",
    "No employees to chat with",
  );
});

test("keyboard navigation scrolls the highlighted option into the panel", async () => {
  const session = app!;
  const { window } = session;
  // More employees than the panel can show, so the list really scrolls.
  for (const name of [
    "Ada",
    "Bo",
    "Cy",
    "Di",
    "Ed",
    "Fay",
    "Gus",
    "Hana",
    "Ivo",
    "Jun",
  ]) {
    await createEmployee(window, name, "Engineer");
  }
  // Record every programmatic scroll so "no smooth animation" is provable
  // instead of inferred from timing.
  await window.addInitScript(() => {
    const original = Element.prototype.scrollTo;
    const calls: string[] = [];
    (
      window as unknown as { __imbScrollBehaviours: string[] }
    ).__imbScrollBehaviours = calls;
    Element.prototype.scrollTo = function (
      this: Element,
      ...args: unknown[]
    ): void {
      const first = args[0];
      calls.push(
        typeof first === "object" && first !== null
          ? ((first as ScrollToOptions).behavior ?? "auto")
          : "auto",
      );
      return (
        original as unknown as (this: Element, ...inner: unknown[]) => void
      ).apply(this, args);
    } as typeof Element.prototype.scrollTo;
  });
  await session.reload();

  await window.getByRole("combobox", { name: "Chat with employee" }).click();
  const panel = window.locator(".imb-select-panel");
  await expect(panel).toBeVisible();
  const search = window.getByPlaceholder("Search employees");
  const optionCount = await window.getByRole("option").count();

  // Walk the highlight to the last option with the real keyboard.
  for (let step = 0; step < optionCount - 1; step += 1) {
    await search.press("ArrowDown");
  }

  const state = await panel.evaluate((panelEl) => {
    const activeRow = panelEl.querySelector<HTMLElement>(
      ".imb-select-option.imb-is-active",
    );
    if (activeRow === null) return null;
    const searchRow = panelEl.querySelector<HTMLElement>(".imb-ms-search");
    const panelRect = panelEl.getBoundingClientRect();
    const top = panelRect.top + (searchRow?.offsetHeight ?? 0);
    const rowRect = activeRow.getBoundingClientRect();
    return {
      scrollTop: panelEl.scrollTop,
      scrollHeight: panelEl.scrollHeight,
      clientHeight: panelEl.clientHeight,
      activeLabel: activeRow.textContent ?? "",
      fullyVisible:
        rowRect.top >= top - 0.5 && rowRect.bottom <= panelRect.bottom + 0.5,
    };
  });
  expect(state).not.toBeNull();
  // The panel overflows; the highlight sits on the last option, which is fully
  // inside the scrollport (below the sticky search row).
  expect(state!.scrollHeight).toBeGreaterThan(state!.clientHeight);
  expect(state!.activeLabel).toContain("Jun");
  expect(state!.scrollTop).toBeGreaterThan(0);
  expect(state!.fullyVisible).toBe(true);

  // Every scroll the app performed was instant — an animated one would show up
  // here as `smooth`.
  const behaviours = await window.evaluate(
    () =>
      (window as unknown as { __imbScrollBehaviours: string[] })
        .__imbScrollBehaviours,
  );
  expect(behaviours.length).toBeGreaterThan(0);
  expect(behaviours.every((behaviour) => behaviour === "auto")).toBe(true);
});
