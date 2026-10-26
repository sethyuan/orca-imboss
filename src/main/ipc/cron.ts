import type { CronJobInfo } from "@shared/types";
import { removeJob, runNow, setEnabled, updateJob } from "../cron";
import * as dbCron from "../db/cron";
import { assertInteger, assertString } from "./helpers";
import type { Binder } from "../rpc/types";

/** Assert a non-empty (trimmed) string within an optional max length. */
function assertNonEmptyString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const safe = assertString(value, field);
  if (safe.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  if (safe.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
  return safe;
}

export function registerCronHandlers(bind: Binder): void {
  // List an employee's jobs (assistant id 0 included) with chat titles resolved
  // for the Employees detail pane.
  bind("cron:listByEmployee", (_ctx, employeeId: unknown) => {
    const safeId = assertInteger(employeeId, "employee id");
    if (safeId < 0) throw new Error("employee id must not be negative.");
    return dbCron.listByEmployee(safeId);
  });

  // Every job across all employees (flat, creation order), for the unified
  // Scheduled tasks module.
  bind("cron:listAll", (): CronJobInfo[] => dbCron.listAll());

  // Edit the editable fields only (schedule + content); the composite id and
  // therefore chat/employee are immutable. Revalidates the schedule (throws on
  // an invalid expression) and returns the updated row, or null when gone.
  bind(
    "cron:update",
    (
      _event,
      id: unknown,
      schedule: unknown,
      content: unknown,
    ): CronJobInfo | null => {
      const safeId = assertNonEmptyString(id, "cron job id", 256);
      const safeSchedule = assertNonEmptyString(schedule, "cron schedule", 128);
      const safeContent = assertNonEmptyString(
        content,
        "cron job content",
        100000,
      );
      return updateJob(safeId, safeSchedule, safeContent);
    },
  );

  // Enable/disable a job: persists the flag and starts/stops the live handle.
  bind(
    "cron:setEnabled",
    (_ctx, id: unknown, enabled: unknown): CronJobInfo | null => {
      const safeId = assertNonEmptyString(id, "cron job id", 256);
      if (typeof enabled !== "boolean") {
        throw new Error("enabled must be a boolean.");
      }
      return setEnabled(safeId, enabled);
    },
  );

  // Manual "Run now": queue the job's content onto its (employee, chat) session
  // immediately. Does not touch the schedule timestamps.
  bind("cron:runNow", async (_ctx, id: unknown): Promise<boolean> => {
    const safeId = assertNonEmptyString(id, "cron job id", 256);
    return runNow(safeId);
  });

  // Remove a job: stops the live Cron handle and deletes the DB row. Returns
  // false when the job does not exist (idempotent from the renderer's view).
  bind("cron:remove", (_ctx, id: unknown): boolean => {
    const safeId = assertString(id, "cron job id");
    if (safeId.trim().length === 0) {
      throw new Error("cron job id must not be empty.");
    }
    return removeJob(safeId);
  });
}
