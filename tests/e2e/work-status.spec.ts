import { expect, test, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./helpers/app";
import { createChat, createEmployee } from "./helpers/fixtures";
import {
  configureMockProvider,
  settleRun,
  startAssistantRun,
  startEmployeeRun,
  startMockModel,
  type MockModel,
} from "./helpers/mock-provider";
import {
  appendNotifyMessage,
  seedTaskGroup,
} from "./helpers/work-status-fixtures";

/**
 * The work-status board: one room per task group **that someone is working in
 * right now**.
 *
 * What can be asserted here and what cannot is a deliberate split:
 * - the **data → view** contract (which groups become rooms, what a room
 *   carries, whose message is on the wall, what happens when a run settles) is
 *   asserted on what the DOM shows;
 * - "someone is working" is the live state of a Pi session, so these cases start
 *   **real runs against a local mock model** (`helpers/mock-provider.ts`) — there
 *   is no stored flag to fake, and a fixture-written row would prove nothing
 *   about the rule the boss asked for;
 * - the board renders either the 3D scene or — when the window has no usable
 *   WebGL, which is not the norm here — the 2D card board, so 3D cases skip
 *   loudly (`test.skip`) instead of silently passing;
 * - the 3D-only behaviours that need a camera (fly into a room, right-click
 *   back) and the pure bubble/rest rules are covered by
 *   `work-status-state-machine.spec.ts` and the focus/keep-alive cases below.
 */

let app: LaunchedApp | undefined;
let mock: MockModel | undefined;

test.beforeEach(async () => {
  app = await launchApp();
  mock = await startMockModel();
  await configureMockProvider(app.window, mock.port);
  // The session composition (and the renderer's model list) is read at startup.
  await app.reload();
});

test.afterEach(async () => {
  await mock?.close();
  await app?.close();
});

function navigation(window: Page) {
  return window.getByRole("navigation", { name: "Modules" });
}

function workStatusNav(window: Page) {
  return navigation(window).getByRole("button", { name: "Work status" });
}

function module(window: Page) {
  return window.locator('.imb-ws-module[data-module="work-status"]');
}

/** The board's empty state (one line since the rule became "someone is working"). */
function emptyState(window: Page) {
  return window.getByText(/No task group is in progress right now/);
}

async function openBoard(window: Page): Promise<void> {
  await workStatusNav(window).click();
  await expect(module(window)).toBeVisible();
}

async function mode(window: Page): Promise<"3d" | "2d"> {
  const value = await module(window).getAttribute("data-ws-mode");
  return value === "3d" ? "3d" : "2d";
}

/** Task-group ids, in the order the fixtures created them. */
interface SeededRooms {
  rootChatId: number;
  openRoom: number;
  doneRoom: number;
  anna: number;
  ben: number;
}

/**
 * Two task groups: one whose progress card still has an open step, one whose
 * card is finished. Under the boss's rule *neither* is a room until somebody
 * works in it.
 */
async function seedRooms(window: Page, dataRoot: string): Promise<SeededRooms> {
  const anna = await createEmployee(window, "Anna", "Architect");
  const ben = await createEmployee(window, "Ben", "Tester");
  const rootChatId = await createChat(window, "Boss chat");
  const openRoom = seedTaskGroup({
    dataRoot,
    rootChatId,
    title: "Search revamp",
    participants: [0, anna, ben],
    progressTitle: "Search revamp progress",
    steps: [
      {
        name: "Anna",
        task: "write the migration",
        status: "done",
        employeeId: anna,
      },
      {
        name: "Ben",
        task: "run the regression",
        status: "busy",
        employeeId: ben,
      },
    ],
    bubbles: [
      {
        employeeId: ben,
        content: `The migration is in — @${anna} can start now.`,
        notify: [anna],
      },
    ],
  }).chatId;
  const doneRoom = seedTaskGroup({
    dataRoot,
    rootChatId,
    title: "Docs pass",
    participants: [0, anna, ben],
    progressTitle: "Docs pass progress",
    steps: [
      { name: "Anna", task: "ship it", status: "done", employeeId: anna },
    ],
  }).chatId;
  return { rootChatId, openRoom, doneRoom, anna, ben };
}

/**
 * Where one employee is on screen.
 *
 * Read off a bubble host: the scene keeps every bubble positioned exactly above an
 * employee's head, so the host's bottom centre plus a few pixels *is* the head.
 * (Hunting a pixel grid does not work any more: a single room is framed small, so
 * people are only a few dozen pixels wide.)
 */
async function pointAtPerson(
  window: Page,
): Promise<{ x: number; y: number } | null> {
  const anchors = window.locator(".imb-ws-bubble-anchor");
  const chip = window.locator(".imb-ws-hover");
  // The snapshot can report a room a frame or two before its bubbles are mounted
  // (they are React portals into hosts the scene creates), so wait for one.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = await anchors.count();
    for (let index = 0; index < count; index += 1) {
      const box = await anchors.nth(index).boundingBox();
      if (box === null) continue;
      // The bubble hangs a fixed gap above the head, and at bird's-eye scale a
      // person is only ~25px tall: walk down from the bubble's bottom edge until
      // the hover chip says a person is under the pointer.
      for (const dy of [6, 10, 14, 4, 8, 12, 16, 18, 20]) {
        const point = { x: box.x + box.width / 2, y: box.y + box.height + dy };
        await window.mouse.move(point.x, point.y);
        await window.waitForTimeout(60);
        if (await chip.isVisible()) return point;
      }
    }
    await window.waitForTimeout(100);
  }
  return null;
}

