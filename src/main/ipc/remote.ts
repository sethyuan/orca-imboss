import type {
  RemoteAgent,
  RemoteAgentInput,
  RemoteCaller,
  RemoteInboundConfig,
  RemoteInboundInput,
} from "@shared/types";
import { ipcMain } from "electron";
import { remoteAgentManager, remoteInboundServer } from "../remote";
import { assertInteger, assertObject, assertString } from "./helpers";

/** Renderer ↔ main channels for remote A2A peers and this agent's endpoint. */
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

  // --- This company's own A2A endpoint (inbound half) -------------------

  ipcMain.handle("remote:inbound:status", (): RemoteInboundConfig =>
    remoteInboundServer.status(),
  );

  ipcMain.handle(
    "remote:inbound:update",
    async (_event, input: unknown): Promise<RemoteInboundConfig> => {
      const record = assertObject(input, "remote inbound input");
      const payload: RemoteInboundInput = {};
      if (record["enabled"] !== undefined) {
        if (typeof record["enabled"] !== "boolean") {
          throw new Error("enabled must be a boolean.");
        }
        payload.enabled = record["enabled"];
      }
      if (record["host"] !== undefined) {
        payload.host = assertString(record["host"], "host");
      }
      if (record["port"] !== undefined) {
        payload.port = assertInteger(record["port"], "port");
      }
      if (record["name"] !== undefined) {
        payload.name = assertString(record["name"], "name");
      }
      return remoteInboundServer.configure(payload);
    },
  );

  ipcMain.handle("remote:inbound:callers", (): RemoteCaller[] =>
    remoteInboundServer.listCallers(),
  );

  ipcMain.handle(
    "remote:inbound:caller:add",
    async (_event, name: unknown): Promise<RemoteCaller> =>
      remoteInboundServer.addCaller(assertString(name, "caller name")),
  );

  ipcMain.handle(
    "remote:inbound:caller:token",
    async (_event, id: unknown): Promise<RemoteCaller> =>
      remoteInboundServer.regenerateCallerToken(
        assertInteger(id, "remote caller id"),
      ),
  );

  ipcMain.handle(
    "remote:inbound:caller:remove",
    async (_event, id: unknown) => {
      await remoteInboundServer.removeCaller(
        assertInteger(id, "remote caller id"),
      );
    },
  );
}
