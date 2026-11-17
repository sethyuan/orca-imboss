import { ASSISTANT_ID } from "@shared/constants/employees";
import {
  MAX_BUBBLE_LENGTH,
  MAX_ROOM_BUBBLES,
  MAX_ROOM_MEMBERS,
  MAX_ROOM_STEPS,
  MAX_WORK_ROOMS,
} from "@shared/constants/work-status";
import type {
  WorkRoom,
  WorkRoomBubble,
  WorkRoomMember,
  WorkRoomsPayload,
} from "@shared/types";
import { listRunningSessions } from "./agent/session-queue";
import * as dbEmployees from "./db/employees";
import {
  listLatestNotifyBySender,
  listLatestProgressByGroup,
  listRoomChatCandidates,
  type RoomBubbleRow,
} from "./db/work-status";

/**
 * Snapshot behind the work-status (3D room) view.
 *
 * Composition only: the task groups, their progress cards and their notifying
 * messages come from `db/work-status`, the roster from the employee store, and
 * "who is working right now" from the session queue. Keeping the live half here
 * (and not in `db/`) is what stops the data layer from importing the agent layer.
 *
 * A group is *in progress* — and therefore gets a room — **only while someone is
 * actually working in it** (a live agent run). The progress card is no longer a
 * criterion: it still feeds the room's screen, but a card with open steps and no
 * run means "nobody is on this now", which is exactly the board's point. The one
 * addition is the orchestrator: the assistant never runs *inside* a task group,
 * it runs in the root chat that spawned it, so a group whose assistant is
 * streaming counts as working too.
 *
 * The candidate selection therefore starts from the live runs: idle groups are
 * never even fetched, so a long history cannot crowd a working group out of the
 * bounded payload (see `listRoomChatCandidates`).
 */

/** One live agent run, as the session queue reports it. */
export interface RunningSessionRef {
  employeeId: number;
  chatId: number;
}

/**
 * Live streaming sessions, indexed as `chatId → employeeIds`. Read once per
 * snapshot so a session that starts between two rooms cannot be seen twice.
 */
function readRunningByChat(
  running: readonly RunningSessionRef[],
): Map<number, Set<number>> {
  const byChat = new Map<number, Set<number>>();
  for (const session of running) {
    const set = byChat.get(session.chatId) ?? new Set<number>();
    set.add(session.employeeId);
    byChat.set(session.chatId, set);
  }
  return byChat;
}

/** One-line bubble label: whitespace collapsed, then clamped by the constant. */
function bubbleLabel(content: string): string {
  // Newlines are kept: the bubble body is rendered as Markdown (the CSS clamps it
  // to two lines visually), and collapsing whitespace turns a table or a code
  // block into one broken line before the parser ever sees it.
  const body = content.replace(/\r\n/gu, "\n").trim();
  if (body.length <= MAX_BUBBLE_LENGTH) return body;
  const head = Array.from(body).slice(0, MAX_BUBBLE_LENGTH).join("");
  // Markdown blocks are paragraph-delimited, so cutting at a blank line keeps the
  // paragraphs before it whole (a table or code block that starts earlier still
  // renders). Only when there is no such break in range do we fall back to a
  // line, a sentence or a word boundary — never mid-token.
  const boundary = Math.max(
    head.lastIndexOf("\n\n"),
    head.lastIndexOf("\n"),
    head.lastIndexOf("。"),
    head.lastIndexOf(". "),
    head.lastIndexOf(" "),
  );
  const cut =
    boundary > MAX_BUBBLE_LENGTH * 0.5 ? head.slice(0, boundary) : head;
  return `${cut.trimEnd()}…`;
}

interface EmployeeLookup {
  name: string;
  avatar: string | null;
  avatarVersion: number | null;
  disabled: boolean;
}

