import type { MessageKind, StepStatus } from "./messages";

/**
 * One employee seated in a work-status room. Avatars travel as a path plus a
 * version (same convention as `Employee.avatar` / `avatarVersion`) so the
 * renderer can build an `imb-file:` URL and bust the image cache on re-upload.
 */
export interface WorkRoomMember {
  employeeId: number;
  name: string;
  avatar: string | null;
  avatarVersion: number | null;
  /** The employee is streaming an agent run in this room right now. */
  running: boolean;
  /**
   * *This employee is the room's orchestrator.* Seated at the assistant desk
   * instead of the meeting table. Always employee 0 (the assistant).
   */
  orchestrator: boolean;
}

/** One step of the room's progress screen — the same rows a `progress` card has. */
export interface WorkRoomStep {
  name: string;
  task: string;
  status: StepStatus;
  employeeId: number | null;
}

/** The room's progress screen: the group's latest `progress` card. */
export interface WorkRoomProgress {
  /** Message row the screen was built from (lets the UI link back to the card). */
  messageId: number;
  title: string;
  steps: WorkRoomStep[];
  /** UNIX timestamp in seconds. */
  at: number;
}

/** The last message one employee posted in the room while notifying others. */
export interface WorkRoomBubble {
  employeeId: number;
  messageId: number;
  kind: MessageKind;
  /** Message body, clamped for a bubble-sized label (see `MAX_BUBBLE_LENGTH`). */
  content: string;
  /** UNIX timestamp in seconds. */
  at: number;
}

/** One task group = one room of the work-status view. */
export interface WorkRoom {
  /** The task group chat id (never the root chat a progress card lives in). */
  chatId: number;
  title: string;
  /**
   * Ordering key: the group's latest observed activity — its last message or
   * the moment its most recent run started, whichever is later.
   */
  lastActiveAt: number;
  members: WorkRoomMember[];
  /** `null` when the group has no progress card yet. */
  progress: WorkRoomProgress | null;
  bubbles: WorkRoomBubble[];
}

/** Payload of `workStatus:rooms`. */
export interface WorkRoomsPayload {
  /** Rooms in the boss's reading order: most recently active first. */
  rooms: WorkRoom[];
  /** More in-progress task groups exist than were returned. */
  truncated: boolean;
}

/**
 * Payload of the `workStatus:changed` push: "the snapshot you hold is stale".
 * It deliberately carries no room data — the renderer re-reads `rooms`, so the
 * push can be coalesced without losing anything.
 */
export interface WorkStatusChangedPayload {
  /** What triggered the refresh; informational (used for diagnostics only). */
  reason: "message" | "chat" | "activity";
}
