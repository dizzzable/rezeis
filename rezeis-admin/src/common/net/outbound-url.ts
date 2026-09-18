import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { parseAddressOrCidr } from '../../modules/blocked-ips/utils/cidr-match';
import {
  embeddedIpv4Addresses,
  findOverlappingRange,
  networkRanges,
  parseSingleAddress,
  type AddressRangeMatch,
} from './ip-ranges';

/**
 * Where the panel may send a request whose destination an operator typed.
 *
 * Two features do that: the `webhook_post` automation action, and the panel's
 * own outgoing webhooks (`WebhookSubscriptionsService`, delivered by
 * `WebhookDispatcherService`). Both go through this file, at save and at send.
 *
 * ── The policy: refuse only what no webhook legitimately needs ──────────────
 *
 * A receiver in the same compose network (`http://n8n:5678`), on a private
 * address (`10.x`, `192.168.x`, a Tailscale `100.64/10` address, an `fc00::/7`
 * one) or under an internal name (`*.internal`, `*.lan`) is an ordinary setup,
 * and refusing it broke real installations while buying little: the panel's
 * own webhooks, created with the same `webhooks:create`, never had any check.
 * So what is refused is only the classes where a request does real damage:
 *
 *   loopback      `127.0.0.0/8`, `::1` — the machine itself: a Docker API on
 *                 `127.0.0.1:2375`, a database without a password;
 *   unspecified   `0.0.0.0/8`, `::` — which Linux connects to the machine
 *                 itself as well;
 *   link-local    `169.254.0.0/16`, `fe80::/10` — where every major cloud's
 *                 metadata service answers (`169.254.169.254`) with the
 *                 machine's credentials;
 *   multicast     `224.0.0.0/4`, `ff00::/8`;
 *   reserved      `240.0.0.0/4`, which includes the broadcast address;
 *   cloud metadata endpoints that live INSIDE a range this policy otherwise
 *                 allows, one address each (see `OUTBOUND_REFUSED_RANGES`),
 *                 and the metadata services' host names
 *                 (`CLOUD_METADATA_HOST_NAMES`).
 *
 * An IPv6 address that carries an IPv4 one — mapped, compatible, SIIT, NAT64,
 * 6to4, Teredo — is judged by where the packet ends up as well as by itself
 * (`embeddedIpv4Addresses`), and the WHATWG URL parser — the one axios hands
 * the request to — has already folded the numeric tricks (`http://2130706433/`,
 * `http://0x7f.1/`, `http://127.1/` are all `127.0.0.1`) before anything is
 * compared.
 *
 * ── Names are judged by what they resolve to ─────────────────────────────────
 *
 * At save only what a name MUST mean is refused: `localhost` and `*.localhost`
 * (RFC 6761 §6.3 — always the loopback) and the metadata host names. Every
 * other name is judged at send, inside the socket's own lookup
 * (`guardedLookup`): every address it resolves to is classified at the moment
 * of connecting, so the address that is checked is the address that is dialled
 * and a name that answers one thing for a check and another for the request
 * (DNS rebinding) has nothing to exploit. Redirects are not followed and
 * proxies from the environment are not used, so neither can route around it.
 */

/** The same ceiling `CreateWebhookSubscriptionDto.url` has. */
export const OUTBOUND_URL_MAX_LENGTH = 2_048;

/** `WebhookSubscriptionsService`'s own scheme test. */
const HTTP_SCHEME = /^https?:\/\//i;

export type OutboundRangeKind =
  | 'unspecified'
  | 'loopback'
  | 'link_local'
  | 'multicast'
  | 'reserved'
  | 'cloud_metadata'
  | 'unparseable';

export type OutboundRangeMatch = AddressRangeMatch<OutboundRangeKind>;

/**
 * Every address a request may not reach, IPv4 and IPv6.
 *
 * The four single addresses at the end are metadata endpoints that sit inside
 * ranges the policy allows, so they have to be named one by one:
 *
 *   100.100.100.200  Alibaba Cloud ECS metadata (inside carrier NAT)
 *                    https://www.alibabacloud.com/help/en/ecs/user-guide/view-instance-metadata/
 *   fd00:ec2::254    AWS EC2 instance metadata over IPv6 (unique local)
 *                    https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html
 *   fd00:ec2::23     AWS EKS Pod Identity Agent over IPv6 (unique local)
 *                    https://docs.aws.amazon.com/eks/latest/userguide/pod-id-how-it-works.html
 *   fd20:ce::254     Google Compute Engine metadata over IPv6 (unique local)
 *                    https://docs.cloud.google.com/compute/docs/metadata/overview
 *
 * AWS, Google, Azure, Oracle, DigitalOcean and OpenStack all answer on
 * `169.254.169.254` as well, and AWS's task and pod agents on `169.254.170.2`
 * and `169.254.170.23`: link-local covers every one of those.
 */
