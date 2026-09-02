import { Injectable } from '@nestjs/common';
import { PointsLedgerSource, Prisma } from '@prisma/client';

/**
 * One movement of a user's points, as a writer describes it.
 */
export interface PointsMovementInput {
  readonly userId: string;
  /**
   * Signed: a credit is positive, a debit negative. Zero is refused — a
   * movement that moves nothing is a bug in the caller, not a row.
   */
  readonly delta: number;
  readonly source: PointsLedgerSource;
  /**
   * Idempotency handle, unique per `source`. The transaction id for a cashback
   * and its reversal, the reward id for a referral payout, the exchange id for
   * a spend. `null` for movements that are not idempotent by nature — an
   * operator typing a number twice means two adjustments.
   */
  readonly referenceKey: string | null;
  /** Shown for the row: plan and price, exchange type, reason and operator… */
  readonly details?: Prisma.InputJsonObject;
  /**
   * What happens to a debit larger than the balance.
   *
   *   - `refuse` (default): nothing is written and the caller is told; the
   *     exchange and the operator's adjustment answer with their own error.
   *   - `floor`: as much as there is is taken, the balance ends at zero, and
   *     the row records requested / applied / shortfall. The refund reversals
   *     use this: the money is already gone back, and a balance driven
   *     negative is a debt nobody collects.
   */
  readonly shortfall?: 'refuse' | 'floor';
  /**
   * Precondition on the balance BEFORE the write, checked inside the same
   * conditional statement as the write itself. The importer's "credit the
   * migrated balance only while the user still holds zero" is this.
   */
  readonly expectedBalance?: number;
}

export type PointsMovementRefusal =
  | 'USER_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'PRECONDITION_FAILED'
  | 'DUPLICATE';

export type PointsMovementResult =
  | {
      readonly applied: true;
      /** What actually moved. Equals `delta` unless the debit was floored. */
      readonly delta: number;
      readonly balanceAfter: number;
      /** `requested - applied` for a floored debit; zero otherwise. */
      readonly shortfall: number;
      readonly entryId: string;
    }
  | {
      readonly applied: false;
      readonly reason: PointsMovementRefusal;
    };

/**
 * The slice of a transaction client the wallet touches. Typed narrowly so a
 * spec can hand in a fake without modelling the whole client, and so the
 * compiler lists exactly which statements this service is allowed to issue.
 */
export type PointsWalletTx = Pick<Prisma.TransactionClient, 'user' | 'pointsLedgerEntry'>;

const FLOOR_RETRIES = 3;

/**
 * THE ONLY WRITER of `User.points`.
 *
 * ── Why one writer ────────────────────────────────────────────────────────
 *
 * The balance used to have eight writers — referral payouts and their refund
 * reversal, quest rewards, the exchange, the operator's manual adjustment, two
 * importers and the account merge — and no journal. Three of them guarded the
 * floor the same way, one guarded it differently, one not at all. A journal
 * bolted on beside them would show a balance and be wrong about it, because
 * every movement that bypassed it would be missing from the sum.
 *
 * So the rule is structural: the conditional balance update and the ledger row
 * are written HERE, in the caller's transaction, by one method. The invariant
 * this buys — for every user, SUM(ledger.delta) = users.points — is checked
 * on a live database by `test/points-wallet-postgres.spec.ts`.
 *
 * ── Why `balanceAfter` is read back, not computed ─────────────────────────
 *
 * The update takes the row lock; a read in the same transaction sees the
 * row as this update left it, and no other writer can move it until commit.
 * Adding `delta` to a number read BEFORE the update would record the balance
 * some other transaction may have changed in between — the exact bug the
 * floor in the `WHERE` was introduced to close.
 *
 * ── Why the floor rides in the `WHERE` ────────────────────────────────────
 *
 * `points >= amount` evaluated by PostgreSQL against the row it locks: zero
 * rows IS the refusal, and there is no read-then-check window. It is the shape
 * the exchange, the manual adjustment and the partner balance already used;
 * they now use it through here.
 *
 * ── Why the service has no dependencies ───────────────────────────────────
 *
 * Every writer already runs inside a transaction of its own and passes it in.
 * A wallet that opened transactions would either nest inside theirs (Prisma
 * does not) or commit apart from the write it belongs to. Dependency-free
 * also means a spec constructs it with `new`, and the module that provides it
 * imports nothing.
 */
