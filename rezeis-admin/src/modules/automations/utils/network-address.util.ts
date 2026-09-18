import {
  clientIpv4,
  networkRanges,
  parseSingleAddress,
  type NetworkRange,
} from '../../../common/net/ip-ranges';
import {
  ipMatchesEntry,
  parseAddressOrCidr,
  type ParsedAddress,
} from '../../blocked-ips/utils/cidr-match';

/**
 * Address arithmetic for `block_ip`, which must never refuse the panel's own
 * traffic. The primitives it is built on are shared with the outbound request
 * policy and live in `common/net/ip-ranges.ts`; this file is the blocklist's
 * half: what the panel's own traffic comes from, and how an entry is spelt so
 * the guard can match it.
 */

export type InternalRangeKind =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'shared_nat'
  | 'unique_local'
  | 'site_local'
  | 'ipv4_mapped';

/**
 * Where the panel's OWN traffic comes from: the machine itself, the reverse
 * proxy in front of it (every `ADMIN_TRUST_PROXY` mode — loopback, linklocal,
 * uniquelocal — is inside this list), the cabinet and the other containers on
 * the compose network, and carrier NAT.
 *
 * The same set the block cascade refuses to list (`NEVER_CAPTURE` in
 * `users/utils/cascade-ip.util.ts`), plus IPv6 site-local and the IPv4-mapped
 * block. The mapped block is here for RANGES only: a single mapped address is
 * unwrapped to its IPv4 form before anything is compared (`parseBlockEntry`),
 * so what this entry refuses is a mapped CIDR — which no request could ever
 * match, because the guard strips `::ffff:` from the caller before it looks.
 *
 * Deliberately wider than the outbound policy (`common/net/outbound-url.ts`):
 * a webhook may reach a private address, but a block may never cover one.
 */
export const INTERNAL_NETWORK_RANGES: readonly NetworkRange<InternalRangeKind>[] = networkRanges<InternalRangeKind>([
  ['0.0.0.0/8', 'unspecified'],
  ['127.0.0.0/8', 'loopback'],
  ['10.0.0.0/8', 'private'],
  ['172.16.0.0/12', 'private'],
  ['192.168.0.0/16', 'private'],
  ['169.254.0.0/16', 'link_local'],
  ['100.64.0.0/10', 'shared_nat'],
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['fc00::/7', 'unique_local'],
  ['fe80::/10', 'link_local'],
  ['fec0::/10', 'site_local'],
  ['::ffff:0:0/96', 'ipv4_mapped'],
]);

/**
 * An address or range the way the IP blocklist stores and matches it.
 *
 * A single IPv4 address in its IPv6-mapped spelling (`::ffff:1.2.3.4`, or the
 * `::ffff:102:304` a URL parser writes) is unwrapped to `1.2.3.4` first — the
 * guard strips that prefix from every caller before it compares, and it
 * compares family first, so the mapped spelling as an ENTRY would never match a
 * request at all. The block cascade unwraps for the same reason.
 */
export function parseBlockEntry(value: string): ParsedAddress | null {
  const parsed = parseAddressOrCidr(value.trim());
  if (parsed === null) return null;
  if (parsed.family === 6 && parsed.prefix === 128) {
    const inner = clientIpv4(parsed);
    if (inner !== null) return parseAddressOrCidr(inner);
  }
  return parsed;
}

/** Whether `address` (a single address, any spelling) is inside `entry`. */
export function entryCoversAddress(entry: ParsedAddress, address: string): boolean {
  const single = parseSingleAddress(address);
  if (single === null) return false;
  const inner = single.family === 6 ? clientIpv4(single) : null;
  return ipMatchesEntry(inner ?? single.canonical, entry);
}
