import { remoteInboundServer } from "./inbound";
import { remoteAgentManager } from "./manager";

export { remoteAgentManager } from "./manager";
export { remoteInboundServer } from "./inbound";
export type { RemoteTaskState } from "./client";
export type {
  RemoteDelegateResult,
  RemoteRunStatus,
  RemoteSendOutcome,
} from "./manager";

/**
 * Start both halves of the A2A bridge: the client side loads its peer secrets
 * and resumes any interrupted run, and the inbound endpoint starts listening
 * when the boss has switched it on.
 */
export async function initRemoteAgents(): Promise<void> {
  await remoteAgentManager.init();
  await remoteInboundServer.init();
}

export async function shutdownRemoteAgents(): Promise<void> {
  remoteAgentManager.disposeAll();
  await remoteInboundServer.stop();
}
