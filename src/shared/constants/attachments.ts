/**
 * Attachment limits, shared by the main-process validation layer, the built-in
 * team tools and the renderer UI so the numbers can never drift apart.
 */

/** Max attachments a user may attach in the chat input bar. */
export const MAX_USER_ATTACHMENTS = 16;

/**
 * Max byte size of a single attachment. Enforced by the main-process DB
 * validation, the built-in team tools and the composer's pasted-file store so
 * the limit can never drift between producers.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Max file paths a single agent tool call may attach. */
export const MAX_TOOL_ATTACHMENTS = 5;

/** Max attachment chips rendered in a message bubble (the rest fold into `+N`). */
export const MAX_VISIBLE_ATTACHMENTS = 5;

/**
 * Upper bound for the tool-supplied `attachmentTotal` — the true number of
 * files an agent attached when it only forwards the first
 * `MAX_TOOL_ATTACHMENTS` to the message.
 */
export const MAX_ATTACHMENT_TOTAL = 1000;

/**
 * Caps for files carried over the A2A bridge. Much lower than
 * `MAX_ATTACHMENT_BYTES` because the payload is base64-ish JSON on the wire and
 * the peer's inbox is not ours to fill: files past the cap stay named in the
 * message text instead of being uploaded.
 */
export const MAX_REMOTE_FILE_BYTES = 8 * 1024 * 1024;

/** Max bytes of all uploaded files in a single A2A message. */
export const MAX_REMOTE_TOTAL_BYTES = 24 * 1024 * 1024;
