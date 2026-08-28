import { ipMatchesEntry, parseAddressOrCidr, ParsedAddress } from '../../blocked-ips/utils/cidr-match';

/**
 * Decides whether an address observed for a blocked user may be added to the
 * IP blocklist.
 *
 * ── Why this is a separate, pure decision ──────────────────────────────────
 *
 * Adding an IP to the blocklist refuses EVERY request from it, for everybody.
 * Every other cascade in the block path can only ever affect the person being
 * blocked; this one is the single place where a mistake takes out strangers, so
 * the reasoning that decides it is kept out of the service, written down, and
 * tested on its own.
 *
 * ── The refusals, and what each one is protecting ─────────────────────────
 *
 * OUR OWN NODES. A customer who browses the cabinet while connected to the VPN
 * arrives from the exit address of one of our own nodes. Listing that address
 * would refuse every other customer behind the same node — and would do it
 * silently, looking exactly like an outage. This is the failure the whole
 * function exists to prevent, which is why {@link classifyCascadeIp} demands a
 * POSITIVELY ENUMERATED node list and refuses to capture anything at all when
 * it does not have one. An empty list is treated as "we do not know", never as
 * "there are no nodes": every real deployment has at least one, so an empty
 * answer means the panel could not be reached, and guessing in that state is
 * how a whole fleet gets blocked by a single ban.
 *
 * PRIVATE AND LOCAL RANGES. A reverse proxy that forgets `X-Forwarded-For`
 * reports `127.0.0.1` for every visitor on earth. Listing it would refuse the
 * entire service, including the admin panel, with a row that reads as a
 * deliberate operator decision.
 *
 * A CIDR. Registration snapshots hold single addresses; a value with a prefix
 * did not come from where this thinks it did, and a cascade must never widen a
 * ban to a range on its own.
 */

/** Ranges no cascade may ever list, whatever the panel reports. */
const NEVER_CAPTURE = [
  // IPv4 loopback / private / link-local / CGNAT. CGNAT (100.64/10) matters
  // most in practice: a mobile carrier puts thousands of unrelated subscribers
  // behind one address there.
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  // IPv6 loopback, unique-local and link-local.
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]
  .map((cidr) => parseAddressOrCidr(cidr))
  .filter((parsed): parsed is ParsedAddress => parsed !== null);

export type CascadeIpDecision =
  | { readonly capture: true; readonly value: string }
  | { readonly capture: false; readonly reason: CascadeIpRefusal };

export type CascadeIpRefusal =
  /** Nothing was recorded for this user — the commonest outcome by far. */
  | 'NO_ADDRESS'
  /** Not an address we can reason about (a hostname, junk, or a range). */
  | 'NOT_AN_ADDRESS'
  /** Loopback, private, link-local or carrier-grade NAT. */
  | 'NOT_PUBLIC'
  /** The address belongs to one of our own nodes. */
  | 'OUR_NODE'
  /** We could not enumerate our nodes, so we cannot prove it is not one. */
  | 'NODES_UNKNOWN';

export function classifyCascadeIp(input: {
  readonly address: string | null | undefined;
  /**
   * Addresses of our own nodes, as reported by the panel. `null` means the
   * enumeration failed.
   *
   * An EMPTY array is treated identically to `null`, deliberately. Every real
   * deployment has at least one node, so "no nodes" is what an unreachable
   * panel looks like — and deciding that here rather than at the call site
   * means no future caller can reintroduce the fleet-wide block by forwarding
   * an empty answer as if it were knowledge.
   */
  readonly nodeAddresses: readonly string[] | null;
}): CascadeIpDecision {
  const raw = (input.address ?? '').trim();
  if (raw.length === 0) return { capture: false, reason: 'NO_ADDRESS' };

  const parsed = parseAddressOrCidr(raw);
  if (parsed === null) return { capture: false, reason: 'NOT_AN_ADDRESS' };
  // A single address parses with the full prefix. Anything shorter is a range,
  // and a range is not something a registration snapshot can contain.
  const fullBits = parsed.family === 4 ? 32 : 128;
  if (parsed.prefix !== fullBits) return { capture: false, reason: 'NOT_AN_ADDRESS' };

  for (const range of NEVER_CAPTURE) {
    if (ipMatchesEntry(parsed.canonical, range)) return { capture: false, reason: 'NOT_PUBLIC' };
  }

  if (input.nodeAddresses === null || input.nodeAddresses.length === 0) {
    return { capture: false, reason: 'NODES_UNKNOWN' };
  }
  for (const nodeAddress of input.nodeAddresses) {
    const node = parseAddressOrCidr(nodeAddress);
    // A node whose address is a hostname does not parse. It is skipped rather
    // than resolved: a DNS lookup here would make the decision depend on a
    // network call that can time out, and a timeout would silently downgrade
    // this from "not our node" to "we did not check".
    if (node === null) continue;
    if (ipMatchesEntry(parsed.canonical, node)) return { capture: false, reason: 'OUR_NODE' };
  }

  return { capture: true, value: parsed.canonical };
}
