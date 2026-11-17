import type { WorkRoomsPayload } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The module's data: one snapshot of every in-progress task group.
 *
 * The main process only pushes "the snapshot is stale" (see
 * `main/work-status-events.ts`), so this hook owns the read. Two rules keep the
 * board honest without polling:
 *
 * - while the module is **not** on screen, changes are remembered as dirty and
 *   nothing is fetched (the host stays mounted, so it must stay cheap);
 * - the snapshot is re-read when the module comes back, and on every change
 *   notification while it is visible.
 */

export interface WorkRoomsState {
  rooms: WorkRoomsPayload["rooms"];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  /** At least one snapshot was read successfully (drives the empty state). */
  loaded: boolean;
}

const EMPTY: WorkRoomsState = {
  rooms: [],
  truncated: false,
  loading: false,
  error: null,
  loaded: false,
};

export interface WorkRoomsResult extends WorkRoomsState {
  reload: () => void;
}

export function useWorkRooms(active: boolean): WorkRoomsResult {
  const [state, setState] = useState<WorkRoomsState>(EMPTY);
  const activeRef = useRef(active);
  const dirtyRef = useRef(true);
  const loadingRef = useRef(false);

  const reload = useCallback((): void => {
    if (loadingRef.current) {
      // Coalesce: one read in flight is enough, the next one happens right after.
      dirtyRef.current = true;
      return;
    }
    loadingRef.current = true;
    dirtyRef.current = false;
    setState((previous) => ({
      ...previous,
      loading: previous.loaded === false,
    }));
    void imb.workStatus
      .rooms()
      .then((payload) => {
        setState({
          rooms: payload.rooms,
          truncated: payload.truncated,
          loading: false,
          error: null,
          loaded: true,
        });
      })
      .catch((error: unknown) => {
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      })
      .finally(() => {
        loadingRef.current = false;
        if (dirtyRef.current && activeRef.current) reload();
      });
  }, []);

  useEffect(() => {
    const off = imb.workStatus.onChanged(() => {
      if (!activeRef.current) {
        dirtyRef.current = true;
        return;
      }
      reload();
    });
    return off;
  }, [reload]);

  useEffect(() => {
    activeRef.current = active;
    // Only the activation edge refreshes; `state.loaded` is read, never a
    // dependency (otherwise a finished read would re-trigger this effect).
    if (active && (dirtyRef.current || !state.loaded)) reload();
  }, [active, reload]);

  return { ...state, reload };
}
