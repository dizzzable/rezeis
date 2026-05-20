/**
 * Tiny CIDR / address matcher.
 *
 * Why hand-write this?
 *   The IPv4 case is trivial; the IPv6 case stays simple if we treat
 *   addresses as BigInt. Pulling a third-party package (`ip-cidr`,
 *   `netmask`) for one match function is overkill — `BlockedIpGuard`
 *   sits on the hot path of every protected request, so we want
 *   predictable performance without external state.
 */

import { isIPv4, isIPv6 } from 'node:net';

export interface ParsedAddress {
  /** Canonical input string (lowercased, trimmed, prefix preserved). */
  readonly canonical: string;
  readonly family: 4 | 6;
  /** Network address (high bits zeroed out below `prefix`). */
  readonly network: bigint;
  /** Prefix length (0-32 for IPv4, 0-128 for IPv6). */
  readonly prefix: number;
}

/**
 * Parses an `address` string. Accepts:
 *   - a single IPv4 address       ("1.2.3.4")
 *   - a single IPv6 address       ("2001:db8::1")
 *   - an IPv4 CIDR                ("1.2.3.0/24")
 *   - an IPv6 CIDR                ("2001:db8::/32")
 *
 * Returns `null` for anything else.
 */
export function parseAddressOrCidr(input: string): ParsedAddress | null {
  const raw = input.trim().toLowerCase();
  if (raw.length === 0) return null;
  const slashIdx = raw.indexOf('/');
  const head = slashIdx === -1 ? raw : raw.slice(0, slashIdx);
  const prefixRaw = slashIdx === -1 ? null : raw.slice(slashIdx + 1);

  let family: 4 | 6;
  if (isIPv4(head)) family = 4;
  else if (isIPv6(head)) family = 6;
  else return null;

  const fullBits = family === 4 ? 32 : 128;
  let prefix = fullBits;
  if (prefixRaw !== null) {
    const n = Number(prefixRaw);
    if (!Number.isInteger(n) || n < 0 || n > fullBits) return null;
    prefix = n;
  }

  const numeric = family === 4 ? ipv4ToBigInt(head) : ipv6ToBigInt(head);
  if (numeric === null) return null;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(fullBits)) - 1n) ^ ((1n << BigInt(fullBits - prefix)) - 1n);
  const network = numeric & mask;
  return {
    canonical: prefixRaw === null ? head : `${head}/${prefix}`,
    family,
    network,
    prefix,
  };
}

/** True when `ip` is a member of `entry` (single address or CIDR). */
export function ipMatchesEntry(ip: string, entry: ParsedAddress): boolean {
  const family: 4 | 6 = isIPv4(ip) ? 4 : isIPv6(ip) ? 6 : 0 as 4 | 6;
  if (family !== entry.family) return false;
  const numeric = family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  if (numeric === null) return false;
  const fullBits = family === 4 ? 32 : 128;
  const mask = entry.prefix === 0
    ? 0n
    : ((1n << BigInt(fullBits)) - 1n) ^ ((1n << BigInt(fullBits - entry.prefix)) - 1n);
  return (numeric & mask) === entry.network;
}

// ── Helpers ────────────────────────────────────────────────────────────

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8n) | BigInt(n);
  }
  return result;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Quick IPv4-mapped form (`::ffff:1.2.3.4`).
  const lastColon = ip.lastIndexOf(':');
  const trail = ip.slice(lastColon + 1);
  if (trail.includes('.')) {
    const v4 = ipv4ToBigInt(trail);
    if (v4 === null) return null;
    const head = ip.slice(0, lastColon + 1) + (v4 >> 16n).toString(16) + ':' + (v4 & 0xffffn).toString(16);
    return ipv6ToBigInt(head);
  }

  const doubleColon = ip.indexOf('::');
  let groups: string[];
  if (doubleColon >= 0) {
    const left = ip.slice(0, doubleColon).split(':').filter((g) => g.length > 0);
    const right = ip.slice(doubleColon + 2).split(':').filter((g) => g.length > 0);
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...new Array<string>(missing).fill('0'), ...right];
  } else {
    groups = ip.split(':');
  }
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    if (!/^[0-9a-f]+$/i.test(g)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return result;
}
