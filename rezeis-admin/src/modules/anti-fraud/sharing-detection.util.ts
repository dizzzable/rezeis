/**
 * Pure helpers for the subscription-sharing IP detector.
 *
 * WHY THIS EXISTS — research-backed false-positive reduction.
 * Counting *distinct source IPs* and flagging when the count exceeds the
 * device limit is a known-bad signal: a single legitimate user routinely
 * presents many IPs in a short window —
 *   • mobile carriers rotate CGNAT egress IPs per request,
 *   • a phone hops between Wi-Fi, LTE and different access points,
 *   • IPv6 privacy extensions rotate the host portion of the address
 *     constantly (a new /128 every few minutes for ONE device),
 *   • a load balancer (e.g. Remnawave node auto-selection) reconnects the
 *     same client across nodes.
 * Industry anti-fraud (device fingerprinting / household models) treats IP
 * as a weak contextual signal, never a standalone identity. So instead of
 * raw IPs we count distinct *networks* (prefix-grouped) and only flag when
 * that exceeds the device limit by a tolerance margin.
 *
 * These functions are intentionally pure + total (no throw) so they can be
 * unit-tested without the Remnawave panel or Prisma.
 */

/** Mask an IPv4 address to its network prefix, e.g. `1.2.3.4` /24 → `1.2.3.0/24`. */
export function ipv4NetworkKey(ip: string, prefix: number): string {
  const octets = ip.trim().split('.');
  if (octets.length !== 4) return ip;
  const nums = octets.map((o) => Number.parseInt(o, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return ip;
  const p = clampPrefix(prefix, 32);
  const bits = (((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0) >>> 0;
  const mask = p === 0 ? 0 : p >= 32 ? 0xffffffff : (0xffffffff << (32 - p)) >>> 0;
  const net = (bits & mask) >>> 0;
  return `${(net >>> 24) & 0xff}.${(net >>> 16) & 0xff}.${(net >>> 8) & 0xff}.${net & 0xff}/${p}`;
}

/** Expand an IPv6 address to its 8 normalised hextets, or `null` if unparseable. */
export function expandIpv6(ip: string): string[] | null {
  // Strip brackets, zone id (`%eth0`) and any embedded port-less form.
  const clean = ip.trim().replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  if (clean.length === 0 || clean.indexOf(':') === -1) return null;
  const parts = clean.split('::');
  if (parts.length > 2) return null;
  const head = parts[0].length > 0 ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1].length > 0 ? parts[1].split(':') : [];
  let groups: string[];
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  }
  const out: string[] = [];
  for (const g of groups) {
    const n = Number.parseInt(g.length > 0 ? g : '0', 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push(n.toString(16));
  }
  return out;
}

/** Group an IPv6 address by its prefix (number of leading hextets). */
export function ipv6NetworkKey(ip: string, prefix: number): string {
  const expanded = expandIpv6(ip);
  if (expanded === null) return ip;
  const p = clampPrefix(prefix, 128);
  const groups = Math.min(8, Math.max(1, Math.ceil(p / 16)));
  return `${expanded.slice(0, groups).join(':')}::/${p}`;
}

/**
 * Resolve the network key for an IP (v4 or v6) at the configured prefixes.
 *
 * NOTE: `countDistinctNetworks` deliberately does NOT go through this — it has
 * to keep the two families in separate sets so a dual-stack device is one
 * network and not two. This stays for callers that want a single opaque key
 * (logging, metadata, ad-hoc grouping) and for the dispatch test.
 */
export function ipNetworkKey(ip: string, v4Prefix: number, v6Prefix: number): string {
  if (ip.indexOf(':') !== -1) return ipv6NetworkKey(ip, v6Prefix);
  return ipv4NetworkKey(ip, v4Prefix);
}

/**
 * Count distinct *networks* among a set of source IPs. When `grouping` is off
 * this collapses to the raw distinct-IP count (legacy behaviour).
 *
 * DUAL-STACK. The two address families are counted in SEPARATE sets and the
 * answer is the larger of the two, never their sum. One set was wrong: a single
 * dual-stack device presents a v4 address AND a v6 address for the same
 * connection, so it contributed one /24 key plus one /48 key — two "networks"
 * for one device. A legitimate two-device household came out at 4 against a
 * tolerance of `deviceLimit + 1 = 3` and was flagged for owning a phone and a
 * laptop on an ISP that enabled IPv6.
 *
 * `max` is not a fudge, it is the minimum number of devices consistent with the
 * observation: every device contributes at most one network per family, so
 * seeing V4 v4-networks and V6 v6-networks requires at least `max(V4, V6)`
 * devices and at most `V4 + V6`. This detector produces an accusation, so it
 * takes the smallest explanation the evidence supports. The cost is the case
 * where one sharer is v4-only and another v6-only — they collapse to one — and
 * that is the correct trade against naming a customer for a protocol their ISP
 * turned on.
 */
export function countDistinctNetworks(
  ips: readonly string[],
  opts: { grouping: boolean; v4Prefix: number; v6Prefix: number },
): number {
  if (!opts.grouping) return new Set(ips).size;
  const v4Networks = new Set<string>();
  const v6Networks = new Set<string>();
  for (const ip of ips) {
    if (typeof ip !== 'string' || ip.length === 0) continue;
    if (ip.indexOf(':') !== -1) v6Networks.add(ipv6NetworkKey(ip, opts.v6Prefix));
    else v4Networks.add(ipv4NetworkKey(ip, opts.v4Prefix));
  }
  return Math.max(v4Networks.size, v6Networks.size);
}

/**
 * Keep only the samples that were in use at essentially the same moment as the
 * user's own most recent sighting.
 *
 * The panel hands us `{ ip, lastSeen }` and no session intervals, so "at the
 * same time" cannot be computed by intersecting connections. What it CAN be
 * computed from is the fact that `lastSeen` tracks a live connection and
 * freezes on an abandoned one: cluster on recency relative to that user's own
 * newest sample and a phone that moved from Wi-Fi to LTE collapses to one
 * network, while two people connected right now both stay.
 *
 * Anchored per user, not on `now`, because "how recently did WE look" is not
 * the question — a user whose whole session ended six minutes ago should have
 * their six-minute-old IPs compared with each other, not discarded wholesale.
 * The anchor is clamped to `nowMs` so that a node whose clock runs fast cannot
 * push the anchor into the future and thereby exclude every other node's
 * samples, which would turn clock skew into silent under-detection.
 *
 * Samples whose `lastSeenMs` is not finite are dropped: an event we cannot
 * place in time is not evidence that two things happened at the same time.
 */
export function selectConcurrentSamples<T extends { readonly lastSeenMs: number }>(
  samples: readonly T[],
  nowMs: number,
  concurrencyWindowMs: number,
): readonly T[] {
  if (samples.length === 0) return [];
  const window = Number.isFinite(concurrencyWindowMs) ? Math.max(0, concurrencyWindowMs) : 0;
  let newest = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (Number.isFinite(sample.lastSeenMs) && sample.lastSeenMs > newest) newest = sample.lastSeenMs;
  }
  if (newest === Number.NEGATIVE_INFINITY) return [];
  const anchor = Number.isFinite(nowMs) ? Math.min(newest, nowMs) : newest;
  const cutoff = anchor - window;
  return samples.filter((s) => Number.isFinite(s.lastSeenMs) && s.lastSeenMs >= cutoff);
}

/**
 * Parse an `ip-control` row's `userId` into a panel user id, or `null`.
 *
 * The vendored contract declares that field as a plain string with no numeric
 * constraint, and the call site used to do `Number.parseInt(value, 10)`, which
 * stops at the first non-digit: a uuid-shaped id like `3f2a-…` came back as the
 * number `3` and the row's IP samples were silently attributed to panel user
 * #3 — one customer's connections filed against another customer's name. A
 * value we cannot read is skipped, never approximated.
 */
export function parsePanelId(value: string): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // The WHOLE string must be digits — not merely start with them.
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A subscription is a sharing offender only when its distinct-network count
 * exceeds the device limit *plus a tolerance margin*. The margin absorbs the
 * natural "one extra network" a single user produces (home Wi-Fi + mobile)
 * without tripping the detector.
 */
export function isNetworkSharingOffender(
  distinctNetworks: number,
  deviceLimit: number,
  margin: number,
): boolean {
  if (deviceLimit <= 0) return false;
  return distinctNetworks > deviceLimit + Math.max(0, margin);
}

function clampPrefix(prefix: number, max: number): number {
  if (!Number.isFinite(prefix)) return max;
  if (prefix < 0) return 0;
  if (prefix > max) return max;
  return Math.floor(prefix);
}
