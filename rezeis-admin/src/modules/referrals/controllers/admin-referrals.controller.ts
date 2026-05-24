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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
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
@UseGuards(AdminJwtAuthGuard)
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

  @Post('invites')
  @ApiOperation({ summary: 'Create a new referral invite token' })
  public createInvite(
    @Body() dto: CreateReferralInviteDto,
  ): Promise<CreateReferralInviteResultInterface> {
    return this.referralsService.createInvite(dto);
  }

  @Delete('invites/:inviteId')
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
  @ApiOperation({ summary: 'Manually grant a referral reward' })
  public grantReward(
    @Body() dto: CreateRewardDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AdminReferralRewardInterface> {
    return this.rewardsService.grant(dto, admin.id);
  }

  @Post('rewards/:rewardId/issue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply a pending reward and mark it as issued' })
  public issueReward(
    @Param('rewardId') rewardId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AdminReferralRewardInterface> {
    return this.rewardsService.issue(rewardId, admin.id);
  }

  @Post('rewards/bulk-issue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue multiple pending rewards in a single request' })
  public bulkIssueRewards(
    @Body() dto: BulkIssueRewardsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<BulkIssueRewardsResultInterface> {
    return this.rewardsService.bulkIssue(dto.ids, admin.id);
  }

  @Post('rewards/:rewardId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a pending reward (already-issued requires refund flow)' })
  public revokeReward(
    @Param('rewardId') rewardId: string,
    @Body() body: { reason?: string },
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AdminReferralRewardInterface> {
    return this.rewardsService.revoke(rewardId, body.reason ?? null, admin.id);
  }

  // ── Manual attach ──────────────────────────────────────────────────────

  @Post('manual-attach')
  @ApiOperation({ summary: 'Manually attach a referrer (cuid identifiers)' })
  public manualAttach(
    @Body() body: { userId: string; referrerId: string },
  ): Promise<ManualAttachResult> {
    return this.manualAttachService.attachReferrerManually({
      userId: body.userId,
      referrerId: body.referrerId,
    });
  }

  /**
   * SPA-friendly variant of `manual-attach`: accepts telegram ids and
   * resolves them server-side. Behaviour is otherwise identical.
   */
  @Post('attach')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually attach a referrer (telegram-id friendly)' })
  public async attach(
    @Body() dto: AdminAttachReferrerDto,
  ): Promise<ManualAttachResult> {
    const userId = await this.resolveUserId(dto.userId, dto.referredTelegramId, 'user');
    const referrerId = await this.resolveUserId(
      dto.referrerId,
      dto.referrerTelegramId,
      'referrer',
    );
    return this.manualAttachService.attachReferrerManually({ userId, referrerId });
  }

  // ── Limits introspection ──────────────────────────────────────────────

  @Get('invite-limits')
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
