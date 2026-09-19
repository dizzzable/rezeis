import {
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { dismissConnectHelpBanner } from '../connect-evidence.util';

/**
 * The cabinet's × on «Не получилось подключиться?».
 *
 * Reiwa calls `POST /api/internal/user/:userRef/subscriptions/:subscriptionId/connect-help/dismiss`
 * — the path shape the per-subscription device routes already use — where
 * `:userRef` is the SESSION's customer (a reiwa_id or a Telegram id), never
 * anything the browser sent. No body.
 */
@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalConnectHelpController {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Hides the banner on this subscription for good — recorded on the
   * subscription, so it does not come back on the customer's other devices.
   *
   * Only the resolved customer's own subscription. An unknown customer, an
   * unknown subscription and SOMEONE ELSE'S subscription all answer the same
   * 404, so the route cannot be used to learn whose a subscription id is.
   * Idempotent: a second × keeps the first one's time and answers the same.
   */
  @Post(':userRef/subscriptions/:subscriptionId/connect-help/dismiss')
  @HttpCode(HttpStatus.OK)
  public async dismissBanner(
    @Param('userRef') userRef: string,
    @Param('subscriptionId') subscriptionId: string,
  ): Promise<{ readonly dismissed: true }> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    const subscription =
      user === null
        ? null
        : await this.prismaService.subscription.findFirst({
            where: { id: subscriptionId, userId: user.id },
            select: { id: true },
          });
    if (subscription === null) {
      throw new NotFoundException('Subscription not found');
    }
    await dismissConnectHelpBanner(this.prismaService, subscription.id, new Date());
    return { dismissed: true };
  }
}
