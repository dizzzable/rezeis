import { isIP } from 'node:net';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { findOverlappingRange, rangesOverlap } from '../../../common/net/ip-ranges';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ParsedAddress } from '../../blocked-ips/utils/cidr-match';
import {
  entryCoversAddress,
  INTERNAL_NETWORK_RANGES,
  parseBlockEntry,
} from '../utils/network-address.util';
import {
  AUTOMATION_NETWORK_PROBES,
  SYSTEM_NETWORK_PROBES,
  type AutomationNetworkProbes,
} from './automation-network-probes';

/** Whom a refused entry would have locked out. */
export type BlockAddressProtection =
  /** The operator saving the rule, or running it by hand — the manual screen's own check. */
  | 'your_address'
  /** Loopback, private, link-local, carrier NAT, unique-local: the panel, its proxy, its containers. */
  | 'internal_network'
  /** An address of the machine the panel runs on. */
  | 'this_panel'
  /** An address an administrator signed in from, or acted from, inside the session window. */
  | 'admin_session'
  /** An active entry of the admin IP allowlist. */
  | 'admin_allowlist'
  /** What the panel's own domain, the cabinet or the subscription page resolve to. */
  | 'panel_service';

export interface BlockAddressRefusal {
  readonly protection: BlockAddressProtection;
  /** The internal range the entry overlaps, for `internal_network` only. */
  readonly range?: string;
}

/** The administrators' addresses could not be read, so nothing can be said to be safe. */
export class BlockAddressUnverifiableError extends Error {
  public constructor(reason: string) {
    super(`could not read the administrators' addresses: ${reason}`);
    this.name = 'BlockAddressUnverifiableError';
  }
}

/**
 * How far back an administrator's addresses are protected.
 *
 * An admin session is a JWT that lives `jwtExpiresIn` — 24 hours
 * (`common/config/auth.config.ts`) — and it is not bound to an address, so an
 * operator who signed in at home is still signed in from the office. Every
 * address that signed in, or did anything audited, inside one token lifetime is
 * therefore an address a live session may be using.
 */
export const ADMIN_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * More distinct administrator addresses than this in one window is not a real
 * panel, and a list cut short at the cap would be a list with holes — so
 * reaching it refuses rather than trusting the part that was read.
 */
export const ADMIN_ADDRESS_READ_CAP = 1_000;

/** One lookup of the panel's own host names may take this long before it is skipped. */
const SERVICE_LOOKUP_TIMEOUT_MS = 2_000;
/** Resolved service addresses are reused for this long. */
const SERVICE_ADDRESS_TTL_MS = 5 * 60 * 1000;

/**
 * The lockout check `block_ip` runs before it writes anything.
 *
 * ── What the manual path protects, and what this protects ───────────────────
 *
 * `BlockedIpsController.refuseSelfLockout` refuses an entry that covers the
 * CALLER's own address, resolved the way `BlockedIpGuard` resolves it — because
 * the guard runs before the admin allowlist and before sign-in, and the only
 * way back from blocking yourself is an UPDATE against the database. That is
 * the whole of it: the caller, and nothing else.
 *
 * A rule has no caller when an event fires it at 03:00, so "the caller" cannot
 * be the whole protection here. Everything below is refused, in this order:
 *
 *   1. the requester's own address, on a save or a manual run — the manual
 *      path's check, unchanged;
 *   2. every internal range: the panel itself, the reverse proxy in front of it
 *      (all three `ADMIN_TRUST_PROXY` modes live inside these ranges), the
 *      cabinet and every other container on the compose network. Blocking one
 *      of those takes the whole cabinet down, because every customer request
 *      reaches the panel from the cabinet's address;
 *   3. the addresses of the machine the panel runs on;
 *   4. every administrator's current sessions: the last sign-in address of
 *      every active admin, and every address that signed in or did anything
 *      audited within `ADMIN_SESSION_WINDOW_MS`;
 *   5. every active entry of the admin IP allowlist;
 *   6. what the panel's own domain, the cabinet and the subscription page
 *      resolve to — their public addresses on a split deployment.
 *
 * An entry is refused when it COVERS any of them: a range is judged by what it
 * contains, exactly as the guard will match it.
 *
 * ── Failing closed, and the one place that does not ──────────────────────────
 *
 * If the administrators' addresses cannot be read, nothing is blocked
 * (`BlockAddressUnverifiableError`). A block that waits for the database is a
 * delay; a block that locks every admin out is an outage with no way back from
 * the panel. Step 6 is the exception: a host name that does not resolve in time
 * contributes nothing and the check goes on, because it is a layer on top of
 * everything the manual path does, and refusing every block whenever DNS
 * hiccups would switch the action off.
 */
