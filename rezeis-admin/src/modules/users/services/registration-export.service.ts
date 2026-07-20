import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  clampExportLimit,
  parseStrictIsoDate,
  renderRegistrationCsv,
  type RegistrationExportRow,
} from '../utils/registration-export.util';

export interface RegistrationExportQuery {
  readonly limit?: number;
  /** Inclusive lower bound on User.createdAt (ISO date/datetime). */
  readonly from?: string;
  /** Inclusive upper bound on User.createdAt (ISO date/datetime). */
  readonly to?: string;
}

@Injectable()
export class RegistrationExportService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Returns a CSV dump of registration snapshot fields (raw PII).
   * Caller MUST enforce `users:export_registration` and write an audit log.
   */
  public async exportCsv(query: RegistrationExportQuery = {}): Promise<{
    csv: string;
    rowCount: number;
    limit: number;
    from: string | null;
    to: string | null;
  }> {
    const limit = clampExportLimit(query.limit);
    const { where, from, to } = this.buildWhere(query);
    const rows = await this.prismaService.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        telegramId: true,
        username: true,
        createdAt: true,
        registrationIp: true,
        registrationUserAgent: true,
        registrationReferer: true,
        registrationUtm: true,
        registrationChannel: true,
        acquisitionPlacementId: true,
        acquisitionAt: true,
      },
    });
    const mapped: RegistrationExportRow[] = rows.map((r) => ({
      id: r.id,
      telegramId: r.telegramId,
      username: r.username,
      createdAt: r.createdAt,
      registrationIp: r.registrationIp,
      registrationUserAgent: r.registrationUserAgent,
      registrationReferer: r.registrationReferer,
      registrationUtm: r.registrationUtm,
      registrationChannel: r.registrationChannel,
      acquisitionPlacementId: r.acquisitionPlacementId,
      acquisitionAt: r.acquisitionAt,
    }));
    return {
      csv: renderRegistrationCsv(mapped),
      rowCount: mapped.length,
      limit,
      from,
      to,
    };
  }

  private buildWhere(query: RegistrationExportQuery): {
    where: Prisma.UserWhereInput;
    from: string | null;
    to: string | null;
  } {
    const createdAt: Prisma.DateTimeFilter = {};
    let fromIso: string | null = null;
    let toIso: string | null = null;

    if (query.from != null && query.from.trim() !== '') {
      const from = parseStrictIsoDate(query.from);
      if (from === null) {
        throw new BadRequestException('Invalid "from" date');
      }
      createdAt.gte = from;
      fromIso = from.toISOString();
    }
    if (query.to != null && query.to.trim() !== '') {
      const to = parseStrictIsoDate(query.to);
      if (to === null) {
        throw new BadRequestException('Invalid "to" date');
      }
      createdAt.lte = to;
      toIso = to.toISOString();
    }
    if (fromIso && toIso && new Date(fromIso).getTime() > new Date(toIso).getTime()) {
      throw new BadRequestException('"from" must be earlier than or equal to "to"');
    }

    // Prefer rows that actually have registration snapshot or acquisition.
    // Channel-only snapshots (bot/tma markers) are included so operators can
    // export first-touch gaps without IP/UA.
    const filters: Prisma.UserWhereInput[] = [
      { registrationIp: { not: null } },
      { registrationUserAgent: { not: null } },
      { registrationReferer: { not: null } },
      { registrationUtm: { not: Prisma.DbNull } },
      { registrationChannel: { not: null } },
      { acquisitionPlacementId: { not: null } },
    ];
    const where: Prisma.UserWhereInput = {
      OR: filters,
    };
    if (Object.keys(createdAt).length > 0) {
      where.createdAt = createdAt;
    }
    return { where, from: fromIso, to: toIso };
  }
}