import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import { WebPushService } from './services/web-push.service';

interface PushSubscriptionShape {
  readonly endpoint?: string;
  readonly keys?: { readonly p256dh?: string; readonly auth?: string };
}

interface AdminPushSubscribeBody {
  readonly subscription?: PushSubscriptionShape;
}

interface AdminPushUnsubscribeBody {
  readonly endpoint?: string;
}

/**
 * AdminPushController
 * ───────────────────
 * Browser web-push subscription management for panel operators. Mirrors the
 * user-facing `InternalPushController` but binds every subscription to the
 * authenticated admin (`AdminJwtAuthGuard` + `@CurrentAdmin`). Reuses the
 * deployment VAPID keypair via `WebPushService`.
 */
@ApiTags('admin/push')
@ApiBearerAuth()
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/push')
export class AdminPushController {
  public constructor(private readonly webPushService: WebPushService) {}

  @Get('public-key')
  @ApiOperation({ summary: 'VAPID public key for admin browser subscription' })
  public async getPublicKey(): Promise<{ publicKey: string }> {
    return { publicKey: await this.webPushService.getPublicKey() };
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Persist a web-push subscription for the current admin' })
  public async subscribe(
    @Body() body: AdminPushSubscribeBody,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<{ success: boolean }> {
    const subscription = body.subscription ?? null;
    if (
      subscription === null ||
      typeof subscription.endpoint !== 'string' ||
      subscription.endpoint.length === 0 ||
      typeof subscription.keys?.p256dh !== 'string' ||
      typeof subscription.keys?.auth !== 'string'
    ) {
      throw new BadRequestException('Invalid subscribe payload');
    }
    await this.webPushService.subscribeAdmin({
      adminId: admin.id,
      endpoint: subscription.endpoint,
      p256dhKey: subscription.keys.p256dh,
      authKey: subscription.keys.auth,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { success: true };
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a web-push subscription for the current admin' })
  public async unsubscribe(
    @Body() body: AdminPushUnsubscribeBody,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ success: boolean }> {
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : null;
    if (endpoint === null || endpoint.length === 0) {
      throw new BadRequestException('Invalid unsubscribe payload');
    }
    await this.webPushService.unsubscribeAdmin({ adminId: admin.id, endpoint });
    return { success: true };
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a test web-push to the current admin\'s subscribed devices' })
  public async sendTest(
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ success: boolean }> {
    if ((await this.webPushService.getPublicKey()).length === 0) {
      throw new BadRequestException('Web-push is not configured (no VAPID keys)');
    }
    if (!(await this.webPushService.adminHasSubscription(admin.id))) {
      throw new BadRequestException('No push subscription — enable notifications first');
    }
    await this.webPushService.sendToAdmin({
      adminId: admin.id,
      // Empty, so `sendToAdmin` heads it with the operator's own brand. A test
      // that arrives under a name the operator has never configured answers a
      // different question than the one they clicked.
      title: '',
      body: 'Тестовое web-push уведомление. Доставка работает.',
      url: '/',
    });
    return { success: true };
  }
}
