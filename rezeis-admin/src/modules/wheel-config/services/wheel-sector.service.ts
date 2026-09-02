import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { sectorChancePercent } from '../../wheel/wheel-draw.util';
import { readWheelSettings, type WheelSettings } from '../../wheel/wheel-settings.util';
import { readWheelBlockers, readWheelEconomy, type WheelBlocker, type WheelEconomy } from '../wheel-economy.util';
import { validateSector, type SectorDraft } from '../wheel-sector-validation.util';

const SECTOR_SELECT = {
  id: true,
  kind: true,
  title: true,
  iconKind: true,
  iconRef: true,
  rarity: true,
  weight: true,
  amount: true,
  promoRewardType: true,
  promoPlanId: true,
  promoPlanIds: true,
  promoLifetime: true,
  keyPoolId: true,
  manualInstructions: true,
  maxWinsPerUser: true,
  maxWinsTotal: true,
  wonCount: true,
  order: true,
  enabled: true,
} as const;

type SectorRow = Prisma.WheelSectorGetPayload<{ select: typeof SECTOR_SELECT }>;

export type WheelSector = SectorRow & {
  /**
   * The live figure, derived from the weights rather than stored — which is
   * why the column always adds up to exactly a hundred. Shown to the operator
   * and to nobody else.
   */
  readonly chancePercent: number;
  /** Keys left in this sector's pool. `null` when it is not a KEY sector. */
  readonly keysAvailable: number | null;
};

export interface WheelOverview {
  readonly settings: WheelSettings;
  readonly sectors: readonly WheelSector[];
  readonly economy: WheelEconomy;
  /** What stands between this wheel and being switched on. */
  readonly blockers: readonly WheelBlocker[];
  /** Spins taken so far — context for the numbers above. */
  readonly spins: { readonly total: number; readonly pending: number };
}

export interface SectorPayload extends SectorDraft {
  readonly title: Prisma.InputJsonValue;
  readonly iconKind?: 'PRESET' | 'SVG';
  readonly iconRef?: string;
  readonly rarity?: 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
  readonly promoPlanIds?: readonly string[];
  readonly enabled?: boolean;
}

/**
 * The wheel as the operator configures it.
 *
 * ── Two guards, and why they bite at different moments ────────────────────
 *
 * Saving a sector is never refused for the wheel's ECONOMY while the wheel is
 * off: an operator building a wheel passes through half-finished states, and a
 * configurator that refuses the middle of an edit is a configurator people
 * fight. What is refused is switching a broken wheel ON — and, once it IS on,
 * any edit that would break it under somebody's feet.
 *
 * Per-sector validity is different: it is refused always, because a sector
 * that cannot pay is not a half-finished state, it is a mistake that the draw
 * would silently hide by never offering it.
 */
@Injectable()
export class WheelSectorService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async overview(): Promise<WheelOverview> {
    const [settingsRow, rows, spinTotal, spinPending] = await Promise.all([
      this.prismaService.settings.findFirst({ select: { wheelSettings: true } }),
      this.prismaService.wheelSector.findMany({
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        select: SECTOR_SELECT,
      }),
      this.prismaService.wheelSpin.count(),
      this.prismaService.wheelSpin.count({ where: { status: WheelSpinStatus.PENDING } }),
    ]);

    const economy = readWheelEconomy(rows);
    const keysByPool = await this.readKeyStock(rows);

