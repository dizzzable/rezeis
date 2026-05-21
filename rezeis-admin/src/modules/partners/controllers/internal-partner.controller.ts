import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PartnersService } from '../services/partners.service';

/**
 * Internal partner endpoints consumed by reiwa (user-facing edge).
 *
 * All endpoints require the internal API token (InternalAdminAuthGuard).
 * The `:telegramId` param identifies the user by their Telegram ID.
 */
@Controller('internal/user/:telegramId/partner')
@UseGuards(InternalAdminAuthGuard)
export class InternalPartnerController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly partnersService: PartnersService,
  ) {}

  /**
   * Returns the partner info for the user (balance, earnings, status).
   * Returns null if the user is not a partner.
   */
  @Get('info')
  public async getInfo(@Param('telegramId') telegramId: string) {
    const user = await this.resolveUser(telegramId);
    if (!user) return null;

    const partner = await this.prismaService.partner.findUnique({
      where: { userId: user.id },
    });
    if (!partner) return null;

    return {
      id: partner.id,
      isActive: partner.isActive,
      balance: partner.balance,
      totalEarned: partner.totalEarned,
      totalWithdrawn: partner.totalWithdrawn,
      createdAt: partner.createdAt.toISOString(),
    };
  }

  /**
   * Returns the partner's earnings history.
   */
  @Get('earnings')
  public async getEarnings(@Param('telegramId') telegramId: string) {
    const user = await this.resolveUser(telegramId);
    if (!user) return { earnings: [] };

    const partner = await this.prismaService.partner.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!partner) return { earnings: [] };

    const transactions = await this.prismaService.partnerTransaction.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      earnings: transactions.map((t) => ({
        id: t.id,
        level: t.level,
        paymentAmount: t.paymentAmount,
        percent: Number(t.percent),
        earnedAmount: t.earnedAmount,
        description: t.description,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Returns the partner's withdrawal history.
   */
  @Get('withdrawals')
  public async getWithdrawals(@Param('telegramId') telegramId: string) {
    const user = await this.resolveUser(telegramId);
    if (!user) return { withdrawals: [] };

    const partner = await this.prismaService.partner.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!partner) return { withdrawals: [] };

    const withdrawals = await this.prismaService.partnerWithdrawal.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        amount: w.amount,
        status: w.status,
        method: w.method,
        requisites: w.requisites,
        adminComment: w.adminComment,
        processedAt: w.processedAt?.toISOString() ?? null,
        createdAt: w.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Creates a withdrawal request. Deducts the amount from the partner's
   * balance immediately (altshop pattern). If the admin later rejects it,
   * the balance is restored.
   */
  @Post('withdraw')
  public async withdraw(
    @Param('telegramId') telegramId: string,
    @Body() body: { amount: number; method: string; requisites: string },
  ) {
    const user = await this.resolveUser(telegramId);
    if (!user) {
      return { error: 'User not found' };
    }

    const partner = await this.prismaService.partner.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!partner) {
      return { error: 'Partner not found' };
    }

    const withdrawal = await this.partnersService.createWithdrawalRequest({
      partnerId: partner.id,
      amount: body.amount,
      method: body.method ?? '',
      requisites: body.requisites ?? '',
    });

    return withdrawal;
  }

  private async resolveUser(telegramId: string) {
    return this.prismaService.user.findFirst({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true },
    });
  }
}
