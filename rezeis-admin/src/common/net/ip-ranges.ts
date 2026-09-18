import { isIP } from 'node:net';

import { parseAddressOrCidr, type ParsedAddress } from '../../modules/blocked-ips/utils/cidr-match';

/**
 * Address arithmetic shared by the two policies that judge an address:
 *
 *   - the IP blocklist's lockout check, which must never list the panel's own
 *     traffic (`automations/services/block-ip-safety.service.ts`);
 *   - the outbound request policy, which decides where the panel may send a
 *     request it did not choose the destination of (`outbound-url.ts`: the
 *     `webhook_post` automation action and the panel's own outgoing webhooks).
 *
 * Built on the blocklist's own matcher (`cidr-match.ts`) rather than a second
 * parser, so "what a range covers" is decided the way `BlockedIpGuard` decides
 * it when a request arrives.
 */

/** A range an address fell into, named for the operator. */
export interface AddressRangeMatch<K extends string = string> {
  readonly cidr: string;
  readonly kind: K;
}

export interface NetworkRange<K extends string = string> extends AddressRangeMatch<K> {
  readonly parsed: ParsedAddress;
}

/**
 * A constant list of ranges, parsed once.
 *
 * A constant that does not parse is a typo in the caller's file, and it would
 * silently drop a whole range from a check. Refusing to load is the only loud
 * answer available.
 */
export function networkRanges<K extends string>(
  entries: ReadonlyArray<readonly [string, K]>,
): readonly NetworkRange<K>[] {
  return entries.map(([cidr, kind]) => {
    const parsed = parseAddressOrCidr(cidr);
    if (parsed === null) throw new Error(`ip-ranges: range "${cidr}" does not parse`);
    return { cidr, kind, parsed };
  });
}

/** True when the two share at least one address: one contains the other. */
export function rangesOverlap(a: ParsedAddress, b: ParsedAddress): boolean {
  if (a.family !== b.family) return false;
  const bits = a.family === 4 ? 32 : 128;
  const mask = prefixMask(Math.min(a.prefix, b.prefix), bits);
  return (a.network & mask) === (b.network & mask);
}

/** The first range of `list` that shares an address with `entry`, or null. */
export function findOverlappingRange<K extends string>(
  entry: ParsedAddress,
  list: readonly NetworkRange<K>[],
): NetworkRange<K> | null {
  for (const range of list) {
    if (rangesOverlap(entry, range.parsed)) return range;
  }
  return null;
}

/** A single address — never a range — or null. Brackets around IPv6 are accepted. */
export function parseSingleAddress(value: string): ParsedAddress | null {
  const bare = value.trim().replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare) === 0) return null;
  const parsed = parseAddressOrCidr(bare);
  if (parsed === null) return null;
  return parsed.prefix === (parsed.family === 4 ? 32 : 128) ? parsed : null;
}

// ── IPv4 inside IPv6 ─────────────────────────────────────────────────────────

/** `::ffff:a.b.c.d` — how Node writes an IPv4 client on a dual-stack socket. */
const MAPPED_HIGH = 0xffffn;
/** `::ffff:0:a.b.c.d` — SIIT's translated form. */
const TRANSLATED_HIGH = 0xffff0000n;
/** `64:ff9b::a.b.c.d` — the well-known NAT64 prefix (RFC 6052), always a /96. */
const NAT64_HIGH = 0x64ff9b0000000000000000n;
/** `64:ff9b:1::/48` — the local-use NAT64 prefix (RFC 8215), any RFC 6052 length. */
const LOCAL_NAT64_PREFIX = 0x64ff9b0001n;
/** `2002:aabb:ccdd::/48` — 6to4, with the IPv4 address in bits 16-47. */
const SIX_TO_FOUR_PREFIX = 0x2002n;
/** `2001:0::/32` — Teredo, with the client's IPv4 address in the last 32 bits, inverted. */
const TEREDO_PREFIX = 0x20010000n;
const LOW_32 = 0xffffffffn;

/**
 * The IPv4 address a single IPv6 address carries in the two spellings an IPv4
 * CLIENT arrives in, or null: mapped (`::ffff:1.2.3.4`), and the deprecated
 * compatible form (`::1.2.3.4` — never `::` or `::1`, which are IPv6's own
 * unspecified and loopback addresses).
 *
 * This is what the blocklist guard strips from a caller before it compares, so
 * it is what an entry has to be unwrapped by too.
 */
export function clientIpv4(address: ParsedAddress): string | null {
  if (address.family !== 6 || address.prefix !== 128) return null;
  const value = address.network;
  const high = value >> 32n;
  const low = value & LOW_32;
  if (high === MAPPED_HIGH) return toIpv4(low);
  if (high === 0n && low > 1n) return toIpv4(low);
  return null;
}

/**
 * Every IPv4 address a single IPv6 address may deliver a packet to — what an
 * outbound request has to see through. Empty for an IPv6 address that carries
 * none.
 *
 *   mapped, compatible  as `clientIpv4`;
 *   SIIT                `::ffff:0:a.b.c.d`;
 *   NAT64               `64:ff9b::a.b.c.d`;
 *   local-use NAT64     `64:ff9b:1::/48`, where the translator may use any of
 *                       the prefix lengths RFC 6052 allows inside it (/48,
 *                       /56, /64, /96) and each puts the IPv4 address in a
 *                       different place. All four readings are returned, so
 *                       an address is refused when ANY of them lands somewhere
 *                       refused: which one the translator uses cannot be known
 *                       from here;
 *   6to4                `2002:aabb:ccdd::/48`;
 *   Teredo              `2001:0::/32`, whose last 32 bits are the client's
 *                       IPv4 address with every bit inverted (RFC 4380).
 *
 * ISATAP is not read: its interface identifier (`…:5efe:a.b.c.d`) names a
 * tunnel endpoint only on a host that has an ISATAP interface for that prefix,
 * and reading it everywhere would refuse ordinary global addresses.
 */
export function embeddedIpv4Addresses(address: ParsedAddress): readonly string[] {
  const client = clientIpv4(address);
  if (client !== null) return [client];
  if (address.family !== 6 || address.prefix !== 128) return [];
  const value = address.network;
  const high = value >> 32n;
  if (high === TRANSLATED_HIGH || high === NAT64_HIGH) return [toIpv4(value & LOW_32)];
  if (value >> 80n === LOCAL_NAT64_PREFIX) {
    const readings = [
      // /96: bits 96-127.
      value & LOW_32,
      // /64: bits 72-103 (bits 64-71 are the zero "u" octet).
      (value >> 24n) & LOW_32,
      // /56: bits 56-63, then bits 72-95.
      (((value >> 64n) & 0xffn) << 24n) | ((value >> 32n) & 0xffffffn),
      // /48: bits 48-63, then bits 72-87.
      (((value >> 64n) & 0xffffn) << 16n) | ((value >> 40n) & 0xffffn),
    ];
    return [...new Set(readings.map(toIpv4))];
  }
  if (value >> 112n === SIX_TO_FOUR_PREFIX) return [toIpv4((value >> 80n) & LOW_32)];
  if (value >> 96n === TEREDO_PREFIX) return [toIpv4(~value & LOW_32)];
  return [];
}

function toIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join('.');
}

function prefixMask(prefix: number, bits: number): bigint {
  if (prefix <= 0) return 0n;
  const all = (1n << BigInt(bits)) - 1n;
  return all ^ ((1n << BigInt(bits - prefix)) - 1n);
}