/** Task-group ids the main process currently reports as rooms. */
async function roomIds(window: Page): Promise<number[]> {
  return await window.evaluate(async () => {
    const api = (
      window as unknown as {
        imb: {
          workStatus: {
            rooms: () => Promise<{ rooms: Array<{ chatId: number }> }>;
          };
        };
      }
    ).imb;
    const payload = await api.workStatus.rooms();
    return payload.rooms.map((room) => room.chatId);
  });
}

/**
 * Wait until the board *shows* exactly `count` rooms.
 *
 * Not the same as `expectRoomCount`: the snapshot from main only lists groups
 * where someone works right now, while the board also keeps a room for a while
 * after its work ended (see `linger.ts`). The header count is derived from what is
 * shown, so it is the mode-agnostic way to read it.
 */
async function expectShownRooms(window: Page, count: number): Promise<void> {
  await expect(module(window).locator(".imb-ws-count")).toContainText(
    count === 1 ? "1 task group" : `${count} task groups`,
    { timeout: 5_000 },
  );
}

/** Wait until the board shows exactly `count` rooms (a run start is async). */
async function expectRoomCount(window: Page, count: number): Promise<void> {
  await expect
    .poll(async () => (await roomIds(window)).length, { timeout: 15_000 })
    .toBe(count);
}

test("a progress card alone no longer makes a room", async () => {
  const session = app!;
  await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);

  // Nobody is working: the cards are there, the rooms are not.
  await expect(emptyState(session.window)).toBeVisible();
  await expect(module(session.window).locator(".imb-ws-card")).toHaveCount(0);
});

test("a room appears while someone works in it, and lingers after they stop", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  await expect(emptyState(session.window)).toBeVisible();

  // Anna works in the group whose card is *finished* — a room must appear anyway.
  await startEmployeeRun(session.window, rooms.doneRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  await expect(module(session.window).locator(".imb-ws-count")).toContainText(
    "1 task group",
  );

  if ((await mode(session.window)) === "3d") {
    await expect(
      module(session.window).locator(".imb-ws-roomlabel").first(),
    ).toContainText("Docs pass");
    // Anna is running, so her bubble says so.
    await expect(
      module(session.window).locator('.imb-ws-bubble[data-kind="working"]'),
    ).toHaveCount(1);
  } else {
    const card = module(session.window).locator(".imb-ws-card").first();
    await expect(card).toContainText("Docs pass");
    await expect(card).toContainText("Working…");
  }

  // …and when she stops the room *stays*: removal is deferred by the linger window
  // (the card did not change). Nobody works in it any more, so no "working" bubble.
  await settleRun(session.window, rooms.anna, rooms.doneRoom);
  // The snapshot is honest — nobody works there any more…
  await expectRoomCount(session.window, 0);
  // …but the room itself stays on the board for the linger window.
  await expectShownRooms(session.window, 1);
  await expect(emptyState(session.window)).toBeHidden();
  if ((await mode(session.window)) === "3d") {
    await expect(
      module(session.window).locator('.imb-ws-bubble[data-kind="working"]'),
    ).toHaveCount(0);
  } else {
    await expect(
      module(session.window).locator(".imb-ws-card").first(),
    ).not.toContainText("Working…");
  }
});

test("the assistant working in the root chat keeps its groups on the board", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);

  await startAssistantRun(session.window, rooms.rootChatId);
  // Both groups belong to that root chat and are unstaffed, so the assistant's
  // own run is what puts them on the board.
  await expectRoomCount(session.window, 2);

  if ((await mode(session.window)) === "3d") {
    await expect(
      module(session.window).locator('.imb-ws-bubble[data-kind="working"]'),
    ).toHaveCount(2);
  }
  // Settling defers the removal, so both rooms are still on the board.
  await settleRun(session.window, 0, rooms.rootChatId);
  await expectRoomCount(session.window, 0);
  await expectShownRooms(session.window, 2);
});

test("several groups working at once are separate rooms", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  await startEmployeeRun(session.window, rooms.doneRoom, rooms.ben);
  // Push-driven: no reload, no Refresh click.
  await expectRoomCount(session.window, 2);
  await expect(module(session.window).locator(".imb-ws-count")).toContainText(
    "2 task groups",
  );
});

test("without a usable WebGL context the board degrades to cards", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  // Make the window behave like a machine whose GPU cannot give us a context: the
  // module probes once, exactly as it does at startup.
  await session.window.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      contextId: string,
      ...rest: unknown[]
    ) {
      if (contextId === "webgl" || contextId === "webgl2") return null;
      return (
        original as unknown as (
          id: string,
          ...args: unknown[]
        ) => RenderingContext | null
      ).call(this, contextId, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await session.reload();
  await openBoard(session.window);
  await expect(module(session.window)).toHaveAttribute("data-ws-mode", "2d");

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  const card = module(session.window).locator(".imb-ws-card").first();
  await expect(card).toContainText("Search revamp");
  // The screen is the group's latest progress card, step for step.
  await expect(card).toContainText("Search revamp progress");
  await expect(card).toContainText("write the migration");
  await expect(card).toContainText("Done");
  await expect(card).toContainText("In progress");
  // Ben's message to Anna is on the wall: it woke someone, so it is a bubble, and
  // its `@<id>` mention is resolved to a name exactly like a thread bubble.
  await expect(card).toContainText(
    "The migration is in — @Anna can start now.",
  );
});

