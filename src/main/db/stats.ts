import type { StatDaily } from "@shared/types";
import { getDB } from "./index";

/**
 * Daily stats rollup: per-employee counters accumulated as work happens, so the
 * numbers survive chat deletion and app restarts (unlike reading live rows).
 * No foreign key on `employee_id`: history outlives a deleted employee.
 */

function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Add to today's counters for one employee (any subset of fields). */
export function bumpStat(
  employeeId: number,
  patch: { runMs?: number; messages?: number; reports?: number },
): void {
  if (!Number.isSafeInteger(employeeId) || employeeId < 0) return;
  const runMs = Math.max(0, Math.round(patch.runMs ?? 0));
  const messages = Math.max(0, Math.round(patch.messages ?? 0));
  const reports = Math.max(0, Math.round(patch.reports ?? 0));
  if (runMs === 0 && messages === 0 && reports === 0) return;
  getDB()
    .prepare(
      `INSERT INTO stats_daily (day, employee_id, run_ms, messages, reports)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, employee_id) DO UPDATE SET
         run_ms = stats_daily.run_ms + excluded.run_ms,
         messages = stats_daily.messages + excluded.messages,
         reports = stats_daily.reports + excluded.reports`,
    )
    .run(today(), employeeId, runMs, messages, reports);
}

/** Every accumulated row (all days). */
export function listStats(): StatDaily[] {
  return (
    getDB()
      .prepare(
        "SELECT day, employee_id, run_ms, messages, reports FROM stats_daily ORDER BY day ASC, employee_id ASC",
      )
      .all() as Array<{
      day: string;
      employee_id: number;
      run_ms: number;
      messages: number;
      reports: number;
    }>
  ).map((row) => ({
    day: row.day,
    employeeId: row.employee_id,
    runMs: row.run_ms,
    messages: row.messages,
    reports: row.reports,
  }));
}
