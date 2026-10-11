import type { Employee, EmployeeInput } from "@shared/types";
import { ipcMain } from "electron";
import { disposeForEmployee } from "../agent/session-queue";
import { deleteAvatarFiles, saveAvatar } from "../avatars";
import * as cron from "../cron";
import * as dbEmployees from "../db/employees";
import { getEmployeeMemory, setEmployeeMemory } from "../employee-memory";
import { listByEmployee, unlinkSessionFile } from "../db/sessions";
import { sendToRenderer } from "../notifications";
import { assertInteger, assertString, parsePageQuery } from "./helpers";

/** Notify the renderer that the employees collection changed (name/avatar). */
function notifyEmployeesChanged(ids: number[]): void {
  sendToRenderer("employees:changed", { ids });
}

export function registerEmployeeHandlers(): void {
  ipcMain.handle("employees:list", () => dbEmployees.listEmployees());

  // Long-term memory: a per-employee note injected into the session prompt.
  ipcMain.handle("employees:getMemory", (_e, id: number) =>
    getEmployeeMemory(assertInteger(id, "id")),
  );
  ipcMain.handle("employees:setMemory", (_e, id: number, text: string) =>
    setEmployeeMemory(assertInteger(id, "id"), assertString(text, "text")),
  );

  ipcMain.handle("employees:listPage", (_event, page: unknown) =>
    dbEmployees.listEmployeesPage(parsePageQuery(page)),
  );

  ipcMain.handle(
    "employees:create",
    (_event, input: EmployeeInput): Employee => {
      const employee = dbEmployees.createEmployee(input);
      notifyEmployeesChanged([employee.id]);
      return employee;
    },
  );

  ipcMain.handle(
    "employees:update",
    (_event, id: unknown, input: EmployeeInput) => {
      const safeId = assertInteger(id, "employee id");
      const employee = dbEmployees.updateEmployee(safeId, input);
      if (employee) notifyEmployeesChanged([safeId]);
      return employee;
    },
  );

  ipcMain.handle("employees:delete", async (_event, id: unknown) => {
    const safeId = assertInteger(id, "employee id");
    // Capture disk session file paths BEFORE the FK cascade wipes the rows.
    const records = listByEmployee(safeId);
    // Tear down any warm agent sessions for this employee first.
    await disposeForEmployee(safeId);
    const result = dbEmployees.deleteEmployee(safeId);
    // Only a hard delete removes disk artifacts; a soft delete (employee still
    // a chat participant) keeps the session/avatar state intact.
    if (result === "deleted") {
      // The `cron_jobs.employee_id` FK cascade removed the rows, but the live
      // in-process Cron handles must be stopped explicitly.
      cron.stopJobsForEmployee(safeId);
      await Promise.all(records.map((r) => unlinkSessionFile(r.session)));
      deleteAvatarFiles(safeId);
    }
    notifyEmployeesChanged([safeId]);
    return result;
  });

  ipcMain.handle(
    "employees:updateAvatar",
    (_event, id: unknown, ext: unknown, data: unknown) => {
      const safeId = assertInteger(id, "employee id");
      const safeExt = assertString(ext, "ext");
      if (!(data instanceof Uint8Array)) {
        throw new Error("Avatar data must be bytes.");
      }
      const path = saveAvatar(safeId, safeExt, Buffer.from(data));
      const employee = dbEmployees.updateEmployeeAvatar(safeId, path);
      if (employee) notifyEmployeesChanged([safeId]);
      return employee;
    },
  );
}