export const OUTBOUND_REFUSED_RANGES = networkRanges<OutboundRangeKind>([
  ['0.0.0.0/8', 'unspecified'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link_local'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['fe80::/10', 'link_local'],
  ['ff00::/8', 'multicast'],
  ['100.100.100.200/32', 'cloud_metadata'],
  ['fd00:ec2::254/128', 'cloud_metadata'],
  ['fd00:ec2::23/128', 'cloud_metadata'],
  ['fd20:ce::254/128', 'cloud_metadata'],
]);

/**
 * Cloud metadata services' own host names, refused at save as well as at send.
 * Both resolve into link-local, which the send-time lookup refuses anyway; the
 * names are here so the operator is told while still looking at the form.
 *
 *   metadata.google.internal  https://docs.cloud.google.com/compute/docs/metadata/overview
 *   metadata.tencentyun.com   https://www.tencentcloud.com/document/product/213/4934
 */
export const CLOUD_METADATA_HOST_NAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.tencentyun.com',
]);

/** RFC 6761 §6.3: `localhost` and every name under it are the loopback. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain']);
const LOOPBACK_SUFFIX = '.localhost';

export type OutboundUrlRefusalReason =
  | 'missing'
  | 'too_long'
  | 'scheme'
  | 'malformed'
  | 'local_name'
  | 'metadata_name'
  | 'internal_address';

export interface OutboundUrlRefusal {
  readonly reason: OutboundUrlRefusalReason;
  /** The range a literal address fell into, for `internal_address`. */
  readonly range?: OutboundRangeMatch;
}

export type OutboundUrlCheck =
  | { readonly ok: true; readonly url: URL; readonly host: string }
  | { readonly ok: false; readonly refusal: OutboundUrlRefusal };

/**
 * Why a single address may not be the target of a request, or null when it
 * may. Anything that is not an address at all is refused rather than guessed
 * about.
 */
export function classifyOutboundAddress(address: string): OutboundRangeMatch | null {
  const parsed = parseSingleAddress(address);
  if (parsed === null) return { cidr: address, kind: 'unparseable' };
  const own = findOverlappingRange(parsed, OUTBOUND_REFUSED_RANGES);
  if (own !== null) return { cidr: own.cidr, kind: own.kind };
  for (const inner of embeddedIpv4Addresses(parsed)) {
    const target = parseAddressOrCidr(inner);
    if (target === null) return { cidr: address, kind: 'unparseable' };
    const match = findOverlappingRange(target, OUTBOUND_REFUSED_RANGES);
    if (match !== null) return { cidr: match.cidr, kind: match.kind };
  }
  return null;
}

/**
 * The static half: everything that can be known without asking DNS. Run at
 * save, and again at send for a destination saved before this existed.
 */
export function checkOutboundUrl(value: unknown): OutboundUrlCheck {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, refusal: { reason: 'missing' } };
  }
  const trimmed = value.trim();
  if (trimmed.length > OUTBOUND_URL_MAX_LENGTH) return { ok: false, refusal: { reason: 'too_long' } };
  if (!HTTP_SCHEME.test(trimmed)) return { ok: false, refusal: { reason: 'scheme' } };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, refusal: { reason: 'malformed' } };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, refusal: { reason: 'scheme' } };
  }
  const host = normaliseHost(url.hostname);
  if (host.length === 0) return { ok: false, refusal: { reason: 'malformed' } };
  if (isIP(host) !== 0) {
    const range = classifyOutboundAddress(host);
    return range === null
      ? { ok: true, url, host }
      : { ok: false, refusal: { reason: 'internal_address', range } };
  }
  if (LOOPBACK_NAMES.has(host) || host.endsWith(LOOPBACK_SUFFIX)) {
    return { ok: false, refusal: { reason: 'local_name' } };
  }
  if (CLOUD_METADATA_HOST_NAMES.has(host)) return { ok: false, refusal: { reason: 'metadata_name' } };
  return { ok: true, url, host };
}

/** The same sentence wherever a refusal is reported. Names no part of the URL. */
export function describeOutboundUrlRefusal(refusal: OutboundUrlRefusal): string {
  switch (refusal.reason) {
    case 'missing':
      return 'needs a URL';
    case 'too_long':
      return `the URL is longer than ${OUTBOUND_URL_MAX_LENGTH} characters`;
    case 'scheme':
      return 'the URL must use the http or https scheme';
    case 'malformed':
      return 'the URL is not a valid address';
    case 'local_name':
      return 'the URL names this machine itself (localhost)';
    case 'metadata_name':
      return 'the URL names a cloud metadata service';
    case 'internal_address':
      return `the URL points at ${describeRange(refusal.range)}`;
  }
}

