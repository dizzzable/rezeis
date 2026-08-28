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
import {
  TelegramStarsWebhookService,
  type TelegramStarsPreCheckoutVerdict,
} from '../services/telegram-stars-webhook.service';

@Controller('internal/payments')
@UseGuards(InternalAdminAuthGuard)
export class InternalPaymentsController {
  public constructor(
    private readonly paymentsCheckoutService: PaymentsCheckoutService,
    private readonly paymentsRenewalCheckoutService: PaymentsRenewalCheckoutService,
    private readonly paymentGatewayRegistryService: PaymentGatewayRegistryService,
    private readonly partnerBalancePaymentService: PartnerBalancePaymentService,
    private readonly settingsService: SettingsService,
    private readonly telegramStarsWebhookService: TelegramStarsWebhookService,
  ) {}

  /**
   * Verdict for a Telegram Stars pre-checkout query.
   *
   * The BOT asks, and the bot answers Telegram — not this panel. That split is
   * forced by how the bot runs: Telegram allows one consumer per token, the bot
   * holds it through long polling, and so a `pre_checkout_query` is delivered
   * to the bot and to nowhere else. The panel could only answer it by holding
   * the same token, which a split deployment does not guarantee.
   *
   * What stays here is the DECISION, because the transaction is here. Telegram
   * allows ten seconds end to end, so the caller is expected to bound this and
   * to refuse on timeout: an unanswered query costs the buyer nothing, while a
   * wrongly approved one takes their stars for something we may not deliver.
   */
  @Post('telegram-stars/pre-checkout')
  public async resolveTelegramStarsPreCheckout(
    @Body() body: { readonly paymentId?: unknown },
  ): Promise<TelegramStarsPreCheckoutVerdict> {
    // Anything that is not a string becomes "unknown payment", which refuses.
    // Refusing is the safe default on every unclear input here: the money has
    // not moved yet.
    const paymentId = typeof body.paymentId === 'string' ? body.paymentId : null;
    return this.telegramStarsWebhookService.resolvePreCheckout(paymentId);
  }

  /**
   * Returns the list of *enabled and ready* gateways the SPA / Mini App
   * should render on the purchase screen. Sorted by `orderIndex` so
   * operators control the visual layout from the admin panel without code
   * changes. Disabled gateways are filtered out — there's no point in
   * leaking them to user-facing surfaces.
   *
   * `isConfigured` is filtered on for the same reason, and it is not
   * redundant with `isActive`. Enabling a gateway checks readiness, but
   * nothing re-checks a row that is already on: when the credential list
   * `isGatewayConfigured` requires grows — as it did when the six
   * webhook-verifying gateways started demanding their callback key — a
   * gateway an operator switched on last month keeps `isActive: true` in
   * the database while all three checkout paths now answer
   * `PAYMENT_GATEWAY_NOT_CONFIGURED` (400). Offering it puts the buyer one
   * click from an error they can do nothing about; a missing option is the
   * better failure. The operator still sees the row, with an amber
   * "not configured" badge — see `AdminPaymentGatewayInterface.isConfigured`.
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
      .filter((gateway) => gateway.isConfigured)
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
      savePaymentMethodConsent: input.savePaymentMethodConsent,
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

  /**
   * Abandon a checkout the buyer started and does not intend to finish.
   *
   * Nothing to do with refunds — no money has moved. It cancels an unpaid draft
   * so its paid-trial reservation is freed immediately instead of after the
   * 30-minute expiry sweep, which is what otherwise hides the trial plan from
   * the buyer who just abandoned it.
   */
  @Post(':paymentId/abandon')
  public async abandon(
    @Param('paymentId') paymentId: string,
    @Query('userId') userId?: string,
    @Query('telegramId') telegramId?: string,
  ): Promise<{ abandoned: boolean; status: string }> {
    return this.paymentsCheckoutService.abandonPendingCheckout({ paymentId, userId, telegramId });
  }
}
