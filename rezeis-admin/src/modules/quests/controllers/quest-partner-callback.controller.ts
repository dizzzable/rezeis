import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { QuestPartnerCallbackGuard } from '../guards/quest-partner-callback.guard';
import { QuestPartnerCallbackDto } from '../dto/quest-partner.dto';
import { QuestPartnerService, QuestPartnerState } from '../services/quest-partner.service';

/**
 * Partner postback endpoint (Phase C). NOT under the global admin guard — each
 * partner authenticates with its own HMAC secret via QuestPartnerCallbackGuard
 * (signature over raw body + atomic nonce dedup). By the time the handler runs,
 * the caller and payload are already verified, so it only resolves identity
 * server-side and records the completion.
 */
@ApiTags('internal/quests/partner')
@UseGuards(QuestPartnerCallbackGuard)
@Controller('internal/quests/partner')
export class QuestPartnerCallbackController {
  public constructor(private readonly partnerService: QuestPartnerService) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Signed partner postback → record a PARTNER_TASK completion' })
  public callback(
    @Body() dto: QuestPartnerCallbackDto,
  ): Promise<{ readonly state: QuestPartnerState }> {
    // Identity is resolved server-side from the verified telegramId/userRef;
    // the client-supplied value is never trusted as a rezeis userId.
    return this.partnerService.applyPostback({
      userRef: dto.telegramId ?? dto.userRef ?? '',
      questId: dto.questId,
    });
  }
}