@Injectable()
export class BlockIpSafetyService {
  private readonly logger = new Logger(BlockIpSafetyService.name);
  private readonly probes: AutomationNetworkProbes;
  private serviceCache: {
    /** The host list the addresses were resolved for: a different list is a different answer. */
    readonly hosts: string;
    readonly addresses: readonly string[];
    readonly expiresAt: number;
  } | null = null;

  public constructor(
    private readonly prismaService: PrismaService,
    @Optional()
    @Inject(AUTOMATION_NETWORK_PROBES)
    probes?: AutomationNetworkProbes,
  ) {
    this.probes = probes ?? SYSTEM_NETWORK_PROBES;
  }

  /**
   * Why `entry` must not be blocked, or null when nothing it covers is protected.
   *
   * @throws BlockAddressUnverifiableError when the administrators' addresses
   *   cannot be read — the caller must then block nothing.
   */
  public async refusalFor(
    entry: ParsedAddress,
    context: { readonly requestIp?: string | null } = {},
  ): Promise<BlockAddressRefusal | null> {
    const requestIp = context.requestIp ?? null;
    if (requestIp !== null && entryCoversAddress(entry, requestIp)) {
      return { protection: 'your_address' };
    }
    const internal = findOverlappingRange(entry, INTERNAL_NETWORK_RANGES);
    if (internal !== null) return { protection: 'internal_network', range: internal.cidr };
    if (this.localAddresses().some((address) => entryCoversAddress(entry, address))) {
      return { protection: 'this_panel' };
    }
    const admin = await this.readAdminAddresses();
    if (admin.sessions.some((address) => entryCoversAddress(entry, address))) {
      return { protection: 'admin_session' };
    }
    if (admin.allowlist.some((listed) => overlapsListedEntry(entry, listed))) {
      return { protection: 'admin_allowlist' };
    }
    const services = await this.serviceAddresses();
    if (services.some((address) => entryCoversAddress(entry, address))) {
      return { protection: 'panel_service' };
    }
    return null;
  }

  private localAddresses(): readonly string[] {
    try {
      return this.probes.localAddresses();
    } catch (err) {
      throw new BlockAddressUnverifiableError(
        `the machine's own addresses could not be listed (${describe(err)})`,
      );
    }
  }

  private async readAdminAddresses(): Promise<{
    readonly sessions: readonly string[];
    readonly allowlist: readonly string[];
  }> {
    const since = new Date(Date.now() - ADMIN_SESSION_WINDOW_MS);
    try {
      const [admins, signIns, actions, allowlist] = await Promise.all([
        this.prismaService.adminUser.findMany({
          where: { isActive: true, lastLoginIp: { not: null } },
          select: { lastLoginIp: true },
        }),
        this.prismaService.adminLoginAttempt.findMany({
          where: { success: true, createdAt: { gte: since } },
          select: { ipAddress: true },
          distinct: ['ipAddress'],
          take: ADMIN_ADDRESS_READ_CAP,
        }),
        this.prismaService.adminAuditLog.findMany({
          where: { adminUserId: { not: null }, ipAddress: { not: null }, createdAt: { gte: since } },
          select: { ipAddress: true },
          distinct: ['ipAddress'],
          take: ADMIN_ADDRESS_READ_CAP,
        }),
        this.prismaService.adminIpAllowlist.findMany({
          where: { isActive: true },
          select: { address: true },
        }),
      ]);
      if (signIns.length >= ADMIN_ADDRESS_READ_CAP || actions.length >= ADMIN_ADDRESS_READ_CAP) {
        throw new Error(`more than ${ADMIN_ADDRESS_READ_CAP} distinct administrator addresses in one window`);
      }
      const sessions = [
        ...admins.map((row) => row.lastLoginIp),
        ...signIns.map((row) => row.ipAddress),
        ...actions.map((row) => row.ipAddress),
      ].filter((address): address is string => typeof address === 'string' && address.length > 0);
      return { sessions, allowlist: allowlist.map((row) => row.address) };
    } catch (err) {
      throw new BlockAddressUnverifiableError(describe(err));
    }
  }