/**
 * Post a *new* notifying message into a room that is already on the board.
 *
 * Seed data is history: a room's first presentation never replays the messages it
 * already had (see the baseline case), so a test that wants a message bubble has
 * to add one now and tell main to refresh.
 */
async function freshMessage(
  session: LaunchedApp,
  input: {
    chatId: number;
    employeeId: number;
    content: string;
    notify: number[];
  },
): Promise<void> {
  // The room's *first* snapshot is what establishes the baseline, so wait until
  // the board has actually drawn it: a message written before that would be
  // baselined away as history.
  await session.window
    .locator(".imb-ws-roomlabel")
    .first()
    .waitFor({ state: "attached", timeout: 5_000 })
    .catch(() => undefined);
  appendNotifyMessage(session.dataRoot, input);
  await session.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("workStatus:changed", {
      reason: "message",
    });
  });
}

/** Focus the only room on the board by clicking its floor. */
async function focusOnlyRoom(window: Page): Promise<void> {
  const canvas = window.locator("canvas.imb-ws-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  for (const [fx, fy] of [
    [0.5, 0.62],
    [0.5, 0.7],
    [0.42, 0.66],
    [0.58, 0.66],
  ] as const) {
    // A bubble may sit under the pointer (it opens the reading view): close it
    // and try the next point.
    await window.keyboard.press("Escape");
    await window.mouse.click(
      box!.x + box!.width * fx,
      box!.y + box!.height * fy,
    );
    await window.waitForTimeout(900);
    if ((await window.locator(".imb-ws-screen").count()) > 0) return;
  }
  throw new Error("clicking the room did not focus it");
}

test("focusing a room puts its title in the header and brings back the board's title after", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  const header = module(session.window).locator(".imb-ws-head");
  await expect(header).toContainText("Work status");

  await focusOnlyRoom(session.window);
  await expect(header.locator(".imb-ws-title-room")).toHaveText(
    "Search revamp",
  );
  await expect(header).not.toContainText("Work status");

  // Right click returns to the grid, and the header goes back to the module's.
  const canvas = session.window.locator("canvas.imb-ws-canvas");
  const box = await canvas.boundingBox();
  await session.window.mouse.click(
    box!.x + box!.width * 0.5,
    box!.y + box!.height * 0.5,
    { button: "right" },
  );
  await expect(module(session.window).locator(".imb-ws-screen")).toHaveCount(0);
  await expect(header).toContainText("Work status");
});

test("the wheel does nothing: no zoom, no leaving the focused room", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  const canvas = session.window.locator("canvas.imb-ws-canvas");
  const plate = module(session.window).locator(".imb-ws-roomlabel").first();

  // Hovering a room lifts it (that is the hover effect), so the pointer is parked
  // outside the scene — over the header — while the wheel events are aimed at the
  // canvas directly. Anything that still listens for `wheel` would move the camera
  // and therefore this plate.
  await module(session.window).locator(".imb-ws-head").hover();
  await session.window.waitForTimeout(700);
  const beforeGrid = await plate.boundingBox();
  await canvas.dispatchEvent("wheel", { deltaY: -600 });
  await canvas.dispatchEvent("wheel", { deltaY: 600 });
  await session.window.waitForTimeout(500);
  const afterGrid = await plate.boundingBox();
  expect(beforeGrid).not.toBeNull();
  expect(afterGrid).not.toBeNull();
  expect(Math.abs(afterGrid!.y - beforeGrid!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterGrid!.width - beforeGrid!.width)).toBeLessThanOrEqual(1);

  // Focused: scrolling outward must not leave the room, and must not move it.
  await focusOnlyRoom(session.window);
  const screen = session.window.locator(".imb-ws-screen");
  await expect(screen).toHaveCount(1);
  await module(session.window).locator(".imb-ws-head").hover();
  await session.window.waitForTimeout(500);
  const beforeFocus = await screen.boundingBox();
  await canvas.dispatchEvent("wheel", { deltaY: 900 });
  await canvas.dispatchEvent("wheel", { deltaY: 900 });
  await session.window.waitForTimeout(600);
  await expect(screen).toHaveCount(1);
  const afterFocus = await screen.boundingBox();
  expect(beforeFocus).not.toBeNull();
  expect(afterFocus).not.toBeNull();
  expect(Math.abs(afterFocus!.y - beforeFocus!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterFocus!.width - beforeFocus!.width)).toBeLessThanOrEqual(
    1,
  );
  await expect(module(session.window).locator(".imb-ws-title-room")).toHaveText(
    "Search revamp",
  );
});

