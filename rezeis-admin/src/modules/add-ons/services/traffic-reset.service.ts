import { Injectable, Logger, Optional } from '@nestjs/common';
import { AddOnType, Prisma } from '@prisma/client';

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
/**
 * The empty string is a SENTINEL, not a term id.
 *
 * `AddOnEligibilityService` uses `''` for "this subscription has no term row"
 * while the reset rows store `null` for the same thing. Left unnormalised the
 * offer counted `termId: ''`, matched nothing, and told every term-less
 * subscription its next reset was free — which the claim, reading `null`, then
 * refused. One shape, converted once, here.
 */
function normalizeTermId(termId: string | null): string | null {
  return typeof termId === 'string' && termId.length > 0 ? termId : null;
}

/**
 * The rows that count against a free allowance.
 *
 * Three conditions, each load-bearing:
 *  - `transactionId: null` — only a FREE reset spends the allowance. Counting
 *    purchases too would let a customer who paid for a reset lose the free one
 *    they had not used yet.
 *  - `addOnId` — the allowance is configured per add-on, so the pool is per
 *    add-on. Shared, two reset options would eat each other's free uses.
 *  - `termId` — per term when there is one; for a subscription that predates
 *    the term ledger this degrades to "all resets ever", which can only run the
 *    allowance out sooner, never hand out more than was configured.
 */
