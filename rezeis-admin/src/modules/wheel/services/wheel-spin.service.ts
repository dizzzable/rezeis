import { Injectable, Logger } from '@nestjs/common';
import {
  PointsLedgerSource,
  Prisma,
  SpinLedgerSource,
  WheelSectorKind,
  WheelSpinPayment,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RewardGrantService } from '../../rewards/reward-grant.service';
import type { RewardGrant, RewardKind } from '../../rewards/reward-grant.types';
import {
  drawSector,
  isWheelSpinnable,
  resolveDrawPool,
  type DrawPool,
  type SectorForDraw,
} from '../wheel-draw.util';
import { readWheelSettings, type WheelSettings } from '../wheel-settings.util';
import { SpinWalletService } from './spin-wallet.service';

/** Why a spin did not happen. None of these costs the person anything. */
export type SpinRefusal =
  /** The operator has not switched the wheel on. */
  | 'WHEEL_DISABLED'
  /** Switched on, but there is nothing on it that this person could win. */
  | 'WHEEL_UNAVAILABLE'
  /** No free spin due and nothing on the balance. */
  | 'NO_SPINS'
  | 'USER_NOT_FOUND';

export interface SpinRecord {
  readonly spinId: string;
  readonly sectorId: string | null;
  readonly kind: WheelSectorKind;
  readonly amount: number;
  readonly status: WheelSpinStatus;
  readonly paidWith: WheelSpinPayment;
  readonly outcome: Prisma.JsonValue | null;
  readonly spinBalanceAfter: number;
  /** True when this is a replay of a request that had already been served. */
  readonly replayed: boolean;
}

export type SpinResult =
  | ({ readonly spun: true } & SpinRecord)
  | { readonly spun: false; readonly reason: SpinRefusal };

/** Thrown to roll the transaction back with a reason the caller can report. */
class SpinRefused extends Error {
  public constructor(public readonly reason: SpinRefusal) {
    super(reason);
  }
}

/**
 * Thrown when this request has already been served and the answer is the
 * earlier spin's answer.
 *
 * Separate from `SpinRefused` because it is the opposite of a refusal: the
 * person DID spin, and telling them "you have no spins" — which is what the
 * wallet's DUPLICATE looks like if it is not caught here — would be a lie
 * that also loses the prize they won.
 */
class SpinAlreadyServed extends Error {}

/** What the transaction hands back for the caller to do after it commits. */
interface PostCommit {
  readonly syncSubscriptionId: string | null;
  /** Set when an operator has to settle the prize by hand. */
  readonly manualSpinId: string | null;
}

export const SECTOR_SELECT = {
  id: true,
  kind: true,
  enabled: true,
  weight: true,
  amount: true,
  title: true,
  iconKind: true,
  iconRef: true,
  rarity: true,
  order: true,
  promoRewardType: true,
  promoPlanId: true,
  promoPlanIds: true,
  promoLifetime: true,
  keyPoolId: true,
  manualInstructions: true,
  maxWinsPerUser: true,
  maxWinsTotal: true,
  wonCount: true,
} as const;

export type SectorRow = Prisma.WheelSectorGetPayload<{ select: typeof SECTOR_SELECT }>;

/**
 * The slice of Prisma the sector read needs. A transaction client satisfies
 * it, and so does the pool — which is what lets the cabinet reuse the read.
 */
export type WheelReadClient = Pick<Prisma.TransactionClient, 'wheelSector' | 'wheelSpin' | 'wheelKey'>;

/**
 * One spin, from the payment to the prize.
 *
 * ── The order of the steps is the design ──────────────────────────────────
 *
 * 1. PAY FIRST. `consumeSpin` takes a lock on the spinner's own row, and
 *    everything after it runs while that lock is held. That is what makes the
 *    per-user ceiling safe: two of this person's requests arriving together
 *    cannot both read "you have won this zero times" and both hand over the
 *    one prize they are allowed. There is no cheaper way to get that —
 *    counting wins before paying would be counting them outside the lock.
 * 2. LOOK AT THE WHEEL, then draw. Read inside the transaction, so a sector
 *    an operator disables mid-spin is either wholly in or wholly out.
 * 3. TAKE THE PRIZE'S LAST SLOT BEFORE GIVING IT. The global ceiling is a
 *    conditional increment and a key is a conditional update; both can lose,
 *    and a loser redraws without that sector rather than handing over
 *    something that has run out.
 * 4. WRITE THE SPIN LAST. The row is the receipt, and a receipt is written
 *    when the thing is done.
 *
 * Every refusal rolls the whole transaction back, so a wheel that cannot pay
 * never costs a spin.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * The caller supplies a handle. A replayed request — a double tap, a retry
 * after a dropped response — finds the spin it already has and is told what
 * it won, rather than being charged again. The handle guards the ledger too:
 * it is the key of the SPENT row, so even a replay that got past the
 * fast-path read cannot spend twice.
 */
