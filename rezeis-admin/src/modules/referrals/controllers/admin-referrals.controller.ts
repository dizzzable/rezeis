import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReferralInviteSource } from '@prisma/client';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminAttachReferrerDto } from '../dto/admin-attach-referrer.dto';
import {
  AnalyticsRangeQueryDto,
  AnalyticsTimeseriesQueryDto,
  AnalyticsTopReferrersQueryDto,
} from '../dto/analytics-range-query.dto';
import { BulkIssueRewardsDto } from '../dto/bulk-issue-rewards.dto';
import { CreateRewardDto } from '../dto/create-reward.dto';
import { CreateReferralInviteDto } from '../dto/create-referral-invite.dto';
import {
  ListReferralInvitesQueryDto,
  ListReferralsQueryDto,
} from '../dto/list-referrals-query.dto';
import { ListRewardsQueryDto } from '../dto/list-rewards-query.dto';
import {
  AdminReferralRewardInterface,
  AdminReferralRewardsListInterface,
  BulkIssueRewardsResultInterface,
} from '../interfaces/admin-rewards.interface';
import {
  ReferralFunnelInterface,
  ReferralRewardDistributionInterface,
  ReferralSourceBreakdownInterface,
  ReferralTimeseriesInterface,
  ReferralTopReferrersInterface,
} from '../interfaces/admin-referral-analytics.interface';
import {
  CreateReferralInviteResultInterface,
  ReferralInterface,
  ReferralInviteInterface,
  ReferralStatsInterface,
} from '../interfaces/referral.interface';
import { AdminReferralAnalyticsService } from '../services/admin-referral-analytics.service';
import { AdminRewardsService } from '../services/admin-rewards.service';
import { ReferralInviteLimitsService } from '../services/referral-invite-limits.service';
import { ReferralManualAttachService, ManualAttachResult } from '../services/referral-manual-attach.service';
import { ReferralsService } from '../services/referrals.service';

@ApiTags('admin/referrals')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('referrals', 'view')
@Controller('admin/referrals')
export class AdminReferralsController {
  public constructor(
    private readonly referralsService: ReferralsService,
    private readonly inviteLimitsService: ReferralInviteLimitsService,
    private readonly manualAttachService: ReferralManualAttachService,
    private readonly rewardsService: AdminRewardsService,
    private readonly analyticsService: AdminReferralAnalyticsService,
    private readonly prismaService: PrismaService,
  ) {}

