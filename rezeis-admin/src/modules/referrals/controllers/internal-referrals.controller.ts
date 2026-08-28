import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AccessMode } from '@prisma/client';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { ReferralInviteLimitsService } from '../services/referral-invite-limits.service';
import {
  ReferralPointsExchangeService,
  ExchangeOptionsResponse,
  PointsExchangeType,
} from '../services/referral-points-exchange.service';
import { normalizeReferralSettings } from '../services/referral-qualification.service';
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
    if (!user) {
      return {
        totalReferrals: 0,
        qualifiedReferrals: 0,
        pointsBalance: 0,
        programAvailable: false,
        referralCode: null,
        // Present even on this arm. A client that reads `program` to decide
        // whether to advertise the program at all must be able to tell "off"
        // from "this panel is too old to say" — and it can only do that if the
        // key is either always there or never there. There is no user here, so
        // there is nothing to promise anyone.
        program: { enabled: false, reward: null },
      };
    }

    const [totalReferrals, qualifiedReferrals, programAvailable, policy] = await Promise.all([
      this.prismaService.referral.count({ where: { referrerId: user.id } }),
      this.prismaService.referral.count({ where: { referrerId: user.id, qualifiedAt: { not: null } } }),
      this.isReferralProgramAvailable(user.id),
      this.prismaService.settings.findUnique({
        where: { id: 1 },
        // `referralSettings` rides along on the row this handler already
        // fetched for `accessMode` — no second round trip.
        select: { accessMode: true, referralSettings: true },
      }),
    ]);

    // Reward terms, read through the ENGINE’s own normaliser. Reading the raw
    // JSON here instead would re-implement the camelCase-form / legacy-donor
    // bridge, and the copy would disagree with the payout engine the first
    // time an install used the shape it did not handle — the cabinet would
    // then advertise a reward `createConfiguredRewards` never makes.
    const program = normalizeReferralSettings(policy?.referralSettings);
    // `createConfiguredRewards` creates NOTHING when the level-1 amount is
    // zero, so a zero here is not "0 points", it is "no reward at all".
    // `reward.strategy` is deliberately not exposed: the engine parses it and
    // then never reads it — `firstAmount` is always spent as an absolute — so
    // shipping PERCENT would invite a client to render a "%" the payout path
    // does not honour.
    const level1Reward = program.reward?.config.FIRST ?? 0;

    return {
      totalReferrals,
      qualifiedReferrals,
      pointsBalance: user.points,
      programAvailable,
      // The user's permanent, reusable referral code — the same reiwa_id the
      // cabinet already shares. `resolveReferrer` accepts it directly, so a
      // link built from it never expires and never consumes an invite slot.
      // Single-use `ReferralInvite` tokens stay reserved for the INVITED
      // access mode, where one-shot admission is the whole point.
      referralCode: user.id,
      // Under INVITED only a real invite token admits a new sign-up, so the
      // client must share a minted token rather than this permanent code —
      // otherwise the friend who taps the link is turned away at registration.
      admissionRequiresInvite: policy?.accessMode === AccessMode.INVITED,
      // Operator-facing state of the program itself, as opposed to
      // `programAvailable`, which answers "may THIS user take part" (the
      // invited-only gate). A client needs both: the first decides whether to
      // advertise the program, the second whether this person can act on it.
      program: {
        // Mirrors the engine kill-switch EXACTLY: only an explicit `false`
        // disables, an absent flag stays on. A stricter reading here would
        // hide the program in the cabinet while rewards kept being paid.
        enabled: program.enabled !== false,
        reward:
          level1Reward > 0 && program.reward
            ? { type: program.reward.type, amount: level1Reward }
            : null,
      },
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
   * Returns the user's share invite, creating one only when they have no live
   * invite yet. The bot calls this every time the invite hub is opened, so
   * minting a fresh token per call both changed the user's share link under
   * them and burned an invite slot per screen view (slots count every invite
   * ever created) — a user with N slots was permanently locked out after N
   * visits without a single friend joining.
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

    const existing = await this.referralsService.findReusableInvite(user.id);
    if (existing !== null) {
      return { invite: existing };
    }

    // Validate slot capacity
    await this.inviteLimitsService.validateCanCreateInvite(user.id);

    // Resolve expiry from settings (per-user TTL override applies).
    const expiresAt = await this.inviteLimitsService.resolveInviteExpiry(user.id);

    const result = await this.referralsService.createInvite({
      inviterId: user.id,
      // `null` (not `undefined`) so "TTL disabled" / VIP bypass really means no
      // expiry. An ABSENT field is no longer a 30-day default: `createInvite`
      // now resolves it from this same limits service. So passing the value
      // explicitly is not what makes this correct any more — it is what stops
      // the same question being answered twice, and guarantees the row carries
      // the instant this handler already computed.
      expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
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
    @Body()
    body: {
      type?: unknown;
      points?: unknown;
      subscriptionId?: unknown;
      idempotencyKey?: unknown;
    },
  ) {
    const user = await this.resolveUser(userRef);
    if (!user) return { error: 'User not found' };
    return this.pointsExchangeService.executeExchange({
      userId: user.id,
      type: body.type as PointsExchangeType,
      points: body.points as number,
      subscriptionId:
        typeof body.subscriptionId === 'string' && body.subscriptionId.length > 0
          ? body.subscriptionId
          : undefined,
      idempotencyKey:
        typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
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