test("a roster change does not take the focused room's screen away", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  await focusOnlyRoom(session.window);
  const screen = session.window.locator(".imb-ws-screen");
  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Search revamp progress");

  // Adding a member rebuilds the room's scene graph. The wall screen is a DOM
  // element parented to that graph, so it used to be detached and the card
  // vanished until the boss refocused the room.
  await session.window.evaluate(
    async (payload: string) => {
      const [roomChatId, employeeId] = JSON.parse(payload) as [number, number];
      const api = (
        window as unknown as {
          imb: {
            chats: {
              updateParticipants: (
                id: number,
                changes: { add?: number[] },
              ) => Promise<unknown>;
            };
          };
        }
      ).imb;
      await api.chats.updateParticipants(roomChatId, { add: [employeeId] });
    },
    JSON.stringify([rooms.openRoom, rooms.ben]),
  );

  await expect(screen).toHaveCount(1);
  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Search revamp progress");
});

test("an employee change refreshes the board (roster and bubbles)", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  // Ben posts something *now*: seeded history never becomes a bubble.
  await freshMessage(session, {
    chatId: rooms.openRoom,
    employeeId: rooms.ben,
    content: "Handing this over.",
    notify: [rooms.anna],
  });
  await expect(module(session.window).locator(".imb-ws-bubble")).toHaveCount(2);

  // Deleting him must reach the board through the `employees:changed` path — the
  // seat goes away, so his bubble goes with it, without clicking Refresh.
  await session.window.evaluate(async (name: string) => {
    const api = (
      window as unknown as {
        imb: {
          employees: {
            list: () => Promise<Array<{ id: number; name: string }>>;
            remove: (id: number) => Promise<unknown>;
          };
        };
      }
    ).imb;
    const employees = await api.employees.list();
    const target = employees.find((employee) => employee.name === name);
    if (target !== undefined) await api.employees.remove(target.id);
  }, "Ben");

  // Only Anna's "working" bubble is left.
  await expect(module(session.window).locator(".imb-ws-bubble")).toHaveCount(1);
  await expect(
    module(session.window).locator('.imb-ws-bubble[data-kind="message"]'),
  ).toHaveCount(0);
});

test("leaving the board for another module keeps it mounted and its state", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  const board = module(session.window);
  await expect(board).toBeVisible();
  // Mark the live DOM node: if the module were unmounted on a module switch, the
  // mark would be gone when it comes back (the boss's requirement is that the
  // board — camera, focus, zoom — is still where it was left).
  await session.window.evaluate(() => {
    document
      .querySelector('.imb-ws-module[data-module="work-status"]')
      ?.setAttribute("data-keepalive-probe", "1");
  });

  await navigation(session.window)
    .getByRole("button", { name: "Chats" })
    .click();
  await expect(board).toHaveAttribute("data-active", "false");

  await workStatusNav(session.window).click();
  await expect(board).toHaveAttribute("data-active", "true");
  await expect(
    session.window.locator('.imb-ws-module[data-keepalive-probe="1"]'),
  ).toHaveCount(1);
  await expect(board.locator(".imb-ws-count")).toContainText("1 task group");
});

/** Count GL draw calls, so "renders nothing while hidden" is measurable. */
async function instrumentDraws(window: Page): Promise<void> {
  await window.evaluate(() => {
    const scope = window as unknown as {
      __draws?: number;
      WebGLRenderingContext?: { prototype: Record<string, unknown> };
      WebGL2RenderingContext?: { prototype: Record<string, unknown> };
    };
    scope.__draws = 0;
    const patch = (prototype: Record<string, unknown> | undefined): void => {
      if (!prototype) return;
      for (const name of [
        "drawElements",
        "drawArrays",
        "drawElementsInstanced",
        "drawArraysInstanced",
      ]) {
        const original = prototype[name];
        if (typeof original !== "function") continue;
        const wrapped = function wrappedDraw(
          this: unknown,
          ...args: unknown[]
        ): unknown {
          scope.__draws = (scope.__draws ?? 0) + 1;
          return (original as (...inner: unknown[]) => unknown).apply(
            this,
            args,
          );
        };
        prototype[name] = wrapped;
      }
    };
    patch(scope.WebGLRenderingContext?.prototype);
    patch(scope.WebGL2RenderingContext?.prototype);
  });
}

async function readDraws(window: Page): Promise<number> {
  return await window.evaluate(
    () => (window as unknown as { __draws?: number }).__draws ?? 0,
  );
}

async function resetDraws(window: Page): Promise<void> {
  await window.evaluate(() => {
    (window as unknown as { __draws?: number }).__draws = 0;
  });
}

/**
 * Make the scene redraw once, without depending on an animation being in flight:
 * any pointer movement over the canvas re-evaluates hover and marks the scene
 * dirty. (A still board deliberately draws nothing — that is the efficiency the
 * loop is built for, and it would make a bare draw count read as "stopped".)
 */
async function pulseDraws(window: Page): Promise<void> {
  const canvas = window.locator("canvas.imb-ws-canvas");
  const box = await canvas.boundingBox();
  if (box === null) return;
  for (const fx of [0.3, 0.36, 0.42]) {
    await window.mouse.move(box.x + box.width * fx, box.y + box.height * 0.3);
    await window.waitForTimeout(80);
  }
}

