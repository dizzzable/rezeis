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
  InternalPartnerCodeDto,
  InternalPartnerVisitDto,
} from '../dto/quest-partner.dto';
import { QuestPartnerService, QuestPartnerState } from '../services/quest-partner.service';

/**
 * BFF-facing partner verification for the manual-code and timed-visit methods
 * (the postback method is a separate signed endpoint). Under the global admin
 * guard: the reiwa BFF calls these with a session-resolved identity, so the
 * user id is never browser-supplied — rezeis re-resolves it server-side.
 */
@ApiTags('internal/quests/partner')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/quests/partner')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalQuestPartnerController {
  public constructor(private readonly partnerService: QuestPartnerService) {}

  @Post('code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a manual partner activation code' })
  public verifyCode(
    @Body() dto: InternalPartnerCodeDto,
  ): Promise<{ readonly state: QuestPartnerState }> {
    return this.partnerService.verifyManualCode({
      userRef: dto.userRef,
      questId: dto.questId,
      code: dto.code,
    });
  }

  @Post('visit/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a timed partner visit (server-authoritative clock)' })
  public startVisit(
    @Body() dto: InternalPartnerVisitDto,
  ): Promise<{ readonly landingUrl: string | null }> {
    return this.partnerService.startTimedVisit({ userRef: dto.userRef, questId: dto.questId });
  }

  @Post('visit/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a timed partner visit once the dwell has elapsed' })
  public completeVisit(
    @Body() dto: InternalPartnerVisitDto,
  ): Promise<{ readonly state: QuestPartnerState }> {
    return this.partnerService.completeTimedVisitFromCache({
      userRef: dto.userRef,
      questId: dto.questId,
    });
  }
}
