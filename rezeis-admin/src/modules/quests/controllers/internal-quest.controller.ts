import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Get,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { QuestClaimResult } from '../interfaces/quest-claim.interface';
import { QuestCabinetResponse } from '../interfaces/quest-cabinet.interface';
import { QuestIconService } from '../services/quest-icon.service';
import { QuestQueryService } from '../services/quest-query.service';
import { QuestRewardService } from '../services/quest-reward.service';

/**
 * InternalQuestController
 * ───────────────────────
 * Cabinet-facing quest surface consumed by reiwa (SPA / Mini App).
 *
 * Auth: `InternalAdminAuthGuard` (api_token) authenticates the reiwa BFF. The
 * end-user identity is proven by reiwa's own session and passed as `:userRef`
 * (reiwa_id CUID or numeric telegramId). Every read/claim is scoped to the
 * resolved user, so one user can never list or claim another user's quests.
 */
@ApiTags('internal/user/quests')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/quests')
export class InternalQuestController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly questQueryService: QuestQueryService,
    private readonly questRewardService: QuestRewardService,
    private readonly questIconService: QuestIconService,
  ) {}

  @Get('icons/:iconId')
  @Header('Content-Type', 'image/svg+xml')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  @Header('Cache-Control', 'public, max-age=86400')
  @ApiOperation({ summary: 'Serve a sanitized quest SVG icon (cabinet, via BFF proxy)' })
  public async serveIcon(@Param('iconId') iconId: string): Promise<string> {
    const svg = await this.questIconService.getSvg(iconId);
    if (svg === null) {
      throw new NotFoundException('Icon not found');
    }
    return svg;
  }

  @Get(':userRef')
  @ApiOperation({ summary: 'List quests relevant to the calling user + points balance' })
  public async list(@Param('userRef') userRef: string): Promise<QuestCabinetResponse> {
    const userId = await this.resolveUserId(userRef);
    return this.questQueryService.listForUser(userId);
  }

  @Post(':userRef/:questId/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Claim a completed quest and receive its reward' })
  public async claim(
    @Param('userRef') userRef: string,
    @Param('questId') questId: string,
  ): Promise<QuestClaimResult> {
    const userId = await this.resolveUserId(userRef);
    return this.questRewardService.claim({ userId, questId });
  }

  private async resolveUserId(userRef: string): Promise<string> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
    return user.id;
  }
}
