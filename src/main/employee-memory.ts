import { getSetting, setSetting } from "./db/settings";

/**
 * Per-employee long-term memory — a free-form Markdown note the employee keeps
 * across sessions (the employee's own "MEMORY.md"). Persisted in the settings
 * key-value table so it needs no schema migration, and injected into the
 * session's system prompt when non-empty.
 */

function memoryKey(employeeId: number): string {
  return `employee.memory.${employeeId}`;
}

/** The employee's memory note (empty string when never written). */
export function getEmployeeMemory(employeeId: number): string {
  return getSetting(memoryKey(employeeId)) ?? "";
}

/** Replace the employee's memory note; returns the stored (trimmed) value. */
export function setEmployeeMemory(employeeId: number, text: string): string {
  const trimmed = text.trim();
  setSetting(memoryKey(employeeId), trimmed);
  return trimmed;
}
