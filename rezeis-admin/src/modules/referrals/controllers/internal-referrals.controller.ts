import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
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
@Controller('internal/user/:userRef/referrals')
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
  public async getSummary(@Param('userRef') userRef: string) {
    const user = await this.resolveUser(userRef);
    if (!user) return { totalReferrals: 0, qualifiedReferrals: 0, pointsBalance: 0, programAvailable: false };

    const [totalReferrals, qualifiedReferrals, programAvailable] = await Promise.all([
      this.prismaService.referral.count({ where: { referrerId: user.id } }),
      this.prismaService.referral.count({ where: { referrerId: user.id, qualifiedAt: { not: null } } }),
      this.isReferralProgramAvailable(user.id),
    ]);

    return {
      totalReferrals,
      qualifiedReferrals,
      pointsBalance: user.points,
      programAvailable,
    };
  }

  /**
   * Returns a paginated list of users this user has invited, newest first.
   * Each entry carries the invited user's display label (login → username →
   * name → masked telegram/email) and whether the referral has qualified.
   */
  @Get('invited')
  public async getInvitedUsers(
    @Param('userRef') userRef: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const user = await this.resolveUser(userRef);
    if (!user) return { items: [], total: 0, page: 1, limit: 20 };

    const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const parsedPage = Math.max(Number(page) || 1, 1);
    const skip = (parsedPage - 1) * parsedLimit;

    const [total, referrals] = await Promise.all([
      this.prismaService.referral.count({ where: { referrerId: user.id } }),
      this.prismaService.referral.findMany({
        where: { referrerId: user.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parsedLimit,
        select: {
          id: true,
          createdAt: true,
          qualifiedAt: true,
          referred: {
            select: {
              id: true,
              name: true,
              username: true,
              telegramId: true,
              email: true,
              webAccount: { select: { login: true } },
            },
          },
        },
      }),
    ]);

    const items = referrals.map((r) => {
      const u = r.referred;
      const label =
        u.webAccount?.login ??
        u.username ??
        (u.name && u.name.length > 0 ? u.name : null) ??
        (u.telegramId !== null ? `tg:${u.telegramId.toString()}` : null) ??
        maskEmail(u.email) ??
        `id:${u.id.slice(0, 8)}`;
      return {
        id: r.id,
        label,
        qualified: r.qualifiedAt !== null,
        invitedAt: r.createdAt.toISOString(),
      };
    });

    return { items, total, page: parsedPage, limit: parsedLimit };
  }

  /**
   * Creates a new referral invite for the user, respecting slot limits.
   */
  @Post('invite')
  public async createInvite(@Param('userRef') userRef: string) {
    const user = await this.resolveUser(userRef);
    if (!user) return { error: 'User not found' };

    // Invited-only gate: when the operator restricts the referral program to
    // invited users, a user who was not themselves invited cannot create
    // invites.
    if (!(await this.isReferralProgramAvailable(user.id))) {
      return { error: 'REFERRAL_PROGRAM_INVITED_ONLY' };
    }

    // Validate slot capacity
    await this.inviteLimitsService.validateCanCreateInvite(user.id);

    // Resolve expiry from settings (per-user TTL override applies).
    const expiresAt = await this.inviteLimitsService.resolveInviteExpiry(user.id);

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
  public async getInviteCapacity(@Param('userRef') userRef: string) {
    const user = await this.resolveUser(userRef);
    if (!user) return { totalSlots: null, usedSlots: 0, remainingSlots: null, canCreateInvite: true };
    return this.inviteLimitsService.getCapacity(user.id);
  }

  /**
   * Returns the available points exchange options for the user.
   */
  @Get('exchange/options')
  public async getExchangeOptions(@Param('userRef') userRef: string): Promise<ExchangeOptionsResponse> {
    const user = await this.resolveUser(userRef);
    if (!user) return { exchangeEnabled: false, pointsBalance: 0, types: [] };
    return this.pointsExchangeService.getExchangeOptions(user.id);
  }

  /**
   * Executes a points exchange for the user.
   */
  @Post('exchange')
  public async executeExchange(
    @Param('userRef') userRef: string,
    @Body() body: { type: PointsExchangeType; points: number; subscriptionId?: string },
  ) {
    const user = await this.resolveUser(userRef);
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
  public async getRewards(@Param('userRef') userRef: string) {
    const user = await this.resolveUser(userRef);
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

  private async resolveUser(userRef: string) {
    return this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true, points: true },
    });
  }

  /**
   * Whether the referral program is available to this user. When the operator
   * sets `referralSettings.invitedOnly = true`, only users who were themselves
   * invited (have a `Referral` edge as the referred party) may participate.
   */
  private async isReferralProgramAvailable(userId: string): Promise<boolean> {
    const settings = await this.prismaService.settings.findUnique({
      where: { id: 1 },
      select: { referralSettings: true },
    });
    const referralSettings = (settings?.referralSettings ?? {}) as Record<string, unknown>;
    if (referralSettings['invitedOnly'] !== true) {
      return true;
    }
    const invitedEdge = await this.prismaService.referral.findUnique({
      where: { referredId: userId },
      select: { id: true },
    });
    return invitedEdge !== null;
  }
}

/**
 * Masks an email for display in the referral list — keeps the first
 * character and the domain, hides the rest: `j***@mail.com`. Returns null
 * when there's nothing to mask.
 */
function maskEmail(email: string | null): string | null {
  if (!email || email.length === 0) return null;
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}
