import { Injectable } from '@nestjs/common';
import {
  PointsLedgerSource,
  Prisma,
  PromocodeRewardType,
  SpinLedgerSource,
  WheelSectorKind,
  WheelSpinStatus,
} from '@prisma/client';

import { RewardGrantService } from '../../rewards/reward-grant.service';
import type { RewardGrant, RewardKind } from '../../rewards/reward-grant.types';
import { SpinWalletService } from './spin-wallet.service';

/** What a prize IS — a sector, a contest place — stripped of who may win it. */
export interface PrizeSpec {
  readonly id: string;
  readonly kind: WheelSectorKind;
  readonly amount: number;
  readonly promoRewardType: PromocodeRewardType | null;
  readonly promoPlanId: string | null;
  readonly promoPlanIds: readonly string[];
  readonly promoLifetime: number | null;
  readonly keyPoolId: string | null;
  readonly manualInstructions: string | null;
}

/** Where the prize came from, for the journals and the minted code. */
export interface PrizeOrigin {
  /** `WHEEL_PRIZE` or `CONTEST_PRIZE`, in both ledgers. */
  readonly source: 'WHEEL' | 'CONTEST';
  /** Idempotency handle for every journal row this payout writes. */
  readonly referenceKey: string;
  /** What the ledger row shows beyond the source. */
  readonly details: Prisma.InputJsonObject;
  /**
   * A key the caller has ALREADY claimed for this prize, when it did so
   * before deciding the prize could be paid — the wheel claims inside its
   * redraw loop. Absent, this service claims one itself.
   */
  readonly claimedKeyId?: string | null;
}

export interface PrizePayout {
  readonly status: WheelSpinStatus;
  readonly outcome: Prisma.InputJsonObject | null;
  /** The subscription to re-sync after the caller commits, if any moved. */
  readonly syncSubscriptionId: string | null;
  readonly spinBalanceAfter: number | null;
  /** The key handed over, so the caller can stamp it with its own row id. */
  readonly keyId: string | null;
}

const LEDGER_SOURCE: Readonly<
  Record<PrizeOrigin['source'], { readonly points: PointsLedgerSource; readonly spins: SpinLedgerSource }>
> = {
  WHEEL: { points: PointsLedgerSource.WHEEL_PRIZE, spins: SpinLedgerSource.WHEEL_PRIZE },
  CONTEST: { points: PointsLedgerSource.CONTEST_PRIZE, spins: SpinLedgerSource.CONTEST_PRIZE },
};

const CODE_PREFIX: Readonly<Record<PrizeOrigin['source'], string>> = {
  WHEEL: 'WHEEL-',
  CONTEST: 'WIN-',
};

/** The kinds the shared applier already knows how to give. */
const REWARD_KIND_OF: Readonly<Partial<Record<WheelSectorKind, RewardKind>>> = {
  [WheelSectorKind.POINTS]: 'POINTS',
  [WheelSectorKind.DAYS]: 'DAYS',
  [WheelSectorKind.TRAFFIC]: 'TRAFFIC',
  [WheelSectorKind.DISCOUNT]: 'DISCOUNT',
  [WheelSectorKind.PROMOCODE]: 'PROMOCODE',
};

/**
 * Hand a prize over, or record that it is owed — for the wheel AND for a
 * contest draw.
 *
 * ── Why this left the spin service ────────────────────────────────────────
 *
 * A contest prize is a sector without a weight: the same nine kinds, the same
 * rules about what "paying" means for each, the same journals. Written twice,
 * the two would drift on the first fix applied to one — the exact reason the
 * reward applier itself was pulled out of the quests. So the wheel keeps what
 * is the wheel's (the draw, the ceilings, the spin journal) and the paying
 * lives here, once.
 *
 * ── What "settled" and "pending" mean, per kind ───────────────────────────
 *
 * NOTHING pays nothing and is EMPTY. MANUAL is PENDING: a human hands it over
 * and the row waits in the operator's queue. KEY is SETTLED with the key on
 * the row — unless the pool ran dry between the promise and the payout, in
 * which case it becomes PENDING with a note saying so: the promise stands,
 * the operator settles it by hand, and nothing pretends a key went out that
 * did not. Everything else is applied here, in the caller's transaction.
 */
@Injectable()
export class PrizePayoutService {
  public constructor(
    private readonly spinWallet: SpinWalletService,
    private readonly rewardGrant: RewardGrantService,
  ) {}

