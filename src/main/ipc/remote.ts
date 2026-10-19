import type { RemoteAgent, RemoteAgentInput } from "@shared/types";
import { ipcMain } from "electron";
import { remoteAgentManager } from "../remote";
import { assertInteger, assertObject, assertString } from "./helpers";

/** Renderer ↔ main channels for remote A2A peers (client side only). */
export function registerRemoteAgentHandlers(): void {
  ipcMain.handle("remote:list", (): RemoteAgent[] => remoteAgentManager.list());

  ipcMain.handle(
    "remote:add",
    async (_event, input: unknown): Promise<RemoteAgent> => {
      const record = assertObject(input, "remote agent input");
      const url = assertString(record["url"], "url");
      const rawToken = record["token"];
      const token: string | undefined =
        rawToken === undefined || rawToken === null
          ? undefined
          : assertString(rawToken, "token");
      const payload: RemoteAgentInput = {
        url,
        ...(token !== undefined ? { token } : {}),
      };
      return remoteAgentManager.add(payload);
    },
  );

  ipcMain.handle(
    "remote:refresh",
    async (_event, id: unknown): Promise<RemoteAgent> =>
      remoteAgentManager.refresh(assertInteger(id, "remote agent id")),
  );

  ipcMain.handle("remote:remove", async (_event, id: unknown) => {
    return remoteAgentManager.remove(assertInteger(id, "remote agent id"));
  });
}
