/**
 * Remote A2A (Agent2Agent) peers.
 *
 * A peer is another agent reachable over the A2A protocol — typically another
 * imboss instance, but any A2A-compliant agent works. Each peer is surfaced as
 * a conversation in the chat list; the peer's messages are stored as messages
 * from a dedicated (hidden) employee row, so avatars, unread badges and
 * notifications work exactly like a local employee's.
 */

/** Outcome of the last agent-card refresh for one peer. */
export type RemoteAgentStatus = "ok" | "error";

/** One A2A peer as shown to the renderer (never carries its token). */
export interface RemoteAgent {
  id: number;
  /** Display name from the peer's agent card. */
  name: string;
  /** Description from the peer's agent card. */
  description: string;
  /** Agent-card base URL (the card is resolved at `/.well-known/agent-card.json`). */
  url: string;
  status: RemoteAgentStatus;
  /** Why the last refresh failed (`null` when `status` is `ok`). */
  statusDetail: string | null;
  /** Skill names advertised by the agent card. */
  skills: string[];
  /**
   * The hidden employee row backing this peer. Messages the peer sends are
   * stored with this sender id; it never appears in the Employees module.
   */
  employeeId: number;
  /** The conversation bridged to this peer. */
  chatId: number;
  /** UNIX timestamp in seconds. */
  createdAt: number;
}

/** Input accepted by `remote:add`. */
export interface RemoteAgentInput {
  /** Agent-card base URL (`https://host` or a full card URL). */
  url: string;
  /**
   * Optional bearer token sent as `Authorization: Bearer <token>` on every
   * request to this peer. Stored in the main-process secrets file only.
   */
  token?: string;
}
