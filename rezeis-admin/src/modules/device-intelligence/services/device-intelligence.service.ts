import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  BlockedIdentityKind,
  DeviceSignalKind,
  Prisma,
  UserReviewFlagKind,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { BlockedIdentityService } from '../../blocked-identities/services/blocked-identity.service';
import {
  deviceFlagFingerprint,
  normaliseDeviceSignal,
} from '../utils/device-signal.util';

/**
 * Device signals from the cabinet, and the quiet flag they raise.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * The bot knows a Telegram id and the VPN client reports a hardware id, but the
 * cabinet can be used without ever touching either — no Telegram account, and
 * no VPN client until after the first purchase. For a person banned from the
 * cabinet, a new mailbox and a new login is the whole cost of coming back.
 *
 * ── Why this never refuses anybody ────────────────────────────────────────
 *
 * A device match proves the same MACHINE, never the same person. A household
 * shares a laptop, an office deploys one image to two hundred of them, and a
 * library terminal touches dozens of accounts a day. Every one of those is
 * indistinguishable here from a ban evader.
 *
 * So the account is created and an operator is asked to look. That decision is
 * the reason the whole feature is worth having: a refusal on this evidence
 * would produce customers who cannot register and are never told why, and the
 * support cost of that dwarfs the fraud it prevents.
 *
 * ── And why the flag is invisible ────────────────────────────────────────
 *
 * {@link report} answers the same thing whether or not it raised a flag, and no
 * cabinet-facing projection reads the table. An evader who can see the flag
 * learns exactly which signal gave them away and what to change next time —
 * which turns a working signal into a training exercise.
 */
@Injectable()
export class DeviceIntelligenceService {
  private readonly logger = new Logger(DeviceIntelligenceService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    /**
     * Optional so the service constructs without the blocklist module. Absent,
     * the second of the two match sources goes quiet — matches against a LIVE
     * blocked account still fire, so the feature degrades rather than fails.
     */
    @Optional() private readonly blockedIdentityService?: BlockedIdentityService,
  ) {}

