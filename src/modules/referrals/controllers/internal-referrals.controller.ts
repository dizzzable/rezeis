import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ReferralInviteLimitsService } from '../services/referral-invite-limits.service';
import {
  ReferralPointsExchangeService,
  ExchangeOptionsResponse,
  PointsExchangeType,
} from '../services/referral-points-exchange.service';
import { ReferralsService } from '../services/referrals.service';

/**
 * Internal referral endpoints consumed by reiwa (user-facing edge).
 *
 * Provides:
 *   - Invite creation with slot/TTL enforcement
 *   - Points exchange options + execution
 *   - Referral summary for the user dashboard
 */
@Controller('internal/user/:telegramId/referrals')
@UseGuards(InternalAdminAuthGuard)
export class InternalReferralsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly referralsService: ReferralsService,
    private readonly inviteLimitsService: ReferralInviteLimitsService,
    private readonly pointsExchangeService: ReferralPointsExchangeService,
  ) {}

  /**
   * Returns the referral summary for the user (total, qualified, points balance).
   */
  @Get('summary')
  public async getSummary(@Param('telegramId') telegramId: string) {
    const user = await this.resolveUser(telegramId);
    if (!user) return { totalReferrals: 0, qualifiedReferrals: 0, pointsBalance: 0 };

    const [totalReferrals, qualifiedReferrals] = await Promise.all([
      this.prismaService.referral.count({ where: { referrerId: user.id } }),
      this.prismaService.referral.count({ where: { referrerId: user.id, qualifiedAt: { not: null } } }),
    ]);

    return {
      totalReferrals,
      qualifiedReferrals,
      pointsBalance: user.points,
    };
  }

  /**
   * Creates a new referral invite for the user, respecting slot limits.
   */
  @Post('invite')
  public async createInvite(@Param('telegramId') telegramId: string) {
    const user = await this.resolveUser(telegramId);
    if (!user) return { error: 'User not found' };

    // Validate slot capacity
    await this.inviteLimitsService.validateCanCreateInvite(user.id);

    // Resolve expiry from settings
    const expiresAt = await this.inviteLimitsService.resolveInviteExpiry();

    const result = await this.referralsService.createInvite({
      inviterId: user.id,
      expiresAt: expiresAt?.toISOString(),
    });

    return result;
  }

  /**
   * Returns the user's invite capacity (slots used/remaining).
   */
  @Get('invite-capacity')
  public async getInviteCapacity(@Param('telegramId') telegramId: string) {
    const user = await this.resolveUser(telegramId);
    if (!user) return { totalSlots: null, usedSlots: 0, remainingSlots: null, canCreateInvite: true };
    return this.inviteLimitsService.getCapacity(user.id);
  }

  /**
   * Returns the available points exchange options for the user.
   */
  @Get('exchange/options')
  public async getExchangeOptions(@Param('telegramId') telegramId: string): Promise<ExchangeOptionsResponse> {
    const user = await this.resolveUser(telegramId);
    if (!user) return { exchangeEnabled: false, pointsBalance: 0, types: [] };
    return this.pointsExchangeService.getExchangeOptions(user.id);
  }

  /**
   * Executes a points exchange for the user.
   */
  @Post('exchange')
  public async executeExchange(
    @Param('telegramId') telegramId: string,
    @Body() body: { type: PointsExchangeType; points: number; subscriptionId?: string },
  ) {
    const user = await this.resolveUser(telegramId);
    if (!user) return { error: 'User not found' };
    return this.pointsExchangeService.executeExchange({
      userId: user.id,
      type: body.type,
      points: body.points,
      subscriptionId: body.subscriptionId,
    });
  }

  /**
   * Returns the user's referral rewards history.
   */
  @Get('rewards')
  public async getRewards(@Param('telegramId') telegramId: string) {
    const user = await this.resolveUser(telegramId);
    if (!user) return { rewards: [] };

    const rewards = await this.prismaService.referralReward.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      rewards: rewards.map((r) => ({
        id: r.id,
        type: r.type,
        amount: r.amount,
        isIssued: r.isIssued,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  private async resolveUser(telegramId: string) {
    return this.prismaService.user.findFirst({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true, points: true },
    });
  }
}
