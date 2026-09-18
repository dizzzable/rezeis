import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import {
  QuestChannelRecheckDto,
  QuestChannelTargetDto,
} from '../dto/quest-channel.dto';
import {
  QuestChannelRecheckCandidate,
  QuestChannelService,
  QuestChannelState,
  QuestChannelTarget,
} from '../services/quest-channel.service';

/**
 * Bot-only channel quest contract. InternalAdminAuthGuard authenticates Reiwa
 * through its API token plus HMAC; no browser route is exposed for membership
 * verification because a web session cannot prove Telegram callback identity.
 */
@ApiTags('internal/quests/channel')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/quests/channel')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalQuestChannelController {
  public constructor(private readonly questChannelService: QuestChannelService) {}

  @Post('target')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get server-derived channel metadata for a bot callback' })
  public getTarget(@Body() dto: QuestChannelTargetDto): Promise<QuestChannelTarget> {
    return this.questChannelService.getVerificationTarget(dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record fresh positive bot membership proof without issuing a reward' })
  public verify(@Body() dto: QuestChannelTargetDto): Promise<{ readonly state: QuestChannelState }> {
    return this.questChannelService.verifyMembership(dto);
  }

  @Post('recheck')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply a bot-owned periodic channel membership recheck result' })
  public recordRecheck(
    @Body() dto: QuestChannelRecheckDto,
  ): Promise<{ readonly state: QuestChannelState }> {
    return this.questChannelService.recordRecheck(dto);
  }

  @Post('recheck/candidates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List bounded unclaimed channel completions for bot-owned recheck' })
  public listRecheckCandidates(): Promise<readonly QuestChannelRecheckCandidate[]> {
    return this.questChannelService.listRecheckCandidates();
  }
}
