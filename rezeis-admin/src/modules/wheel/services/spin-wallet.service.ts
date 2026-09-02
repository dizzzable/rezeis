import { Injectable } from '@nestjs/common';
import { Prisma, SpinLedgerSource } from '@prisma/client';

import { freeSpinClaimThreshold, isFreeSpinEnabled } from '../spin-availability.util';

export interface SpinMovementInput {
  readonly userId: string;
  /** Signed: a credit is positive, a debit negative. Zero is a bug in the caller. */
  readonly delta: number;
  readonly source: SpinLedgerSource;
  /**
   * Idempotency handle, unique per `source`: the spin id for SPENT and for the
   * WHEEL_PRIZE it produced, the purchase id for PURCHASED. `null` for an
   * operator's adjustment, which is not idempotent by nature.
   */
  readonly referenceKey: string | null;
  readonly details?: Prisma.InputJsonObject;
}

export type SpinMovementRefusal = 'USER_NOT_FOUND' | 'INSUFFICIENT_BALANCE' | 'DUPLICATE';

export type SpinMovementResult =
  | { readonly applied: true; readonly delta: number; readonly balanceAfter: number; readonly entryId: string }
  | { readonly applied: false; readonly reason: SpinMovementRefusal };

/** How a spin was paid for, which is what the wheel records against the spin. */
export type SpinPayment = 'FREE' | 'BALANCE';

export type ConsumeSpinResult =
  | { readonly consumed: true; readonly paidWith: SpinPayment; readonly balanceAfter: number }
  | { readonly consumed: false; readonly reason: 'NO_SPINS' | 'USER_NOT_FOUND' | 'DUPLICATE' };

/** The slice of a transaction client this wallet touches. */
export type SpinWalletTx = Pick<Prisma.TransactionClient, 'user' | 'spinLedgerEntry'>;

/**
 * THE ONLY WRITER of `User.spinBalance`, and the sibling of
 * `PointsWalletService` down to the shape of its methods.
 *
 * ── Why a sibling and not one generic wallet ──────────────────────────────
 *
 * The two balances sit on the same table but answer different questions, carry
 * different sources and are read by different screens. A wallet generic over
 * both would have to reach its Prisma delegates through a cast, and the typed
 * single writer is the entire point of the rule. What is shared is the
 * DISCIPLINE, and the discipline is guarded per wallet by its own test against
 * a live database: for every user, SUM(ledger.delta) = the balance column.
 *
 * The points wallet also carries two options this one does not, because their
 * reasons do not exist here: a floored debit (a refund takes back what it can
 * and stops at zero) and an expected-balance precondition (an importer credits
 * only an untouched wallet). A spin is either affordable or it is not.
 *
 * ── The free spin is not in this ledger ───────────────────────────────────
 *
 * It never touches the balance, so a row for it would break the invariant or
 * force a zero-delta row that explains nothing. Every spin — free or paid — is
 * recorded by the wheel against the spin itself, together with how it was
 * paid. This journal explains the BALANCE; the wheel's own history explains
 * the spins.
 */
@Injectable()
export class SpinWalletService {
  /**
   * Apply one movement inside the caller's transaction. On `applied: true` the
   * balance and the journal row commit together with everything else in `tx`;
   * on `applied: false` nothing was written.
   */
  public async apply(tx: SpinWalletTx, input: SpinMovementInput): Promise<SpinMovementResult> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new Error(`Spin movement must be a non-zero integer, got ${String(input.delta)}`);
    }

    if (input.referenceKey !== null) {
      const existing = await tx.spinLedgerEntry.findUnique({
        where: { source_referenceKey: { source: input.source, referenceKey: input.referenceKey } },
        select: { id: true },
      });
      if (existing !== null) return { applied: false, reason: 'DUPLICATE' };
    }

    // The floor rides in the `WHERE` of the write, so `count === 0` IS the
    // refusal and there is no read-then-check window. Same shape as the points
    // wallet, and as the partner balance before it.
    const written =
      input.delta > 0
        ? await tx.user.updateMany({
            where: { id: input.userId },
            data: { spinBalance: { increment: input.delta } },
          })
        : await tx.user.updateMany({
            where: { id: input.userId, spinBalance: { gte: -input.delta } },
            data: { spinBalance: { decrement: -input.delta } },
          });
    if (written.count !== 1) {
      const exists = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      return { applied: false, reason: exists === null ? 'USER_NOT_FOUND' : 'INSUFFICIENT_BALANCE' };
    }

    // Read back UNDER the row lock this update took. Adding the delta to a
    // number read beforehand would record a balance another transaction may
    // have moved in between.
    const after = await tx.user.findUnique({
      where: { id: input.userId },
      select: { spinBalance: true },
    });
    if (after === null) return { applied: false, reason: 'USER_NOT_FOUND' };

    const entry = await tx.spinLedgerEntry.create({
      data: {
        userId: input.userId,
        delta: input.delta,
        balanceAfter: after.spinBalance,
        source: input.source,
        referenceKey: input.referenceKey,
        ...(input.details === undefined ? {} : { details: input.details }),
      },
      select: { id: true },
    });

    return { applied: true, delta: input.delta, balanceAfter: after.spinBalance, entryId: entry.id };
  }

  /**
   * Pay for one spin: the free one first when it is due, otherwise the
   * balance.
   *
   * Free first on purpose. Spending the balance while a free spin sits unused
   * costs the person a spin they had, and they cannot get it back — the free
   * one does not accumulate, so it is simply gone at the next cooldown.
   *
   * Claiming the free spin is a conditional write on the timestamp itself, so
   * two requests racing for it cannot both win: the second finds the row
   * already stamped and falls through to the balance.
   */
  public async consumeSpin(
    tx: SpinWalletTx,
    input: {
      readonly userId: string;
      /** Identifies THIS spin; the ledger row for a paid spin is keyed on it. */
      readonly spinId: string;
      readonly freeSpinCooldownHours: number | null;
      readonly now?: Date;
    },
  ): Promise<ConsumeSpinResult> {
    const now = input.now ?? new Date();
    if (isFreeSpinEnabled(input.freeSpinCooldownHours)) {
      const claimed = await tx.user.updateMany({
        where: {
          id: input.userId,
          OR: [
            { freeSpinUsedAt: null },
            { freeSpinUsedAt: { lte: freeSpinClaimThreshold(input.freeSpinCooldownHours, now) } },
          ],
        },
        data: { freeSpinUsedAt: now },
      });
      if (claimed.count === 1) {
        const row = await tx.user.findUnique({
          where: { id: input.userId },
          select: { spinBalance: true },
        });
        // The free spin leaves the balance alone, so it leaves no ledger row
        // either. The wheel records the spin and that it was paid for free.
        return { consumed: true, paidWith: 'FREE', balanceAfter: row?.spinBalance ?? 0 };
      }
    }

    const spent = await this.apply(tx, {
      userId: input.userId,
      delta: -1,
      source: SpinLedgerSource.SPENT,
      referenceKey: input.spinId,
      details: { spinId: input.spinId },
    });
    if (spent.applied) {
      return { consumed: true, paidWith: 'BALANCE', balanceAfter: spent.balanceAfter };
    }
    return {
      consumed: false,
      reason:
        spent.reason === 'USER_NOT_FOUND'
          ? 'USER_NOT_FOUND'
          : spent.reason === 'DUPLICATE'
            ? 'DUPLICATE'
            : 'NO_SPINS',
    };
  }
}
