import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LaunchedApp } from "./app";

/**
 * Write a persisted Pi session transcript for one `(employee, chat)` pair.
 *
 * This is the only way to exercise the **session view's projection** of things
 * the app can only produce while a model runs (a boss prompt carrying the
 * per-turn hint, a prompt with its `[Attachments]` block, tool calls…): the file
 * is written straight into the throw-away data root in the Pi session format,
 * and `sessions:set` records it so the app reads it back like any other
 * transcript.
 *
 * Format (a `session` header line, then one line per entry, chained by
 * `parentId` — the leaf is the session's current branch):
 *
 * ```
 * {"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}
 * {"type":"message","id":…,"parentId":…,"timestamp":…,"message":{"role":…,"content":[…],"timestamp":…}}
 * ```
 */
export interface SessionMessageSpec {
  role: "user" | "assistant";
  /** Concatenated `text` blocks of the message (what the projection reads). */
  text: string;
}

export async function seedSessionTranscript(
  app: LaunchedApp,
  employeeId: number,
  chatId: number,
  messages: readonly SessionMessageSpec[],
): Promise<void> {
  const dir = join(app.dataRoot, "agent", "sessions", "chats", String(chatId));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${employeeId}.jsonl`);

  const now = new Date().toISOString();
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: now,
      cwd: app.dataRoot,
    }),
  ];
  let parentId: string | null = null;
  for (const [index, message] of messages.entries()) {
    const id = `e2e${index.toString(16).padStart(6, "0")}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: now,
        message: {
          role: message.role,
          content: [{ type: "text", text: message.text }],
          timestamp: Date.parse(now) + index,
        },
      }),
    );
    parentId = id;
  }
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");

  await app.window.evaluate(
    async (input: { employeeId: number; chatId: number; file: string }) => {
      const imb = (
        window as unknown as {
          imb: {
            sessions: {
              set(
                employeeId: number,
                chatId: number,
                file: string,
              ): Promise<void>;
            };
          };
        }
      ).imb;
      await imb.sessions.set(input.employeeId, input.chatId, input.file);
    },
    { employeeId, chatId, file },
  );
}