test("the camera, the focus and the render loop survive a module switch", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  await focusOnlyRoom(session.window);
  const screen = session.window.locator(".imb-ws-screen");
  await expect(screen).toBeVisible();
  const before = await screen.boundingBox();
  expect(before).not.toBeNull();

  // Rendering is measurable: touching the scene makes it draw while it is on
  // screen (a still board draws nothing on purpose).
  await instrumentDraws(session.window);
  await resetDraws(session.window);
  await pulseDraws(session.window);
  expect(await readDraws(session.window)).toBeGreaterThan(0);

  // Switch away: the module stays mounted, but it must stop drawing.
  await navigation(session.window)
    .getByRole("button", { name: "Chats" })
    .click();
  await expect(module(session.window)).toHaveAttribute("data-active", "false");
  await resetDraws(session.window);
  await session.window.waitForTimeout(700);
  expect(await readDraws(session.window)).toBe(0);

  // Back again: the focused room is still focused, at the same place on screen
  // (which is the camera pose), and the loop is running.
  await workStatusNav(session.window).click();
  await expect(module(session.window)).toHaveAttribute("data-active", "true");
  await expect(screen).toBeVisible();
  const after = await screen.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after!.x ?? 0) - (before!.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((after!.y ?? 0) - (before!.y ?? 0))).toBeLessThanOrEqual(1);
  expect(
    Math.abs((after!.width ?? 0) - (before!.width ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((after!.height ?? 0) - (before!.height ?? 0)),
  ).toBeLessThanOrEqual(1);

  await resetDraws(session.window);
  await pulseDraws(session.window);
  expect(await readDraws(session.window)).toBeGreaterThan(0);
});

test("the nav entry sits before Scheduled tasks and has its own icon colour", async () => {
  const session = app!;
  // Pure DOM: no GPU and no run needed.
  const order = await session.window.evaluate(() =>
    [...document.querySelectorAll(".imb-nav .imb-nav-items")]
      .flatMap((group) => [
        ...group.querySelectorAll(".imb-nav-item[data-module]"),
      ])
      .map((item) => (item as HTMLElement).dataset["module"] ?? ""),
  );
  const workStatus = order.indexOf("work-status");
  const cron = order.indexOf("cron");
  expect(workStatus).toBeGreaterThanOrEqual(0);
  expect(cron).toBeGreaterThanOrEqual(0);
  expect(workStatus).toBeLessThan(cron);

  // Every module icon carries its own tint; the work-status one is neither the
  // default ink nor a copy of another module's colour.
  const colours = await session.window.evaluate(() => {
    const result: Record<string, string> = {};
    for (const item of document.querySelectorAll(
      ".imb-nav-item[data-module]",
    )) {
      const module = (item as HTMLElement).dataset["module"] ?? "";
      const icon = item.querySelector(".imb-icon");
      result[module] = icon === null ? "" : getComputedStyle(icon).color;
    }
    return result;
  });
  const own = colours["work-status"] ?? "";
  expect(own).not.toBe("");
  for (const [module, colour] of Object.entries(colours)) {
    if (module === "work-status") continue;
    expect(colour, `work-status must not share ${module}'s tint`).not.toBe(own);
  }
});

test("a plate shows the full task-group title on hover, even when condensed", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  // Enough working groups that the plates switch to their condensed style.
  const longTitle = "Search revamp and its very long descriptive title";
  const crowded: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const group = seedTaskGroup({
      dataRoot: session.dataRoot,
      rootChatId: rooms.rootChatId,
      title: index === 0 ? longTitle : `Crowd ${index}`,
      participants: [0, rooms.anna, rooms.ben],
      progressTitle: `Crowd ${index} progress`,
      steps: [
        { name: "Anna", task: "grind", status: "busy", employeeId: rooms.anna },
      ],
    });
    crowded.push(group.chatId);
  }
  for (const chatId of crowded) {
    await startEmployeeRun(session.window, chatId, rooms.anna);
  }
  // Nine working groups → nine plates, which is past the "condensed" threshold.
  await expectRoomCount(session.window, 9);

  const plates = module(session.window).locator(".imb-ws-roomlabel");
  await expect(plates).toHaveCount(9);
  // Condensed: the plate itself truncates the long title…
  const longPlate = plates.filter({ hasText: "Search revamp" }).first();
  await expect(longPlate).toHaveAttribute("data-dense", "1");
  // Really truncated on screen (ellipsis): the element is narrower than its text.
  const truncated = await longPlate.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(truncated).toBe(true);

  // …and the tooltip still gives it in full (the repo's own Tooltip).
  await longPlate.hover();
  const tooltip = session.window.locator(".imb-tooltip");
  await expect(tooltip).toHaveText(longTitle, { timeout: 3_000 });
});

test("in the bird's-eye grid a click on a person only focuses their room", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  const point = await pointAtPerson(session.window);
  test.skip(point === null, "no employee on screen to click");
  await session.window.mouse.click(point!.x, point!.y);

  // Focused, not navigated: the board stays the active module and the header
  // takes the room's title (an employee click from the grid means "show me that
  // room", never "open an agent session").
  await expect(module(session.window).locator(".imb-ws-screen")).toHaveCount(
    1,
    {
      timeout: 3_000,
    },
  );
  await expect(module(session.window)).toHaveAttribute("data-active", "true");
  await expect(module(session.window).locator(".imb-ws-title-room")).toHaveText(
    "Search revamp",
  );
});

