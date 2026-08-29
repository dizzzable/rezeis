import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { BlockedIdentityService } from '../../blocked-identities/services/blocked-identity.service';
import { BlockedIpService } from '../../blocked-ips/services/blocked-ip.service';
import { parseAddressOrCidr } from '../../blocked-ips/utils/cidr-match';
import { DeviceIntelligenceService } from '../../device-intelligence/services/device-intelligence.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { NodeAddressesService } from '../../remnawave/services/node-addresses.service';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { classifyCascadeIp, CascadeIpRefusal } from '../utils/cascade-ip.util';

/**
 * The one place a user is blocked or unblocked.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * Blocking used to be a single `UPDATE users SET is_blocked = true` written out
 * twice — once on the user card, once in the bulk toolbar — and everything a
 * ban is supposed to DO lived nowhere. The person kept their VPN, kept their
 * cabinet session, could sign back in with their password, and could walk
 * straight back through `/start` with a new Telegram account. Every one of
 * those is a different subsystem, so leaving the act spread across two call
 * sites guaranteed they would keep disagreeing about what a ban means.
 *
 * ── What a block does, and why each part is where it is ───────────────────
 *
 *  1. THE FLAG. Still the fact of record. Everything else is derived from it,
 *     so nothing here can leave the account blocked-ish.
 *
 *  2. THE IDENTITY CASCADE. Telegram id, e-mail and login are copied onto the
 *     blocklist, which is what makes the ban survive the account: `is_blocked`
 *     can only refuse a row that exists, and a fresh Telegram account has none.
 *
 *  3. THE DEVICE CASCADE. Hardware ids from the VPN panel and device
 *     fingerprints from the cabinet are listed too. These are the only two
 *     things a ban evader carries across a new Telegram account and a new
 *     mailbox, and neither of them refuses anybody at a door — see
 *     {@link captureDevices} and `DeviceIntelligenceService`.
 *
 *  4. THE REGISTRATION ADDRESS. Listed on the IP blocklist, with a refusal
 *     that fails closed around our own nodes — see {@link captureIp}.
 *
 *  5. THE VPN. A sync job per live subscription, plus a connection drop so the
 *     tunnel dies now rather than at the next handshake. The job is what makes
 *     this survive an unreachable panel; the drop is what makes it immediate.
 *     Both are needed and neither is sufficient.
 *
 * ── The ordering rule ─────────────────────────────────────────────────────
 *
 * The flag is written FIRST and everything after it is best-effort. Reversing
 * that — doing the expensive, network-dependent work first and the flag last —
 * would mean a panel timeout leaves an account that was never blocked at all
 * after an operator watched a spinner for six seconds. A blocked account whose
 * VPN teardown failed is recoverable and visible; an unblocked account the
 * operator believes they blocked is neither.
 */
@Injectable()
export class UserBlockService {
  private readonly logger = new Logger(UserBlockService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly blockedIdentityService: BlockedIdentityService,
    /**
     * The rest are optional so a container that never loaded the VPN
     * integration — and every unit test of the surrounding controllers — still
     * constructs. An absent dependency means that half of the cascade is
     * skipped and SAID SO in the report, never silently counted as done.
     */
    @Optional() private readonly blockedIpService?: BlockedIpService,
    @Optional() private readonly remnawaveApiService?: RemnawaveApiService,
    @Optional() private readonly nodeAddresses?: NodeAddressesService,
    @Optional() private readonly profileSyncQueue?: ProfileSyncQueueService,
    @Optional() private readonly deviceIntelligenceService?: DeviceIntelligenceService,
  ) {}

  public async block(input: {
    readonly userId: string;
    readonly adminId: string | null;
    readonly reason?: string | null;
  }): Promise<UserBlockReport> {
    const user = await this.loadUser(input.userId);
    await this.prismaService.user.update({
      where: { id: user.id },
      data: { isBlocked: true },
    });

    const hwids = await this.captureDevices(user.subscriptions);
    const fingerprints =
      (await this.deviceIntelligenceService?.valuesForUser(user.id)) ?? [];
    const captured = await this.blockedIdentityService.captureFromUser({
      userId: user.id,
      telegramId: user.telegramId,
      email: user.webAccount?.emailNormalized ?? user.email,
      webLogin: user.webAccount?.loginNormalized ?? null,
      hwids: hwids.values,
      deviceFingerprints: fingerprints,
      reason: input.reason ?? 'Account blocked',
      createdById: input.adminId,
    });

    const ip = await this.captureIp(user.registrationIp, input.reason ?? null, input.adminId);
    const vpn = await this.pushVpnState(user.subscriptions, 'block');

    return {
      userId: user.id,
      identitiesCaptured: captured.identities,
      devicesCaptured: captured.devices,
      devicesUnreadable: hwids.unreadable,
      ipListed: ip.listed,
      ipRefusedBecause: ip.refusal,
      subscriptionsQueued: vpn.queued,
      connectionsDropped: vpn.dropped,
    };
  }

