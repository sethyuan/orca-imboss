import type { Employee, EmployeeInput, EmployeeMetric } from "@shared/types";
import { ipcMain } from "electron";
import { disposeForEmployee } from "../agent/session-queue";
import { deleteAvatarFiles, saveAvatar } from "../avatars";
import * as cron from "../cron";
import * as dbEmployees from "../db/employees";
import { listEmployeeMessageMetrics } from "../db/metrics";
import { getEmployeeRuntime } from "../employee-runtime";
import { listByEmployee, unlinkSessionFile } from "../db/sessions";
import { sendToRenderer } from "../notifications";
import { assertInteger, assertString, parsePageQuery } from "./helpers";

/** Notify the renderer that the employees collection changed (name/avatar). */
function notifyEmployeesChanged(ids: number[]): void {
  sendToRenderer("employees:changed", { ids });
}

export function registerEmployeeHandlers(): void {
  ipcMain.handle("employees:list", () => dbEmployees.listEmployees());

  ipcMain.handle("employees:listPage", (_event, page: unknown) =>
    dbEmployees.listEmployeesPage(parsePageQuery(page)),
  );

  // Live per-employee dashboard metrics (message/report counts, run time).
  ipcMain.handle("employees:metrics", (): EmployeeMetric[] => {
    const byId = new Map(
      listEmployeeMessageMetrics().map((m) => [m.employeeId, m]),
    );
    return dbEmployees.listEmployees().map((employee) => {
      const m = byId.get(employee.id);
      return {
        employeeId: employee.id,
        working: false,
        currentRunMs: 0,
        totalRunMs: getEmployeeRuntime(employee.id),
        messages: m?.messages ?? 0,
        reports: m?.reports ?? 0,
        lastText: m?.lastText ?? null,
        lastAt: m?.lastAt ?? null,
        tasks: { pending: 0, running: 0, done: 0, closed: 0 },
      };
    });
  });

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