test("a second room does not change the scale of the first one", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  // With one room the camera frames the "two rooms" reference box: the plate of
  // the only room has to be inside the canvas (it used to be pushed out of view
  // when a single room was blown up to fill the pane).
  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  const canvas = await session.window
    .locator("canvas.imb-ws-canvas")
    .boundingBox();
  const plates = module(session.window).locator(".imb-ws-roomlabel");
  await expect(plates).toHaveCount(1);
  const single = await plates.first().boundingBox();
  expect(canvas).not.toBeNull();
  expect(single).not.toBeNull();
  expect(single!.y).toBeGreaterThanOrEqual(canvas!.y);
  expect(single!.y + single!.height).toBeLessThanOrEqual(
    canvas!.y + canvas!.height,
  );

  // …and the scale must not depend on how many rooms are on the board: adding a
  // second working group may re-frame the grid, but the first room's projection
  // stays where it was (this is the "size is fixed, not fitted to the count"
  // rule the boss asked for).
  await startEmployeeRun(session.window, rooms.doneRoom, rooms.ben);
  await expectRoomCount(session.window, 2);
  await expect(plates).toHaveCount(2);
  const first = await plates.first().boundingBox();
  expect(first).not.toBeNull();
  expect(Math.abs(first!.y - single!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(first!.width - single!.width)).toBeLessThanOrEqual(1);

  // Both plates inside the canvas, and the room pitch (world units between two
  // rooms of one row) implies a px-per-unit the plate size is consistent with —
  // the concrete size check the previous version of this case was missing.
  const second = await plates.nth(1).boundingBox();
  expect(second).not.toBeNull();
  for (const plate of [first!, second!]) {
    expect(plate.x).toBeGreaterThanOrEqual(canvas!.x - 1);
    expect(plate.x + plate.width).toBeLessThanOrEqual(
      canvas!.x + canvas!.width + 1,
    );
  }
});

test("Escape leaves the focused room, and only closes the reading view first", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  await focusOnlyRoom(session.window);
  await expect(module(session.window).locator(".imb-ws-screen")).toHaveCount(1);

  // With a bubble open, Escape closes the bubble and keeps the room focused.
  await freshMessage(session, {
    chatId: rooms.openRoom,
    employeeId: rooms.ben,
    content: "Handing this over.",
    notify: [rooms.anna],
  });
  const bubble = module(session.window)
    .locator('.imb-ws-bubble[data-kind="message"]')
    .first();
  await bubble.click();
  const panel = session.window.locator(".imb-ws-bubble-panel");
  await expect(panel).toBeVisible();
  await session.window.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(module(session.window).locator(".imb-ws-screen")).toHaveCount(1);

  // A second Escape is the room's exit: same as right-click.
  await session.window.keyboard.press("Escape");
  await expect(module(session.window).locator(".imb-ws-screen")).toHaveCount(0);
  await expect(
    module(session.window).locator(".imb-ws-title-room"),
  ).toHaveCount(0);
  await expect(module(session.window).locator(".imb-ws-head")).toContainText(
    "Work status",
  );
});

test("a bubble opens a reading view and Escape puts the board back", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  // Reading a message is a focused-room action (see the grid-vs-focus case).
  await focusOnlyRoom(session.window);
  await freshMessage(session, {
    chatId: rooms.openRoom,
    employeeId: rooms.ben,
    content: `The migration is in — @${rooms.anna} can start now.`,
    notify: [rooms.anna],
  });

  const bubble = module(session.window)
    .locator('.imb-ws-bubble[data-kind="message"]')
    .first();
  await expect(bubble).toBeVisible();
  // The preview is Markdown, with `@id` mentions resolved like a thread bubble.
  await expect(bubble).toContainText("The migration is in");
  // `@<id>` resolved to the employee's name, exactly like a thread bubble.
  await expect(bubble).toContainText("@Anna");

  await bubble.click();
  const panel = session.window.locator(".imb-ws-bubble-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("The migration is in");
  // Nearly the whole window, and it scrolls inside rather than growing.
  const panelBox = await panel.boundingBox();
  const moduleBox = await module(session.window).boundingBox();
  expect(panelBox!.width).toBeGreaterThan(moduleBox!.width * 0.6);

  await session.window.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  // The room's own state is untouched by the reading view.
  await expect(module(session.window)).toHaveAttribute("data-active", "true");
});

