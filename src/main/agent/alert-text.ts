/**
 * One readable line out of a message body, for the OS notification the boss sees.
 *
 * Lives on its own so two very different producers can share it without
 * importing each other: the `imb_send_message` pipeline (`builtin-tools.ts`,
 * where `report`/`ask` derive their alert text) and the queue's employee-direct-
 * chat mirror (`session-queue.ts`, which alerts with the run's final text).
 *
 * The rule matches what a notification body must be: the first non-empty line,
 * markdown markers stripped, whitespace collapsed, length capped. Markdown list
 * bullets and headers are chrome the boss does not need in a banner, and a blank
 * result means "nothing worth alerting about" rather than an empty banner.
 */

/** Cap on the one-liner derived for an alerting message. */
export const ALERT_BODY_MAX = 200;

export function alertOneLine(value: string, max = ALERT_BODY_MAX): string {
  const line =
    value
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  const plain = line
    .replace(/^[#>*+\-\s]+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return "";
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
