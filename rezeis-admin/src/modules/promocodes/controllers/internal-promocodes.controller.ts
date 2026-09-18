import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
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
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
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

  /**
   * Reference-friendly variant: takes `{ userRef, code }` where `userRef`
   * is the canonical reiwa_id (CUID) for web / web-first users OR a numeric
   * telegramId for Telegram flows. Resolves the rezeis-admin user and
   * forwards to the same activation pipeline used by `POST /activate`.
   *
   * This is the endpoint reiwa's SPA/Mini App edge calls — it forwards the
   * identity resolved from its own session (reiwa_id first), so users with
   * no Telegram are fully supported.
   */
  @Post('activate-by-ref')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate a promocode by user reference (reiwa edge)' })
  public async activateByRef(
    @Body() body: { userRef: string; code: string; subscriptionId?: string; confirmCreateNew?: boolean },
  ): Promise<PromocodeActivationResultInterface> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(body.userRef),
      select: { id: true, telegramId: true },
    });
    if (user === null) {
      throw new NotFoundException(`User with reference=${body.userRef} not found`);
    }
    return this.portalService.activate({
      userId: user.id,
      userTelegramId: user.telegramId,
      dto: {
        code: body.code,
        subscriptionId:
          typeof body.subscriptionId === 'string' && body.subscriptionId.length > 0
            ? body.subscriptionId
            : undefined,
        confirmCreateNew: body.confirmCreateNew === true ? true : undefined,
      },
    });
  }

  @Post('eligible-subscriptions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve eligible subscription ids for a given promocode + user',
  })
  public async getEligibleSubscriptions(
    @Query('userRef') userRef: string,
    @Query('code') code: string,
  ): Promise<{
    readonly subscriptionIds: readonly string[];
    readonly hasPromocode: boolean;
  }> {
    const promocode = await this.portalService.getByCode(code);
    if (promocode === null) {
      return { subscriptionIds: [], hasPromocode: false };
    }
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) {
      return { subscriptionIds: [], hasPromocode: true };
    }
    const subscriptionIds =
      await this.portalService['validationService'].getEligibleSubscriptionIds({
        userId: user.id,
        promocode,
      });
    return { subscriptionIds, hasPromocode: true };
  }

  /**
   * Returns the user's promocode activation history (paginated).
   * Used by reiwa settings → Promocodes page. `:userRef` is the canonical
   * reiwa_id (CUID) or a numeric telegramId.
   */
  @Get('user/:userRef/activations')
  @ApiOperation({ summary: 'Get user promocode activation history' })
  public async getUserActivations(
    @Param('userRef') userRef: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ): Promise<{
    readonly entries: readonly PromocodeActivationInterface[];
    readonly total: number;
  }> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (!user) return { entries: [], total: 0 };
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 100);
    const offset = Math.max(Number(offsetStr) || 0, 0);
    return this.lifecycleService.listUserActivations({ userId: user.id, limit, offset });
  }
}
