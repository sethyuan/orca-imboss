import { readSessionView } from "../agent/session-view";
import { deleteSession, getSession, setSession } from "../db/sessions";
import { assertInteger, assertString } from "./helpers";
import type { Binder } from "../rpc/types";

export function registerSessionHandlers(bind: Binder): void {
  // Projected, read-only view of a persistent `(employee, chat)` agent
  // session. Never exposes system prompts / tool args / tool results.
  bind("sessions:entries", (_ctx, employeeId: unknown, chatId: unknown) => {
    const safeEmployee = assertInteger(employeeId, "employee id");
    const safeChat = assertInteger(chatId, "chat id");
    return readSessionView(safeEmployee, safeChat);
  });

  bind("sessions:get", (_ctx, employeeId: unknown, chatId: unknown) => {
    const safeEmployee = assertInteger(employeeId, "employee id");
    const safeChat = assertInteger(chatId, "chat id");
    return getSession(safeEmployee, safeChat);
  });

  bind(
    "sessions:set",
    (_ctx, employeeId: unknown, chatId: unknown, sessionPath: unknown) => {
      const safeEmployee = assertInteger(employeeId, "employee id");
      const safeChat = assertInteger(chatId, "chat id");
      setSession(
        safeEmployee,
        safeChat,
        assertString(sessionPath, "session path"),
      );
    },
  );

  bind("sessions:delete", (_ctx, employeeId: unknown, chatId: unknown) => {
    const safeEmployee = assertInteger(employeeId, "employee id");
    const safeChat = assertInteger(chatId, "chat id");
    return deleteSession(safeEmployee, safeChat);
  });
}
