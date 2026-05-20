import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CreateReferralInviteDto } from '../dto/create-referral-invite.dto';
import {
  ListReferralInvitesQueryDto,
  ListReferralsQueryDto,
} from '../dto/list-referrals-query.dto';
import {
  CreateReferralInviteResultInterface,
  ReferralInterface,
  ReferralInviteInterface,
  ReferralStatsInterface,
} from '../interfaces/referral.interface';
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
  ) {}

  @Get()
  @ApiOperation({ summary: 'List referral edges' })
  public listReferrals(
    @Query() query: ListReferralsQueryDto,
  ): Promise<readonly ReferralInterface[]> {
    return this.referralsService.listReferrals(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Bounded referral stats snapshot' })
  public getStats(): Promise<ReferralStatsInterface> {
    return this.referralsService.getStats();
  }

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
  public revokeInvite(@Param('inviteId') inviteId: string): Promise<ReferralInviteInterface> {
    return this.referralsService.revokeInvite(inviteId);
  }

  @Post('manual-attach')
  @ApiOperation({ summary: 'Manually attach a referrer to a user and replay historical payments' })
  public manualAttach(
    @Body() body: { userId: string; referrerId: string },
  ): Promise<ManualAttachResult> {
    return this.manualAttachService.attachReferrerManually({
      userId: body.userId,
      referrerId: body.referrerId,
    });
  }

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
}