@Injectable()
export class PointsWalletService {
  /**
   * Apply one movement inside the caller's transaction.
   *
   * On `applied: true` the balance and the ledger row are both written and
   * will commit or roll back together with everything else in `tx`. On
   * `applied: false` NOTHING was written, and the caller decides what the
   * refusal means for it — the exchange throws "insufficient balance", a
   * replayed hook logs and moves on.
   *
   * A `DUPLICATE` is reported from a pre-check on `(source, referenceKey)`.
   * Two writers racing on the same key both pass the pre-check; the unique
   * index then refuses the second row and its transaction rolls back
   * including its balance update — exactly-once still holds, the loser just
   * learns it from a thrown `P2002` instead of a return value.
   */
  public async apply(tx: PointsWalletTx, input: PointsMovementInput): Promise<PointsMovementResult> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new Error(`Points movement must be a non-zero integer, got ${String(input.delta)}`);
    }

    if (input.referenceKey !== null) {
      const existing = await tx.pointsLedgerEntry.findUnique({
        where: {
          source_referenceKey: { source: input.source, referenceKey: input.referenceKey },
        },
        select: { id: true },
      });
      if (existing !== null) return { applied: false, reason: 'DUPLICATE' };
    }

    const moved =
      input.delta > 0
        ? await this.credit(tx, input)
        : input.shortfall === 'floor'
          ? await this.debitFloored(tx, input)
          : await this.debit(tx, input);
    if (!moved.applied) return moved;

    const after = await tx.user.findUnique({
      where: { id: input.userId },
      select: { points: true },
    });
    if (after === null) {
      // Unreachable: this transaction holds the lock on the row it has just
      // written. Kept so the type stays honest without a non-null assertion.
      return { applied: false, reason: 'USER_NOT_FOUND' };
    }

    const details: Prisma.InputJsonObject | undefined =
      moved.shortfall > 0
        ? {
            ...(input.details ?? {}),
            requested: Math.abs(input.delta),
            applied: Math.abs(moved.delta),
            shortfall: moved.shortfall,
          }
        : input.details;

    const entry = await tx.pointsLedgerEntry.create({
      data: {
        userId: input.userId,
        delta: moved.delta,
        balanceAfter: after.points,
        source: input.source,
        referenceKey: input.referenceKey,
        // Omitted, not `JsonNull`: a movement with nothing to show leaves the
        // column NULL, and a fake that models the row sees `undefined`.
        ...(details === undefined ? {} : { details }),
      },
      select: { id: true },
    });

    return {
      applied: true,
      delta: moved.delta,
      balanceAfter: after.points,
      shortfall: moved.shortfall,
      entryId: entry.id,
    };
  }

  private async credit(
    tx: PointsWalletTx,
    input: PointsMovementInput,
  ): Promise<PointsMovementResult> {
    const written = await tx.user.updateMany({
      where: {
        id: input.userId,
        ...(input.expectedBalance === undefined ? {} : { points: input.expectedBalance }),
      },
      data: { points: { increment: input.delta } },
    });
    if (written.count === 1) {
      return { applied: true, delta: input.delta, balanceAfter: 0, shortfall: 0, entryId: '' };
    }
    return { applied: false, reason: await this.whyRefused(tx, input.userId, 'PRECONDITION_FAILED') };
  }

  private async debit(
    tx: PointsWalletTx,
    input: PointsMovementInput,
  ): Promise<PointsMovementResult> {
    const amount = -input.delta;
    const written = await tx.user.updateMany({
      where: {
        id: input.userId,
        // Both preconditions when both are given: the balance must be what the
        // caller expects AND cover the debit. `expectedBalance` below the
        // amount can never match, which is the correct answer to that request.
        points:
          input.expectedBalance === undefined
            ? { gte: amount }
            : { equals: input.expectedBalance, gte: amount },
      },
      data: { points: { decrement: amount } },
    });
    if (written.count === 1) {
      return { applied: true, delta: input.delta, balanceAfter: 0, shortfall: 0, entryId: '' };
    }
    const reason =
      input.expectedBalance === undefined
        ? await this.whyRefused(tx, input.userId, 'INSUFFICIENT_BALANCE')
        : await this.whyRefused(tx, input.userId, 'PRECONDITION_FAILED');
    return { applied: false, reason };
  }

  /**
   * Take as much as there is. Full debit first — one statement, no read. Only
   * when the floor refuses it is the balance read, and the "empty the wallet"
   * write is conditioned on that exact value so a concurrent movement in the
   * gap makes it miss and retry rather than overwrite.
   */
  private async debitFloored(
    tx: PointsWalletTx,
    input: PointsMovementInput,
  ): Promise<PointsMovementResult> {
    const amount = -input.delta;
    for (let attempt = 0; attempt < FLOOR_RETRIES; attempt += 1) {
      const full = await tx.user.updateMany({
        where: { id: input.userId, points: { gte: amount } },
        data: { points: { decrement: amount } },
      });
      if (full.count === 1) {
        return { applied: true, delta: input.delta, balanceAfter: 0, shortfall: 0, entryId: '' };
      }

      const row = await tx.user.findUnique({
        where: { id: input.userId },
        select: { points: true },
      });
      if (row === null) return { applied: false, reason: 'USER_NOT_FOUND' };

      // A balance already at or below zero has nothing to give. The row is
      // still written (delta 0) so the reversal is on record and its
      // reference key is consumed — a replay must not try again later when
      // the user has earned points that were never part of this refund.
      const available = Math.max(0, row.points);
      if (available === 0) {
        return { applied: true, delta: 0, balanceAfter: 0, shortfall: amount, entryId: '' };
      }

      const emptied = await tx.user.updateMany({
        where: { id: input.userId, points: row.points },
        data: { points: { decrement: available } },
      });
      if (emptied.count === 1) {
        return {
          applied: true,
          delta: -available,
          balanceAfter: 0,
          shortfall: amount - available,
          entryId: '',
        };
      }
      // The balance moved between the read and the write; go round again with
      // the fresh value.
    }
    throw new Error(
      `Points floor debit for user ${input.userId} lost the race ${FLOOR_RETRIES} times`,
    );
  }

  /**
   * Zero rows is either "no such user" or "the condition refused it", and the
   * count cannot say which. Only the refused branch pays for telling them
   * apart; the path that succeeds never reads the balance before writing it.
   */
  private async whyRefused(
    tx: PointsWalletTx,
    userId: string,
    otherwise: PointsMovementRefusal,
  ): Promise<PointsMovementRefusal> {
    const existing = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    return existing === null ? 'USER_NOT_FOUND' : otherwise;
  }
}
