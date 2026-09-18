import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../auth/guards/internal-admin-auth.guard';
import { WebPushService } from './services/web-push.service';

interface PushSubscribeBody {
  readonly userId?: unknown;
  readonly subscription?: unknown;
  readonly userAgent?: unknown;
}

interface PushUnsubscribeBody {
  readonly userId?: unknown;
  readonly endpoint?: unknown;
}

interface PushSubscriptionShape {
  readonly endpoint?: string;
  readonly keys?: { readonly p256dh?: string; readonly auth?: string };
}

/**
 * InternalPushController
 * ──────────────────────
 * Manages browser web-push subscriptions for the SPA. Endpoints are
 * proxied by reiwa-web's BFF so the SPA never talks to admin
 * directly. Auth: shared internal API token.
 *
 *  GET /public-key — returns the VAPID public key the SPA hands to
 *      the Push Manager during `subscribe()`. Empty string when push
 *      is disabled (operator hasn't generated VAPID keys yet).
 *
 *  POST /subscribe — persist a subscription. Idempotent on `endpoint`.
 *
 *  POST /unsubscribe — delete a subscription by endpoint.
 *
 * Delivery is handled by `WebPushService.sendToUser()`, called from
 * `UserNotificationsService` when a notification fans out alongside
 * the Telegram bot push.
 */
@ApiTags('internal/push')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/push')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalPushController {
  public constructor(private readonly webPushService: WebPushService) {}

  @Get('public-key')
  @ApiOperation({
    summary: 'Get the VAPID public key for browser subscription',
    description:
      'Returns the operator-configured VAPID public key. Empty string when push is disabled — the SPA should hide its push opt-in UI in that case.',
  })
  public async getPublicKey(): Promise<{ publicKey: string }> {
    return { publicKey: await this.webPushService.getPublicKey() };
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Persist a web-push subscription for a user' })
  public async subscribe(@Body() body: PushSubscribeBody): Promise<{ success: boolean }> {
    const userId = typeof body.userId === 'string' ? body.userId : null;
    const subscription =
      body.subscription !== null && typeof body.subscription === 'object'
        ? (body.subscription as PushSubscriptionShape)
        : null;
    if (
      userId === null ||
      subscription === null ||
      typeof subscription.endpoint !== 'string' ||
      typeof subscription.keys?.p256dh !== 'string' ||
      typeof subscription.keys?.auth !== 'string'
    ) {
      throw new BadRequestException('Invalid subscribe payload');
    }
    await this.webPushService.subscribe({
      userId,
      endpoint: subscription.endpoint,
      p256dhKey: subscription.keys.p256dh,
      authKey: subscription.keys.auth,
      userAgent: typeof body.userAgent === 'string' ? body.userAgent : null,
    });
    return { success: true };
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a web-push subscription for a user' })
  public async unsubscribe(@Body() body: PushUnsubscribeBody): Promise<{ success: boolean }> {
    const userId = typeof body.userId === 'string' ? body.userId : null;
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : null;
    if (userId === null || endpoint === null) {
      throw new BadRequestException('Invalid unsubscribe payload');
    }
    await this.webPushService.unsubscribe({ userId, endpoint });
    return { success: true };
  }
}
