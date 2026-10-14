import { getSetting, setSetting } from "./db/settings";

/**
 * Accumulated agent run time per employee (`工時`), persisted in the settings
 * key-value table so it survives restarts. The in-process session queue adds to
 * it whenever an agent turn ends; the employees list and the usage page read it.
 */

function runtimeKey(employeeId: number): string {
  return `employee.runtime.${employeeId}`;
}

/** Total recorded run time for an employee, in milliseconds. */
export function getEmployeeRuntime(employeeId: number): number {
  const raw = getSetting(runtimeKey(employeeId));
  if (!raw) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Add one finished agent turn's duration to an employee's running total. */
export function addEmployeeRuntime(employeeId: number, ms: number): void {
  if (!Number.isFinite(ms) || ms < 1000) return;
  setSetting(
    runtimeKey(employeeId),
    String(getEmployeeRuntime(employeeId) + Math.round(ms)),
  );
}
