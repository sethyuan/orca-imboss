/**
 * The text form a reference name takes inside a message.
 *
 * The composer's `@` / `#` triggers only pick a candidate: what gets written into
 * the message is the name alone, wrapped in backticks — `` `名字` ``. Inline code
 * is what makes a name with spaces survive as **one** token (`@John Doe` could
 * not be told apart from `@John` followed by prose), and it keeps the trigger
 * character out of the message body.
 *
 * Pure and shared so the rule is testable without a renderer (the node
 * equivalence harness asserts it): the composer is the only writer, and nothing
 * on the main side parses these spans — they render as ordinary inline code.
 */

/**
 * Normalize one name into the text a reference may carry.
 *
 * - every whitespace run (newlines included) collapses to a single space and the
 *   ends are trimmed, so a group title written across lines still yields one
 *   inline-code token;
 * - a backtick inside the name becomes `'`: an embedded backtick would close the
 *   code span early and leave the rest of the name outside it;
 * - an empty result falls back to `fallbackId` (an employee with neither a name
 *   nor a role, an untitled row), so a reference is never inserted as `` `` ``.
 */
export function normalizeRefName(name: string, fallbackId: number): string {
  const collapsed = name.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return collapsed.length > 0 ? collapsed : String(fallbackId);
}

/**
 * The inline-code span written into a message for one reference: `` `名字` ``.
 * `name` may be empty (see `normalizeRefName`).
 */
export function wrapRefName(name: string, fallbackId: number): string {
  return `\`${normalizeRefName(name, fallbackId)}\``;
}
