import { ROOM_LINGER_MS } from "@shared/constants/work-status";
import type { WorkRoom, WorkRoomsPayload } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";

import { type LingeringRoom, mergeRoomsWithLinger } from "./linger";

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
 *
 * The snapshot itself only lists groups where someone works *now*. What the board
 * shows is that list plus the rooms still inside their `ROOM_LINGER_MS` window
 * (see `linger.ts`), so a group that just finished keeps its room for a while.
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
  const snapshotRef = useRef<WorkRoom[]>([]);
  const truncatedRef = useRef(false);
  const lingeringRef = useRef<Map<number, LingeringRoom>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveAtRef = useRef(0);

  // Re-derives the visible rooms from the last snapshot at `now`, and schedules the
  // single timer that removes the next room when its window closes. Running it on
  // activation as well is what keeps the keep-alive case honest: time passed while
  // the module was hidden, so an expired room is dropped before it is ever painted.
  const apply = useCallback((now: number): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const merged = mergeRoomsWithLinger(
      lingeringRef.current,
      snapshotRef.current,
      now,
      ROOM_LINGER_MS,
      liveAtRef.current === 0 ? now : liveAtRef.current,
    );
    lingeringRef.current = merged.lingering;
    setState((previous) => ({
      ...previous,
      rooms: merged.rooms,
      truncated: truncatedRef.current,
    }));
    if (merged.nextExpiryInMs !== null) {
      timerRef.current = setTimeout(
        () => apply(Date.now()),
        merged.nextExpiryInMs,
      );
    }
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

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
        snapshotRef.current = payload.rooms;
        truncatedRef.current = payload.truncated;
        liveAtRef.current = Date.now();
        apply(liveAtRef.current);
        setState((previous) => ({
          ...previous,
          loading: false,
          error: null,
          loaded: true,
        }));
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
  }, [apply]);

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
    if (active) apply(Date.now());
  }, [active, reload, apply]);

  return { ...state, reload };
}
