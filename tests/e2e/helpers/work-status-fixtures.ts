import Database from "better-sqlite3";
import { join } from "node:path";

/**
 * Fixtures for the work-status board: a task group with a progress card and a
 * notifying message.
 *
 * **Why this one bypasses the IPC bridge** (which every other fixture uses): the
 * rows the board reads cannot be produced through a channel. A task group is
 * only ever created by the assistant's `imb_create_chat` tool — there is no
 * `chats:create` option for `from_chat_id` — and a `progress` message is only
 * written by `imb_progress`, because `messages:append` carries no `steps` /
 * `groupChatId`. Driving the tool path instead would need a model provider and
 * real spending, which this suite deliberately never does.
 *
 * The write is kept minimal and schema-correct by construction: it inserts only
 * into `chats` and `messages`, uses the app's own column names, and lets the app
 * migrate/validate everything else (employees and the root chat are created
 * through the app's channels by the caller). The app runs its database in WAL
 * mode, so a committed write from this process is visible to it immediately; the
 * caller reloads the renderer, which is exactly the "read it back from disk"
 * rule the suite follows everywhere else.
 */

export interface SeedStep {
  name: string;
  task: string;
  status: "done" | "busy" | "pending";
  employeeId: number;
}

export interface SeedBubble {
  /** Employee that posted the message. */
  employeeId: number;
  content: string;
  /** Participants the message woke (this is what makes it a bubble). */
  notify: number[];
}

export interface SeedRoomInput {
  dataRoot: string;
  /** Root conversation the progress card is posted into. */
  rootChatId: number;
  title: string;
  participants: number[];
  progressTitle: string;
  steps: SeedStep[];
  bubbles?: SeedBubble[];
}

export interface SeededRoom {
  chatId: number;
  progressMessageId: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Append one notifying message to an existing task group (the "a new message
 * arrived while the board is open" case).
 */
export function appendNotifyMessage(
  dataRoot: string,
  input: {
    chatId: number;
    employeeId: number;
    content: string;
    notify: number[];
  },
): number {
  const db = new Database(join(dataRoot, "db", "imboss.db"));
  try {
    const result = db
      .prepare(
        "INSERT INTO messages (chat_id, sender_employee_id, kind, content, notify, created_at) " +
          "VALUES (?, ?, 'text', ?, ?, ?)",
      )
      .run(
        input.chatId,
        input.employeeId,
        input.content,
        JSON.stringify(input.notify),
        nowSeconds(),
      );
    // The chat's own activity timestamp drives the room order.
    db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(
      nowSeconds(),
      input.chatId,
    );
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

/**
 * Repoint a task group's newest progress card at a new set of steps and wake the
 * board (the "the card changed while the screen is on the wall" case).
 */
export function updateProgressCard(
  dataRoot: string,
  input: {
    progressMessageId: number;
    progressTitle: string;
    steps: SeedStep[];
  },
): void {
  const db = new Database(join(dataRoot, "db", "imboss.db"));
  try {
    // The card's payload is `{ chatId, steps }` — `chatId` is what links the card to
    // its task group, so it has to be carried over rather than overwritten.
    const row = db
      .prepare("SELECT steps FROM messages WHERE id = ?")
      .get(input.progressMessageId) as { steps: string | null } | undefined;
    const previous =
      row?.steps == null
        ? {}
        : (JSON.parse(row.steps) as Record<string, unknown>);
    db.prepare("UPDATE messages SET content = ?, steps = ? WHERE id = ?").run(
      input.progressTitle,
      JSON.stringify({ ...previous, steps: input.steps }),
      input.progressMessageId,
    );
  } finally {
    db.close();
  }
}

/** Insert one task group + its progress card + its notifying messages. */
export function seedTaskGroup(input: SeedRoomInput): SeededRoom {
  const db = new Database(join(input.dataRoot, "db", "imboss.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const createdAt = nowSeconds();
    const participants = JSON.stringify([...new Set(input.participants)]);

    const chatResult = db
      .prepare(
        "INSERT INTO chats (title, participants, created_at, last_message_at, from_chat_id) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.title, participants, createdAt, createdAt, input.rootChatId);
    const chatId = Number(chatResult.lastInsertRowid);

    // `steps` doubles as the card's link to its group (see `serializeSteps`).
    const stepsJson = JSON.stringify({ chatId, steps: input.steps });
    const progressResult = db
      .prepare(
        "INSERT INTO messages (chat_id, sender_employee_id, kind, content, steps, created_at) " +
          "VALUES (?, 0, 'progress', ?, ?, ?)",
      )
      .run(input.rootChatId, input.progressTitle, stepsJson, createdAt);
    const progressMessageId = Number(progressResult.lastInsertRowid);

    for (const bubble of input.bubbles ?? []) {
      db.prepare(
        "INSERT INTO messages (chat_id, sender_employee_id, kind, content, notify, created_at) " +
          "VALUES (?, ?, 'text', ?, ?, ?)",
      ).run(
        chatId,
        bubble.employeeId,
        bubble.content,
        JSON.stringify(bubble.notify),
        createdAt,
      );
    }

    return { chatId, progressMessageId };
  } finally {
    db.close();
  }
}