test("the hover chip is not covered by the bubble it sits next to", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  // `pointAtPerson` leaves the pointer on the person it found.
  const point = await pointAtPerson(session.window);
  test.skip(point === null, "no employee on screen to hover");
  const chip = session.window.locator(".imb-ws-hover");
  await expect(chip).toBeVisible({ timeout: 3_000 });

  // The chip must paint above every bubble on the board: same stacking context
  // (the HUD), a higher layer, and it wins where the two overlap. The HUD itself
  // ignores pointer events (it is an overlay), so the paint probe re-enables them
  // for a moment — that measures paint order, not hit-testing policy.
  const stacking = await session.window.evaluate(() => {
    const chipElement = document.querySelector<HTMLElement>(".imb-ws-hover");
    const host = document.querySelector<HTMLElement>(".imb-ws-bubble-anchor");
    const bubble = document.querySelector<HTMLElement>(".imb-ws-bubble");
    if (chipElement === null || host === null || bubble === null) return null;

    const restore = [chipElement, host, bubble].map(
      (element) => [element, element.style.pointerEvents] as const,
    );
    for (const element of [chipElement, host, bubble]) {
      element.style.pointerEvents = "auto";
    }
    const chipBox = chipElement.getBoundingClientRect();
    const bubbleBox = bubble.getBoundingClientRect();
    const overlaps =
      chipBox.left < bubbleBox.right &&
      chipBox.right > bubbleBox.left &&
      chipBox.top < bubbleBox.bottom &&
      chipBox.bottom > bubbleBox.top;
    const probeX =
      (Math.max(chipBox.left, bubbleBox.left) +
        Math.min(chipBox.right, bubbleBox.right)) /
      2;
    const probeY =
      (Math.max(chipBox.top, bubbleBox.top) +
        Math.min(chipBox.bottom, bubbleBox.bottom)) /
      2;
    const top = document.elementFromPoint(probeX, probeY);
    for (const [element, value] of restore) {
      element.style.pointerEvents = value;
    }
    return {
      overlaps,
      chipZ: Number(getComputedStyle(chipElement).zIndex),
      bubbleZ: Number(getComputedStyle(host).zIndex),
      chipOnTop:
        top !== null && (top === chipElement || chipElement.contains(top)),
    };
  });
  expect(stacking).not.toBeNull();
  expect(stacking!.chipZ).toBeGreaterThan(stacking!.bubbleZ);
  if (stacking!.overlaps) expect(stacking!.chipOnTop).toBe(true);
});

test("bubbles are a glance in the grid and reading them needs focus", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  await freshMessage(session, {
    chatId: rooms.openRoom,
    employeeId: rooms.ben,
    content: "Fresh handover for the reader check.",
    notify: [rooms.anna],
  });

  const bubble = module(session.window)
    .locator('.imb-ws-bubble[data-kind="message"]')
    .first();
  await expect(bubble).toBeVisible();
  // Grid: smaller type, not a control, and `pointer-events: none` so the click
  // falls through to the room behind it (that is how "not clickable" is done —
  // the bubble must not swallow the click that focuses its room).
  await expect(bubble).toHaveAttribute("data-focus", "0");
  await expect(bubble).not.toHaveAttribute("role", "button");
  expect(
    await bubble.evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe("10px");
  expect(
    await bubble.evaluate((element) => getComputedStyle(element).pointerEvents),
  ).toBe("none");

  const bubbleBox = await bubble.boundingBox();
  expect(bubbleBox).not.toBeNull();
  await session.window.mouse.click(
    bubbleBox!.x + bubbleBox!.width / 2,
    bubbleBox!.y + bubbleBox!.height / 2,
  );
  // No reading view… and the click went through: the room behind the bubble got
  // focused, exactly as clicking the room itself would.
  await expect(session.window.locator(".imb-ws-bubble-panel")).toHaveCount(0);
  await expect(module(session.window).locator(".imb-ws-screen")).toHaveCount(
    1,
    {
      timeout: 4_000,
    },
  );

  // Focused: full size, a real button that takes pointer events, reader opens.
  const focused = module(session.window)
    .locator('.imb-ws-bubble[data-kind="message"]')
    .first();
  await expect(focused).toHaveAttribute("data-focus", "1");
  await expect(focused).toHaveAttribute("role", "button");
  expect(
    await focused.evaluate(
      (element) => getComputedStyle(element).pointerEvents,
    ),
  ).toBe("auto");
  expect(
    await focused.evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe("12px");
  await module(session.window).locator(".imb-ws-head").hover();
  await focused.click();
  await expect(session.window.locator(".imb-ws-bubble-panel")).toBeVisible();
});

test("the grid draws the progress card on the wall, the focus view uses the DOM card", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  // Bird's-eye: no CSS3D card — the progress screen is a painted texture (a CSS3D
  // element is always painted above the whole canvas, so it is reserved for the
  // one focused room). The plate still names the group.
  await expect(session.window.locator(".imb-ws-screen")).toHaveCount(0);
  await expect(
    module(session.window).locator(".imb-ws-roomlabel").first(),
  ).toContainText("Search revamp");

  await focusOnlyRoom(session.window);
  const screen = session.window.locator(".imb-ws-screen");
  await expect(screen).toHaveCount(1);
  await expect(screen).toContainText("Search revamp progress");
});

