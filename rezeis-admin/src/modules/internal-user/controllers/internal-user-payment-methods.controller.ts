/**
 * InternalUserPaymentMethodsController
 * ────────────────────────────────────
 * User-facing saved payment methods (list + self-service unbind + autopay toggle).
 *
 * YooKassa autopayments store `payment_method.id` after a successful payment
 * with `save_payment_method: true`. Merchants cannot delete the method on the
 * provider side — unbind only deactivates the local row so we stop charging it.
 * Autopay can also be disabled per method without unbinding (card stays listed).
 *
 * Auth: InternalAdminAuthGuard (Bearer token from api_tokens table).
 * Path: `/api/internal/user/:userRef/payment-methods`
 * `:userRef` is a reiwa_id (CUID) or a telegramId.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsUrl } from 'class-validator';
import type { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SavedPaymentMethodService } from '../../payments/services/saved-payment-method.service';
import { PaymentMethodSetupService } from '../../payments/services/payment-method-setup.service';
import { buildUserReferenceWhere } from '../utils/user-reference.util';

class UpdatePaymentMethodAutopayDto {
  @IsBoolean()
  public autopayEnabled!: boolean;
}

class StartPaymentMethodSetupDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  public returnUrl!: string;

  @IsBoolean()
  public consent!: boolean;
}

@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserPaymentMethodsController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly savedPaymentMethodService: SavedPaymentMethodService,
    private readonly paymentMethodSetupService: PaymentMethodSetupService,
  ) {}

  /**
   * Lists active saved payment methods for the user.
   *
   * Reiwa calls: `GET /api/internal/user/:userRef/payment-methods`
   */
  @Get(':userRef/payment-methods')
  public async listPaymentMethods(@Param('userRef') userRef: string) {
    const userId = await this.resolveUserId(userRef);
    const [methods, capabilities] = await Promise.all([
      this.savedPaymentMethodService.listActiveForUser(userId),
      this.paymentMethodSetupService.getCapabilities(),
    ]);
    return { ...methods, capabilities };
  }

  /** Starts a zero-amount hosted YooKassa card binding. */
  @Post(':userRef/payment-methods/setup')
  public async startPaymentMethodSetup(
    @Param('userRef') userRef: string,
    @Body() body: StartPaymentMethodSetupDto,
    @Req() request: Request,
  ) {
    const userId = await this.resolveUserId(userRef);
    return this.paymentMethodSetupService.startYookassaSetup({
      userId,
      returnUrl: body.returnUrl,
      consent: body.consent,
      // Audit the consent context for a "save my card" agreement. Reiwa is the
      // BFF, so forwarded client hints are the closest we get to the end user.
      consentIp: readForwardedClientIp(request),
      consentUserAgent: readForwardedUserAgent(request),
    });
  }

  /** Pollable, user-scoped status after YooKassa redirects back to Reiwa. */
  @Get(':userRef/payment-methods/setup/:setupId')
  public async getPaymentMethodSetupStatus(
    @Param('userRef') userRef: string,
    @Param('setupId') setupId: string,
  ) {
    const userId = await this.resolveUserId(userRef);
    return this.paymentMethodSetupService.getStatusForUser({ userId, setupId });
  }

  /**
   * Soft-unbinds a saved payment method owned by the user.
   *
   * Reiwa calls: `DELETE /api/internal/user/:userRef/payment-methods/:methodId`
   */
  @Delete(':userRef/payment-methods/:methodId')
  @HttpCode(HttpStatus.OK)
  public async unbindPaymentMethod(
    @Param('userRef') userRef: string,
    @Param('methodId') methodId: string,
  ) {
    const userId = await this.resolveUserId(userRef);
    return this.savedPaymentMethodService.unbindForUser(userId, methodId);
  }

  /**
   * Enables/disables autopay for a bound method without unbinding.
   *
   * Reiwa calls: `PATCH /api/internal/user/:userRef/payment-methods/:methodId`
   * Body: `{ "autopayEnabled": boolean }`
   */
  @Patch(':userRef/payment-methods/:methodId')
  public async updatePaymentMethodAutopay(
    @Param('userRef') userRef: string,
    @Param('methodId') methodId: string,
    @Body() body: UpdatePaymentMethodAutopayDto,
  ) {
    const userId = await this.resolveUserId(userRef);
    return this.savedPaymentMethodService.setAutopayEnabledForUser(
      userId,
      methodId,
      body.autopayEnabled,
    );
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

/**
 * Reiwa is the BFF, so the direct socket IP is reiwa's. Prefer the forwarded
 * client hint it relays; fall back to the socket address. Best-effort audit
 * data for the consent record — never used for auth decisions.
 */
function readForwardedClientIp(request: Request): string | null {
  const header = request.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  const first = typeof raw === 'string' ? raw.split(',')[0]?.trim() : '';
  if (first) return first.slice(0, 100);
  const socketIp = request.ip ?? request.socket.remoteAddress ?? null;
  return socketIp ? socketIp.slice(0, 100) : null;
}

function readForwardedUserAgent(request: Request): string | null {
  const header = request.headers['x-client-user-agent'] ?? request.headers['user-agent'];
  const raw = Array.isArray(header) ? header[0] : header;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().slice(0, 500) : null;
}
