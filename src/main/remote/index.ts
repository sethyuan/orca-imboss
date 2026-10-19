import { remoteAgentManager } from "./manager";

export { remoteAgentManager } from "./manager";
export type { RemoteTaskState } from "./client";
export type {
  RemoteDelegateResult,
  RemoteRunStatus,
  RemoteSendOutcome,
} from "./manager";

/**
 * Remote A2A peers are client-only in this phase: there is nothing to start
 * at boot and nothing to stop at quit beyond aborting in-flight sends.
 */
export function initRemoteAgents(): Promise<void> {
  return remoteAgentManager.init();
}

export function shutdownRemoteAgents(): void {
  remoteAgentManager.disposeAll();
}
