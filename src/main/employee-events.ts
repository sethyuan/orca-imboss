import { reconcileCapabilityRefs } from "./capability-refs";
import { sendToRenderer } from "./notifications";
import { notifyWorkStatusChanged } from "./work-status-events";

/**
 * Renderer notifications about the `employees` collection.
 *
 * `employees` rows are read by several modules (the Employees module, chat
 * cards, avatars, the assistant's tool briefs), so every main-process write —
 * a profile edit, an import, a capability-reference cleanup — goes through this
 * one helper to keep the shape of `employees:changed` consistent.
 */

/** Tell the renderer these employees changed (no-op for an empty id list). */
export function notifyEmployeesChanged(ids: readonly number[]): void {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  sendToRenderer("employees:changed", { ids: unique });
  // Rooms seat these employees and show their names/avatars, and a bubble can
  // belong to one of them: a rename, an avatar change or a deletion has to reach
  // the work-status board as well. Every employee write funnels through here, so
  // this is the one place that keeps the board in step with the roster.
  notifyWorkStatusChanged("chat");
}

/**
 * One throttled capability-reference self-heal pass (see
 * `capability-refs.ts`) followed by a renderer refresh of whatever it repaired.
 *
 * Intended for read paths (`employees:list*`, `models:list`): capabilities can
 * be removed *without* going through the app (the assistant edits `mcp.json`
 * and `rm -rf`s skill folders by design), so the next time the UI reads the
 * collection is the moment the stale references can be noticed. Never throws.
 */
export function reconcileEmployeeRefsOnRead(): void {
  const report = reconcileCapabilityRefs();
  notifyEmployeesChanged(report.employeeIds);
}