  public async payOut(
    tx: Prisma.TransactionClient,
    input: { readonly userId: string; readonly prize: PrizeSpec; readonly origin: PrizeOrigin },
  ): Promise<PrizePayout> {
    const { prize, origin } = input;
    const ledger = LEDGER_SOURCE[origin.source];

    switch (prize.kind) {
      case WheelSectorKind.NOTHING:
        return { status: WheelSpinStatus.EMPTY, outcome: null, syncSubscriptionId: null, spinBalanceAfter: null, keyId: null };

      case WheelSectorKind.MANUAL:
        // Owed, not paid. A jackpot the operator settles by hand is the one
        // prize this system must not pretend to have delivered.
        return {
          status: WheelSpinStatus.PENDING,
          outcome: { manual: true, instructions: prize.manualInstructions ?? '' },
          syncSubscriptionId: null,
          spinBalanceAfter: null,
          keyId: null,
        };

      case WheelSectorKind.KEY: {
        const keyId =
          origin.claimedKeyId ?? (await this.claimKey(tx, prize.keyPoolId, input.userId));
        if (keyId === null) {
          // The pool emptied between the promise and now. The promise stands;
          // a human keeps it. Recording SETTLED with nothing behind it would
          // be a key that went out to nobody.
          return {
            status: WheelSpinStatus.PENDING,
            outcome: {
              manual: true,
              instructions: 'Ключи в пуле закончились — выдайте ключ вручную',
              keyPoolId: prize.keyPoolId,
            },
            syncSubscriptionId: null,
            spinBalanceAfter: null,
            keyId: null,
          };
        }
        return {
          status: WheelSpinStatus.SETTLED,
          outcome: { keyId, poolId: prize.keyPoolId },
          syncSubscriptionId: null,
          spinBalanceAfter: null,
          keyId,
        };
      }

      case WheelSectorKind.SPINS: {
        const credited = await this.spinWallet.apply(tx, {
          userId: input.userId,
          delta: prize.amount,
          source: ledger.spins,
          referenceKey: origin.referenceKey,
          details: { prizeId: prize.id, ...origin.details },
        });
        if (!credited.applied) {
          throw new Error(`Won spins were not credited (${credited.reason})`);
        }
        return {
          status: WheelSpinStatus.SETTLED,
          outcome: { spins: prize.amount, balanceAfter: credited.balanceAfter },
          syncSubscriptionId: null,
          spinBalanceAfter: credited.balanceAfter,
          keyId: null,
        };
      }

      // Named one by one rather than gathered into a `default`, so that a
      // tenth kind is a compile error here instead of a value quietly cast
      // into a reward the applier has never heard of.
      case WheelSectorKind.POINTS:
      case WheelSectorKind.DAYS:
      case WheelSectorKind.TRAFFIC:
      case WheelSectorKind.DISCOUNT:
      case WheelSectorKind.PROMOCODE: {
        const applied = await this.rewardGrant.apply(tx, {
          userId: input.userId,
          grant: grantFor(prize.kind, prize),
          origin: {
            pointsSource: ledger.points,
            referenceKey: origin.referenceKey,
            details: { source: origin.source, prizeId: prize.id, ...origin.details },
            codePrefix: CODE_PREFIX[origin.source],
          },
        });
        return {
          status: WheelSpinStatus.SETTLED,
          outcome: {
            ...(applied.points === undefined ? {} : { points: applied.points }),
            ...(applied.days === undefined ? {} : { days: applied.days }),
            ...(applied.trafficGb === undefined ? {} : { trafficGb: applied.trafficGb }),
            ...(applied.discountPercent === undefined ? {} : { discountPercent: applied.discountPercent }),
            ...(applied.promoCode === undefined ? {} : { promoCode: applied.promoCode }),
          },
          syncSubscriptionId: applied.syncSubscriptionId,
          spinBalanceAfter: null,
          keyId: null,
        };
      }
    }
  }

  /**
   * The oldest unclaimed key in the pool, taken atomically.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this contention-free: a second
   * winner arriving at the same instant steps over the row this one is
   * taking instead of waiting for it and then finding it gone.
   */
  public async claimKey(
    tx: Prisma.TransactionClient,
    poolId: string | null,
    userId: string,
  ): Promise<string | null> {
    if (poolId === null) return null;
    const claimed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "wheel_keys"
         SET "claimed_by_user_id" = ${userId},
             "claimed_at" = NOW()
       WHERE "id" = (
         SELECT "id"
           FROM "wheel_keys"
          WHERE "pool_id" = ${poolId}
            AND "claimed_at" IS NULL
          ORDER BY "created_at"
          LIMIT 1
            FOR UPDATE SKIP LOCKED
       )
      RETURNING "id"
    `);
    return claimed[0]?.id ?? null;
  }
}

function grantFor(kind: WheelSectorKind, prize: PrizeSpec): RewardGrant {
  const rewardKind = REWARD_KIND_OF[kind];
  if (rewardKind === undefined) {
    throw new Error(`Prize kind ${kind} is not a reward the applier can give`);
  }
  if (kind !== WheelSectorKind.PROMOCODE) {
    return { kind: rewardKind, amount: prize.amount, planId: null };
  }
  return {
    kind: 'PROMOCODE',
    amount: prize.amount,
    planId: prize.promoPlanId,
    ...(prize.promoRewardType === null
      ? {}
      : {
          promo: {
            rewardType: prize.promoRewardType,
            allowedPlanIds: prize.promoPlanIds,
            lifetimeDays: prize.promoLifetime,
          },
        }),
  };
}
