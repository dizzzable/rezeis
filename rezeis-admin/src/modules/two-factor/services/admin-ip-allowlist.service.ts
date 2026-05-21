import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  ipMatchesEntry,
  parseAddressOrCidr,
  ParsedAddress,
} from '../../blocked-ips/utils/cidr-match';

const CACHE_TTL_MS = 30_000;

interface CachedEntry {
  readonly id: string;
  readonly address: string;
  readonly parsed: ParsedAddress;
}

export interface AdminIpAllowlistEntryInterface {
  readonly id: string;
  readonly address: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly createdById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Admin IP allowlist — restricts the entire `/api/admin/*` surface to a
 * curated list of IPs/CIDRs.
 *
 * Activation rule
 *   - Empty list   --> the allowlist is OFF; all source IPs accepted.
 *   - Non-empty    --> only requests whose IP matches at least one
 *                      ACTIVE entry are allowed; everything else returns
 *                      `403`.
 *
 * This is the sibling of `BlockedIpService` (Phase 4): both rely on the
 * same CIDR matcher, but allowlist is opt-in and applies only to admin
 * routes. End-user (`/api/internal/*`, `/api/public/*`) traffic is never
 * subject to it.
 *
 * Cache
 *   The active entries are cached in memory for 30 s to keep the guard
 *   off the hot path of every request.
 */
@Injectable()
export class AdminIpAllowlistService {
  private readonly logger = new Logger(AdminIpAllowlistService.name);

  private cache: { entries: readonly CachedEntry[]; loadedAt: number } | null = null;

  public constructor(private readonly prismaService: PrismaService) {}

  public async list(): Promise<readonly AdminIpAllowlistEntryInterface[]> {
    const rows = await this.prismaService.adminIpAllowlist.findMany({
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map(toDto);
  }

  public async create(input: {
    readonly address: string;
    readonly label: string;
    readonly isActive: boolean;
    readonly createdById: string | null;
  }): Promise<AdminIpAllowlistEntryInterface> {
    const parsed = parseAddressOrCidr(input.address);
    if (!parsed) throw new BadRequestException('Invalid address or CIDR');
    try {
      const created = await this.prismaService.adminIpAllowlist.create({
        data: {
          address: input.address.trim(),
          label: input.label,
          isActive: input.isActive,
          createdById: input.createdById,
        },
      });
      this.invalidateCache();
      return toDto(created);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('Address already in the allowlist');
      }
      throw err;
    }
  }

  public async update(
    id: string,
    input: {
      readonly label?: string;
      readonly isActive?: boolean;
    },
  ): Promise<AdminIpAllowlistEntryInterface> {
    try {
      const updated = await this.prismaService.adminIpAllowlist.update({
        where: { id },
        data: {
          label: input.label,
          isActive: input.isActive,
        },
      });
      this.invalidateCache();
      return toDto(updated);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Allowlist entry not found');
      }
      throw err;
    }
  }

  public async delete(id: string): Promise<void> {
    try {
      await this.prismaService.adminIpAllowlist.delete({ where: { id } });
      this.invalidateCache();
    } catch (err) {
      if ((err as { code?: string }).code === 'P2025') {
        throw new NotFoundException('Allowlist entry not found');
      }
      throw err;
    }
  }

  /**
   * Returns `true` when the request should pass.
   *  - Empty (or all-disabled) allowlist --> always passes.
   *  - Non-empty                          --> passes only on a CIDR match.
   */
  public async isRequestAllowed(ipAddress: string): Promise<boolean> {
    const trimmed = ipAddress.trim();
    if (trimmed.length === 0) return false;
    const entries = await this.getActiveEntries();
    if (entries.length === 0) return true;
    for (const entry of entries) {
      if (ipMatchesEntry(trimmed, entry.parsed)) {
        return true;
      }
    }
    return false;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async getActiveEntries(): Promise<readonly CachedEntry[]> {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.loadedAt < CACHE_TTL_MS) {
      return this.cache.entries;
    }
    const rows = await this.prismaService.adminIpAllowlist.findMany({
      where: { isActive: true },
      select: { id: true, address: true },
    });
    const entries: CachedEntry[] = [];
    for (const row of rows) {
      const parsed = parseAddressOrCidr(row.address);
      if (parsed) {
        entries.push({ id: row.id, address: row.address, parsed });
      } else {
        this.logger.warn(`Allowlist entry ${row.id} has malformed address ${row.address}`);
      }
    }
    this.cache = { entries, loadedAt: now };
    return entries;
  }

  private invalidateCache(): void {
    this.cache = null;
  }
}

function toDto(row: {
  id: string;
  address: string;
  label: string;
  isActive: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AdminIpAllowlistEntryInterface {
  return {
    id: row.id,
    address: row.address,
    label: row.label,
    isActive: row.isActive,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