  /** The panel's own services, resolved; see step 6 in the class comment. */
  private async serviceAddresses(): Promise<readonly string[]> {
    const now = Date.now();
    const hosts = this.probes.serviceHosts();
    const key = hosts.join(',');
    const cached = this.serviceCache;
    if (cached !== null && cached.hosts === key && cached.expiresAt > now) return cached.addresses;
    const resolved = await Promise.all(hosts.map((host) => this.resolveHost(host)));
    const addresses = resolved.flatMap((entry) => entry ?? []);
    // Kept only when every name answered: a lookup that failed is asked again
    // on the next block rather than left unprotected for the whole TTL.
    this.serviceCache = resolved.includes(null)
      ? null
      : { hosts: key, addresses, expiresAt: now + SERVICE_ADDRESS_TTL_MS };
    return addresses;
  }

  /** The addresses a service host resolves to, or null when it did not answer in time. */
  private resolveHost(host: string): Promise<readonly string[] | null> {
    if (isIP(host) !== 0) return Promise.resolve([host]);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: readonly string[] | null, problem?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (problem !== undefined) {
          this.logger.warn(`block_ip: "${host}" ${problem}; its addresses are not protected this round`);
        }
        resolve(value);
      };
      const timer = setTimeout(() => settle(null, 'did not resolve in time'), SERVICE_LOOKUP_TIMEOUT_MS);
      timer.unref?.();
      try {
        this.probes.lookupAll(host, {}, (error, addresses) => {
          if (error !== null) {
            settle(null, `did not resolve (${error.code ?? error.message})`);
            return;
          }
          settle(addresses.map((entry) => entry.address));
        });
      } catch (err) {
        settle(null, `could not be looked up (${describe(err)})`);
      }
    });
  }
}

/**
 * A refusal as the end of a sentence: "… because it covers <this>".
 *
 * Names the KIND of address and never an administrator's address itself: the
 * sentence lands on an execution row that everybody with `automations:view`
 * can read, and where an admin signs in from is not theirs to learn.
 */
export function describeBlockProtection(refusal: BlockAddressRefusal): string {
  switch (refusal.protection) {
    case 'your_address':
      return 'your own address';
    case 'internal_network':
      return (
        `the panel's internal network (${refusal.range ?? 'loopback, private or link-local'}), ` +
        'where the panel itself, its reverse proxy and the services beside it connect from'
      );
    case 'this_panel':
      return 'an address of the machine the panel runs on';
    case 'admin_session':
      return `an address an administrator signed in or worked from in the last ${ADMIN_SESSION_WINDOW_MS / 3_600_000} hours`;
    case 'admin_allowlist':
      return 'an entry of the admin IP allowlist';
    case 'panel_service':
      return "the address of the panel's own domain or of a service it works with (the cabinet, the subscription page)";
  }
}

/** Whether `entry` and an allowlist row share an address. A row that does not parse protects nothing. */
function overlapsListedEntry(entry: ParsedAddress, listed: string): boolean {
  const parsed = parseBlockEntry(listed);
  return parsed !== null && rangesOverlap(entry, parsed);
}

function describe(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
