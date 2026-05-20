import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { QuickSearchHitInterface } from '../interfaces/quick-search-result.interface';

const DEFAULT_LIMIT = 12;
/** Per-domain hit cap so a single domain cannot dominate the overlay. */
const PER_DOMAIN_CAP = 5;

/**
 * Aggregates results across users / subscriptions / transactions / promocodes
 * / partners for the admin Cmd+K overlay.
 *
 * The service runs five small, capped queries in parallel and merges them.
 * No raw payload values, provider tokens or webhook payloads ever leak into
 * the response — only the labels needed to render a row.
 */
@Injectable()
export class QuickSearchService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async search(rawQuery: string, limit?: number): Promise<QuickSearchHitInterface[]> {
    const query = rawQuery.trim();
    if (query.length < 2) return [];
    const cap = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, 25));

    const [users, subscriptions, transactions, promocodes, partners] = await Promise.all([
      this.searchUsers(query),
      this.searchSubscriptions(query),
      this.searchTransactions(query),
      this.searchPromocodes(query),
      this.searchPartners(query),
    ]);

    const merged: QuickSearchHitInterface[] = [
      ...users,
      ...subscriptions,
      ...transactions,
      ...promocodes,
      ...partners,
    ];
    return merged.slice(0, cap);
  }

  private async searchUsers(query: string): Promise<QuickSearchHitInterface[]> {
    // Numeric-looking inputs match telegramId in addition to username/email.
    // We cast via String() rather than Number() because telegramId is BigInt.
    const tgIdMatch: Prisma.UserWhereInput | null = /^\d+$/.test(query)
      ? { telegramId: BigInt(query) }
      : null;
    const where: Prisma.UserWhereInput = {
      OR: [
        { username: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
        { referralCode: { contains: query, mode: 'insensitive' } },
        ...(tgIdMatch ? [tgIdMatch] : []),
      ],
    };
    const rows = await this.prismaService.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        telegramId: true,
      },
      take: PER_DOMAIN_CAP,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((u) => ({
      type: 'user' as const,
      id: u.id,
      label: u.name && u.name.length > 0
        ? u.name
        : u.username ?? u.email ?? (u.telegramId !== null ? `tg:${u.telegramId.toString()}` : u.id),
      subtitle: u.email ?? u.username ?? (u.telegramId !== null ? u.telegramId.toString() : undefined),
    }));
  }

  private async searchSubscriptions(query: string): Promise<QuickSearchHitInterface[]> {
    const where: Prisma.SubscriptionWhereInput = {
      OR: [
        { id: { contains: query, mode: 'insensitive' } },
        { remnawaveId: { contains: query, mode: 'insensitive' } },
      ],
    };
    const rows = await this.prismaService.subscription.findMany({
      where,
      select: {
        id: true,
        status: true,
        planSnapshot: true,
        userId: true,
      },
      take: PER_DOMAIN_CAP,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => ({
      type: 'subscription' as const,
      id: s.id,
      label: extractPlanName(s.planSnapshot) ?? `Subscription ${s.id.slice(0, 8)}`,
      subtitle: `${s.status} · user ${s.userId.slice(0, 8)}`,
    }));
  }

  private async searchTransactions(query: string): Promise<QuickSearchHitInterface[]> {
    const where: Prisma.TransactionWhereInput = {
      OR: [
        { id: { contains: query, mode: 'insensitive' } },
        { paymentId: { contains: query, mode: 'insensitive' } },
        { gatewayId: { contains: query, mode: 'insensitive' } },
      ],
    };
    const rows = await this.prismaService.transaction.findMany({
      where,
      select: {
        id: true,
        paymentId: true,
        status: true,
        gatewayType: true,
        amount: true,
        currency: true,
      },
      take: PER_DOMAIN_CAP,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((tx) => ({
      type: 'transaction' as const,
      id: tx.paymentId,
      label: `${tx.gatewayType} · ${tx.amount.toString()} ${tx.currency}`,
      subtitle:
        tx.status === TransactionStatus.COMPLETED
          ? `${tx.status} · ${tx.paymentId.slice(0, 12)}`
          : `${tx.status} · pending payment`,
    }));
  }

  private async searchPromocodes(query: string): Promise<QuickSearchHitInterface[]> {
    // Promocodes are model-less in some schemas; fall back gracefully if
    // the table does not exist in this Prisma client build.
    const promocodeDelegate = (this.prismaService as unknown as Record<string, unknown>)['promocode'] as
      | { findMany: (args: unknown) => Promise<unknown[]> }
      | undefined;
    if (!promocodeDelegate) return [];
    try {
      const rows = (await promocodeDelegate.findMany({
        where: {
          OR: [
            { code: { contains: query, mode: 'insensitive' } },
            { id: { contains: query, mode: 'insensitive' } },
          ],
        },
        select: { id: true, code: true, isActive: true, rewardType: true },
        take: PER_DOMAIN_CAP,
        orderBy: { createdAt: 'desc' },
      })) as Array<{
        id: string;
        code: string;
        isActive?: boolean;
        rewardType?: string | null;
      }>;
      return rows.map((p) => ({
        type: 'promocode' as const,
        id: p.id,
        label: p.code,
        subtitle: p.rewardType
          ? `${p.rewardType}${p.isActive === false ? ' · disabled' : ''}`
          : p.isActive === false
            ? 'disabled'
            : undefined,
      }));
    } catch {
      return [];
    }
  }

  private async searchPartners(query: string): Promise<QuickSearchHitInterface[]> {
    const where: Prisma.PartnerWhereInput = {
      OR: [
        { id: { contains: query, mode: 'insensitive' } },
        { userId: { contains: query, mode: 'insensitive' } },
      ],
    };
    const rows = await this.prismaService.partner.findMany({
      where,
      select: { id: true, userId: true, balance: true, isActive: true },
      take: PER_DOMAIN_CAP,
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((p) => ({
      type: 'partner' as const,
      id: p.id,
      label: `Partner ${p.userId.slice(0, 8)}`,
      subtitle: `balance ${(p.balance / 100).toFixed(2)}${p.isActive ? '' : ' · disabled'}`,
    }));
  }
}

function extractPlanName(snapshot: Prisma.JsonValue): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const v = (snapshot as Record<string, unknown>)['name'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
