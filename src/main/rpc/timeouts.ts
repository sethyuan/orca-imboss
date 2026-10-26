/**
 * Per-channel deadlines, shared by the client (which asks) and the backend
 * (which enforces). One table so the two can never disagree about how long a
 * channel may take.
 *
 * Rationale for the exceptions: these are the channels that wait for a human or
 * write a whole data folder — everything else is a database read/write or a small
 * file operation and belongs under a minute.
 */

/** Default deadline for a channel call. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const TIMEOUTS: Readonly<Record<string, number>> = {
  // Tearing down sessions and files for a whole chat tree.
  "chats:delete": 120_000,
  // Unpack + validate a whole employee package.
  "employees:importApply": 120_000,
  // Spawn a Mini App server and wait for it to answer.
  "miniapps:open": 120_000,
  // Unpack an archive over the data folder.
  "backup:restore": 300_000,
  // Whole-data-folder operations (archive in / archive out, skill folders).
  "backup:export": 1_800_000,
  "employees:export": 1_800_000,
  "skills:install": 1_800_000,
  // Interactive sign-ins: a human scans a QR code / completes a device flow.
  "providers:login": 1_800_000,
  "integrations:login": 1_800_000,
};

export function timeoutForChannel(channel: string): number {
  return TIMEOUTS[channel] ?? DEFAULT_TIMEOUT_MS;
}