  // ── Referrals ──────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List referral edges' })
  public listReferrals(
    @Query() query: ListReferralsQueryDto,
  ): Promise<readonly ReferralInterface[]> {
    return this.referralsService.listReferrals(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Bounded referral stats snapshot for the SPA dashboard' })
  public getStats(): Promise<ReferralStatsInterface> {
    return this.referralsService.getStats();
  }

  // ── Invites ────────────────────────────────────────────────────────────

  @Get('invites')
  @ApiOperation({ summary: 'List referral invites' })
  public listInvites(
    @Query() query: ListReferralInvitesQueryDto,
  ): Promise<readonly ReferralInviteInterface[]> {
    return this.referralsService.listInvites(query);
  }

  /**
   * Mints an invite on an operator's behalf.
   *
   * WHAT THIS ROUTE OVERRIDES, AND WHAT IT DOES NOT.
   *
   * It reaches `ReferralsService.createInvite` directly, so it deliberately
   * skips the two things `InternalReferralsController.createInvite` does first:
   * `findReusableInvite` (hand back the user's existing live share link instead
   * of minting) and the invited-only program gate. Both are eligibility rules
   * ABOUT THE USER, and overruling them is what an operator route is for - the
   * panel exists to hand out targeted and VIP invites that no user-facing rule
   * would allow. Do not "fix" that by adding them here.
   *
   * It does NOT override the invite QUOTA or the invite TTL. Those are not
   * rules about the user, they are the operator's own settings, and both are
   * resolved at the write site so no route can diverge from them - see the two
   * comment blocks in `ReferralsService.createInvite`. The TTL used to be
   * resolved per route, and this one had none, so a panel invite carried a
   * hardcoded 30 days no matter what the operator had configured.
   *
   * An operator who wants a different lifetime for one invite still says so:
   * `expiresInDays` (or `expiresAt`) on the body still wins outright. Only the
   * DEFAULT changed - what happens when the body says nothing, which is what
   * both panel surfaces send.
   */
  @Post('invites')
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Create a new referral invite token' })
  public createInvite(
    @Body() dto: CreateReferralInviteDto,
  ): Promise<CreateReferralInviteResultInterface> {
    return this.referralsService.createInvite(dto);
  }

  @Delete('invites/:inviteId')
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Revoke a referral invite' })
  public revokeInvite(
    @Param('inviteId') inviteId: string,
  ): Promise<ReferralInviteInterface> {
    return this.referralsService.revokeInvite(inviteId);
  }

  /**
   * Alias of `DELETE /invites/:inviteId` for SPA parity. The legacy
   * "Invites" tab uses POST `/invites/:id/revoke`; we keep both shapes
   * so the React Query mutation does not have to know which method.
   */
  @Post('invites/:inviteId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Revoke a referral invite (POST alias)' })
  public revokeInviteAlias(
    @Param('inviteId') inviteId: string,
  ): Promise<ReferralInviteInterface> {
    return this.referralsService.revokeInvite(inviteId);
  }

  // ── Rewards ────────────────────────────────────────────────────────────

  @Get('rewards')
  @ApiOperation({ summary: 'List referral rewards (admin view)' })
  public listRewards(
    @Query() query: ListRewardsQueryDto,
  ): Promise<AdminReferralRewardsListInterface> {
    return this.rewardsService.list(query);
  }

  @Post('rewards')
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Manually grant a referral reward' })
  public grantReward(
    @Body() dto: CreateRewardDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AdminReferralRewardInterface> {
    return this.rewardsService.grant(dto, admin.id);
  }

  /**
   * Both issue routes take `@Req` in addition to `@CurrentAdmin`, the same
   * pairing `manualAttach`/`attach` below already use, and for the same
   * reason: issuing moves money and the resulting `referral.reward.issued`
   * audit row wants the ip, the user-agent and the request id behind the act.
   * `@CurrentAdmin` names WHO; only the request names FROM WHERE.
   *
   * Nothing else changes here — no decorator is added or removed, and the
   * class-level `@UseGuards(AdminJwtAuthGuard, RbacGuard)` plus each route's
   * `@RequirePermission('referrals', 'edit')` are untouched. `@Req` is a
   * parameter decorator; it grants no access it did not already have.
   */
  @Post('rewards/:rewardId/issue')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Apply a pending reward and mark it as issued' })
  public issueReward(
    @Param('rewardId') rewardId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<AdminReferralRewardInterface> {
    return this.rewardsService.issue(rewardId, admin.id, extractRequestMetadata(req));
  }

  @Post('rewards/bulk-issue')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Issue multiple pending rewards in a single request' })
  public bulkIssueRewards(
    @Body() dto: BulkIssueRewardsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<BulkIssueRewardsResultInterface> {
    return this.rewardsService.bulkIssue(dto.ids, admin.id, extractRequestMetadata(req));
  }

  @Post('rewards/:rewardId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Revoke a pending reward (already-issued requires refund flow)' })
  public revokeReward(
    @Param('rewardId') rewardId: string,
    @Body() body: { reason?: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AdminReferralRewardInterface> {
    return this.rewardsService.revoke(rewardId, body.reason ?? null, admin.id);
  }

  // ── Manual attach ──────────────────────────────────────────────────────

  /**
   * Both attach routes below take `@CurrentAdmin` — the same way every other
   * mutating route on this controller obtains its actor (`grantReward`,
   * `issueReward`, `bulkIssueRewards`, `revokeReward` all do) — and additionally
   * `@Req`, because an audit row wants the ip and user-agent behind the act.
   *
   * Neither had ANY actor parameter until now, and neither recorded anything,
   * while the two user-card routes that reach the same service recorded two
   * DIFFERENT audit actions. Attaching a referrer replays every completed
   * payment through the new graph and credits partner earnings, so all four
   * move money. `ReferralManualAttachService` now owns the single audit action
   * and the system event; the surface travels in `metadata.source`.
   */

  @Post('manual-attach')
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Manually attach a referrer (cuid identifiers)' })
  public manualAttach(
    @Body() body: { userId: string; referrerId: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ManualAttachResult> {
    return this.manualAttachService.attachReferrerManually({
      // An admin attaching after the fact did not observe an invite link, so
      // there is no honest BOT/WEB answer here. `ReferralInviteSource` has no
      // MANUAL member, so this stays UNKNOWN — deliberately chosen, not
      // defaulted. Adding a MANUAL value is a schema/migration decision for
      // the owner.
      inviteSource: ReferralInviteSource.UNKNOWN,
      userId: body.userId,
      referrerId: body.referrerId,
      operator: {
        currentAdmin: admin,
        requestMetadata: extractRequestMetadata(req),
        source: 'referrals_tab',
      },
    });
  }

  /**
   * SPA-friendly variant of `manual-attach`: accepts telegram ids and
   * resolves them server-side. Behaviour is otherwise identical.
   *
   * This is the route the Referrals page's "Attach referrer" dialog posts to,
   * and it is the one that recorded nothing at all.
   */
  @Post('attach')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('referrals', 'edit')
  @ApiOperation({ summary: 'Manually attach a referrer (telegram-id friendly)' })
  public async attach(
    @Body() dto: AdminAttachReferrerDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ManualAttachResult> {
    const userId = await this.resolveUserId(dto.userId, dto.referredTelegramId, 'user');
    const referrerId = await this.resolveUserId(
      dto.referrerId,
      dto.referrerTelegramId,
      'referrer',
    );
    // Admin manual attach — see the `manual-attach` handler above for why this
    // is UNKNOWN rather than BOT/WEB.
    return this.manualAttachService.attachReferrerManually({
      userId,
      referrerId,
      inviteSource: ReferralInviteSource.UNKNOWN,
      // Same surface as `manual-attach`: one dialog, two identifier shapes.
      operator: {
        currentAdmin: admin,
        requestMetadata: extractRequestMetadata(req),
        source: 'referrals_tab',
      },
    });
  }

  // ── Limits introspection ──────────────────────────────────────────────

  @Get('invite-limits')
  @RequirePermission('referral_settings', 'view')
  @ApiOperation({ summary: 'Get current invite limits configuration' })
  public getInviteLimits() {
    return this.inviteLimitsService.getEffectiveLimits();
  }

  @Get('invite-capacity/:userId')
  @ApiOperation({ summary: 'Get invite capacity for a specific user' })
  public getInviteCapacity(@Param('userId') userId: string) {
    return this.inviteLimitsService.getCapacity(userId);
  }

  // ── Analytics ─────────────────────────────────────────────────────────

  @Get('analytics/funnel')
  @ApiOperation({ summary: '4-step conversion funnel for the configured date range' })
  public getFunnel(
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<ReferralFunnelInterface> {
    return this.analyticsService.getFunnel(query);
  }

  @Get('analytics/timeseries')
  @ApiOperation({ summary: 'Bucketed time-series of invites/referrals/rewards' })
  public getTimeseries(
    @Query() query: AnalyticsTimeseriesQueryDto,
  ): Promise<ReferralTimeseriesInterface> {
    return this.analyticsService.getTimeseries(query);
  }

  @Get('analytics/top-referrers')
  @ApiOperation({ summary: 'Top-N referrers by qualified count, with conversion rate and points' })
  public getTopReferrers(
    @Query() query: AnalyticsTopReferrersQueryDto,
  ): Promise<ReferralTopReferrersInterface> {
    return this.analyticsService.getTopReferrers(query);
  }

  @Get('analytics/reward-distribution')
  @ApiOperation({ summary: 'Reward distribution by type × issued/pending/revoked' })
  public getRewardDistribution(): Promise<ReferralRewardDistributionInterface> {
    return this.analyticsService.getRewardDistribution();
  }

  @Get('analytics/source-breakdown')
  @ApiOperation({ summary: 'Referral graph breakdown by `inviteSource`' })
  public getSourceBreakdown(): Promise<ReferralSourceBreakdownInterface> {
    return this.analyticsService.getSourceBreakdown();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async resolveUserId(
    cuid: string | undefined,
    telegramId: string | undefined,
    kind: 'user' | 'referrer',
  ): Promise<string> {
    if (cuid !== undefined && cuid.length > 0) return cuid;
    if (telegramId !== undefined && telegramId.length > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        select: { id: true },
      });
      if (user === null) {
        throw new NotFoundException(`${kind === 'user' ? 'User' : 'Referrer'} not found by telegram id`);
      }
      return user.id;
    }
    throw new BadRequestException(`Provide ${kind}Id (cuid) or ${kind === 'user' ? 'referredTelegramId' : 'referrerTelegramId'}`);
  }
}