function freeResetsWhere(subscriptionId: string, termId: string | null, addOnId: string) {
  return termId === null
    ? { subscriptionId, addOnId, transactionId: null }
    : { subscriptionId, addOnId, termId, transactionId: null };
}

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
    readonly addOnId: string;
    readonly freeUsesPerTerm: number;
  }): Promise<TrafficResetAllowance> {
    const free = Math.max(0, input.freeUsesPerTerm);
    if (free === 0) {
      return { freeUsesPerTerm: 0, usedThisTerm: 0, freeRemaining: 0, isFree: false };
    }
    const termId = normalizeTermId(input.termId);
    // ── ONLY THE FREE ONES COUNT ──────────────────────────────────────────
    //
    // `transactionId: null` is what marks a reset as taken from the allowance.
    // Counting every row would let a PURCHASE eat the free use: a customer who
    // paid for a reset before ever taking their free one would find it gone,
    // having been charged for the privilege of losing it. The allowance is a
    // gift the operator configured, and only spending it should spend it.
    const usedThisTerm = await this.prismaService.subscriptionTrafficReset.count({
      where: freeResetsWhere(input.subscriptionId, termId, input.addOnId),
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
   *
   * ── Reserve, then reset ───────────────────────────────────────────────────
   *
   * Counting and then resetting is not enough, and the first version of this
   * claimed otherwise: between the count and the write sits a panel round trip,
   * so two tabs both read nought used and both reset. The row is therefore
   * INSERTED first, inside a transaction that locks the subscription row and
   * re-counts under that lock — a reservation. Only then is the panel called,
   * and a panel that refuses gives the reservation straight back.
   *
   * The residual failure is a process that dies between the commit and the
   * panel call: the customer loses one free use without a reset. That is the
   * direction to fail in. The other order hands out free resets that were never
   * configured, and there is no way to take those back.
   *
   * ── It refuses rather than charging ───────────────────────────────────────
   *
   * When the allowance is spent this answers "not free" and does nothing. The
   * alternative — quietly falling through to a paid purchase — would take money
   * from somebody who pressed a button that said the word "free".
   *
   * ── The caller has already checked eligibility ────────────────────────────
   *
   * `owner` is mandatory, and the ownership check below is the LAST line rather
   * than the only one: the controller resolves the offer through
   * `AddOnEligibilityService` first, so plan applicability, the finite-traffic
   * baseline and subscription status are all applied by the same code that
   * decides what to display. This method re-checks ownership anyway, because a
   * write that trusts its caller for that is one refactor away from being an
   * open door.
   */
  public async claimFree(input: {
    readonly subscriptionId: string;
    readonly addOnId: string;
    readonly owner: { readonly userId?: string; readonly telegramId?: string };
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

    const ownerUserId = await this.resolveOwnerUserId(input.owner);
    if (ownerUserId === null) {
      return { ok: false, reason: 'subscription not found' };
    }

    const reservation = await this.reserveFreeReset({
      subscriptionId: input.subscriptionId,
      ownerUserId,
      addOnId: addOn.id,
      freeUsesPerTerm: addOn.freeUsesPerTerm,
    });
    if (reservation.kind !== 'reserved') {
      return { ok: false, reason: reservation.reason };
    }

    const performed = await this.resetOnPanel(input.subscriptionId);
    if (!performed.ok) {
      // Hand the free use back. The reservation exists to stop two claims from
      // racing, not to charge for a reset that never happened.
      await this.prismaService.subscriptionTrafficReset
        .delete({ where: { id: reservation.id } })
        .catch(() => undefined);
      return performed;
    }
    this.logger.log(
      `Traffic reset performed for subscription ${input.subscriptionId} (free allowance)`,
    );
    return { ok: true, reason: null };
  }

  /**
   * Locks the subscription, re-counts the allowance under that lock and writes
   * the reservation row — all in one transaction, so two claims cannot both see
   * the last free use.
   *
   * The ownership check is inside the same transaction and against the locked
   * row: a subscription that does not belong to this caller is reported exactly
   * as a missing one, so the endpoint cannot be used to discover which ids exist.
   */
  private async reserveFreeReset(input: {
    readonly subscriptionId: string;
    readonly ownerUserId: string;
    readonly addOnId: string;
    readonly freeUsesPerTerm: number;
  }): Promise<{ readonly kind: 'reserved'; readonly id: string } | { readonly kind: 'refused'; readonly reason: string }> {
    const free = Math.max(0, input.freeUsesPerTerm);
    if (free === 0) {
      return { kind: 'refused', reason: 'this option has no free resets' };
    }
    return this.prismaService.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; user_id: string }>>(Prisma.sql`
        SELECT "id", "user_id"
        FROM "subscriptions"
        WHERE "id" = ${input.subscriptionId}
        FOR UPDATE
      `);
      const row = locked[0];
      if (row === undefined || row.user_id !== input.ownerUserId) {
        return { kind: 'refused' as const, reason: 'subscription not found' };
      }
      const term = await tx.subscriptionTerm.findFirst({
        where: { subscriptionId: input.subscriptionId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const termId = normalizeTermId(term?.id ?? null);
      const used = await tx.subscriptionTrafficReset.count({
        where: freeResetsWhere(input.subscriptionId, termId, input.addOnId),
      });
      if (used >= free) {
        return { kind: 'refused' as const, reason: 'the free allowance for this term is used up' };
      }
      const created = await tx.subscriptionTrafficReset.create({
        data: {
          subscriptionId: input.subscriptionId,
          termId,
          addOnId: input.addOnId,
          transactionId: null,
        },
        select: { id: true },
      });
      return { kind: 'reserved' as const, id: created.id };
    });
  }

  /** `null` when the identity resolves to nobody — reported as "not found". */
  private async resolveOwnerUserId(owner: {
    readonly userId?: string;
    readonly telegramId?: string;
  }): Promise<string | null> {
    if (typeof owner.userId === 'string' && owner.userId.length > 0) {
      return owner.userId;
    }
    if (typeof owner.telegramId === 'string' && /^\d+$/.test(owner.telegramId)) {
      const user = await this.prismaService.user.findFirst({
        where: { telegramId: BigInt(owner.telegramId) },
        select: { id: true },
      });
      return user?.id ?? null;
    }
    return null;
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
    const performed = await this.resetOnPanel(input.subscriptionId);
    if (!performed.ok) return performed;

    await this.prismaService.subscriptionTrafficReset.create({
      data: {
        subscriptionId: input.subscriptionId,
        termId: normalizeTermId(input.termId),
        addOnId: input.addOnId,
        transactionId: input.transactionId,
      },
    });
    this.logger.log(`Traffic reset performed for subscription ${input.subscriptionId}`);
    return { ok: true, reason: null };
  }

  /**
   * Zeroes the profile's counter on the panel. Records nothing.
   *
   * Shared by the paid path (which records afterwards) and the free path (which
   * has already reserved). The SELECT carries all four identity columns on
   * purpose: `storedIdentityOf` builds the address from `remnawaveId`,
   * `remnawavePanelId`, `remnawavePanelUsername` and the short uuid in
   * `configUrl`, and omitting the middle two collapses a four-step fallback to
   * one. A profile provisioned on 2.x and now served by a 3.x panel is
   * addressable only by the numeric id — the admin endpoint for this same action
   * selects all four and says so.
   */
  private async resetOnPanel(
    subscriptionId: string,
  ): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        configUrl: true,
      },
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
      this.logger.warn(`Traffic reset refused by the panel for subscription ${subscriptionId}`);
      return { ok: false, reason: 'the panel refused the reset' };
    }
    return { ok: true, reason: null };
  }
}
