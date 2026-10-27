/**
 * Ask-card answer limits, shared by the renderer (draft store, card UI, parser)
 * and the main-process validation layer so the number can never drift.
 */

/**
 * Cap for the boss's "additional notes" (`supplement`) on an answer, in
 * characters. Long enough for a paragraph of extra instructions, short enough
 * that one pasted blob cannot bloat a message row or the agent's context.
 */
export const MAX_ANSWER_SUPPLEMENT_LENGTH = 10_000;
