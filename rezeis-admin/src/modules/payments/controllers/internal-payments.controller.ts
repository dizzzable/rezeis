import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PurchaseChannel } from '@prisma/client';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SettingsService } from '../../settings/services/settings.service';
import { isGatewayAvailableForChannel } from '../../plans/utils/purchase-gateway-policy.util';
import { InternalPaymentCheckoutDto } from '../dto/internal-payment-checkout.dto';
import { InternalPartnerBalanceCheckoutDto } from '../dto/internal-partner-balance-checkout.dto';
import { InternalRenewalCheckoutDto, toAddOnSelectionMap } from '../dto/internal-renewal-checkout.dto';
import { toDurationMap } from '../../subscriptions/dto/renewal-duration.dto';
import { toPlanMap } from '../../subscriptions/dto/renewal-plan.dto';
import {
  InternalPaymentCheckoutInterface,
  InternalPaymentStatusInterface,
} from '../interfaces/internal-payment-checkout.interface';
import { InternalPaymentGatewayInterface } from '../interfaces/internal-payment-gateway.interface';
import { PaymentGatewayRegistryService } from '../services/payment-gateway-registry.service';
import { PartnerBalancePaymentService } from '../services/partner-balance-payment.service';
import { PaymentsCheckoutService } from '../services/payments-checkout.service';
import { PaymentsRenewalCheckoutService } from '../services/payments-renewal-checkout.service';

@Controller('internal/payments')
@UseGuards(InternalAdminAuthGuard)
export class InternalPaymentsController {
  public constructor(
    private readonly paymentsCheckoutService: PaymentsCheckoutService,
    private readonly paymentsRenewalCheckoutService: PaymentsRenewalCheckoutService,
    private readonly paymentGatewayRegistryService: PaymentGatewayRegistryService,
    private readonly partnerBalancePaymentService: PartnerBalancePaymentService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Returns the list of *enabled* gateways the SPA / Mini App should
   * render on the purchase screen. Sorted by `orderIndex` so operators
   * control the visual layout from the admin panel without code
   * changes. Disabled gateways are filtered out — there's no point in
   * leaking them to user-facing surfaces.
   *
   * The optional `channel` query (defaults to `WEB`) additionally drops
   * gateways that can't operate in that context — most importantly
   * `TELEGRAM_STARS`, which only works inside a Telegram invoice and is
   * meaningless in the browser cabinet.
   *
   * Gateways accepting the operator's default currency (Settings →
   * "Валюта по умолчанию") are floated to the top, preserving the
   * admin-defined `orderIndex` within each currency group. No conversion
   * happens — this is display priority only.
   */
  @Get('gateways')
  public async listEnabledGateways(
    @Query('channel') channelRaw?: string,
  ): Promise<readonly InternalPaymentGatewayInterface[]> {
    const channel = this.parseChannel(channelRaw);
    const [all, policy] = await Promise.all([
      this.paymentGatewayRegistryService.listGateways(),
      this.settingsService.getInternalPlatformPolicy(),
    ]);
    const defaultCurrency = policy.defaultCurrency;
    return all
      .filter((gateway) => gateway.isActive)
      .filter((gateway) => isGatewayAvailableForChannel(gateway.type, channel))
      .map((gateway): InternalPaymentGatewayInterface => ({
        id: gateway.id,
        type: gateway.type,
        currency: gateway.currency,
        orderIndex: gateway.orderIndex,
      }))
      .sort((a, b) => {
        // Default-currency gateways first; stable on orderIndex within a group.
        const aDefault = a.currency === defaultCurrency ? 0 : 1;
        const bDefault = b.currency === defaultCurrency ? 0 : 1;
        if (aDefault !== bDefault) return aDefault - bDefault;
        return a.orderIndex - b.orderIndex;
      });
  }

  private parseChannel(raw: string | undefined): PurchaseChannel {
    const upper = (raw ?? '').toUpperCase();
    if (upper in PurchaseChannel) {
      return PurchaseChannel[upper as keyof typeof PurchaseChannel];
    }
    return PurchaseChannel.WEB;
  }

  @Post('checkout')
  public async checkout(
    @Body() input: InternalPaymentCheckoutDto,
  ): Promise<InternalPaymentCheckoutInterface> {
    return this.paymentsCheckoutService.checkout(input);
  }

  /**
   * Pay for a subscription (new / additional / renew / upgrade) using the
   * partner's accrued balance instead of an external gateway.
   */
  @Post('partner-balance/checkout')
  public async partnerBalanceCheckout(
    @Body() input: InternalPartnerBalanceCheckoutDto,
  ): Promise<InternalPaymentCheckoutInterface> {
    return this.partnerBalancePaymentService.pay({
      userId: input.userId,
      telegramId: input.telegramId,
      purchaseType: input.purchaseType,
      planId: input.planId,
      durationDays: input.durationDays,
      subscriptionId: input.subscriptionId,
      channel: input.channel,
      deviceType: input.deviceType,
    });
  }

  @Post('renewal-checkout')
  public async renewalCheckout(
    @Body() input: InternalRenewalCheckoutDto,
  ): Promise<InternalPaymentCheckoutInterface> {
    return this.paymentsRenewalCheckoutService.renewalCheckout({
      userId: input.userId,
      telegramId: input.telegramId,
      subscriptionIds: input.subscriptionIds,
      gatewayType: input.gatewayType,
      channel: input.channel,
      successUrl: input.successUrl ?? null,
      failUrl: input.failUrl ?? null,
      durations: toDurationMap(input.durations),
      plans: toPlanMap(input.plans),
      idempotencyKey: input.idempotencyKey,
      expectedAmount: input.expectedAmount,
      expectedCurrency: input.expectedCurrency,
      addOns: toAddOnSelectionMap(input.addOns),
      savedPaymentMethodId: input.savedPaymentMethodId,
      savePaymentMethod: input.savePaymentMethod,
    });
  }

  @Get(':paymentId')
  public async getStatus(
    @Param('paymentId') paymentId: string,
    @Query('userId') userId?: string,
    @Query('telegramId') telegramId?: string,
  ): Promise<InternalPaymentStatusInterface> {
    return this.paymentsCheckoutService.getPaymentStatus({ paymentId, userId, telegramId });
  }
}
