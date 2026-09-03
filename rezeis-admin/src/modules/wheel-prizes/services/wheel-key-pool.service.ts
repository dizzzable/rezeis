import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ContestStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface KeyPoolSummary {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly createdAt: string;
  /** Everything ever loaded into the pool. */
  readonly total: number;
  /** Handed out. */
  readonly claimed: number;
  /** Still winnable — the number the draw actually cares about. */
  readonly available: number;
  /** Sectors drawing from this pool, so deleting it is never a surprise. */
  readonly sectors: ReadonlyArray<{
    readonly id: string;
    readonly title: Prisma.JsonValue;
    readonly enabled: boolean;
  }>;
}

export interface KeyRow {
  readonly id: string;
  /**
   * Masked unless the caller may read secrets. A pool is inventory somebody
   * skimming the panel could redeem before its winner does.
   */
  readonly value: string;
  readonly masked: boolean;
  readonly claimedAt: string | null;
  readonly claimedSpinId: string | null;
  readonly claimedBy: {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    readonly telegramId: string | null;
  } | null;
}

export interface KeyPage {
  readonly items: readonly KeyRow[];
  readonly nextCursor: string | null;
}

export interface LoadKeysResult {
  /** Lines the operator pasted, after blanks were dropped. */
  readonly received: number;
  readonly added: number;
  /** Already in the pool, or repeated within the paste itself. */
  readonly duplicates: number;
}

export const KEY_PAGE_DEFAULT_LIMIT = 50;
export const KEY_PAGE_MAX_LIMIT = 500;
/** One paste. Big enough for a real batch, small enough to stay one statement. */
export const KEY_LOAD_MAX = 5000;
export const KEY_VALUE_MAX_LENGTH = 512;

/**
 * The batches of one-use secrets a KEY sector draws from.
 *
 * ── What this owns and what the draw owns ─────────────────────────────────
 *
 * Loading, counting and retiring keys live here. TAKING one does not: the draw
 * claims a key inside the spin's own transaction, with `FOR UPDATE SKIP
 * LOCKED`, because that is the only place where "hand exactly one key to
 * exactly one person" can be decided atomically with everything else the spin
 * writes. Nothing in this service hands a key out.
 *
 * ── Why the values are masked by default ──────────────────────────────────
 *
 * A pool is inventory, and an unclaimed key is a bearer secret: whoever reads
 * it can redeem it before the person who wins it does. The operator who loaded
 * the batch already has it, so the reader this protects against is the OTHER
 * person with a panel login. Revealing is a separate permission for exactly
 * that reason — and, unlike a payment gateway's stored credential, it is a
 * permission a real operator genuinely needs: a winner writes in to say the
 * key does not work, and somebody has to look.
 */
