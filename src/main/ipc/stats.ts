import type { StatDaily } from "@shared/types";
import { ipcMain } from "electron";
import { listStats } from "../db/stats";

/** Persistent daily stats (survives chat deletion and restarts). */
export function registerStatHandlers(): void {
  ipcMain.handle("stats:list", (): StatDaily[] => listStats());
}
