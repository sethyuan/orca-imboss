/**
 * Caps for the comment feature: a comment annotates a passage of an earlier
 * message and is delivered to the agent inside the `[Comments]` block of the
 * next prompt (see `src/main/comment-prompt.ts`).
 *
 * Two sets of limits on purpose:
 * - the **stored** lengths bound what a message may carry (`messages.comments`
 *   and the pending draft in the composer), keeping one prompt's payload sane;
 * - the **prompt** lengths are what actually reaches the model. A quote is cut
 *   short there because the annotated message is still in the conversation —
 *   the agent can re-read it with `imb_read_chat` — while the note is the boss's
 *   own words and only loses its tail past a much higher bound.
 */

/** Comments one message may carry (also the cap for one pending batch). */
export const MAX_COMMENTS_PER_MESSAGE = 20;

/** Stored length of one comment's note (multi-line, kept verbatim). */
export const MAX_COMMENT_NOTE_LENGTH = 4_000;

/** Stored length of the quoted passage. */
export const MAX_COMMENT_QUOTE_LENGTH = 2_000;

/** Longest quote written into the prompt block (rest is `…`-truncated). */
export const MAX_PROMPT_COMMENT_QUOTE_LENGTH = 500;

/** Longest note written into the prompt block. */
export const MAX_PROMPT_COMMENT_NOTE_LENGTH = 2_000;
