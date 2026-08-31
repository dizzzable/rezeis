import { Injectable, Logger, Optional } from '@nestjs/common';
import { AddOnType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolvePanelUserId } from '../../profile-sync/profile-sync.processor';
import { storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { PanelUsersClient } from '../../remnawave/services/panel-users.client';

/** What the customer is offered, and what it will cost them. */
export interface TrafficResetAllowance {
  /** Free uses the operator configured for one subscription term. */
  readonly freeUsesPerTerm: number;
  /** Resets already performed inside the CURRENT term. */
  readonly usedThisTerm: number;
  /** Free uses still available; never negative. */
  readonly freeRemaining: number;
  /** True when the next reset costs nothing. */
  readonly isFree: boolean;
}

/**
 * Zeroes a subscription's consumed traffic, and knows when that is free.
 *
 * ── What a reset is, and what it is not ───────────────────────────────────
 *
 * It is an ACTION. `EXTRA_TRAFFIC` and `EXTRA_DEVICES` are grants — they hold a
 * value, expire on a date and can be revoked. A reset holds nothing: by the
 * time it has happened the counter is at zero and there is nothing left to
 * take back. That is also why it is sold as non-refundable, and why it writes a
 * plain history row rather than an entitlement whose every lifecycle field
 * would be meaningless.
 *
 * ── What it deliberately leaves alone ─────────────────────────────────────
 *
 * Reset EPOCHS and every entitlement's `expiresAt`. Epochs describe the PLAN's
 * reset cycle, and extra gigabytes somebody bought are pinned to them: closing
 * an epoch out of cycle would expire goods that were paid for. So a reset
 * zeroes CONSUMPTION and nothing else — the limit, and every add-on inside it,
 * lives out the term it was sold for. A customer who buys 50 GB and then a
 * reset keeps both.
 *
 * ── Why the free allowance is counted per TERM ────────────────────────────
 *
 * It refreshes when the customer renews, which is the unit they already think
 * in ("one free reset a month"). Counting per calendar month would drift away
 * from what they paid for, and counting for all time would make the allowance a
 * one-off gift rather than part of the offer.
 */
@Injectable()
export class TrafficResetService {
  private readonly logger = new Logger(TrafficResetService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly panelUsers?: PanelUsersClient,
  ) {}

  /**
   * How many free resets are left on this subscription's current term.
   *
   * `termId` is nullable throughout: a subscription that predates the term
   * ledger has none, and its resets are counted against the subscription
   * instead. That degrades to "all resets ever" for those rows, which is the
   * conservative direction — it can only make the allowance run out sooner,
   * never hand out more free resets than the operator configured.
   */
  public async describeAllowance(input: {
    readonly subscriptionId: string;
    readonly termId: string | null;
    readonly freeUsesPerTerm: number;
  }): Promise<TrafficResetAllowance> {
    const free = Math.max(0, input.freeUsesPerTerm);
    if (free === 0) {
      return { freeUsesPerTerm: 0, usedThisTerm: 0, freeRemaining: 0, isFree: false };
    }
    // ── ONLY THE FREE ONES COUNT ──────────────────────────────────────────
    //
    // `transactionId: null` is what marks a reset as taken from the allowance.
    // Counting every row would let a PURCHASE eat the free use: a customer who
    // paid for a reset before ever taking their free one would find it gone,
    // having been charged for the privilege of losing it. The allowance is a
    // gift the operator configured, and only spending it should spend it.
    const usedThisTerm = await this.prismaService.subscriptionTrafficReset.count({
      where:
        input.termId === null
          ? { subscriptionId: input.subscriptionId, transactionId: null }
          : { subscriptionId: input.subscriptionId, termId: input.termId, transactionId: null },
    });
    const freeRemaining = Math.max(0, free - usedThisTerm);
    return {
      freeUsesPerTerm: free,
      usedThisTerm,
      freeRemaining,
      isFree: freeRemaining > 0,
    };
  }

  /**
   * Takes one reset from the free allowance, if there is one to take.
   *
   * ── The allowance is decided here, not on the offer ───────────────────────
   *
   * The listing says whether the next reset is free; this decides. A customer
   * with two tabs open, a double tap, or a replayed request would otherwise
   * each read "free" from a stale offer and spend an allowance of one twice.
   * The count and the reset happen in one call, against the same rows.
   *
   * ── It refuses rather than charging ───────────────────────────────────────
   *
   * When the allowance is spent this answers "not free" and does nothing. The
   * alternative — quietly falling through to a paid purchase — would take money
   * from somebody who pressed a button that said the word "free".
   */
  public async claimFree(input: {
    readonly subscriptionId: string;
    readonly addOnId: string;
  }): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
    const addOn = await this.prismaService.addOn.findUnique({
      where: { id: input.addOnId },
      select: { id: true, type: true, isActive: true, freeUsesPerTerm: true },
    });
    if (addOn === null || !addOn.isActive) {
      return { ok: false, reason: 'this option is not available' };
    }
    if (addOn.type !== AddOnType.RESET_TRAFFIC) {
      return { ok: false, reason: 'this option is not a traffic reset' };
    }

    const termId = await this.currentTermId(input.subscriptionId);
    const allowance = await this.describeAllowance({
      subscriptionId: input.subscriptionId,
      termId,
      freeUsesPerTerm: addOn.freeUsesPerTerm,
    });
    if (!allowance.isFree) {
      return { ok: false, reason: 'the free allowance for this term is used up' };
    }

    return this.perform({
      subscriptionId: input.subscriptionId,
      termId,
      addOnId: addOn.id,
      transactionId: null,
    });
  }

  /**
   * The term the allowance is counted against.
   *
   * `null` when the subscription predates the term ledger — see
   * {@link describeAllowance} for what that degrades to and why it is the safe
   * direction.
   */
  public async currentTermId(subscriptionId: string): Promise<string | null> {
    const term = await this.prismaService.subscriptionTerm.findFirst({
      where: { subscriptionId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return term?.id ?? null;
  }

  /**
   * Performs the reset and records it.
   *
   * ── The panel goes first, on purpose ──────────────────────────────────
   *
   * The row is written only after the panel has zeroed the counter. The other
   * order reads better and is wrong: a history row for a reset that never
   * happened both lies to the customer and burns one of their free uses, and
   * the allowance is counted from exactly these rows. A panel failure must cost
   * them nothing.
   *
   * The reverse risk — the panel resets and the row fails to write — gives a
   * free extra use, which is the cheap direction of the same coin.
   */
  public async perform(input: {
    readonly subscriptionId: string;
    readonly termId: string | null;
    readonly addOnId: string | null;
    readonly transactionId: string | null;
  }): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { id: true, remnawaveId: true, configUrl: true },
    });
    if (subscription === null) {
      return { ok: false, reason: 'subscription not found' };
    }
    if (this.panelUsers === undefined) {
      return { ok: false, reason: 'the Remnawave integration is not configured' };
    }

    // THE SHARED RESOLVER, not a local read of `remnawaveId`. A profile created
    // on a 2.x panel stores a uuid the panel no longer answers to once it is on
    // 3.x, and `resolvePanelUserId` is the one place that knows how to recover
    // the numeric id from it. Reading the column directly is the defect that
    // left `remnawave_id` NULL for ever on this codebase once already.
    const identity = storedIdentityOf(subscription);
    if (identity === null) {
      return { ok: false, reason: 'this subscription has no panel profile yet' };
    }
    const address = await resolvePanelUserId(this.panelUsers, identity);
    if (address.kind !== 'ok') {
      return { ok: false, reason: 'the panel profile could not be addressed' };
    }

    const outcome = await this.panelUsers.resetTraffic(address.userId);
    if (outcome.kind !== 'ok') {
      this.logger.warn(
        `Traffic reset refused by the panel for subscription ${input.subscriptionId}`,
      );
      return { ok: false, reason: 'the panel refused the reset' };
    }

    await this.prismaService.subscriptionTrafficReset.create({
      data: {
        subscriptionId: input.subscriptionId,
        termId: input.termId,
        addOnId: input.addOnId,
        transactionId: input.transactionId,
      },
    });
    this.logger.log(
      `Traffic reset performed for subscription ${input.subscriptionId}` +
        `${input.transactionId === null ? ' (free allowance)' : ''}`,
    );
    return { ok: true, reason: null };
  }
}
