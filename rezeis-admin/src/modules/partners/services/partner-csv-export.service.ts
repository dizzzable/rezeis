import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';

import { PrismaService } from '../../../common/prisma/prisma.service';

import { AdminPartnerAnalyticsService } from './admin-partner-analytics.service';
import { PartnerDetailService } from './partner-detail.service';
import { PartnersService } from './partners.service';

/**
 * Render-only service that turns existing analytics/list payloads into
 * CSV strings. Kept separate so the data-shaping logic stays
 * dependency-free and easy to unit-test.
 */
@Injectable()
export class PartnerCsvExportService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly partnersService: PartnersService,
    private readonly analyticsService: AdminPartnerAnalyticsService,
    private readonly partnerDetailService: PartnerDetailService,
  ) {}

  public async exportPartners(): Promise<string> {
    // Bounded — same default cap the SPA list uses; CSVs over 500 rows
    // should be paginated through the API instead.
    const partners = await this.partnersService.listPartners({ limit: 500 });
    const header = [
      'partner_id',
      'user_id',
      'name',
      'username',
      'telegram_id',
      'is_active',
      'balance_minor',
      'total_earned_minor',
      'total_withdrawn_minor',
      'referrals_count',
      'use_global_settings',
      'reward_type',
      'accrual_strategy',
      'created_at',
    ];
    const rows = partners.map((p) => [
      p.id,
      p.user.id,
      p.user.name ?? '',
      p.user.username ?? '',
      p.user.telegramId ?? '',
      String(p.isActive),
      String(p.balance),
      String(p.totalEarned),
      String(p.totalWithdrawn),
      String(p.referralsCount),
      String(p.useGlobalSettings),
      p.rewardType,
      p.accrualStrategy,
      p.createdAt,
    ]);
    return renderCsv(header, rows);
  }

  /**
   * Stream every partner row as CSV directly from Postgres in pages so
   * the response starts flowing before all rows are buffered. Useful
   * when the directory grows beyond a few thousand rows.
   */
  public streamPartners(): Readable {
    const header = [
      'partner_id',
      'user_id',
      'name',
      'username',
      'telegram_id',
      'is_active',
      'balance_minor',
      'total_earned_minor',
      'total_withdrawn_minor',
      'referrals_count',
      'use_global_settings',
      'reward_type',
      'accrual_strategy',
      'created_at',
    ];

    const prismaService = this.prismaService;
    async function* iterate() {
      yield BOM + headerLine(header);
      const pageSize = 200;
      let cursor: string | null = null;
      while (true) {
        const rows = await prismaService.partner.findMany({
          take: pageSize,
          ...(cursor !== null ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: 'asc' },
          include: {
            user: { select: { id: true, name: true, username: true, telegramId: true } },
            _count: { select: { referrals: true } },
          },
        });
        if (rows.length === 0) break;
        for (const partner of rows) {
          yield csvLine([
            partner.id,
            partner.user?.id ?? '',
            partner.user?.name ?? '',
            partner.user?.username ?? '',
            partner.user?.telegramId?.toString() ?? '',
            String(partner.isActive),
            String(partner.balance),
            String(partner.totalEarned),
            String(partner.totalWithdrawn),
            String(partner._count?.referrals ?? 0),
            String(partner.useGlobalSettings),
            partner.rewardType,
            partner.accrualStrategy,
            partner.createdAt.toISOString(),
          ]);
        }
        cursor = rows[rows.length - 1]?.id ?? null;
        if (cursor === null || rows.length < pageSize) break;
      }
    }

    return Readable.from(iterate());
  }

  /**
   * Stream withdrawals as CSV. Same pattern as `streamPartners` —
   * cursor-paginated through Prisma so memory stays bounded regardless
   * of dataset size.
   */
  public streamWithdrawals(input: { from?: string; to?: string }): Readable {
    const range = resolveRange(input);
    const header = [
      'withdrawal_id',
      'partner_id',
      'user_id',
      'username',
      'telegram_id',
      'amount_minor',
      'status',
      'method',
      'requisites',
      'admin_comment',
      'created_at',
      'processed_at',
    ];

    const prismaService = this.prismaService;
    async function* iterate() {
      yield BOM + headerLine(header);
      const pageSize = 200;
      let cursor: string | null = null;
      while (true) {
        const rows = await prismaService.partnerWithdrawal.findMany({
          where: { createdAt: { gte: range.from, lte: range.to } },
          take: pageSize,
          ...(cursor !== null ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: 'asc' },
          include: {
            partner: {
              select: {
                user: {
                  select: { id: true, name: true, username: true, telegramId: true },
                },
              },
            },
          },
        });
        if (rows.length === 0) break;
        for (const row of rows) {
          yield csvLine([
            row.id,
            row.partnerId,
            row.partner?.user?.id ?? '',
            row.partner?.user?.username ?? '',
            row.partner?.user?.telegramId?.toString() ?? '',
            String(row.amount),
            row.status,
            row.method,
            row.requisites,
            row.adminComment ?? '',
            row.createdAt.toISOString(),
            row.processedAt?.toISOString() ?? '',
          ]);
        }
        cursor = rows[rows.length - 1]?.id ?? null;
        if (cursor === null || rows.length < pageSize) break;
      }
    }

    return Readable.from(iterate());
  }

  /** Stream a single partner's earnings ledger as CSV. */
  public streamEarnings(partnerId: string): Readable {
    const header = [
      'transaction_id',
      'created_at',
      'level',
      'percent',
      'payment_amount_minor',
      'earned_amount_minor',
      'source_transaction_id',
      'referral_user_id',
      'referral_username',
      'description',
    ];

    const prismaService = this.prismaService;
    async function* iterate() {
      yield BOM + headerLine(header);
      const pageSize = 500;
      let cursor: string | null = null;
      while (true) {
        const rows = await prismaService.partnerTransaction.findMany({
          where: { partnerId },
          take: pageSize,
          ...(cursor !== null ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: 'asc' },
          include: {
            referral: { select: { id: true, username: true } },
          },
        });
        if (rows.length === 0) break;
        for (const row of rows) {
          yield csvLine([
            row.id,
            row.createdAt.toISOString(),
            String(row.level),
            row.percent.toString(),
            String(row.paymentAmount),
            String(row.earnedAmount),
            row.sourceTransactionId ?? '',
            row.referral?.id ?? '',
            row.referral?.username ?? '',
            row.description ?? '',
          ]);
        }
        cursor = rows[rows.length - 1]?.id ?? null;
        if (cursor === null || rows.length < pageSize) break;
      }
    }

    return Readable.from(iterate());
  }

  public async exportTopPartners(input: { from?: string; to?: string }): Promise<string> {
    const data = await this.analyticsService.getTopPartners({ ...input, limit: 100 });
    const header = [
      'rank',
      'partner_id',
      'user_id',
      'name',
      'username',
      'telegram_id',
      'earnings_minor',
      'transactions',
      'referrals',
      'balance_minor',
    ];
    const rows = data.items.map((row, idx) => [
      String(idx + 1),
      row.partnerId,
      row.userId,
      row.name ?? '',
      row.username ?? '',
      row.telegramId ?? '',
      String(row.earnings),
      String(row.transactions),
      String(row.referrals),
      String(row.balance),
    ]);
    return renderCsv(header, rows);
  }

  public async exportEarnings(partnerId: string): Promise<string> {
    const data = await this.partnerDetailService.listEarnings(partnerId, { limit: 1000 });
    const header = [
      'transaction_id',
      'created_at',
      'level',
      'percent',
      'payment_amount_minor',
      'earned_amount_minor',
      'source_transaction_id',
      'referral_user_id',
      'referral_username',
      'description',
    ];
    const rows = data.items.map((row) => [
      row.id,
      row.createdAt,
      String(row.level),
      row.percent,
      String(row.paymentAmount),
      String(row.earnedAmount),
      row.sourceTransactionId ?? '',
      row.referralUser?.id ?? '',
      row.referralUser?.username ?? '',
      row.description ?? '',
    ]);
    return renderCsv(header, rows);
  }

  public async exportWithdrawals(input: {
    from?: string;
    to?: string;
  }): Promise<string> {
    const range = resolveRange(input);
    const rows = await this.prismaService.partnerWithdrawal.findMany({
      where: {
        createdAt: { gte: range.from, lte: range.to },
      },
      include: {
        partner: {
          select: {
            user: {
              select: { id: true, name: true, username: true, telegramId: true },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 1000,
    });
    const header = [
      'withdrawal_id',
      'partner_id',
      'user_id',
      'username',
      'telegram_id',
      'amount_minor',
      'status',
      'method',
      'requisites',
      'admin_comment',
      'created_at',
      'processed_at',
    ];
    const csvRows = rows.map((row) => [
      row.id,
      row.partnerId,
      row.partner?.user?.id ?? '',
      row.partner?.user?.username ?? '',
      row.partner?.user?.telegramId?.toString() ?? '',
      String(row.amount),
      row.status,
      row.method,
      row.requisites,
      row.adminComment ?? '',
      row.createdAt.toISOString(),
      row.processedAt?.toISOString() ?? '',
    ]);
    return renderCsv(header, csvRows);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 90;

function resolveRange(input: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = input.to !== undefined ? new Date(input.to) : new Date();
  const from =
    input.from !== undefined
      ? new Date(input.from)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  return { from, to };
}

/**
 * RFC-4180-ish CSV renderer. Quotes any field that contains a comma,
 * a quote, a newline, or starts with one of `=+-@` (Excel formula
 * injection guard).
 */
export function renderCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines: string[] = [];
  lines.push(header.map(quote).join(','));
  for (const row of rows) {
    lines.push(row.map(quote).join(','));
  }
  // Excel-safe: leading BOM so UTF-8 names render correctly.
  return `${BOM}${lines.join('\r\n')}`;
}

const BOM = '\ufeff';

function headerLine(values: readonly string[]): string {
  return `${values.map(quote).join(',')}\r\n`;
}

function csvLine(values: readonly string[]): string {
  return `${values.map(quote).join(',')}\r\n`;
}

function quote(value: string): string {
  let v = value === null || value === undefined ? '' : String(value);
  // Defang Excel formulas — prefix with single quote.
  if (/^[=+\-@]/.test(v)) {
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
