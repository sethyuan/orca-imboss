import type { WorkStatusChangedPayload } from "@shared/types";
import { sendToRenderer } from "./rpc/broadcast";

/**
 * Push channel of the work-status view.
 *
 * The view holds one snapshot (`workStatus:rooms`) and only needs to be told
 * that the snapshot went stale. Coalescing is not a nicety here: a busy task
 * group appends several messages per second (progress cards, reports, join
 * notices) and every one of them would otherwise be one full snapshot read per
 * open window.
 *
 * Kept dependency-free on purpose (only the Electron-free broadcaster). It is
 * called from the message store, the chat channels and the session queue, and
 * those three must never pull each other in through it.
 */

/** Trailing-edge window: a burst of writes costs one refresh. */
const COALESCE_MS = 200;

let timer: NodeJS.Timeout | null = null;
let pending: WorkStatusChangedPayload | null = null;

/**
 * Tell every window the work-status snapshot is stale. `reason` only picks the
 * more specific of two coalesced triggers, and is informational.
 */
export function notifyWorkStatusChanged(
  reason: WorkStatusChangedPayload["reason"],
): void {
  if (pending === null || reason === "activity") pending = { reason };
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    const payload = pending;
    pending = null;
    if (payload !== null) sendToRenderer("workStatus:changed", payload);
  }, COALESCE_MS);
  // Never hold the process open for a UI refresh.
  timer.unref?.();
}