  public async unblock(input: {
    readonly userId: string;
    readonly adminId: string | null;
  }): Promise<UserUnblockReport> {
    const user = await this.loadUser(input.userId);
    await this.prismaService.user.update({
      where: { id: user.id },
      data: { isBlocked: false },
    });

    // Released BEFORE the VPN is pushed back, and that order matters: the
    // release is the half that decides whether the person can get back in at
    // all, and it must not be skipped because a panel call ahead of it threw.
    const released = await this.blockedIdentityService.releaseCascadeForUser({
      userId: user.id,
      telegramId: user.telegramId,
      email: user.webAccount?.emailNormalized ?? user.email,
      webLogin: user.webAccount?.loginNormalized ?? null,
    });

    const ipsReleased = await this.releaseIp(user.registrationIp);
    const vpn = await this.pushVpnState(user.subscriptions, 'unblock');

    return {
      userId: user.id,
      entriesReleased: released,
      ipsReleased,
      subscriptionsQueued: vpn.queued,
      connectionsDropped: vpn.dropped,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async loadUser(userId: string): Promise<BlockTargetUser> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        telegramId: true,
        email: true,
        registrationIp: true,
        webAccount: { select: { loginNormalized: true, emailNormalized: true } },
        subscriptions: {
          // DELETED profiles have nothing upstream left to disable, and their
          // panel link is already cleared.
          where: { status: { not: SubscriptionStatus.DELETED } },
          select: {
            id: true,
            remnawaveId: true,
            remnawavePanelId: true,
            remnawavePanelUsername: true,
          },
        },
      },
    });
    if (user === null) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Reads the hardware ids bound to a blocked user's VPN profiles.
   *
   * BEST-EFFORT, AND THE REPORT SAYS WHICH. An unreachable panel must not stop
   * a ban — the whole point of the flag being written first — but a caller that
   * cannot tell "no devices" from "we could not look" would report a complete
   * cascade after capturing nothing. `unreadable` counts the profiles whose
   * device list did not come back, so the operator sees an incomplete capture
   * instead of a confident empty one.
   */
  private async captureDevices(
    subscriptions: readonly BlockTargetSubscription[],
  ): Promise<{ readonly values: readonly string[]; readonly unreadable: number }> {
    const api = this.remnawaveApiService;
    if (api === undefined) {
      return { values: [], unreadable: subscriptions.length };
    }
    const values = new Set<string>();
    let unreadable = 0;
    for (const subscription of subscriptions) {
      if (subscription.remnawaveId === null) continue;
      try {
        const outcome = await api.strictListUserDevices({
          remnawaveId: subscription.remnawaveId,
          panelId: subscription.remnawavePanelId,
          panelUsername: subscription.remnawavePanelUsername,
        });
        if (outcome.kind !== 'ok') {
          // `notFound` is counted with the rest deliberately. A profile the
          // panel does not know is one whose devices we did not read, and
          // treating it as "no devices" would be the confident empty answer
          // this counter exists to prevent.
          unreadable += 1;
          continue;
        }
        for (const device of outcome.value.devices) values.add(device.hwid);
      } catch (err) {
        unreadable += 1;
        this.logger.warn(
          `Block cascade: could not read devices for subscription ${subscription.id}: ${
            (err as Error).message
          }`,
        );
      }
    }
    return { values: [...values], unreadable };
  }

  /**
   * Lists the address the account registered from.
   *
   * ── This is the one cascade that can hurt strangers ─────────────────────
   *
   * Every other part of a block reaches only the person being blocked. An IP
   * entry refuses EVERY request from that address, so the decision about
   * whether an address may be listed lives in {@link classifyCascadeIp}, where
   * it is written down and tested on its own. The two failures it exists to
   * prevent are worth naming here:
   *
   *   OUR OWN NODES. A customer who opens the cabinet while connected to the
   *   VPN arrives from a node exit address. Listing it would refuse every
   *   other customer behind that node, and would look exactly like an outage.
   *   So the node list is enumerated first and an address is listed only when
   *   we POSITIVELY know it is not ours — an unreachable panel declines to
   *   capture rather than guessing.
   *
   *   CARRIER NAT. A mobile operator puts thousands of unrelated subscribers
   *   behind one address, which is why the shared ranges are refused outright.
   *
   * ── Why the registration address and not a live one ─────────────────────
   *
   * `registrationIp` is the address the account was CREATED from, which is the
   * one that matters for coming back: an evader signs up again from the same
   * connection. A current connection address would need a polling job against
   * the VPN panel and would return nothing at all unless the person happened
   * to be online at the moment the operator pressed the button.
   */
  private async captureIp(
    address: string | null,
    reason: string | null,
    adminId: string | null,
  ): Promise<{ readonly listed: string | null; readonly refusal: CascadeIpRefusal | null }> {
    if (this.blockedIpService === undefined) {
      return { listed: null, refusal: 'NODES_UNKNOWN' };
    }
    // `getAllNodes` answers `[]` on any failure, which is why the classifier
    // treats empty and null alike — there is no way to tell them apart here,
    // and the safe reading of both is "we did not check".
    const nodes = await this.readNodeAddresses();
    const decision = classifyCascadeIp({ address, nodes });
    if (!decision.capture) {
      if (decision.reason !== 'NO_ADDRESS') {
        this.logger.log(`Block cascade: address not listed (${decision.reason})`);
      }
      return { listed: null, refusal: decision.reason };
    }
    try {
      await this.blockedIpService.create({
        address: decision.value,
        reason: reason ?? 'Cascaded from a blocked account',
        source: 'cascade',
        createdById: adminId,
        expiresAt: null,
      });
      return { listed: decision.value, refusal: null };
    } catch (err) {
      // The commonest throw here is "already on the blocklist", which is a
      // success as far as a ban is concerned: the address is refused either
      // way. Reported as listed rather than as a failure, so an operator is
      // not told the cascade fell short when it did not.
      this.logger.log(
        `Block cascade: address ${decision.value} not added (${(err as Error).message})`,
      );
      return { listed: decision.value, refusal: null };
    }
  }

  /**
   * Drops the IP entry this block created.
   *
   * Matched on `source` AND address, because `blocked_ips` carries no origin
   * column. That is exact for the normal case and imprecise for one: if two
   * accounts registered from the same address and both were blocked, the entry
   * exists once (the address is unique) under the first block, and unblocking
   * EITHER of them removes it. The alternative — leaving it — would strand an
   * unblocked customer behind an address ban with nothing on their account to
   * explain it, which is the worse of the two.
   *
   * MATCHED ON THE CANONICAL FORM, because that is what the block stored.
   * Capture writes `parsed.canonical`, which is lower-cased; this used to
   * search the raw column value, trimmed only. IPv4 was unaffected — there is
   * nothing to case-fold — but an IPv6 address reaches
   * `Subscription.registrationIp` however the upstream proxy spelled it, and
   * `2001:DB8::1234` was stored as `2001:db8::1234` and then looked up as
   * `2001:DB8::1234`. No row, no error, no log: `ipsReleased: 0`, the customer
   * unblocked on paper and still refused by the guard on every request, with
   * nothing on their account explaining why — the precise failure the
   * paragraph above says this method exists to avoid.
   */
  private async releaseIp(address: string | null): Promise<number> {
    if (this.blockedIpService === undefined) return 0;
    const raw = (address ?? '').trim();
    if (raw.length === 0) return 0;
    // Parsed rather than lower-cased by hand: one function decides what an
    // address IS on both sides of the ban, so the two spellings cannot drift.
    const parsed = parseAddressOrCidr(raw);
    const trimmed = parsed === null ? raw : parsed.canonical;
    // Found here and deleted THROUGH THE SERVICE rather than with a `deleteMany`
    // of my own. The guard in front of every request reads the list through a
    // 30-second in-process cache that only the service's own writes invalidate,
    // so a direct delete would leave the address refused for up to half a minute
    // after the unblock — exactly the window in which the customer tries again
    // and reports that unblocking did nothing.
    //
    // At most one row can match: `address` is unique.
    const entry = await this.prismaService.blockedIp.findFirst({
      where: { source: 'cascade', address: trimmed },
      select: { id: true },
    });
    if (entry === null) return 0;
    await this.blockedIpService.delete(entry.id);
    return 1;
  }

  /**
   * Our own nodes, one entry per node, or `null` when the panel could not be
   * asked.
   *
   * GROUPED PER NODE, not flattened, and that is the whole point of the shape.
   * A node reached by hostname contributes nothing comparable from its
   * configured address and everything from the addresses it reports for itself
   * — but the panel only began reporting those in 3.2.3. On an older one such a
   * node yields an empty group, and the classifier needs to SEE that emptiness
   * to know it could not rule the node out. Flattened into one list it is
   * invisible: the list is non-empty because other nodes filled it, and the
   * guard passes while the node nobody could compare against is exactly the one
   * the customer was connected through.
   */
  private async readNodeAddresses(): Promise<readonly (readonly string[])[] | null> {
    // Delegated. This was a private method here until a third consumer
    // appeared, and three copies of "what counts as our own address" is three
    // places for the answer to drift. `null` still means "could not ask",
    // which is the distinction everything downstream decides on.
    return this.nodeAddresses?.read() ?? null;
  }
  /**
   * Pushes the VPN side of a block or an unblock.
   *
   * WHY A SYNC JOB AND NOT A DIRECT PATCH. A direct call fails when the panel
   * is down, and a ban whose VPN teardown was lost to a timeout is a ban that
   * did not happen. The sync queue already owns retries, supersession and the
   * sweep that recovers failed rows, so a job survives what a call does not.
   *
   * WHY `propagateStatus` IS SET FOR BOTH DIRECTIONS. The processor derives the
   * panel status from the subscription column and forces `DISABLED` while the
   * owner is blocked, so the same flag means "assert the status" on the way in
   * and "assert it again" on the way out. Without it the unblock would push
   * every other field and leave the profile disabled.
   *
   * WHY THE DROP IS SEPARATE. `status: DISABLED` stops the NEXT handshake; an
   * established tunnel keeps carrying traffic until it renegotiates. Dropping
   * connections is what makes a block take effect while the operator is still
   * looking at the screen. It is fire-and-forget: the panel answers `202` with
   * nothing to confirm, so a failure here is logged, never surfaced as a failed
   * block.
   */
  private async pushVpnState(
    subscriptions: readonly BlockTargetSubscription[],
    direction: 'block' | 'unblock',
  ): Promise<{ readonly queued: number; readonly dropped: boolean }> {
    const linked = subscriptions.filter(
      (subscription): subscription is BlockTargetSubscription & { remnawaveId: string } =>
        subscription.remnawaveId !== null,
    );
    if (linked.length === 0) return { queued: 0, dropped: false };

    let queued = 0;
    for (const subscription of linked) {
      try {
        const job = await this.prismaService.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: SyncAction.UPDATE,
            status: SyncJobStatus.PENDING,
            payload: {
              source: direction === 'block' ? 'USER_BLOCK' : 'USER_UNBLOCK',
              propagateStatus: true,
            } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        queued += 1;
        // A job row with nothing enqueued is picked up by the sweep, minutes
        // later. Enqueuing is what makes a block immediate; failing to enqueue
        // is therefore a delay, not a loss, and must not throw away the rest.
        await this.profileSyncQueue?.enqueue(job.id);
      } catch (err) {
        this.logger.error(
          `Block cascade: could not queue VPN ${direction} for subscription ${subscription.id}: ${
            (err as Error).message
          }`,
        );
      }
    }

    let dropped = false;
    if (direction === 'block' && this.remnawaveApiService !== undefined) {
      try {
        const outcome = await this.remnawaveApiService.dropConnections({
          dropBy: { by: 'userUuids', userUuids: linked.map((s) => s.remnawaveId) },
          targetNodes: { target: 'allNodes' },
        });
        dropped = outcome.ok;
      } catch (err) {
        this.logger.warn(
          `Block cascade: could not drop live connections: ${(err as Error).message}`,
        );
      }
    }

    return { queued, dropped };
  }
}

interface BlockTargetSubscription {
  readonly id: string;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
}

interface BlockTargetUser {
  readonly id: string;
  readonly telegramId: bigint | null;
  readonly email: string | null;
  readonly registrationIp: string | null;
  readonly webAccount: {
    readonly loginNormalized: string | null;
    readonly emailNormalized: string | null;
  } | null;
  readonly subscriptions: readonly BlockTargetSubscription[];
}

export interface UserBlockReport {
  readonly userId: string;
  readonly identitiesCaptured: number;
  readonly devicesCaptured: number;
  /** Profiles whose device list could not be read — an INCOMPLETE capture. */
  readonly devicesUnreadable: number;
  /** The address that was listed, or `null` when none was. */
  readonly ipListed: string | null;
  /** Why no address was listed. `null` when one was. */
  readonly ipRefusedBecause: CascadeIpRefusal | null;
  readonly subscriptionsQueued: number;
  readonly connectionsDropped: boolean;
}

export interface UserUnblockReport {
  readonly userId: string;
  readonly entriesReleased: number;
  readonly ipsReleased: number;
  readonly subscriptionsQueued: number;
  readonly connectionsDropped: boolean;
}
