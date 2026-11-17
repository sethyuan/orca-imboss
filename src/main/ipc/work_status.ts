import type { WorkRoomsPayload } from "@shared/types";
import { readWorkRooms } from "../work-status";
import type { Binder } from "../rpc/types";

/**
 * Channels of the work-status (3D room) view.
 *
 * Read-only by design: the view observes task groups, it never drives them. The
 * only other half of the contract is the push channel
 * (`workStatus:changed`, see `main/work-status-events.ts`), which just says
 * "re-read this snapshot".
 */
export function registerWorkStatusHandlers(bind: Binder): void {
  bind("workStatus:rooms", (): WorkRoomsPayload => readWorkRooms());
}
