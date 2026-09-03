import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PointsLedgerSource,
  Prisma,
  SpinLedgerSource,
  WheelSectorKind,
  WheelSpinStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PointsWalletService } from '../../points/services/points-wallet.service';
import { SpinWalletService } from '../../wheel/services/spin-wallet.service';
import { SECTOR_SELECT, WheelSpinService } from '../../wheel/services/wheel-spin.service';
import { resolveFreeSpin } from '../../wheel/spin-availability.util';
import { resolveDrawPool, type SectorExclusion } from '../../wheel/wheel-draw.util';
import { readWheelSettings } from '../../wheel/wheel-settings.util';
import { scopedLedgerReference } from '../../wheel/ledger-reference.util';

/** Why a sector is greyed out for this person. */
export type SectorUnavailable =
  /** They have already won it as often as they may. */
  | 'ALREADY_WON'
  /** Nobody can win it any more. */
  | 'ALL_GONE';

export interface CabinetSector {
  readonly id: string;
  readonly kind: WheelSectorKind;
  readonly title: Prisma.JsonValue;
  readonly iconKind: string;
  readonly iconRef: string;
  readonly rarity: string;
  /** Points, spins, days, GB or percent, by kind. Zero where it means nothing. */
  readonly amount: number;
  /** Whether this person can still land on it. */
  readonly available: boolean;
  readonly unavailable: SectorUnavailable | null;
}

export interface CabinetWheel {
  readonly enabled: boolean;
  readonly sectors: readonly CabinetSector[];
  readonly spinBalance: number;
  readonly pointsBalance: number;
  readonly freeSpin: { readonly available: boolean; readonly availableAt: string | null };
  /** `null` when spins cannot be bought with points at all. */
  readonly spinPricePoints: number | null;
  /** Whether a spin can be taken right now, free or paid. */
  readonly canSpin: boolean;
}

export interface CabinetSpinRow {
  readonly spinId: string;
  readonly kind: WheelSectorKind;
  readonly title: Prisma.JsonValue;
  readonly rarity: string;
  readonly amount: number;
  readonly status: WheelSpinStatus;
  readonly createdAt: string;
  /** The Steam key, the minted code — what the person actually received. */
  readonly prize: Record<string, unknown> | null;
  /** The conversation where a manual prize is being settled. */
  readonly ticketId: string | null;
}

export interface CabinetSpinPage {
  readonly items: readonly CabinetSpinRow[];
  readonly nextCursor: string | null;
}

export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 100;
/** One purchase. More than this is a mis-click, not a wish. */
export const MAX_SPINS_PER_PURCHASE = 50;

/**
 * The wheel as the person spinning it sees it.
 *
 * ── The odds are not in here ──────────────────────────────────────────────
 *
 * Not the weight, not the derived percentage, not the total. That was the
 * owner's decision and it is enforced by the SHAPE of `CabinetSector`: there
 * is no field to leak them into, so a later edit cannot add one by accident.
 *
 * What IS told is whether a sector can still be won by this person, because
 * that is the honest half: a wheel that visibly shows a Steam key you can
 * never land on again — you have had yours — is worse than one that says so.
 */
