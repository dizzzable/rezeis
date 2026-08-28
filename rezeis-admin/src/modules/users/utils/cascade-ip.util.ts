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
 * ENUMERATED MEANS COMPARABLE, PER NODE — and the first version of this
 * function got that wrong in a way that would have shipped. It counted the
 * ENTRIES it was handed rather than the ones it could actually compare, so a
 * node configured by hostname (`de1.example.net`) made the list non-empty,
 * satisfied the guard, and then contributed nothing: the hostname does not
 * parse, the loop skipped it, and the address was captured as "not one of
 * ours" without a single comparison having been made. On a deployment whose
 * nodes are all hostnames — the panel only started reporting per-node `ips` in
 * 3.2.3, and rezeis serves installs older than that — the guard was decorative
 * and one ban could refuse an entire node's customers.
 *
 * So the input is grouped BY NODE, and a node that yields no parsable address
 * is not a node we checked. One such node anywhere in the fleet turns the whole
 * answer into `NODES_UNKNOWN`: we cannot prove the address is not its exit
 * address, and the cost of being wrong is asymmetric. Failing to list a banned
 * customer's address weakens the weakest layer of the ban — identity and device
 * still hold. Listing a node's address refuses every customer behind it.
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

/**
 * One node's addresses: whatever it is configured as, plus every address it
 * reports for itself. Grouped per node rather than flattened, because the
 * question the guard asks is "could we compare against THIS node?" and a flat
 * list cannot answer it — see the file header.
 */
export type CascadeNodeAddresses = readonly string[];

export function classifyCascadeIp(input: {
  readonly address: string | null | undefined;
  /**
   * Our own nodes, one entry per node, as reported by the panel. `null` means
   * the enumeration failed.
   *
   * An EMPTY array is treated identically to `null`, deliberately. Every real
   * deployment has at least one node, so "no nodes" is what an unreachable
   * panel looks like — and deciding that here rather than at the call site
   * means no future caller can reintroduce the fleet-wide block by forwarding
   * an empty answer as if it were knowledge.
   */
  readonly nodes: readonly CascadeNodeAddresses[] | null;
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

  if (input.nodes === null || input.nodes.length === 0) {
    return { capture: false, reason: 'NODES_UNKNOWN' };
  }

  // Every node is examined before the coverage guard below, because a MATCH is
  // conclusive on its own: if the address is demonstrably one of ours, it makes
  // no difference that some other node was unreadable.
  let uncomparableNodes = 0;
  for (const node of input.nodes) {
    let comparable = 0;
    for (const nodeAddress of node) {
      const parsedNode = parseAddressOrCidr(nodeAddress);
      // A hostname does not parse, and is deliberately NOT resolved: a DNS
      // lookup here would make the decision depend on a network call that can
      // time out, and a timeout would silently downgrade "not our node" into
      // "we did not check" — the exact confusion this function exists to stop.
      // It is not skipped silently either; it simply does not count as a
      // comparison, which is what the tally below is for.
      if (parsedNode === null) continue;
      comparable += 1;
      if (ipMatchesEntry(parsed.canonical, parsedNode)) {
        return { capture: false, reason: 'OUR_NODE' };
      }
    }
    if (comparable === 0) uncomparableNodes += 1;
  }

  // One node we could not compare against is enough to withhold the capture.
  // Not a partial answer, not a best effort: the whole value of this function
  // is that a `capture: true` means every node was ruled out, and a node whose
  // address is a name we refused to resolve was not ruled out at all.
  if (uncomparableNodes > 0) return { capture: false, reason: 'NODES_UNKNOWN' };

  return { capture: true, value: parsed.canonical };
}