@Injectable()
export class WheelSpinService {
  private readonly logger = new Logger(WheelSpinService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly spinWallet: SpinWalletService,
    private readonly rewardGrant: RewardGrantService,
  ) {}

  /**
   * The operator's switches. A caller that is about to render the wheel has
   * already read these; a caller that only wants to spin passes them in, which
   * is why they are an argument rather than a read hidden inside the spin.
   */
  public async readSettings(): Promise<WheelSettings> {
    const row = await this.prismaService.settings.findFirst({ select: { wheelSettings: true } });
    return readWheelSettings(row?.wheelSettings);
  }

  public async spin(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly settings: WheelSettings;
    readonly now?: Date;
    /** Injectable for the tests; production spins on `Math.random`. */
    readonly random?: () => number;
  }): Promise<SpinResult> {
    const { settings } = input;
    if (!settings.enabled) return { spun: false, reason: 'WHEEL_DISABLED' };

    const alreadyServed = await this.readSpin(input.userId, input.idempotencyKey);
    if (alreadyServed !== null) return { spun: true, ...alreadyServed };

    let spun: { readonly record: SpinRecord; readonly post: PostCommit } | null = null;
    try {
      spun = await this.prismaService.$transaction(async (tx: Prisma.TransactionClient) => {
        return this.spinInTransaction(tx, {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          freeSpinCooldownHours: settings.freeSpinCooldownHours,
          now: input.now ?? new Date(),
          random: input.random ?? Math.random,
        });
      });
    } catch (error) {
      if (error instanceof SpinRefused) return { spun: false, reason: error.reason };
      // Anything but a lost race is a real failure and belongs to the caller.
      if (!(error instanceof SpinAlreadyServed) && !isDuplicateSpin(error)) throw error;
    }

    if (spun === null) {
      // A concurrent request with the SAME handle got there first. It is
      // committed by now — the ledger row and the spin row commit together —
      // so the answer is its answer, and this request rolled back and cost
      // nothing.
      const served = await this.readSpin(input.userId, input.idempotencyKey);
      if (served !== null) return { spun: true, ...served };
      // The handle was spent and there is no spin to show for it. Unreachable
      // by construction, and not something to paper over with a refusal that
      // would read to the person as "you have no spins".
      throw new Error(
        `Spin request ${input.idempotencyKey} was already spent but no spin was recorded`,
      );
    }

    await this.afterCommit(spun.post);
    return { spun: true, ...spun.record };
  }

  private async spinInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly userId: string;
      readonly idempotencyKey: string;
      readonly freeSpinCooldownHours: number | null;
      readonly now: Date;
      readonly random: () => number;
    },
  ): Promise<{ readonly record: SpinRecord; readonly post: PostCommit }> {
    const paid = await this.spinWallet.consumeSpin(tx, {
      userId: input.userId,
      spinRequestKey: input.idempotencyKey,
      freeSpinCooldownHours: input.freeSpinCooldownHours,
      now: input.now,
    });
    if (!paid.consumed) {
      // DUPLICATE is NOT a refusal: the wallet is saying this exact request has
      // already been paid for, which means the spin happened and its answer is
      // waiting to be read.
      if (paid.reason === 'DUPLICATE') throw new SpinAlreadyServed();
      throw new SpinRefused(paid.reason === 'USER_NOT_FOUND' ? 'USER_NOT_FOUND' : 'NO_SPINS');
    }

    const sectors = await tx.wheelSector.findMany({
      where: { enabled: true },
      orderBy: { order: 'asc' },
      select: SECTOR_SELECT,
    });
    const byId = new Map(sectors.map((sector) => [sector.id, sector]));
    const forDraw = await this.describeForDraw(tx, input.userId, sectors);

    let pool = resolveDrawPool({ sectors: forDraw.sectors, userWins: forDraw.userWins });
    if (!isWheelSpinnable(pool)) throw new SpinRefused('WHEEL_UNAVAILABLE');

    // A sector can lose its last slot between the draw and the claim. Redraw
    // without it; the loop is bounded by the number of candidates, so a wheel
    // whose prizes all ran out at once ends at "unavailable" rather than
    // spinning forever.
    for (let attempt = pool.candidates.length; attempt > 0; attempt -= 1) {
      const drawnId = drawSector(pool, input.random);
      if (drawnId === null) break;
      const sector = byId.get(drawnId);
      if (sector === undefined) break;

      const claim = await this.claimSlot(tx, sector, input.userId);
      if (!claim.claimed) {
        pool = withoutSector(pool, drawnId);
        if (!isWheelSpinnable(pool)) break;
        continue;
      }

      const applied = await this.payOut(tx, {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        sector,
        keyId: claim.keyId,
      });

      const spin = await tx.wheelSpin.create({
        data: {
          userId: input.userId,
          sectorId: sector.id,
          sectorSnapshot: snapshotOf(sector),
          kind: sector.kind,
          amount: sector.amount,
          status: applied.status,
          paidWith: paid.paidWith === 'FREE' ? WheelSpinPayment.FREE : WheelSpinPayment.BALANCE,
          idempotencyKey: input.idempotencyKey,
          ...(applied.outcome === null ? {} : { outcome: applied.outcome }),
          ...(applied.status === WheelSpinStatus.PENDING ? {} : { settledAt: input.now }),
        },
        select: { id: true, outcome: true },
      });

      // The key row is stamped with the spin only now, because only now does
      // the spin have an id. Both writes are in this transaction, so a key is
      // never claimed by a spin that does not exist.
      if (claim.keyId !== null) {
        await tx.wheelKey.update({
          where: { id: claim.keyId },
          data: { claimedSpinId: spin.id },
        });
      }

      return {
        record: {
          spinId: spin.id,
          sectorId: sector.id,
          kind: sector.kind,
          amount: sector.amount,
          status: applied.status,
          paidWith: paid.paidWith === 'FREE' ? WheelSpinPayment.FREE : WheelSpinPayment.BALANCE,
          outcome: spin.outcome,
          spinBalanceAfter: applied.spinBalanceAfter ?? paid.balanceAfter,
          replayed: false,
        },
        post: {
          syncSubscriptionId: applied.syncSubscriptionId,
          manualSpinId: applied.status === WheelSpinStatus.PENDING ? spin.id : null,
        },
      };
    }

    throw new SpinRefused('WHEEL_UNAVAILABLE');
  }

  /**
   * The sectors as the draw needs to see them: how often THIS person has won
   * each, and how many keys are left in the pools behind the key sectors.
   *
   * Public, and typed against the delegates rather than against a transaction,
   * because the CABINET asks the same question outside one: which sectors can
   * this person still win. Both answers must come from here — a second reading
   * of the ceilings would be a second place for them to be got wrong, and the
   * screen would then promise a prize the draw refuses to offer.
   */
  public async describeForDraw(
    tx: WheelReadClient,
    userId: string,
    sectors: readonly SectorRow[],
  ): Promise<{ readonly sectors: readonly SectorForDraw[]; readonly userWins: Map<string, number> }> {
    const capped = sectors.filter((sector) => sector.maxWinsPerUser !== null).map((s) => s.id);
    const userWins = new Map<string, number>();
    if (capped.length > 0) {
      // Counted under the row lock `consumeSpin` took, which is what stops two
      // of this person's requests both passing a ceiling of one.
      const wins = await tx.wheelSpin.groupBy({
        by: ['sectorId'],
        where: { userId, sectorId: { in: capped } },
        _count: { _all: true },
      });
      for (const row of wins) {
        if (row.sectorId !== null) userWins.set(row.sectorId, row._count._all);
      }
    }

    const poolIds = [
      ...new Set(
        sectors
          .filter((sector) => sector.kind === WheelSectorKind.KEY && sector.keyPoolId !== null)
          .map((sector) => sector.keyPoolId as string),
      ),
    ];
    const stock = new Map<string, number>();
    if (poolIds.length > 0) {
      const counts = await tx.wheelKey.groupBy({
        by: ['poolId'],
        where: { poolId: { in: poolIds }, claimedAt: null },
        _count: { _all: true },
      });
      for (const row of counts) stock.set(row.poolId, row._count._all);
    }

    return {
      userWins,
      sectors: sectors.map((sector) => ({
        id: sector.id,
        kind: sector.kind,
        enabled: sector.enabled,
        weight: sector.weight,
        maxWinsPerUser: sector.maxWinsPerUser,
        maxWinsTotal: sector.maxWinsTotal,
        wonCount: sector.wonCount,
        keyPoolId: sector.keyPoolId,
        keysAvailable: sector.keyPoolId === null ? null : (stock.get(sector.keyPoolId) ?? 0),
      })),
    };
  }

  /**
   * Take the drawn sector's last slot before anything is handed over.
   *
   * The global ceiling is tested inside the UPDATE that consumes it, and a key
   * is taken by an UPDATE that still says the key is free. Both are the same
   * shape as the quest budget for the same reason: a read followed by a check
   * lets two simultaneous winners past the last remaining prize.
   */
  private async claimSlot(
    tx: Prisma.TransactionClient,
    sector: SectorRow,
    userId: string,
  ): Promise<{ readonly claimed: boolean; readonly keyId: string | null }> {
    if (sector.maxWinsTotal !== null) {
      const taken = await tx.wheelSector.updateMany({
        where: { id: sector.id, wonCount: { lt: sector.maxWinsTotal } },
        data: { wonCount: { increment: 1 } },
      });
      if (taken.count !== 1) return { claimed: false, keyId: null };
    } else {
      await tx.wheelSector.update({
        where: { id: sector.id },
        data: { wonCount: { increment: 1 } },
      });
    }

    if (sector.kind !== WheelSectorKind.KEY) return { claimed: true, keyId: null };

    const keyId = await this.claimKey(tx, sector.keyPoolId, userId);
    if (keyId === null) {
      // The pool emptied between the read and here. Give the slot back, or the
      // ceiling would count a prize nobody received.
      await tx.wheelSector.update({
        where: { id: sector.id },
        data: { wonCount: { decrement: 1 } },
      });
      return { claimed: false, keyId: null };
    }
    return { claimed: true, keyId };
  }

  /**
   * The oldest unclaimed key in the pool, taken atomically.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this contention-free: a second
   * spinner arriving at the same instant steps over the row this one is
   * taking instead of waiting for it and then finding it gone.
   */
  private async claimKey(
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

  /** Hand the prize over, or record that it is owed. */
  private async payOut(
    tx: Prisma.TransactionClient,
    input: {
      readonly userId: string;
      readonly idempotencyKey: string;
      readonly sector: SectorRow;
      readonly keyId: string | null;
    },
  ): Promise<{
    readonly status: WheelSpinStatus;
    readonly outcome: Prisma.InputJsonObject | null;
    readonly syncSubscriptionId: string | null;
    readonly spinBalanceAfter: number | null;
  }> {
    const { sector } = input;

    switch (sector.kind) {
      case WheelSectorKind.NOTHING:
        return { status: WheelSpinStatus.EMPTY, outcome: null, syncSubscriptionId: null, spinBalanceAfter: null };

      case WheelSectorKind.MANUAL:
        // Recorded as owed, not paid. A jackpot the operator settles by hand
        // is the one prize this system must not pretend to have delivered.
        return {
          status: WheelSpinStatus.PENDING,
          outcome: { manual: true, instructions: sector.manualInstructions ?? '' },
          syncSubscriptionId: null,
          spinBalanceAfter: null,
        };

      case WheelSectorKind.KEY:
        return {
          status: WheelSpinStatus.SETTLED,
          outcome: { keyId: input.keyId, poolId: sector.keyPoolId },
          syncSubscriptionId: null,
          spinBalanceAfter: null,
        };

      case WheelSectorKind.SPINS: {
        const credited = await this.spinWallet.apply(tx, {
          userId: input.userId,
          delta: sector.amount,
          source: SpinLedgerSource.WHEEL_PRIZE,
          referenceKey: input.idempotencyKey,
          details: { sectorId: sector.id, spinRequestKey: input.idempotencyKey },
        });
        if (!credited.applied) {
          throw new Error(`Won spins were not credited (${credited.reason})`);
        }
        return {
          status: WheelSpinStatus.SETTLED,
          outcome: { spins: sector.amount, balanceAfter: credited.balanceAfter },
          syncSubscriptionId: null,
          spinBalanceAfter: credited.balanceAfter,
        };
      }

      // Named one by one rather than gathered into a `default`, so that adding
      // a tenth sector kind is a compile error here instead of a value quietly
      // cast into a reward the applier has never heard of.
      case WheelSectorKind.POINTS:
      case WheelSectorKind.DAYS:
      case WheelSectorKind.TRAFFIC:
      case WheelSectorKind.DISCOUNT:
      case WheelSectorKind.PROMOCODE: {
        const applied = await this.rewardGrant.apply(tx, {
          userId: input.userId,
          grant: grantFor(sector.kind, sector),
          origin: {
            pointsSource: PointsLedgerSource.QUEST_REWARD,
            referenceKey: input.idempotencyKey,
            details: { source: 'WHEEL', sectorId: sector.id },
            codePrefix: 'WHEEL-',
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
        };
      }
    }
  }

  private async readSpin(userId: string, idempotencyKey: string): Promise<SpinRecord | null> {
    const spin = await this.prismaService.wheelSpin.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: {
        id: true,
        sectorId: true,
        kind: true,
        amount: true,
        status: true,
        paidWith: true,
        outcome: true,
        user: { select: { spinBalance: true } },
      },
    });
    if (spin === null) return null;
    return {
      spinId: spin.id,
      sectorId: spin.sectorId,
      kind: spin.kind,
      amount: spin.amount,
      status: spin.status,
      paidWith: spin.paidWith,
      outcome: spin.outcome,
      spinBalanceAfter: spin.user.spinBalance,
      replayed: true,
    };
  }

  /**
   * After the commit, never inside it: a sync job enqueued in a transaction
   * announces a change a rollback then undoes.
   *
   * The operator's conversation for a manual prize is opened by
   * `WheelManualPrizeService`, not here: opening one needs the support stack,
   * and this module stays a leaf because it is imported wherever the wheel is
   * merely READ. The debt is recorded as a PENDING spin and
   * `WheelPrizeReconcilerService` sweeps every minute for owed prizes with no
   * conversation yet, so nothing is lost even if the caller never asks.
   *
   * A caller that CAN reach the prize module — the cabinet controller — should
   * also call `openTicket` on a PENDING result, so the operator hears about a
   * jackpot in the same second rather than at the next sweep.
   */
  private async afterCommit(post: PostCommit): Promise<void> {
    if (post.manualSpinId !== null) {
      this.logger.log(`Wheel spin ${post.manualSpinId} needs an operator to settle it by hand`);
    }
    if (post.syncSubscriptionId !== null) {
      this.logger.debug(`Wheel prize changed subscription ${post.syncSubscriptionId}`);
    }
  }
}

