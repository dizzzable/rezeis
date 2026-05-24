import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  PartnerAuditEventInterface,
  PartnerAuditListInterface,
  PartnerDetailOverviewInterface,
  PartnerEarningInterface,
  PartnerEarningsListInterface,
  PartnerReferralInterface,
  PartnerReferralsListInterface,
  PartnerWithdrawalListInterface,
} from '../interfaces/partner-detail.interface';
import { PartnerInterface, PartnerWithdrawalInterface } from '../interfaces/partner.interface';

const PARTNER_USER_SUMMARY_SELECT = {
  id: true,
  name: true,
  username: true,
  telegramId: true,
} as const;

const PARTNER_DETAIL_INCLUDE = {
  user: {
    select: {
      id: true,
      name: true,
      username: true,
      telegramId: true,
      createdAt: true,
    },
  },
  _count: {
    select: { referrals: true },
  },
} as const;

interface DetailPagingQuery {
  readonly limit?: number;
  readonly offset?: number;
}

@Injectable()
export class PartnerDetailService {
  public constructor(private readonly prismaService: PrismaService) {}

  // ── Overview ────────────────────────────────────────────────────────────

  public async getOverview(partnerId: string): Promise<PartnerDetailOverviewInterface> {
    const partner = await this.prismaService.partner.findUnique({
      where: { id: partnerId },
      include: PARTNER_DETAIL_INCLUDE,
    });
    if (partner === null) throw new NotFoundException('Partner not found');

    const now = new Date();
    const window7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const window30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      earnings30d,
      earnings7d,
      transactions30d,
      transactionsAll,
      earningsAllTime,
      referralLevels,
    ] = await Promise.all([
      this.prismaService.partnerTransaction.aggregate({
        where: { partnerId, createdAt: { gte: window30d } },
        _sum: { earnedAmount: true },
      }),
      this.prismaService.partnerTransaction.aggregate({
        where: { partnerId, createdAt: { gte: window7d } },
        _sum: { earnedAmount: true },
      }),
      this.prismaService.partnerTransaction.count({
        where: { partnerId, createdAt: { gte: window30d } },
      }),
      this.prismaService.partnerTransaction.count({ where: { partnerId } }),
      this.prismaService.partnerTransaction.aggregate({
        where: { partnerId },
        _sum: { earnedAmount: true },
      }),
      this.prismaService.partnerReferral.groupBy({
        by: ['level'],
        where: { partnerId },
        _count: { _all: true },
      }),
    ]);

    const byLevel = { l1: 0, l2: 0, l3: 0 };
    for (const row of referralLevels) {
      if (row.level === 1) byLevel.l1 = row._count._all;
      if (row.level === 2) byLevel.l2 = row._count._all;
      if (row.level === 3) byLevel.l3 = row._count._all;
    }

