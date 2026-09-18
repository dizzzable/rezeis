/**
 * What a customer pastes when they say "this is my subscription".
 * ═══════════════════════════════════════════════════════════════
 * Recovery by subscription link asks for the link the customer's VPN app holds.
 * Nobody copies it from our database: they copy it out of Happ, v2rayNG,
 * Hiddify, Streisand, Shadowrocket — each of which stores and exports it in its
 * own wrapping. This file turns whatever arrived into the SHORT IDS it could
 * contain, and nothing more.
 *
 * ── Only ids, never a host ─────────────────────────────────────────────────
 *
 * The host in a pasted URL is the customer's claim, not ours. Nothing here
 * fetches it, and nothing downstream compares it: a candidate is matched only
 * against the short ids derived from OUR stored `Subscription.configUrl`
 * (`configUrlShortIds`). A link rewritten onto another domain still
 * carries the same short id, and a link onto our domain with someone else's id
 * matches nothing of theirs.
 *
 * ── Shapes accepted ────────────────────────────────────────────────────────
 *
 *   https://sub.example.com/<id>                      Remnawave 3.x
 *   https://sub.example.com/<id>/singbox?x=1          a client-type suffix, a query
 *   https://panel.example.com/api/sub/<id>/json       the `/api/sub/` and `/sub/` forms
 *   <id>                                              the bare short id
 *   happ://add/https://…   v2raytun://import/https://…   streisand://import/https://…
 *   v2rayng://install-sub?url=https%3A%2F%2F…          the URL percent-encoded in a parameter
 *   sing-box://import-remote-profile?url=…#name   clash://install-config?url=…
 *   sub://<base64 of the URL>                          Shadowrocket's export
 *
 * Encrypted Happ links (`happ://crypt…`) are opaque by design — the app
 * encrypts the URL so it cannot be read back out — and are reported as such so
 * the page can say why they cannot be used.
 */

/**
 * The alphabet of a short id this path will look up: Remnawave's generated ids
 * are drawn from it. Its one LIKE metacharacter, `_`, is escaped before any
 * lookup (`escapeLikeLiteral`), and the exact comparison that follows the
 * lookup decides regardless.
 */
export const SUBSCRIPTION_SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/** At most this many candidates are taken from one paste — each costs one exact lookup. */
export const MAX_SUBSCRIPTION_LINK_CANDIDATES = 6;

/**
 * `value` as a literal inside a Postgres LIKE pattern. Prisma binds `contains`
 * / `startsWith` / `endsWith` values VERBATIM, with no `ESCAPE` clause, so `_`
 * and `%` in them are wildcards; backslash is Postgres's default LIKE escape.
 * A short id may contain `_`, and a candidate of six underscores used to match
 * every stored address at once.
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** A pasted value longer than this is cut before parsing. */
const MAX_INPUT_LENGTH = 4096;

/** Path segments that are routes, never ids. */
const RESERVED_SEGMENTS = new Set([
  'api',
  'sub',
  'subs',
  'subscription',
  'subscriptions',
  'admin',
  'assets',
  'asset',
  'health',
  'metrics',
]);

export interface ParsedSubscriptionLink {
  /** Short ids the input could name, most likely first, deduplicated. */
  readonly candidates: readonly string[];
  /** `happ://crypt…` — the link is encrypted and cannot be resolved. */
  readonly encrypted: boolean;
}

export function parseSubscriptionLink(raw: string): ParsedSubscriptionLink {
  const input = (typeof raw === 'string' ? raw : '').trim().slice(0, MAX_INPUT_LENGTH);
  if (input.length === 0) return { candidates: [], encrypted: false };
  if (/^happ:\/\/crypt/i.test(input)) return { candidates: [], encrypted: true };

  const found: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!SUBSCRIPTION_SHORT_ID_PATTERN.test(trimmed)) return;
    if (RESERVED_SEGMENTS.has(trimmed.toLowerCase())) return;
    if (!found.includes(trimmed)) found.push(trimmed);
  };

  // A bare id, pasted on its own.
  if (SUBSCRIPTION_SHORT_ID_PATTERN.test(input)) push(input);

  for (const url of embeddedHttpUrls(input)) {
    for (const id of idsFromUrlPath(url)) push(id);
  }

  return { candidates: found.slice(0, MAX_SUBSCRIPTION_LINK_CANDIDATES), encrypted: false };
}

/**
 * Every `http(s)://` URL the input carries: as written, percent-decoded (a
 * `?url=` parameter), and base64-decoded (`sub://…`). Decoding runs a bounded
 * number of rounds, so a doubly-encoded parameter is still found and a hostile
 * input cannot make it loop.
 */
function embeddedHttpUrls(input: string): string[] {
  const variants: string[] = [input];
  let current = input;
  for (let round = 0; round < 3; round += 1) {
    const decoded = safeDecodeURIComponent(current);
    if (decoded === null || decoded === current) break;
    variants.push(decoded);
    current = decoded;
  }
  const base64 = /^sub:\/\/([A-Za-z0-9+/=_-]+)/i.exec(input);
  if (base64 !== null) {
    const decoded = decodeBase64(base64[1]);
    if (decoded !== null) variants.push(decoded);
  }

  const urls: string[] = [];
  for (const variant of variants) {
    for (const match of variant.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      if (!urls.includes(match[0])) urls.push(match[0]);
    }
  }
  return urls;
}

/**
 * Short-id candidates in a URL's PATH. Its host is ignored on purpose (see the
 * file header). The segment after a `sub` segment comes first — that is where
 * the `/api/sub/<id>` and `/sub/<id>` forms put it — then the first segment
 * (the bare-domain form), then the last and the one before it (an operator's
 * custom path prefix, with or without a client-format suffix), then the rest.
 * Each is only ever compared, exactly, with ids derived from OUR stored
 * addresses; a candidate that is not an id simply matches nothing.
 */
function idsFromUrlPath(value: string): string[] {
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return [];
  }
  const segments = pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => safeDecodeURIComponent(segment) ?? segment);
  const ordered: string[] = [];
  const subIndex = segments.findIndex((segment) => segment.toLowerCase() === 'sub');
  if (subIndex !== -1 && subIndex + 1 < segments.length) ordered.push(segments[subIndex + 1]);
  if (segments.length > 0) ordered.push(segments[0]);
  if (segments.length > 1) ordered.push(segments[segments.length - 1], segments[segments.length - 2]);
  ordered.push(...segments);
  return ordered;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decodeBase64(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    return /https?:\/\//i.test(text) ? text : null;
  } catch {
    return null;
  }
}