@Injectable()
export class WheelCabinetService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly wheelSpin: WheelSpinService,
    private readonly spinWallet: SpinWalletService,
    private readonly pointsWallet: PointsWalletService,
  ) {}

  public async view(userId: string): Promise<CabinetWheel> {
    const [settingsRow, user, sectors] = await Promise.all([
      this.prismaService.settings.findFirst({ select: { wheelSettings: true } }),
      this.prismaService.user.findUnique({
        where: { id: userId },
        select: { spinBalance: true, points: true, freeSpinUsedAt: true },
      }),
      this.prismaService.wheelSector.findMany({
        where: { enabled: true },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        select: SECTOR_SELECT,
      }),
    ]);
    if (user === null) throw new NotFoundException('User not found');

    const settings = readWheelSettings(settingsRow?.wheelSettings);
    // The SAME read the draw uses, so the screen cannot promise a prize the
    // draw would refuse to offer.
    const described = await this.wheelSpin.describeForDraw(this.prismaService, userId, sectors);
    const pool = resolveDrawPool({ sectors: described.sectors, userWins: described.userWins });

    const freeSpin = resolveFreeSpin({
      freeSpinUsedAt: user.freeSpinUsedAt,
      cooldownHours: settings.freeSpinCooldownHours,
    });

    const visible = sectors
      .map((sector) => {
        const exclusion = pool.excluded.get(sector.id) ?? null;
        const reason = toCabinetReason(exclusion);
        // A sector excluded for a reason that is not about THIS person —
        // misconfigured, weightless — is not shown at all. Explaining an
        // operator's mistake to a customer helps nobody.
        if (exclusion !== null && reason === null) return null;
        const visibleSector: CabinetSector = {
          id: sector.id,
          kind: sector.kind,
          title: sector.title,
          iconKind: sector.iconKind,
          iconRef: sector.iconRef,
          rarity: sector.rarity,
          amount: sector.amount,
          available: exclusion === null,
          unavailable: reason,
        };
        return visibleSector;
      })
      .filter((sector): sector is CabinetSector => sector !== null);

    return {
      enabled: settings.enabled,
      sectors: visible,
      spinBalance: user.spinBalance,
      pointsBalance: user.points,
      freeSpin,
      spinPricePoints: settings.spinPricePoints,
      canSpin:
        settings.enabled &&
        pool.candidates.length > 0 &&
        (freeSpin.available || user.spinBalance > 0),
    };
  }

  /**
   * Buy spins with points.
   *
   * One transaction, both wallets, and both movements keyed on the caller's
   * handle: a retry after a dropped response finds the points already spent
   * and writes nothing. The points side goes first, because it is the one
   * that can refuse — crediting spins and then failing to charge for them is
   * the direction that costs money.
   */
  public async buySpins(input: {
    readonly userId: string;
    readonly count: number;
    readonly idempotencyKey: string;
  }): Promise<{ readonly spinBalance: number; readonly pointsBalance: number }> {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_SPINS_PER_PURCHASE) {
      throw new BadRequestException('Некорректное количество прокрутов');
    }
    const settingsRow = await this.prismaService.settings.findFirst({
      select: { wheelSettings: true },
    });
    const settings = readWheelSettings(settingsRow?.wheelSettings);
    if (!settings.enabled) throw new BadRequestException('Колесо выключено');
    if (settings.spinPricePoints === null) {
      throw new BadRequestException('Прокруты нельзя купить за баллы');
    }

    const cost = settings.spinPricePoints * input.count;
    const reference = scopedLedgerReference(input.userId, input.idempotencyKey);

    try {
      return await this.buyInTransaction({ ...input, cost, reference, price: settings.spinPricePoints });
    } catch (error) {
      // Two taps that arrive together both pass the wallet's duplicate READ
      // and race to the unique index; the loser lands here. Exactly one debit
      // happened — the index is what guarantees that — so the honest answer is
      // the one the sequential path gives: the balances as they now stand.
      if (!isDuplicateReference(error)) throw error;
      const user = await this.prismaService.user.findUnique({
        where: { id: input.userId },
        select: { spinBalance: true, points: true },
      });
      return { spinBalance: user?.spinBalance ?? 0, pointsBalance: user?.points ?? 0 };
    }
  }

  private async buyInTransaction(input: {
    readonly userId: string;
    readonly count: number;
    readonly cost: number;
    readonly price: number;
    readonly reference: string;
  }): Promise<{ readonly spinBalance: number; readonly pointsBalance: number }> {
    const { cost, reference, price } = input;
    return this.prismaService.$transaction(async (tx) => {
      const spent = await this.pointsWallet.apply(tx, {
        userId: input.userId,
        delta: -cost,
        source: PointsLedgerSource.EXCHANGE,
        referenceKey: reference,
        details: { purpose: 'WHEEL_SPINS', spins: input.count, pricePoints: price },
      });
      if (!spent.applied) {
        if (spent.reason === 'DUPLICATE') {
          // Already bought under this handle. Report the balances as they are
          // rather than charging a second time for a lost response.
          const user = await tx.user.findUnique({
            where: { id: input.userId },
            select: { spinBalance: true, points: true },
          });
          return { spinBalance: user?.spinBalance ?? 0, pointsBalance: user?.points ?? 0 };
        }
        throw new BadRequestException(
          spent.reason === 'INSUFFICIENT_BALANCE' ? 'Не хватает баллов' : 'Пользователь не найден',
        );
      }

      const credited = await this.spinWallet.apply(tx, {
        userId: input.userId,
        delta: input.count,
        source: SpinLedgerSource.PURCHASED,
        referenceKey: reference,
        details: { pricePoints: price, costPoints: cost },
      });
      if (!credited.applied) {
        // The points are debited in this same transaction, so throwing here
        // takes them back with it. Nobody is charged for spins they did not get.
        throw new BadRequestException('Не удалось начислить прокруты');
      }

      return { spinBalance: credited.balanceAfter, pointsBalance: spent.balanceAfter };
    });
  }

  /** This person's own spins, newest first. */
  /**
   * One spin of this person's, by id.
   *
   * The stop screen needs the prize for the spin that just happened — which,
   * on a REPLAY, is not necessarily the newest one: two tabs, or any spin
   * taken between the lost response and the retry, and "the newest row" is
   * somebody else's answer or a later one. Asking by id is the only reading
   * that survives the case idempotency exists for. Scoped by `userId`, so an
   * id from elsewhere finds nothing.
   */
  public async findSpin(input: {
    readonly userId: string;
    readonly spinId: string;
  }): Promise<CabinetSpinRow | null> {
    const spin = await this.prismaService.wheelSpin.findFirst({
      where: { id: input.spinId, userId: input.userId },
      select: SPIN_ROW_SELECT,
    });
    return spin === null ? null : toSpinRow(spin);
  }

  public async history(input: {
    readonly userId: string;
    readonly cursor?: string | null;
    readonly limit?: number | null;
  }): Promise<CabinetSpinPage> {
    const limit = clampLimit(input.limit);
    const rows = await this.prismaService.wheelSpin.findMany({
      where: { userId: input.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: SPIN_ROW_SELECT,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(toSpinRow),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}

/**
 * Everything a spin row needs, and nothing the person may not see: no
 * settlement note, no operator, no weight.
 */
const SPIN_ROW_SELECT = {
  id: true,
  kind: true,
  amount: true,
  status: true,
  outcome: true,
  sectorSnapshot: true,
  manualTicketId: true,
  createdAt: true,
  // The key this spin won, read through the relation rather than out of the
  // outcome: the outcome names an id, and the person needs the secret itself.
  // It is theirs — they won it — and it is readable only through their own
  // history.
  key: { select: { value: true } },
} as const;

type SpinRowPayload = Prisma.WheelSpinGetPayload<{ select: typeof SPIN_ROW_SELECT }>;

function toSpinRow(spin: SpinRowPayload): CabinetSpinRow {
  const snapshot = readObject(spin.sectorSnapshot);
  return {
    spinId: spin.id,
    kind: spin.kind,
    title: (snapshot['title'] ?? {}) as Prisma.JsonValue,
    rarity: typeof snapshot['rarity'] === 'string' ? snapshot['rarity'] : 'COMMON',
    amount: spin.amount,
    status: spin.status,
    createdAt: spin.createdAt.toISOString(),
    prize: buildPrize(spin.kind, spin.outcome, spin.key?.value ?? null),
    ticketId: spin.manualTicketId,
  };
}

/**
 * A write that lost the race to a unique reference key.
 *
 * P2002 on either journal's `(source, reference_key)` index means somebody
 * else's transaction wrote this exact movement first — which, for a handle,
 * is the request being served twice, not a failure.
 */
function isDuplicateReference(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.['target'];
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes('reference_key') || text.includes('referenceKey');
}

/**
 * The customer-facing half of an exclusion.
 *
 * Only the two reasons that are about THIS person survive. `DISABLED`,
 * `ZERO_WEIGHT` and `UNCONFIGURED` are the operator's business and are
 * answered with `null`, which the caller reads as "do not show this at all".
 */
function toCabinetReason(exclusion: SectorExclusion | null): SectorUnavailable | null {
  switch (exclusion) {
    case 'USER_CAP':
      return 'ALREADY_WON';
    case 'EXHAUSTED':
    case 'OUT_OF_STOCK':
      return 'ALL_GONE';
    default:
      return null;
  }
}

/** What the person actually received, by kind. */
function buildPrize(
  kind: WheelSectorKind,
  outcome: Prisma.JsonValue,
  keyValue: string | null,
): Record<string, unknown> | null {
  const raw = readObject(outcome);
  switch (kind) {
    case WheelSectorKind.NOTHING:
      return null;
    case WheelSectorKind.KEY:
      // The id in the outcome is for the operator; the value is for the winner.
      return keyValue === null ? null : { key: keyValue };
    case WheelSectorKind.MANUAL:
      // The instruction on the outcome is the operator's note to themselves
      // and is deliberately not passed on.
      return null;
    default: {
      const { points, days, trafficGb, discountPercent, promoCode, spins } = raw;
      return {
        ...(points === undefined ? {} : { points }),
        ...(days === undefined ? {} : { days }),
        ...(trafficGb === undefined ? {} : { trafficGb }),
        ...(discountPercent === undefined ? {} : { discountPercent }),
        ...(promoCode === undefined ? {} : { promoCode }),
        ...(spins === undefined ? {} : { spins }),
      };
    }
  }
}

function readObject(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampLimit(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), HISTORY_MAX_LIMIT);
}
