/**
 * Classifier for the User-Agent a subscription fetch arrives with.
 *
 * WHAT THIS LOOKS FOR, AND — MORE IMPORTANTLY — WHAT IT REFUSES TO.
 * ────────────────────────────────────────────────────────────────
 * Remnawave records one row per hit on `/sub/<shortUuid>`: `{ requestIp,
 * userAgent, requestAt }`. The only thing in that row this module trusts is a
 * STRUCTURAL anomaly: the User-Agent carrying a **proxy config URI** —
 * `vless://…`, `trojan://…`, `ss://…` and friends.
 *
 * A legitimate client's UA is `Product/Version (platform)`. It does not
 * contain a proxy config. When one does, the software fetching our
 * subscription is passing an upstream node/config through its own UA — the
 * signature of a subscription being consumed through a second panel,
 * aggregator, or tunnel rather than by the customer's own client. That is a
 * harm class no other detector here sees: a re-hoster looks like ONE
 * well-behaved device on ONE network to the HWID and concurrent-IP detectors.
 *
 * EVERY OTHER UA HEURISTIC IS DELIBERATELY REJECTED, because our customers
 * legitimately use many clients and the panel logs every kind of fetch:
 *
 *   - "empty / missing UA" — plenty of clients send none. Filing that as
 *     evidence accuses the quiet half of the client ecosystem.
 *   - "generic HTTP library" (`okhttp`, `Go-http-client`, `curl`) — okhttp IS
 *     the Android HTTP stack, so a large share of ordinary Android clients
 *     report it. Scoring it means scoring Android.
 *   - "browser UA" — Remnawave serves a human-readable subscription page at
 *     the same URL (see `/api/subscription-templates`), so every customer who
 *     opens their own link in a browser produces one. It is the most normal
 *     thing a customer can do.
 *   - "a mix of valid and suspicious clients" — the upstream project this idea
 *     came from treats a mixed set as "probably a second client". For a
 *     population that is *encouraged* to try v2rayNG, then Happ, then Clash,
 *     that fires on satisfied customers.
 *
 * A generic `http(s)://` inside the UA is ALSO refused, and that exclusion is
 * load-bearing rather than lazy. Well-behaved crawlers and link-preview
 * fetchers advertise a policy URL inside their UA — `(compatible; Xbot/1.0;
 * +http://example.com/bot.html)` — and our own bot posting a subscription link
 * into a Telegram chat invites exactly such a fetch. Separating "a link to
 * SOMEWHERE" from "a link to OUR subscription host" needs the panel's public
 * subscription host, which this deployment does not configure
 * (`remnawave.config.ts` carries host/port/token and no subscription URL).
 * Until that host is known, only the proxy-config schemes below — which no
 * crawler has any reason to emit — are treated as evidence.
 */

/**
 * URI schemes a proxy/VPN config is written in. Matching one inside a UA means
 * the UA is carrying a config, which is never true of a client identifying
 * itself.
 *
 * `socks`/`socks5`/`http` are deliberately absent: a proxy-aware HTTP library
 * can legitimately mention its own upstream proxy scheme, and `http://` is the
 * crawler-policy-URL case described above.
 */
const PROXY_CONFIG_SCHEMES = [
  'vless',
  'vmess',
  'trojan',
  'ssr',
  'ssd',
  'ss',
  'hysteria2',
  'hysteria',
  'hy2',
  'tuic',
  'juicity',
  'snell',
  'anytls',
  'mieru',
  'wireguard',
] as const;

/**
 * `(^|non-scheme-char)(scheme)://`.
 *
 * The leading boundary is what stops `ss` from matching the tail of
 * `https://`: the character before `s://` there is `p`, which the class
 * excludes. Scheme characters per RFC 3986 are `[a-z0-9+.-]`, so the boundary
 * is "anything that could not itself be part of the scheme".
 *
 * Longer schemes are listed before their own prefixes (`hysteria2` before
 * `hysteria`) so the alternation reports the specific one.
 */
const PROXY_CONFIG_URI_PATTERN = new RegExp(
  `(?:^|[^a-z0-9+.-])(${PROXY_CONFIG_SCHEMES.join('|')})://`,
  'i',
);

/** What a UA was found to be carrying. */
export interface ProxyConfigUriFinding {
  /** The matched scheme, lowercased — e.g. `vless`. */
  readonly scheme: string;
  /**
   * True when the config URI only became visible after percent-decoding, i.e.
   * the UA carried `vless%3A%2F%2F…`. Worth recording separately: an encoded
   * config is a stronger sign of deliberate pass-through than an accidental
   * paste, but it is NOT scored differently — both mean the same thing.
   */
  readonly percentEncoded: boolean;
}

/**
 * Percent-decode without throwing. `decodeURIComponent` rejects a lone `%` or
 * a truncated escape, and a malformed UA is exactly the kind of input that
 * carries one — returning the original is the right answer there, not an
 * exception that would take a detector run down.
 */
function decodePercentSafely(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The proxy config URI a subscription-fetch User-Agent is carrying, or `null`.
 *
 * `null` for an absent/empty UA is a deliberate non-finding, not a degraded
 * read: see the module note on why a missing UA is not evidence.
 */
export function findProxyConfigUri(userAgent: string | null | undefined): ProxyConfigUriFinding | null {
  if (typeof userAgent !== 'string') return null;
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) return null;

  const direct = PROXY_CONFIG_URI_PATTERN.exec(trimmed);
  if (direct !== null) {
    return { scheme: direct[1].toLowerCase(), percentEncoded: false };
  }

  const decoded = decodePercentSafely(trimmed);
  if (decoded === trimmed) return null;
  const encoded = PROXY_CONFIG_URI_PATTERN.exec(decoded);
  if (encoded !== null) {
    return { scheme: encoded[1].toLowerCase(), percentEncoded: true };
  }
  return null;
}

/**
 * A log/metadata-safe rendering of a UA that carries a proxy config.
 *
 * THIS IS NOT COSMETIC TRUNCATION — IT IS CREDENTIAL REDACTION.
 * A `vless://` or `trojan://` URI's userinfo component IS the secret: the
 * client uuid or the trojan password authenticates the connection. Storing the
 * raw UA would copy live credentials — quite possibly OUR OWN customer's —
 * into a `FraudSignal.metadata` blob that the admin UI renders and every
 * operator can read. So the userinfo is replaced, the host is kept (it is the
 * evidence: which upstream this fetcher is carrying), and the whole thing is
 * capped.
 */
export function redactUserAgentForEvidence(userAgent: string, maxLength = 120): string {
  const withoutUserinfo = userAgent.replace(
    // `scheme://userinfo@` — the userinfo is everything up to the last `@`
    // before the authority ends.
    new RegExp(`((?:^|[^a-z0-9+.-])(?:${PROXY_CONFIG_SCHEMES.join('|')})://)[^@\\s/]+@`, 'gi'),
    '$1<redacted>@',
  );
  return withoutUserinfo.length > maxLength
    ? `${withoutUserinfo.slice(0, maxLength)}…`
    : withoutUserinfo;
}
