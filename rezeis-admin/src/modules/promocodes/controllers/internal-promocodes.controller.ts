import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { ActivatePromocodeDto } from '../dto/activate-promocode.dto';
import { PromocodeActivationInterface, PromocodeActivationResultInterface } from '../interfaces/promocode.interface';
import { PromocodeLifecycleService } from '../services/promocode-lifecycle.service';
import { PromocodePortalService } from '../services/promocode-portal.service';
import { PrismaService } from '../../../common/prisma/prisma.service';

interface InternalActivateBody {
  readonly userId: string;
  readonly userTelegramId?: string;
  readonly dto: ActivatePromocodeDto;
}

/**
 * Internal API surface called by the public ruid edge. The endpoint is
 * protected with the static internal API key — ruid forwards an already
 * authenticated `userId` resolved from its session cookie.
 */
@ApiTags('internal/promocodes')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/promocodes')
export class InternalPromocodesController {
  public constructor(
    private readonly portalService: PromocodePortalService,
    private readonly lifecycleService: PromocodeLifecycleService,
    private readonly prismaService: PrismaService,
  ) {}

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate a promocode for an authenticated end-user (ruid bridge)',
  })
  public activate(
    @Body() body: InternalActivateBody,
  ): Promise<PromocodeActivationResultInterface> {
    return this.portalService.activate({
      userId: body.userId,
      userTelegramId:
        typeof body.userTelegramId === 'string' && body.userTelegramId.length > 0
          ? BigInt(body.userTelegramId)
          : null,
      dto: body.dto,
    });
  }

  @Post('eligible-subscriptions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve eligible subscription ids for a given promocode + user',
  })
  public async getEligibleSubscriptions(
    @Query('userId') userId: string,
    @Query('code') code: string,
  ): Promise<{
    readonly subscriptionIds: readonly string[];
    readonly hasPromocode: boolean;
  }> {
    const promocode = await this.portalService.getByCode(code);
    if (promocode === null) {
      return { subscriptionIds: [], hasPromocode: false };
    }
    const subscriptionIds =
      await this.portalService['validationService'].getEligibleSubscriptionIds({
        userId,
        promocode,
      });
    return { subscriptionIds, hasPromocode: true };
  }

  /**
   * Returns the user's promocode activation history (paginated).
   * Used by reiwa settings → Promocodes page.
   */
  @Get('user/:telegramId/activations')
  @ApiOperation({ summary: 'Get user promocode activation history' })
  public async getUserActivations(
    @Param('telegramId') telegramId: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ): Promise<{
    readonly entries: readonly PromocodeActivationInterface[];
    readonly total: number;
  }> {
    const user = await this.prismaService.user.findFirst({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true },
    });
    if (!user) return { entries: [], total: 0 };
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 100);
    const offset = Math.max(Number(offsetStr) || 0, 0);
    return this.lifecycleService.listUserActivations({ userId: user.id, limit, offset });
  }
}