function toMembers(
  participants: readonly number[],
  running: Set<number> | undefined,
  assistantRunning: boolean,
  employees: Map<number, EmployeeLookup>,
): WorkRoomMember[] {
  const members: WorkRoomMember[] = [];
  for (const employeeId of participants) {
    const employee = employees.get(employeeId);
    if (!employee || employee.disabled) continue;
    const orchestrator = employeeId === ASSISTANT_ID;
    members.push({
      employeeId,
      name: employee.name,
      avatar: employee.avatar,
      avatarVersion: employee.avatarVersion,
      // The assistant never runs *inside* a task group: it orchestrates from its
      // own session in the root chat that spawned the group.
      running: orchestrator
        ? assistantRunning
        : running?.has(employeeId) === true,
      orchestrator,
    });
    if (members.length >= MAX_ROOM_MEMBERS) break;
  }
  // The orchestrator is the room's anchor (its desk defines the layout), so it
  // must never be the member that the cap drops.
  if (!members.some((member) => member.orchestrator)) {
    const assistant = employees.get(ASSISTANT_ID);
    if (assistant) {
      members.unshift({
        employeeId: ASSISTANT_ID,
        name: assistant.name,
        avatar: assistant.avatar,
        avatarVersion: assistant.avatarVersion,
        running: assistantRunning,
        orchestrator: true,
      });
    }
  }
  return members;
}

function toBubbles(rows: RoomBubbleRow[]): WorkRoomBubble[] {
  const bubbles: WorkRoomBubble[] = [];
  for (const row of rows) {
    if (bubbles.length >= MAX_ROOM_BUBBLES) break;
    bubbles.push({
      employeeId: row.employeeId,
      messageId: row.messageId,
      kind: row.kind,
      content: bubbleLabel(row.content),
      at: row.at,
    });
  }
  return bubbles;
}

/**
 * Build the full snapshot.
 *
 * `truncated` is true only when genuinely in-progress rooms did not fit — a board
 * that says "most recent only" while showing nothing must never happen.
 *
 * `running` is a parameter (defaulting to the live session queue) so the rules
 * above can be exercised without a model provider: the snapshot is a pure
 * function of the database plus the set of live runs.
 */
export function readWorkRooms(
  running: readonly RunningSessionRef[] = listRunningSessions(),
): WorkRoomsPayload {
  const progressByGroup = listLatestProgressByGroup();
  const runningByChat = readRunningByChat(running);

  // A live run can be in a group (an employee) or in a root chat (the assistant).
  const runningChatIds = [...runningByChat.keys()];
  const chats = listRoomChatCandidates(runningChatIds, runningChatIds);

  const bubblesByGroup = new Map<number, RoomBubbleRow[]>();
  for (const row of listLatestNotifyBySender(
    chats.map((chat) => chat.chatId),
  )) {
    const list = bubblesByGroup.get(row.chatId) ?? [];
    list.push(row);
    bubblesByGroup.set(row.chatId, list);
  }

  const employees = new Map(
    dbEmployees
      .listEmployees()
      .map((employee) => [employee.id, employee] as const),
  );

  const rooms: WorkRoom[] = [];
  for (const chat of chats) {
    const progressRow = progressByGroup.get(chat.chatId) ?? null;
    const running = runningByChat.get(chat.chatId);
    const assistantRunning =
      chat.fromChatId !== null &&
      runningByChat.get(chat.fromChatId)?.has(ASSISTANT_ID) === true;
    // Nobody working → not in progress, whatever the card says.
    const anyoneRunning = (running?.size ?? 0) > 0 || assistantRunning;
    if (!anyoneRunning) continue;

    const bubbles = toBubbles(bubblesByGroup.get(chat.chatId) ?? []);
    const members = toMembers(
      chat.participants,
      running,
      assistantRunning,
      employees,
    );
    // "Recently active" is the later of the last message and the latest bubble
    // on the wall — a room that just woke everyone must not sort as stale.
    const lastBubbleAt = bubbles.reduce(
      (latest, bubble) => Math.max(latest, bubble.at),
      0,
    );
    rooms.push({
      chatId: chat.chatId,
      title: chat.title,
      lastActiveAt: Math.max(chat.lastMessageAt, lastBubbleAt),
      members,
      progress:
        progressRow === null
          ? null
          : {
              messageId: progressRow.messageId,
              title: progressRow.title,
              steps: progressRow.steps.slice(0, MAX_ROOM_STEPS),
              at: progressRow.at,
            },
      bubbles,
    });
  }

  rooms.sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.chatId - a.chatId);
  return {
    rooms: rooms.slice(0, MAX_WORK_ROOMS),
    truncated: rooms.length > MAX_WORK_ROOMS,
  };
}
