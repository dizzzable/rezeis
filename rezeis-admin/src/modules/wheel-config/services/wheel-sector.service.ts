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

/**
 * What the economy guard needs, and no more.
 *
 * The ceilings and the key pool are part of it: a sector that can leave
 * somebody's pool makes every other share bigger, which is how a wheel that
 * reads as safe becomes perpetual. See `wheel-economy.util.ts`.
 */
const ECONOMY_SELECT = {
  kind: true,
  enabled: true,
  weight: true,
  amount: true,
  maxWinsPerUser: true,
  maxWinsTotal: true,
  keyPoolId: true,
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
    await this.prismaService.$transaction(async (tx) => {
      await this.lockWheelConfig(tx);
      const last = await tx.wheelSector.findFirst({
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      await tx.wheelSector.create({
        data: { ...this.toData(payload), order: (last?.order ?? -1) + 1, createdBy },
      });
      await this.assertLiveWheelStillWorks(tx);
    });
    return this.overview();
  }

  public async update(sectorId: string, payload: SectorPayload): Promise<WheelOverview> {
    this.assertSectorValid(payload);
    await this.prismaService.$transaction(async (tx) => {
      await this.lockWheelConfig(tx);
      const exists = await tx.wheelSector.findUnique({
        where: { id: sectorId },
        select: { id: true },
      });
      if (exists === null) throw new NotFoundException('Wheel sector not found');

      await tx.wheelSector.update({ where: { id: sectorId }, data: this.toData(payload) });
      await this.assertLiveWheelStillWorks(tx);
    });
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
    await this.prismaService.$transaction(async (tx) => {
      await this.lockWheelConfig(tx);
      const exists = await tx.wheelSector.findUnique({
        where: { id: sectorId },
        select: { id: true },
      });
      if (exists === null) throw new NotFoundException('Wheel sector not found');
      await tx.wheelSector.delete({ where: { id: sectorId } });
      await this.assertLiveWheelStillWorks(tx);
    });
    return this.overview();
  }

  public async reorder(orderedIds: readonly string[]): Promise<WheelOverview> {
    const known = await this.prismaService.wheelSector.findMany({ select: { id: true } });
    const knownIds = new Set(known.map((sector) => sector.id));
    const listed = new Set(orderedIds);
    if (
      orderedIds.length !== knownIds.size ||
      listed.size !== orderedIds.length ||
      orderedIds.some((id) => !knownIds.has(id))
    ) {
      // "Ровно один раз" means both halves: a partial list would leave the
      // missing sectors sharing an order with somebody, and a list naming one
      // sector twice is the same fault wearing the right length.
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
    await this.prismaService.$transaction(async (tx) => {
      await this.lockWheelConfig(tx);

      const row = await tx.settings.findFirst({ select: { id: true, wheelSettings: true } });
      if (row === null) {
        // The settings row is a singleton created on first read elsewhere; if
        // it genuinely does not exist yet there is nothing to switch on.
        throw new BadRequestException('Настройки платформы ещё не созданы');
      }
      const next: WheelSettings = { ...readWheelSettings(row.wheelSettings), ...patch };

      if (next.enabled) {
        // Read the sectors under the same lock the edits take, so a sector
        // saved a moment ago cannot be the one this switch was judged without.
        const rows = await tx.wheelSector.findMany({
          select: ECONOMY_SELECT,
        });
        const blockers = readWheelBlockers(rows);
        if (blockers.length > 0) {
          throw new BadRequestException(describeBlockers(blockers, readWheelEconomy(rows)));
        }
      }

      await tx.settings.update({
        where: { id: row.id },
        data: {
          wheelSettings: {
            enabled: next.enabled,
            freeSpinCooldownHours: next.freeSpinCooldownHours,
            spinPricePoints: next.spinPricePoints,
          } as Prisma.InputJsonObject,
        },
      });
    });
    return this.overview();
  }

  /**
   * One writer at a time for the whole wheel configuration.
   *
   * The economy guard reads every sector and the switch together, so two
   * edits that are each harmless can commit into a wheel that is neither:
   * enabling the wheel while a spins sector is being made richer reads the
   * old sectors, and the sector edit reads the old switch. The singleton
   * settings row is the natural mutex — there is exactly one wheel.
   */
  private async lockWheelConfig(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT "id" FROM "settings" FOR UPDATE`;
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
   * Runs on the caller's TRANSACTION, after the write and before the commit,
   * so throwing here takes the write back with it. It used to run outside one
   * — and then a refusal was a lie: the operator read "эта правка его ломает"
   * while the edit that broke the live wheel had already committed, paying
   * spins forever to everybody spinning. A guard whose refusal does not undo
   * the thing it refuses is not a guard.
   *
   * It reads only the sectors and the switch, which is all the blockers need;
   * the counts in `overview()` are for the screen and are read outside.
   */
  private async assertLiveWheelStillWorks(tx: Prisma.TransactionClient): Promise<void> {
    const [settingsRow, rows] = await Promise.all([
      tx.settings.findFirst({ select: { wheelSettings: true } }),
      tx.wheelSector.findMany({ select: ECONOMY_SELECT }),
    ]);
    if (!readWheelSettings(settingsRow?.wheelSettings).enabled) return;
    const blockers = readWheelBlockers(rows);
    if (blockers.length === 0) return;
    throw new BadRequestException(
      `Колесо включено, и эта правка его ломает. ${describeBlockers(blockers, readWheelEconomy(rows))}`,
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