/** The five kinds the shared applier already knows how to give. */
const REWARD_KIND_OF: Readonly<Record<GrantableKind, RewardKind>> = {
  [WheelSectorKind.POINTS]: 'POINTS',
  [WheelSectorKind.DAYS]: 'DAYS',
  [WheelSectorKind.TRAFFIC]: 'TRAFFIC',
  [WheelSectorKind.DISCOUNT]: 'DISCOUNT',
  [WheelSectorKind.PROMOCODE]: 'PROMOCODE',
};

type GrantableKind =
  | typeof WheelSectorKind.POINTS
  | typeof WheelSectorKind.DAYS
  | typeof WheelSectorKind.TRAFFIC
  | typeof WheelSectorKind.DISCOUNT
  | typeof WheelSectorKind.PROMOCODE;

function grantFor(kind: GrantableKind, sector: SectorRow): RewardGrant {
  if (kind !== WheelSectorKind.PROMOCODE) {
    return { kind: REWARD_KIND_OF[kind], amount: sector.amount, planId: null };
  }
  return {
    kind: 'PROMOCODE',
    amount: sector.amount,
    planId: sector.promoPlanId,
    ...(sector.promoRewardType === null
      ? {}
      : {
          promo: {
            rewardType: sector.promoRewardType,
            allowedPlanIds: sector.promoPlanIds,
            lifetimeDays: sector.promoLifetime,
          },
        }),
  };
}

