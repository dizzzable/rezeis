import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';

import { advertisingConfig } from '../../../common/config/advertising.config';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { CreateAdRequestDto } from '../dto/advertising.dto';
import { AdPlacementRequestService } from '../services/ad-placement-request.service';
import { buildAdDeepLinks, buildAdPayload } from '../utils/tracking-code.util';

/**
 * Partner-facing advertising endpoints consumed by reiwa. The `:telegramId`
 * param identifies the user; only users who are partners may submit/list ad
 * requests and read their per-campaign stats. Auth: `InternalAdminAuthGuard`.
 */
@ApiTags('internal/user/advertising')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/user/:telegramId/advertising')
export class InternalPartnerAdvertisingController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly requestService: AdPlacementRequestService,
    @Inject(advertisingConfig.KEY)
    private readonly adConfig: ConfigType<typeof advertisingConfig>,
  ) {}

  @Get('requests')
  public async listRequests(@Param('telegramId') telegramId: string) {
    const partner = await this.resolvePartner(telegramId);
    if (partner === null) {
      return { requests: [] };
    }
    return { requests: await this.requestService.listForPartner(partner.id) };
  }

  @Post('requests')
  public async createRequest(
    @Param('telegramId') telegramId: string,
    @Body() body: CreateAdRequestDto,
  ) {
    const partner = await this.resolvePartner(telegramId);
    if (partner === null) {
      throw new ForbiddenException('Not a partner');
    }
    return this.requestService.createRequest(partner.id, body);
  }

  /**
   * Partner accepts operator counter-terms (`COUNTERED` → ACTIVE placements).
   * Ownership is enforced by partnerId resolved from the path user.
   */
  @Post('requests/:requestId/accept')
  public async acceptRequest(
    @Param('telegramId') telegramId: string,
    @Param('requestId') requestId: string,
  ) {
    const partner = await this.resolvePartner(telegramId);
    if (partner === null) {
      throw new ForbiddenException('Not a partner');
    }
    return this.requestService.accept(requestId, partner.id);
  }

  /**
   * Per-placement stats for the partner's own placements (opens/regs/conv/earned)
   * plus tracking code + deep links so the partner can actually run ads.
   */
  @Get('stats')
  public async getStats(@Param('telegramId') telegramId: string) {
    const partner = await this.resolvePartner(telegramId);
    if (partner === null) {
      return { placements: [] };
    }
    const placements = await this.prismaService.adPlacement.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, platform: true, channel: true, trackingCode: true, status: true, campaignId: true },
    });
    const botUsername = this.adConfig.botUsername ?? '';
    const stats = await Promise.all(
      placements.map(async (p) => {
        const [opens, registrations, conversions, acquired] = await Promise.all([
          this.prismaService.adClick.count({ where: { placementId: p.id } }),
          this.prismaService.user.count({ where: { acquisitionPlacementId: p.id } }),
          this.prismaService.adConversion.count({ where: { placementId: p.id, status: 'ATTRIBUTED' } }),
          this.prismaService.user.findMany({
            where: { acquisitionPlacementId: p.id },
            select: { id: true },
          }),
        ]);
        const earned =
          acquired.length === 0
            ? 0
            : (
                await this.prismaService.partnerTransaction.aggregate({
                  where: { partnerId: partner.id, referralUserId: { in: acquired.map((u) => u.id) } },
                  _sum: { earnedAmount: true },
                })
              )._sum.earnedAmount ?? 0;
        const payload = buildAdPayload(p.trackingCode);
        const links =
          botUsername.length > 0
            ? buildAdDeepLinks({
                botUsername,
                miniAppShortName: this.adConfig.miniAppShortName,
                miniAppWebBaseUrl: this.adConfig.webBaseUrl,
                code: p.trackingCode,
              })
            : { botStart: '', miniAppStart: null, miniAppWeb: null };
        return {
          placementId: p.id,
          platform: p.platform,
          channel: p.channel,
          status: p.status,
          trackingCode: p.trackingCode,
          payload,
          links,
          opens,
          registrations,
          conversions,
          earnedMinor: earned,
        };
      }),
    );
    return { placements: stats };
  }

  private async resolvePartner(telegramId: string): Promise<{ id: string } | null> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(telegramId),
      select: { id: true },
    });
    if (user === null) {
      return null;
    }
    return this.prismaService.partner.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
  }
}