@Injectable()
export class WheelKeyPoolService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async listPools(): Promise<readonly KeyPoolSummary[]> {
    const pools = await this.prismaService.wheelKeyPool.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        note: true,
        createdAt: true,
        sectors: { select: { id: true, title: true, enabled: true } },
      },
    });
    if (pools.length === 0) return [];

    const ids = pools.map((pool) => pool.id);
    // Two grouped counts rather than a count per pool: the pool list is short
    // and the key table is not, so the round trips are what would cost.
    const [totals, claimed] = await Promise.all([
      this.prismaService.wheelKey.groupBy({
        by: ['poolId'],
        where: { poolId: { in: ids } },
        _count: { _all: true },
      }),
      this.prismaService.wheelKey.groupBy({
        by: ['poolId'],
        where: { poolId: { in: ids }, claimedAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const totalBy = new Map(totals.map((row) => [row.poolId, row._count._all]));
    const claimedBy = new Map(claimed.map((row) => [row.poolId, row._count._all]));

    return pools.map((pool) => {
      const total = totalBy.get(pool.id) ?? 0;
      const taken = claimedBy.get(pool.id) ?? 0;
      return {
        id: pool.id,
        name: pool.name,
        note: pool.note,
        createdAt: pool.createdAt.toISOString(),
        total,
        claimed: taken,
        available: total - taken,
        sectors: pool.sectors,
      };
    });
  }

  public async createPool(input: {
    readonly name: string;
    readonly note: string | null;
    readonly createdBy: string;
  }): Promise<KeyPoolSummary> {
    const pool = await this.prismaService.wheelKeyPool.create({
      data: { name: input.name, note: input.note, createdBy: input.createdBy },
      select: { id: true },
    });
    return this.getPool(pool.id);
  }

  public async updatePool(
    poolId: string,
    input: { readonly name?: string; readonly note?: string | null },
  ): Promise<KeyPoolSummary> {
    await this.assertPoolExists(poolId);
    await this.prismaService.wheelKeyPool.update({
      where: { id: poolId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    return this.getPool(poolId);
  }

  /**
   * Delete a pool, but only when nothing is lost by it.
   *
   * A claimed key is the record of who got what, and the keys cascade with the
   * pool — so a pool anybody has ever won from is refused rather than quietly
   * erasing that. An enabled sector pointing at it is refused too: the foreign
   * key would null the reference and the sector would go on being drawn with
   * nothing behind it, which the draw then has to exclude as UNCONFIGURED. Far
   * better to make the operator unhook it deliberately.
   */
  public async deletePool(poolId: string): Promise<void> {
    const pool = await this.prismaService.wheelKeyPool.findUnique({
      where: { id: poolId },
      select: {
        id: true,
        sectors: { where: { enabled: true }, select: { id: true } },
        // A contest prize points at a pool too, and its foreign key nulls on
        // delete — so without this the pool goes, the keys cascade away, and
        // a contest that has not been drawn yet quietly becomes unpayable.
        contestPrizes: {
          where: { contest: { status: { in: [ContestStatus.DRAFT, ContestStatus.ACTIVE] } } },
          select: { id: true },
        },
        _count: { select: { keys: true } },
      },
    });
    if (pool === null) throw new NotFoundException('Key pool not found');

    if (pool.sectors.length > 0) {
      throw new ConflictException('Пул используется включённым сектором колеса');
    }
    if (pool.contestPrizes.length > 0) {
      throw new ConflictException('Пул разыгрывается в конкурсе — его нельзя удалить');
    }
    const claimed = await this.prismaService.wheelKey.count({
      where: { poolId, claimedAt: { not: null } },
    });
    if (claimed > 0) {
      throw new ConflictException('Из пула уже выдавались ключи — его нельзя удалить');
    }

    await this.prismaService.wheelKeyPool.delete({ where: { id: poolId } });
  }

  /**
   * Load a pasted batch.
   *
   * Duplicates are skipped rather than refused, because the realistic mistake
   * is pasting a list that overlaps one loaded last week — and refusing the
   * whole batch for that would make the operator diff two files by hand. What
   * is reported back is the count, so a paste of 200 that adds 3 is visibly
   * not what they expected.
   */
  public async loadKeys(poolId: string, values: readonly string[]): Promise<LoadKeysResult> {
    await this.assertPoolExists(poolId);

    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
      // Trimmed but never case-folded: a key is case-sensitive, and "helpfully"
      // upper-casing one turns a whole batch into rubbish nobody can redeem.
      const value = raw.trim();
      if (value === '') continue;
      if (value.length > KEY_VALUE_MAX_LENGTH) {
        throw new BadRequestException(`Ключ длиннее ${KEY_VALUE_MAX_LENGTH} символов`);
      }
      if (seen.has(value)) continue;
      seen.add(value);
      cleaned.push(value);
    }
    if (cleaned.length === 0) throw new BadRequestException('Не из чего загружать ключи');
    if (cleaned.length > KEY_LOAD_MAX) {
      throw new BadRequestException(`За раз можно загрузить не больше ${KEY_LOAD_MAX} ключей`);
    }

    // `skipDuplicates` leans on the (pool_id, value) unique index, so a key
    // already in the pool is stepped over by PostgreSQL rather than by a read
    // this code would have to do first and could still lose a race to.
    const written = await this.prismaService.wheelKey.createMany({
      data: cleaned.map((value) => ({ poolId, value })),
      skipDuplicates: true,
    });

    const received = values.filter((raw) => raw.trim() !== '').length;
    return { received, added: written.count, duplicates: received - written.count };
  }

  public async listKeys(input: {
    readonly poolId: string;
    readonly claimed?: boolean | null;
    readonly cursor?: string | null;
    readonly limit?: number | null;
    /** Whether the caller holds `wheel:view_secrets`. */
    readonly reveal: boolean;
  }): Promise<KeyPage> {
    await this.assertPoolExists(input.poolId);
    const limit = clampLimit(input.limit);

    const rows = await this.prismaService.wheelKey.findMany({
      where: {
        poolId: input.poolId,
        ...(input.claimed == null ? {} : input.claimed ? { claimedAt: { not: null } } : { claimedAt: null }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        value: true,
        claimedAt: true,
        claimedSpinId: true,
        claimedByUser: { select: { id: true, name: true, username: true, telegramId: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => ({
        id: row.id,
        value: input.reveal ? row.value : maskKey(row.value),
        masked: !input.reveal,
        claimedAt: row.claimedAt?.toISOString() ?? null,
        claimedSpinId: row.claimedSpinId,
        claimedBy:
          row.claimedByUser === null
            ? null
            : {
                id: row.claimedByUser.id,
                name: row.claimedByUser.name,
                username: row.claimedByUser.username,
                telegramId: row.claimedByUser.telegramId?.toString() ?? null,
              },
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Retire one key that has not gone out yet — a typo in a paste, a batch the
   * supplier revoked.
   *
   * A CLAIMED key is never removed: it is the record of what somebody was
   * given, and the person may still be holding it.
   */
  public async deleteKey(poolId: string, keyId: string): Promise<void> {
    // `claimedAt: null` rides in the WHERE, so a key claimed a millisecond ago
    // by a spin in flight is not deleted out from under its winner.
    const removed = await this.prismaService.wheelKey.deleteMany({
      where: { id: keyId, poolId, claimedAt: null },
    });
    if (removed.count === 1) return;

    const exists = await this.prismaService.wheelKey.findFirst({
      where: { id: keyId, poolId },
      select: { claimedAt: true },
    });
    if (exists === null) throw new NotFoundException('Key not found in this pool');
    throw new ConflictException('Ключ уже выдан — его нельзя удалить');
  }

  public async getPool(poolId: string): Promise<KeyPoolSummary> {
    const pools = await this.listPools();
    const pool = pools.find((candidate) => candidate.id === poolId);
    if (pool === undefined) throw new NotFoundException('Key pool not found');
    return pool;
  }

  private async assertPoolExists(poolId: string): Promise<void> {
    const pool = await this.prismaService.wheelKeyPool.findUnique({
      where: { id: poolId },
      select: { id: true },
    });
    if (pool === null) throw new NotFoundException('Key pool not found');
  }
}

/**
 * Enough to recognise a key, not enough to redeem it.
 *
 * The last four characters are what an operator matches against a supplier's
 * invoice or a screenshot from a winner; everything before them is hidden. A
 * key too short to hide is hidden entirely rather than mostly.
 */
export function maskKey(value: string): string {
  if (value.length <= 8) return '•'.repeat(Math.max(value.length, 4));
  return `${'•'.repeat(6)}${value.slice(-4)}`;
}

function clampLimit(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return KEY_PAGE_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), KEY_PAGE_MAX_LIMIT);
}
