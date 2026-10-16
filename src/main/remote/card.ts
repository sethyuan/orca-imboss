import { DefaultAgentCardResolver } from "@a2a-js/sdk/client";

/**
 * Agent-card discovery for a remote peer.
 *
 * A peer is identified by its agent-card URL. The card is resolved once when
 * the peer is added (and on every explicit refresh), then cached in the
 * database and reused for requests — so a send never pays for discovery.
 */

/** What the app keeps from an agent card. */
export interface ResolvedRemoteCard {
  /** Normalized card, cached as JSON and re-used to build the client. */
  card: unknown;
  name: string;
  description: string;
  skills: string[];
}

/** Caps applied to card-derived strings before they reach the database. */
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const MAX_SKILLS = 50;
const MAX_SKILL_NAME = 120;

/**
 * Validate and canonicalize a user-supplied peer URL.
 *
 * Only `http:`/`https:` are accepted: a peer URL is handed to `fetch`, and
 * every other scheme (`file:`, `data:`, custom protocols) is either useless
 * or a local-file read primitive.
 */
export function normalizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Enter the peer's agent card URL.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The URL must start with http:// or https://.");
  }
  return url.toString();
}

/**
 * Card path passed to the resolver. A URL that already points at a card file
 * (`.../agent-card.json`) is used verbatim; anything else is treated as a base
 * URL and gets the standard `/.well-known/agent-card.json`.
 */
export function cardPathFor(url: string): string | undefined {
  try {
    return new URL(url).pathname.endsWith(".json") ? "" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `fetch` with the peer's bearer token attached, when it has one.
 * Caller-provided headers win, mirroring the SDK's own authenticating fetch.
 */
export function authFetch(token: string | null): typeof fetch {
  if (token === null || token.length === 0) return fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

/** Resolve (and normalize) the agent card of a peer. */
export async function resolveRemoteCard(
  url: string,
  token: string | null,
): Promise<ResolvedRemoteCard> {
  const resolver = new DefaultAgentCardResolver({
    fetchImpl: authFetch(token),
  });
  let card: unknown;
  try {
    card = await resolver.resolve(url, cardPathFor(url));
  } catch (err) {
    throw new Error(describeResolveFailure(url, err));
  }
  const record = card as {
    name?: unknown;
    description?: unknown;
    skills?: unknown;
  };
  const name = clamp(record?.name, MAX_NAME) || "Remote agent";
  const description = clamp(record?.description, MAX_DESCRIPTION);
  const skills = Array.isArray(record?.skills)
    ? (record.skills as Array<{ name?: unknown }>)
        .map((skill) => clamp(skill?.name, MAX_SKILL_NAME))
        .filter((skillName) => skillName.length > 0)
        .slice(0, MAX_SKILLS)
    : [];
  return { card, name, description, skills };
}

/** Turn a resolver failure into a short, user-facing sentence. */
function describeResolveFailure(url: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = /: (\d{3})$/.exec(message)?.[1];
  if (status !== undefined) {
    return `The agent card at ${url} answered HTTP ${status}.`;
  }
  return `Could not reach the agent card at ${url}: ${message}`;
}

function clamp(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  if (cleaned.length <= max) return cleaned;
  // The ellipsis counts against the cap so callers can rely on `max` as a hard
  // limit (a chat title, for example, is rejected above 200 characters).
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}