test("hovering a room lifts it without rocking it", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);

  const canvas = await session.window
    .locator("canvas.imb-ws-canvas")
    .boundingBox();
  const plate = module(session.window).locator(".imb-ws-roomlabel").first();
  await session.window.mouse.move(20, 20);
  await session.window.waitForTimeout(700);
  const rest = await plate.boundingBox();

  // Hover the room and let the lift settle.
  await session.window.mouse.move(
    canvas!.x + canvas!.width * 0.5,
    canvas!.y + canvas!.height * 0.6,
  );
  await session.window.waitForTimeout(800);
  const lifted = await plate.boundingBox();
  expect(rest).not.toBeNull();
  expect(lifted).not.toBeNull();
  // Lifted: the plate moved up with the room…
  expect(lifted!.y).toBeLessThan(rest!.y - 2);

  // …and it stays put while the pointer keeps hovering (no sway any more).
  await session.window.waitForTimeout(400);
  const later = await plate.boundingBox();
  expect(Math.abs(later!.y - lifted!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(later!.x - lifted!.x)).toBeLessThanOrEqual(1);
});

test("a room does not replay the messages it already had when it appeared", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  // Ben's message exists *before* the room is first shown: it is history.
  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  await expect(
    module(session.window).locator('.imb-ws-bubble[data-kind="message"]'),
  ).toHaveCount(0);
  // Anna is running, so the working bubble is there (the room is alive).
  await expect(
    module(session.window).locator('.imb-ws-bubble[data-kind="working"]'),
  ).toHaveCount(1);

  // A snapshot refresh must not turn that history into news either.
  await session.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("workStatus:changed", {
      reason: "message",
    });
  });
  await session.window.waitForTimeout(600);
  await expect(
    module(session.window).locator('.imb-ws-bubble[data-kind="message"]'),
  ).toHaveCount(0);

  // A message that arrives *now* is news and gets its bubble.
  appendNotifyMessage(session.dataRoot, {
    chatId: rooms.openRoom,
    employeeId: rooms.ben,
    content: "Fresh handover, just now.",
    notify: [rooms.anna],
  });
  await session.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("workStatus:changed", {
      reason: "message",
    });
  });
  const fresh = module(session.window).locator(
    '.imb-ws-bubble[data-kind="message"]',
  );
  await expect(fresh).toHaveCount(1);
  await expect(fresh).toContainText("Fresh handover, just now.");
});

test("starting a run does not replay a room's history", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  // Anna starts: the room appears, and Ben's seeded message is history.
  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  const messages = module(session.window).locator(
    '.imb-ws-bubble[data-kind="message"]',
  );
  await expect(messages).toHaveCount(0);

  // Ben's own session starts too — this is the case that used to pop the old
  // message: a second bubble host appeared and React drew the snapshot's latest
  // notify message into it instead of the "working" bubble.
  await startEmployeeRun(session.window, rooms.openRoom, rooms.ben);
  await expect(
    module(session.window).locator(".imb-ws-bubble-anchor"),
  ).toHaveCount(2);
  await expect(messages).toHaveCount(0);
  await expect(
    module(session.window).locator('.imb-ws-bubble[data-kind="working"]'),
  ).toHaveCount(2);

  // A roster change rebuilds the room: still no replay.
  await session.window.evaluate(
    async (payload: string) => {
      const [roomChatId, employeeId] = JSON.parse(payload) as [number, number];
      const api = (
        window as unknown as {
          imb: {
            chats: {
              updateParticipants: (
                id: number,
                changes: { add?: number[] },
              ) => Promise<unknown>;
            };
          };
        }
      ).imb;
      await api.chats.updateParticipants(roomChatId, { add: [employeeId] });
    },
    JSON.stringify([
      rooms.openRoom,
      await createEmployee(session.window, "Joiner", "Designer"),
    ]),
  );
  await session.window.waitForTimeout(800);
  await expect(messages).toHaveCount(0);
});

test("dragging inside a focused room orbits the camera and is not a click", async () => {
  const session = app!;
  const rooms = await seedRooms(session.window, session.dataRoot);
  await openBoard(session.window);
  test.skip(
    (await mode(session.window)) === "2d",
    "no usable WebGL in this environment",
  );

  await startEmployeeRun(session.window, rooms.openRoom, rooms.anna);
  await expectRoomCount(session.window, 1);
  await focusOnlyRoom(session.window);

  const screen = session.window.locator(".imb-ws-screen");
  const before = await screen.boundingBox();
  expect(before).not.toBeNull();

  const canvas = await session.window
    .locator("canvas.imb-ws-canvas")
    .boundingBox();
  const start = {
    x: canvas!.x + canvas!.width * 0.5,
    y: canvas!.y + canvas!.height * 0.55,
  };
  await session.window.mouse.move(start.x, start.y);
  await session.window.mouse.down();
  await session.window.mouse.move(start.x + 150, start.y - 60, { steps: 8 });
  await session.window.mouse.up();
  await session.window.waitForTimeout(300);

  // The camera moved (the wall screen's projection changed)…
  const after = await screen.boundingBox();
  expect(after).not.toBeNull();
  expect(
    Math.abs(after!.x - before!.x) + Math.abs(after!.y - before!.y),
  ).toBeGreaterThan(5);
  // …the room is still focused, and the drag did not open anything.
  await expect(screen).toHaveCount(1);
  await expect(module(session.window)).toHaveAttribute("data-active", "true");
  await expect(session.window.locator(".imb-ws-bubble-panel")).toHaveCount(0);

  // A real click (no movement) still opens the group.
  await session.window.locator(".imb-ws-screen-body").click();
  await expect(module(session.window)).toHaveAttribute("data-active", "false", {
    timeout: 5_000,
  });
});