    return {
      partner: mapPartnerDetail(partner),
      earningsLast30d: earnings30d._sum.earnedAmount ?? 0,
      earningsLast7d: earnings7d._sum.earnedAmount ?? 0,
      earningsAllTime: earningsAllTime._sum.earnedAmount ?? 0,
      transactionsLast30d: transactions30d,
      transactionsAllTime: transactionsAll,
      referralsByLevel: byLevel,
    };
  }

  // ── Earnings ────────────────────────────────────────────────────────────

  public async listEarnings(
    partnerId: string,
    query: DetailPagingQuery,
  ): Promise<PartnerEarningsListInterface> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prismaService.partnerTransaction.findMany({
        where: { partnerId },
        include: {
          referral: { select: PARTNER_USER_SUMMARY_SELECT },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.partnerTransaction.count({ where: { partnerId } }),
    ]);
    return {
      items: rows.map(
        (row): PartnerEarningInterface => ({
          id: row.id,
          level: row.level,
          paymentAmount: row.paymentAmount,
          percent: row.percent.toString(),
          earnedAmount: row.earnedAmount,
          sourceTransactionId: row.sourceTransactionId,
          description: row.description,
          createdAt: row.createdAt.toISOString(),
          referralUser: row.referral
            ? {
                id: row.referral.id,
                name: row.referral.name === '' ? null : row.referral.name,
                username: row.referral.username,
                telegramId: row.referral.telegramId?.toString() ?? null,
              }
            : null,
        }),
      ),
      total,
    };
  }

  // ── Referrals ───────────────────────────────────────────────────────────

  public async listReferrals(
    partnerId: string,
    query: DetailPagingQuery,
  ): Promise<PartnerReferralsListInterface> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prismaService.partnerReferral.findMany({
        where: { partnerId },
        include: {
          referral: { select: PARTNER_USER_SUMMARY_SELECT },
        },
        orderBy: [{ level: 'asc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.partnerReferral.count({ where: { partnerId } }),
    ]);
    return {
      items: rows.map(
        (row): PartnerReferralInterface => ({
          id: row.id,
          level: row.level,
          parentPartnerId: row.parentPartnerId,
          createdAt: row.createdAt.toISOString(),
          user: row.referral
            ? {
                id: row.referral.id,
                name: row.referral.name === '' ? null : row.referral.name,
                username: row.referral.username,
                telegramId: row.referral.telegramId?.toString() ?? null,
              }
            : null,
        }),
      ),
      total,
    };
  }

  // ── Withdrawals ─────────────────────────────────────────────────────────

  public async listWithdrawals(
    partnerId: string,
    query: DetailPagingQuery,
  ): Promise<PartnerWithdrawalListInterface> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prismaService.partnerWithdrawal.findMany({
        where: { partnerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.partnerWithdrawal.count({ where: { partnerId } }),
    ]);
    return {
      items: rows.map(
        (row): PartnerWithdrawalInterface => ({
          id: row.id,
          partnerId: row.partnerId,
          amount: row.amount,
          status: row.status,
          method: row.method,
          requisites: row.requisites,
          adminComment: row.adminComment,
          processedBy: row.processedBy,
          processedAt: row.processedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          partner: null,
        }),
      ),
      total,
    };
  }

  // ── Audit log ───────────────────────────────────────────────────────────

  /**
   * Returns admin audit-log rows whose `metadata.partnerId` matches the
   * given partner. Filtering is done in JS over a bounded slice — Prisma's
   * JSON path operators differ across versions and we don't need fully
   * indexed querying for the audit drawer.
   */
  public async listAuditEvents(
    partnerId: string,
    query: DetailPagingQuery,
  ): Promise<PartnerAuditListInterface> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const recentLogs = await this.prismaService.adminAuditLog.findMany({
      where: {
        OR: [
          { metadata: { path: ['partnerId'], equals: partnerId } },
          { action: { startsWith: 'partner.' } },
        ],
      },
      include: {
        adminUser: { select: { id: true, login: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit + offset + 50, // small over-fetch — JS filter below
    });

    const filtered: PartnerAuditEventInterface[] = [];
    for (const log of recentLogs) {
      const metadata =
        typeof log.metadata === 'object' && log.metadata !== null && !Array.isArray(log.metadata)
          ? (log.metadata as Record<string, unknown>)
          : {};
      const matchesPartner =
        metadata.partnerId === partnerId || extractPartnerId(metadata) === partnerId;
      if (!matchesPartner) continue;
      filtered.push({
        id: log.id,
        action: log.action,
        adminUserId: log.adminUser?.id ?? null,
        adminUsername: log.adminUser?.login ?? null,
        metadata,
        createdAt: log.createdAt.toISOString(),
      });
    }
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }
}

function mapPartnerDetail(
  record: Prisma.PartnerGetPayload<{ include: typeof PARTNER_DETAIL_INCLUDE }>,
): PartnerInterface {
  return {
    id: record.id,
    user: {
      id: record.user.id,
      login: null,
      username: record.user.username,
      name: record.user.name === '' ? null : record.user.name,
      telegramId: record.user.telegramId?.toString() ?? null,
      createdAt: record.user.createdAt.toISOString(),
    },
    balance: record.balance,
    totalEarned: record.totalEarned,
    totalWithdrawn: record.totalWithdrawn,
    isActive: record.isActive,
    referralsCount: record._count.referrals,
    useGlobalSettings: record.useGlobalSettings,
    accrualStrategy: record.accrualStrategy,
    rewardType: record.rewardType,
    level1Percent: record.level1Percent?.toString() ?? null,
    level2Percent: record.level2Percent?.toString() ?? null,
    level3Percent: record.level3Percent?.toString() ?? null,
    level1FixedAmount: record.level1FixedAmount,
    level2FixedAmount: record.level2FixedAmount,
    level3FixedAmount: record.level3FixedAmount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function extractPartnerId(metadata: Record<string, unknown>): string | null {
  const candidate = metadata.partnerId;
  return typeof candidate === 'string' ? candidate : null;
}