    return {
      settings: readWheelSettings(settingsRow?.wheelSettings),
      sectors: rows.map((sector) => ({
        ...sector,
        chancePercent:
          sector.enabled && sector.weight > 0
            ? sectorChancePercent(sector.weight, economy.totalWeight)
            : 0,
        keysAvailable:
          sector.kind === WheelSectorKind.KEY && sector.keyPoolId !== null
            ? (keysByPool.get(sector.keyPoolId) ?? 0)
            : null,
      })),
      economy,
      blockers: readWheelBlockers(rows),
      spins: { total: spinTotal, pending: spinPending },
    };
  }

  public async create(payload: SectorPayload, createdBy: string): Promise<WheelOverview> {
    this.assertSectorValid(payload);
    const last = await this.prismaService.wheelSector.findFirst({
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    await this.prismaService.wheelSector.create({
      data: { ...this.toData(payload), order: (last?.order ?? -1) + 1, createdBy },
    });
    await this.assertLiveWheelStillWorks();
    return this.overview();
  }

  public async update(sectorId: string, payload: SectorPayload): Promise<WheelOverview> {
    this.assertSectorValid(payload);
    const exists = await this.prismaService.wheelSector.findUnique({
      where: { id: sectorId },
      select: { id: true },
    });
    if (exists === null) throw new NotFoundException('Wheel sector not found');

    await this.prismaService.wheelSector.update({
      where: { id: sectorId },
      data: this.toData(payload),
    });
    await this.assertLiveWheelStillWorks();
    return this.overview();
  }

  /**
   * Delete a sector.
   *
   * The spins that landed on it survive: the foreign key nulls the reference
   * and the snapshot on each spin keeps showing what was won. So this is not
   * the destructive operation it looks like — the history is not in the
   * sector.
   */
  public async remove(sectorId: string): Promise<WheelOverview> {
    const exists = await this.prismaService.wheelSector.findUnique({
      where: { id: sectorId },
      select: { id: true },
    });
    if (exists === null) throw new NotFoundException('Wheel sector not found');
    await this.prismaService.wheelSector.delete({ where: { id: sectorId } });
    await this.assertLiveWheelStillWorks();
    return this.overview();
  }

  public async reorder(orderedIds: readonly string[]): Promise<WheelOverview> {
    const known = await this.prismaService.wheelSector.findMany({ select: { id: true } });
    const knownIds = new Set(known.map((sector) => sector.id));
    if (orderedIds.length !== knownIds.size || orderedIds.some((id) => !knownIds.has(id))) {
      // A partial list would silently leave the missing sectors sharing an
      // order with somebody, and the wheel's slot order is what a person sees.
      throw new BadRequestException('Порядок должен перечислять все секторы ровно один раз');
    }
    await this.prismaService.$transaction(
      orderedIds.map((id, index) =>
        this.prismaService.wheelSector.update({ where: { id }, data: { order: index } }),
      ),
    );
    return this.overview();
  }

  /**
   * The master switches.
   *
   * Turning the wheel ON is where the economy is judged, because that is the
   * moment a broken wheel would start costing something.
   */
  public async updateSettings(patch: Partial<WheelSettings>): Promise<WheelOverview> {
    const current = await this.overview();
    const next: WheelSettings = { ...current.settings, ...patch };

    if (next.enabled && current.blockers.length > 0) {
      throw new BadRequestException(describeBlockers(current.blockers, current.economy));
    }

    const row = await this.prismaService.settings.findFirst({ select: { id: true } });
    if (row === null) {
      // The settings row is a singleton created on first read elsewhere; if it
      // genuinely does not exist yet there is nothing configured to switch on.
      throw new BadRequestException('Настройки платформы ещё не созданы');
    }
    await this.prismaService.settings.update({
      where: { id: row.id },
      data: {
        wheelSettings: {
          enabled: next.enabled,
          freeSpinCooldownHours: next.freeSpinCooldownHours,
          spinPricePoints: next.spinPricePoints,
        } as Prisma.InputJsonObject,
      },
    });
    return this.overview();
  }

  private assertSectorValid(payload: SectorPayload): void {
    const problems = validateSector(payload);
    if (problems.length > 0) {
      throw new BadRequestException(problems.map((problem) => problem.message).join('; '));
    }
  }

  /**
   * A wheel that is already ON must not be edited into a broken one.
   *
   * Run after the write and inside no transaction, so a refusal here has to
   * undo nothing — it reports a wheel that is now live and broken. That is
   * deliberate: the alternative is holding a transaction open across the
   * overview read, and the failure it guards against (an operator enabling a
   * spins sector that tips the economy over) is one somebody is watching.
   */
  private async assertLiveWheelStillWorks(): Promise<void> {
    const after = await this.overview();
    if (!after.settings.enabled) return;
    if (after.blockers.length === 0) return;
    throw new BadRequestException(
      `Колесо включено, и эта правка его ломает. ${describeBlockers(after.blockers, after.economy)}`,
    );
  }

  private toData(payload: SectorPayload): Prisma.WheelSectorUncheckedCreateInput {
    return {
      kind: payload.kind,
      title: payload.title,
      ...(payload.iconKind === undefined ? {} : { iconKind: payload.iconKind }),
      ...(payload.iconRef === undefined ? {} : { iconRef: payload.iconRef }),
      ...(payload.rarity === undefined ? {} : { rarity: payload.rarity }),
      weight: payload.weight,
      amount: payload.amount,
      promoRewardType: payload.promoRewardType,
      promoPlanId: payload.promoPlanId,
      promoPlanIds: [...(payload.promoPlanIds ?? [])],
      promoLifetime: payload.promoLifetime,
      keyPoolId: payload.keyPoolId,
      manualInstructions: payload.manualInstructions,
      maxWinsPerUser: payload.maxWinsPerUser,
      maxWinsTotal: payload.maxWinsTotal,
      ...(payload.enabled === undefined ? {} : { enabled: payload.enabled }),
    };
  }

  private async readKeyStock(sectors: readonly SectorRow[]): Promise<Map<string, number>> {
    const poolIds = [
      ...new Set(
        sectors
          .filter((sector) => sector.kind === WheelSectorKind.KEY && sector.keyPoolId !== null)
          .map((sector) => sector.keyPoolId as string),
      ),
    ];
    if (poolIds.length === 0) return new Map();
    const counts = await this.prismaService.wheelKey.groupBy({
      by: ['poolId'],
      where: { poolId: { in: poolIds }, claimedAt: null },
      _count: { _all: true },
    });
    return new Map(counts.map((row) => [row.poolId, row._count._all]));
  }
}

/** The blockers, spelled out with the number that produced them. */
export function describeBlockers(
  blockers: readonly WheelBlocker[],
  economy: WheelEconomy,
): string {
  return blockers
    .map((blocker) => {
      switch (blocker) {
        case 'NO_SECTORS':
          return 'На колесе нет ни одного включённого сектора с весом.';
        case 'NO_LOSS_SECTOR':
          return 'Нужен включённый сектор «не повезло»: он единственный без лимитов, и без него человек, забравший свои разовые призы, останется без доступного сектора.';
        case 'PERPETUAL':
          return `Прокруты не кончатся: один прокрут возвращает в среднем ${economy.spinsReturnedPerSpin.toFixed(2)} прокрута. Нужно меньше единицы — уменьшите шанс или номинал секторов с прокрутами.`;
      }
    })
    .join(' ');
}