/**
 * What the sector was at the moment of the draw. The history reads from this
 * and not from the live row, so renaming a sector — or deleting it — does not
 * rewrite what somebody remembers winning.
 */
function snapshotOf(sector: SectorRow): Prisma.InputJsonObject {
  return {
    id: sector.id,
    kind: sector.kind,
    title: (sector.title ?? {}) as Prisma.InputJsonValue,
    iconKind: sector.iconKind,
    iconRef: sector.iconRef,
    rarity: sector.rarity,
    amount: sector.amount,
    order: sector.order,
  };
}

function withoutSector(pool: DrawPool, sectorId: string): DrawPool {
  const candidates = pool.candidates.filter((candidate) => candidate.id !== sectorId);
  return {
    candidates,
    excluded: pool.excluded,
    totalWeight: candidates.reduce((sum, candidate) => sum + candidate.weight, 0),
  };
}

/**
 * A unique index refused a second spin for the same request.
 *
 * Two can fire, depending on how far the loser got before the winner
 * committed: the spin's own `(user, handle)` index, and the ledger's
 * `(source, reference_key)` — which the loser reaches first, because the
 * payment happens before the receipt is written.
 */
function isDuplicateSpin(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = JSON.stringify(error.meta ?? {});
  return target.includes('idempotency_key') || target.includes('reference_key');
}
