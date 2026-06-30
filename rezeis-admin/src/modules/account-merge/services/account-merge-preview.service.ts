import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AccountMergeConflict,
  AccountMergePreview,
  AccountSummary,
} from '../interfaces/account-merge.interface';

const TELEGRAM_ID_RE = /^\d{1,19}$/;
const REIWA_ID_RE = /^c[a-z0-9]{20,}$/i;

/**
 * Resolves a counterpart account from any identifier and builds the
 * side-by-side merge preview. Resolution prefers the unambiguous shapes
 * (telegramId digits, email with `@`, reiwa_id CUID) and falls back to a
 * web-account login.
 */
@Injectable()
export class AccountMergePreviewService {
  public constructor(private readonly prismaService: PrismaService) {}

  /** Resolve a raw reference to a `User.id`, or throw a typed error. */
  public async resolveUserId(ref: string): Promise<string> {
    const value = ref.trim();
    if (value.length === 0) {
      throw new BadRequestException('A reference is required');
    }

    if (TELEGRAM_ID_RE.test(value)) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(value) },
        select: { id: true },
      });
      if (user === null) throw new NotFoundException('No account with that Telegram id');
      return user.id;
    }

    if (value.includes('@')) {
      const normalized = value.toLowerCase();
      const byUser = await this.prismaService.user.findUnique({
        where: { email: normalized },
        select: { id: true },
      });
      if (byUser !== null) return byUser.id;
      const byWeb = await this.prismaService.webAccount.findUnique({
        where: { emailNormalized: normalized },
        select: { userId: true },
      });
      if (byWeb === null) throw new NotFoundException('No account with that email');
      return byWeb.userId;
    }

    if (REIWA_ID_RE.test(value)) {
      const byId = await this.prismaService.user.findUnique({
        where: { id: value },
        select: { id: true },
      });
      if (byId !== null) return byId.id;
      // fall through to login (a login could theoretically be CUID-shaped)
    }

    const byLogin = await this.prismaService.webAccount.findUnique({
      where: { loginNormalized: value.toLowerCase() },
      select: { userId: true },
    });
    if (byLogin === null) throw new NotFoundException('No account matches that reference');
    return byLogin.userId;
  }

  public async preview(currentUserId: string, ref: string): Promise<AccountMergePreview> {
    const counterpartId = await this.resolveUserId(ref);
    if (counterpartId === currentUserId) {
      throw new BadRequestException('The reference resolves to the same account');
    }
    const [current, counterpart] = await Promise.all([
      this.buildSummary(currentUserId),
      this.buildSummary(counterpartId),
    ]);
    return {
      current,
      counterpart,
      conflicts: this.detectConflicts(current, counterpart),
    };
  }

  public async buildSummary(userId: string): Promise<AccountSummary> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        telegramId: true,
        email: true,
        name: true,
        isBlocked: true,
        createdAt: true,
        webAccount: { select: { login: true } },
        partner: { select: { balance: true } },
        trialGrant: { select: { userId: true } },
      },
    });
    if (user === null) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    const [total, active, trial, transactionsCount] = await Promise.all([
      this.prismaService.subscription.count({ where: { userId } }),
      this.prismaService.subscription.count({ where: { userId, status: 'ACTIVE' } }),
      this.prismaService.subscription.count({ where: { userId, isTrial: true } }),
      this.prismaService.transaction.count({ where: { userId } }),
    ]);
    return {
      userId: user.id,
      login: user.webAccount?.login ?? null,
      telegramId: user.telegramId?.toString() ?? null,
      email: user.email,
      name: user.name,
      isBlocked: user.isBlocked,
      hasWebAccount: user.webAccount !== null,
      hasTrialGrant: user.trialGrant !== null,
      subscriptions: { total, active, trial },
      transactionsCount,
      partner: {
        isPartner: user.partner !== null,
        balanceMinor: user.partner?.balance ?? 0,
      },
      createdAt: user.createdAt.toISOString(),
    };
  }

  private detectConflicts(a: AccountSummary, b: AccountSummary): AccountMergeConflict[] {
    const conflicts: AccountMergeConflict[] = [];
    if (a.hasWebAccount && b.hasWebAccount) conflicts.push('login');
    if (a.telegramId !== null && b.telegramId !== null) conflicts.push('telegram');
    if (a.email !== null && b.email !== null) conflicts.push('email');
    if (a.partner.isPartner && b.partner.isPartner) conflicts.push('partner');
    if (a.hasTrialGrant && b.hasTrialGrant) conflicts.push('trial');
    return conflicts;
  }
}
