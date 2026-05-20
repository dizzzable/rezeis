import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { BlockedIp } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import {
  ipMatchesEntry,
  parseAddressOrCidr,
  ParsedAddress,
} from '../utils/cidr-match';

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly entries: readonly ParsedAddress[];
  readonly expiresAt: number;
}

/**
 * Source of truth for the IP blocklist.
 *
 * Reads
 *   `isBlocked(ip)` is hot path (called by the request guard). We cache the
 *   active entries for 30 seconds in-process; that's a reasonable balance
 *   between block latency (max 30 s) and DB load. The cache is invalidated
 *   on every write below.
 *
 * Writes
 *   CRUD endpoints accept either a plain IPv4/IPv6 address or a CIDR range
 *   (`1.2.3.0/24`, `2001:db8::/32`). The address is canonicalised on save
 *   so "192.168.001.1" and "192.168.1.1" don't collide.
 */
@Injectable()
export class BlockedIpService implements OnModuleInit {
  private readonly logger = new Logger(BlockedIpService.name);
  private cache: CacheEntry | null = null;

  public constructor(private readonly prismaService: PrismaService) {}

  public async onModuleInit(): Promise<void> {
    // Warm the cache on boot so the first guarded request doesn't pay
    // the DB round-trip latency.
    try {
      await this.refreshCache();
    } catch (err) {
      this.logger.warn(`Initial blocked-IP cache load failed: ${(err as Error).message}`);
    }
  }

  // ── Read API ───────────────────────────────────────────────────────────

  /**
   * Returns `true` when the given IP is blocked. Used by `BlockedIpGuard`
   * and by the `block_ip` automation action to deduplicate.
   */
  public async isBlocked(ip: string): Promise<{ blocked: boolean; entry?: ParsedAddress }> {
    const trimmed = ip.trim();
    if (trimmed.length === 0) return { blocked: false };
    const entries = await this.getActiveEntries();
    for (const entry of entries) {
      if (ipMatchesEntry(trimmed, entry)) {
        return { blocked: true, entry };
      }
    }
    return { blocked: false };
  }

  public async list(input: { readonly limit?: number; readonly offset?: number }): Promise<{
    readonly items: readonly BlockedIpDto[];
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const [rows, total] = await Promise.all([
      this.prismaService.blockedIp.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.blockedIp.count(),
    ]);
    return {
      items: rows.map(toDto),
      total,
      limit,
      offset,
    };
  }

  // ── Write API ──────────────────────────────────────────────────────────

  public async create(input: {
    readonly address: string;
    readonly reason: string | null;
    readonly source: string;
    readonly createdById: string | null;
    readonly expiresAt: Date | null;
  }): Promise<BlockedIpDto> {
    const parsed = parseAddressOrCidr(input.address);
    if (!parsed) throw new BadRequestException('Invalid address or CIDR');
    try {
      const created = await this.prismaService.blockedIp.create({
        data: {
          address: parsed.canonical,
          reason: input.reason,
          source: input.source,
          createdById: input.createdById,
          expiresAt: input.expiresAt,
        },
      });
      this.invalidateCache();
      return toDto(created);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new BadRequestException('Address is already on the blocklist');
      }
      throw err;
    }
  }

  public async update(
    id: string,
    input: {
      readonly reason?: string | null;
      readonly expiresAt?: Date | null;
    },
  ): Promise<BlockedIpDto> {
    try {
      const updated = await this.prismaService.blockedIp.update({
        where: { id },
        data: {
          reason: input.reason !== undefined ? input.reason : undefined,
          expiresAt: input.expiresAt !== undefined ? input.expiresAt : undefined,
        },
      });
      this.invalidateCache();
      return toDto(updated);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Blocked IP not found');
      }
      throw err;
    }
  }

  public async delete(id: string): Promise<void> {
    try {
      await this.prismaService.blockedIp.delete({ where: { id } });
      this.invalidateCache();
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Blocked IP not found');
      }
      throw err;
    }
  }

  // ── Maintenance ────────────────────────────────────────────────────────

  /**
   * Drop expired rows so they stop counting against unique-address
   * lookups. Runs daily so the table stays small.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  public async pruneExpired(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      const result = await this.prismaService.blockedIp.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        this.logger.log(`Pruned ${result.count} expired blocked IP(s)`);
        this.invalidateCache();
      }
    } catch (err) {
      this.logger.warn(`Blocked IP prune failed: ${(err as Error).message}`);
    }
  }

  // ── Cache ──────────────────────────────────────────────────────────────

  private async getActiveEntries(): Promise<readonly ParsedAddress[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.entries;
    }
    return this.refreshCache();
  }

  private async refreshCache(): Promise<readonly ParsedAddress[]> {
    const rows = await this.prismaService.blockedIp.findMany({
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { address: true },
    });
    const entries = rows
      .map((row) => parseAddressOrCidr(row.address))
      .filter((entry): entry is ParsedAddress => entry !== null);
    this.cache = {
      entries,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return entries;
  }

  private invalidateCache(): void {
    this.cache = null;
  }
}

export interface BlockedIpDto {
  readonly id: string;
  readonly address: string;
  readonly reason: string | null;
  readonly source: string;
  readonly createdById: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toDto(row: BlockedIp): BlockedIpDto {
  return {
    id: row.id,
    address: row.address,
    reason: row.reason,
    source: row.source,
    createdById: row.createdById,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