/** How a range reads in a sentence: "a loopback address (127.0.0.0/8)". */
export function describeRange(range: OutboundRangeMatch | undefined): string {
  if (range === undefined) return 'an address requests may not reach';
  const noun = RANGE_NOUNS[range.kind];
  return range.kind === 'unparseable' ? noun : `${noun} (${range.cidr})`;
}

const RANGE_NOUNS: Readonly<Record<OutboundRangeKind, string>> = {
  unspecified: 'an unspecified address',
  loopback: 'a loopback address',
  link_local: 'a link-local address, where cloud metadata services answer',
  multicast: 'a multicast address',
  reserved: 'a reserved address',
  cloud_metadata: 'a cloud metadata address',
  unparseable: 'something that is not an IP address',
};

// ── The check at the moment of connecting ────────────────────────────────────

/**
 * The injection token for a `LookupAll`: absent from a container, a consumer
 * uses `systemLookupAll`. A spec provides its own to answer DNS itself.
 */
export const OUTBOUND_LOOKUP = Symbol('OUTBOUND_LOOKUP');

/** Name resolution, every address at once. A seam for tests; production is `dns.lookup`. */
export type LookupAll = (
  hostname: string,
  options: { readonly family?: number; readonly hints?: number },
  callback: (error: NodeJS.ErrnoException | null, addresses: readonly LookupAddress[]) => void,
) => void;

export const systemLookupAll: LookupAll = (hostname, options, callback) => {
  dnsLookup(
    hostname,
    { all: true, family: options.family ?? 0, ...(options.hints === undefined ? {} : { hints: options.hints }) },
    (error, addresses) => callback(error, error === null ? addresses : []),
  );
};

/** A name that resolved, among other things, to somewhere a request may not go. */
export class OutboundAddressRefusedError extends Error {
  public readonly code = 'EOUTBOUNDREFUSED';

  public constructor(
    public readonly host: string,
    public readonly address: string,
    public readonly range: OutboundRangeMatch,
  ) {
    super(`${host} resolves to ${describeRange(range)}: ${address}`);
    this.name = 'OutboundAddressRefusedError';
  }
}

/**
 * A socket lookup that refuses to hand over an address the policy refuses.
 *
 * EVERY address the name resolves to is judged, not only the one that would be
 * dialled first: with `autoSelectFamily` Node may try any of them, and a name
 * answering one allowed and one refused address is the other shape of the same
 * attack. `onRefused` hears about the refusal before the socket does, so the
 * caller can report it by name rather than dig it out of the HTTP client's
 * wrapping.
 */
export function guardedLookup(
  resolveAll: LookupAll,
  onRefused: (error: OutboundAddressRefusedError) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname, { family: familyNumber(options.family), hints: options.hints }, (error, addresses) => {
      if (error !== null) {
        callback(error, '', 0);
        return;
      }
      if (addresses.length === 0) {
        const empty: NodeJS.ErrnoException = new Error(`${hostname} resolved to no address`);
        empty.code = 'ENOTFOUND';
        callback(empty, '', 0);
        return;
      }
      for (const entry of addresses) {
        const range = classifyOutboundAddress(entry.address);
        if (range !== null) {
          const refused = new OutboundAddressRefusedError(hostname, entry.address, range);
          onRefused(refused);
          callback(refused, '', 0);
          return;
        }
      }
      if (options.all === true) {
        callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
        return;
      }
      const first = addresses[0];
      callback(null, first.address, first.family);
    });
  };
}

/**
 * One pair of agents for ONE request, with the guarded lookup inside.
 *
 * Fresh rather than shared, and without keep-alive: a pooled socket is one
 * whose address was judged for an earlier request, and a request must not ride
 * a connection its own check never saw. `refusal()` answers what the lookup
 * refused, if anything, once the request has settled.
 */
export function guardedAgents(resolveAll: LookupAll): {
  readonly httpAgent: HttpAgent;
  readonly httpsAgent: HttpsAgent;
  readonly refusal: () => OutboundAddressRefusedError | null;
} {
  let refused: OutboundAddressRefusedError | null = null;
  const lookup = guardedLookup(resolveAll, (error) => {
    refused ??= error;
  });
  return {
    httpAgent: new HttpAgent({ keepAlive: false, lookup }),
    httpsAgent: new HttpsAgent({ keepAlive: false, lookup }),
    refusal: () => refused,
  };
}

/** `dns.LookupOptions.family` in the numeric form: the names are its legacy spelling. */
function familyNumber(family: number | 'IPv4' | 'IPv6' | undefined): number {
  if (family === 'IPv4') return 4;
  if (family === 'IPv6') return 6;
  return typeof family === 'number' ? family : 0;
}

function normaliseHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // A fully qualified `localhost.` is `localhost`.
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}