  /**
   * Records what the cabinet reported and, if it belongs to a banned machine,
   * marks the account.
   *
   * NEVER THROWS AT THE CALLER. This runs beside a page load, and a device
   * report that fails must not be the thing that stops somebody using their
   * subscription. A failure here loses a signal; a failure that propagates
   * loses the customer.
   */
  public async report(input: {
    readonly userId: string;
    readonly installId?: string | null;
    readonly deviceHash?: string | null;
  }): Promise<void> {
    const signals = [
      normaliseDeviceSignal(DeviceSignalKind.INSTALL_ID, input.installId),
      normaliseDeviceSignal(DeviceSignalKind.DEVICE_HASH, input.deviceHash),
    ].filter((signal): signal is Extract<typeof signal, { ok: true }> => signal.ok);
    if (signals.length === 0) return;

    try {
      for (const signal of signals) {
        await this.record(input.userId, signal.kind, signal.value);
        await this.evaluate(input.userId, signal.kind, signal.value);
      }
    } catch (err) {
      this.logger.warn(`Device report failed for ${input.userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Open flags for a page of users, as `userId → count`.
   *
   * ONE QUERY FOR THE WHOLE PAGE. The users list renders fifty rows; a
   * per-row lookup would be fifty round-trips on the busiest admin screen
   * there is.
   */
  public async openFlagCounts(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (userIds.length === 0) return counts;
    const grouped = await this.prismaService.userReviewFlag.groupBy({
      by: ['userId'],
      where: { userId: { in: [...userIds] }, clearedAt: null },
      _count: { _all: true },
    });
    for (const row of grouped) counts.set(row.userId, row._count._all);
    return counts;
  }

  /** Every flag on one account, newest first — cleared ones included. */
  public async listForUser(userId: string): Promise<readonly UserReviewFlagView[]> {
    const rows = await this.prismaService.userReviewFlag.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      relatedUserId: row.relatedUserId,
      detail: (row.detail ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      clearedAt: row.clearedAt?.toISOString() ?? null,
      clearedById: row.clearedById,
    }));
  }

  /**
   * Marks a flag judged.
   *
   * The row stays. "Was this account ever flagged, and what did we decide" is
   * the question that actually gets asked, and a queue that deletes what it
   * resolves cannot answer it.
   */
  public async clear(flagId: string, adminId: string | null): Promise<void> {
    await this.prismaService.userReviewFlag.updateMany({
      where: { id: flagId, clearedAt: null },
      data: { clearedAt: new Date(), clearedById: adminId },
    });
  }

  /**
   * The device signals an account has reported — used by the block cascade to
   * copy them onto the blocklist, so the evidence outlives the account.
   */
  public async valuesForUser(userId: string): Promise<readonly string[]> {
    const rows = await this.prismaService.deviceObservation.findMany({
      where: { userId },
      select: { value: true },
      take: 100,
    });
    return rows.map((row) => row.value);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async record(
    userId: string,
    kind: DeviceSignalKind,
    value: string,
  ): Promise<void> {
    await this.prismaService.deviceObservation.upsert({
      where: { userId_kind_value: { userId, kind, value } },
      create: { userId, kind, value },
      // `hits` and `lastSeenAt` are what separate a machine somebody uses daily
      // from one they touched once. An operator needs that before acting on a
      // match, and a bare existence row cannot say it.
      update: { lastSeenAt: new Date(), hits: { increment: 1 } },
    });
  }

  /**
   * Two independent ways a signal can be known-bad, and both are needed.
   *
   * A LIVE BLOCKED ACCOUNT that reported the same signal. This is the useful
   * one for an operator, because it names the account to compare against.
   *
   * A BLOCKLIST ENTRY for the value. Observations cascade-delete with the user,
   * so deleting a banned account — frequently the first thing done after a ban
   * — would erase the first source entirely. The blocklist copy is written by
   * the block cascade for exactly that reason.
   */
  private async evaluate(
    userId: string,
    kind: DeviceSignalKind,
    value: string,
  ): Promise<void> {
    const sibling = await this.prismaService.deviceObservation.findFirst({
      where: { kind, value, userId: { not: userId }, user: { isBlocked: true } },
      select: { userId: true },
      orderBy: { lastSeenAt: 'desc' },
    });

    const listed =
      sibling === null
        ? await this.blockedIdentityService?.find(BlockedIdentityKind.DEVICE_FP, value)
        : null;

    if (sibling === null && (listed === null || listed === undefined)) return;

    await this.raiseFlag({
      userId,
      kind,
      value,
      relatedUserId: sibling?.userId ?? null,
      source: sibling !== null ? 'blocked_account' : 'blocklist_entry',
    });
  }

  private async raiseFlag(input: {
    readonly userId: string;
    readonly kind: DeviceSignalKind;
    readonly value: string;
    readonly relatedUserId: string | null;
    readonly source: 'blocked_account' | 'blocklist_entry';
  }): Promise<void> {
    const fingerprint = deviceFlagFingerprint(input.kind, input.value);
    const detail: Prisma.InputJsonObject = {
      signal: input.kind,
      source: input.source,
      // The VALUE is deliberately absent. An operator cannot act on an opaque
      // digest, and putting it in a JSON column that admin screens render would
      // spread a tracking identifier across the UI for no gain.
      strength: input.kind === DeviceSignalKind.DEVICE_HASH ? 'lead' : 'strong',
    };

    await this.prismaService.userReviewFlag.upsert({
      where: {
        userId_kind_fingerprint: {
          userId: input.userId,
          kind: UserReviewFlagKind.DEVICE_MATCH,
          fingerprint,
        },
      },
      create: {
        userId: input.userId,
        kind: UserReviewFlagKind.DEVICE_MATCH,
        fingerprint,
        relatedUserId: input.relatedUserId,
        detail,
      },
      // A repeat sighting refreshes the evidence but must NOT reopen a flag an
      // operator has already judged: the device does not stop matching just
      // because the decision was "this is a household", and reopening it would
      // hand them the same row to dismiss on every page load.
      update: { relatedUserId: input.relatedUserId, detail },
    });

    this.logger.log(
      `Device match on user ${input.userId} (${input.kind}, source=${input.source})`,
    );
  }
}

export interface UserReviewFlagView {
  readonly id: string;
  readonly kind: UserReviewFlagKind;
  readonly relatedUserId: string | null;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
  readonly clearedAt: string | null;
  readonly clearedById: string | null;
}
