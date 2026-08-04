import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';
import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Currency, PaymentGateway, PaymentGatewayType, Transaction } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';

import { paymentsConfig } from '../../../common/config/payments.config';
import {
  CHECKOUT_LIFETIME_MINUTES,
  CHECKOUT_LIFETIME_SECONDS,
  checkoutExpiresAt,
} from '../constants/checkout-lifetime.constant';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { normalizePaymentProviderError, redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import {
  buildResultUrl,
  buildWebhookUrl,
  md5,
  sha1,
  readBooleanSetting,
  readOptionalString,
  readRecord,
  requireSetting,
  requireYookassaSecretKey,
  resolveFailUrl,
  resolveSuccessUrl,
  truncate,
} from './payment-provider-execution.helpers';
import { PaymentWebhookPayloadRedactionService } from './payment-webhook-payload-redaction.service';

function isYookassaCanceled(providerStatus: string | null): boolean {
  const status = providerStatus?.trim().toLowerCase();
  return status === 'canceled' || status === 'cancelled';
}

/** Version string stamped into gatewayData / metadata for autopay consent audit. */
export const YOOKASSA_AUTOPAY_CONSENT_VERSION = 'yookassa-autopay-v1';

/**
 * Resolves whether interactive YooKassa checkout should request
 * `save_payment_method`. Off-session charges never save again.
 *
 * Rules (in order):
 * 1. Off-session (`paymentMethodId` set) → never save
 * 2. Gateway `savePaymentMethod: false` → never save
 * 3. Request `savePaymentMethod: false` → never save
 * 4. Request `savePaymentMethod: true` requires `consent === true`
 * 5. Request omitted → no save (fail-closed for YooKassa informed-consent rules;
 *    cabinets must send explicit true + consent after the user ticks the box)
 */
export function resolveYookassaSavePaymentMethod(input: {
  readonly paymentMethodId: string | null;
  readonly gatewayAllows: boolean;
  readonly requestSave: boolean | null | undefined;
  readonly consent: boolean | null | undefined;
}): { readonly save: boolean; readonly consent: boolean; readonly reason: string } {
  if (input.paymentMethodId !== null) {
    return { save: false, consent: false, reason: 'off_session' };
  }
  if (!input.gatewayAllows) {
    return { save: false, consent: false, reason: 'gateway_disabled' };
  }
  if (input.requestSave === false) {
    return { save: false, consent: false, reason: 'request_opt_out' };
  }
  if (input.requestSave === true) {
    if (input.consent === true) {
      return { save: true, consent: true, reason: 'request_with_consent' };
    }
    // Explicit save without consent is rejected (YooKassa requires informed consent).
    return { save: false, consent: false, reason: 'consent_required' };
  }
  // Omitted fields: do not auto-bind (old clients no longer get silent save).
  return { save: false, consent: false, reason: 'consent_required_omit' };
}

interface ProviderCheckoutResult {
  readonly gatewayId: string | null;
  readonly checkoutUrl: string | null;
  readonly providerMode: string;
  readonly providerStatus: string | null;
  readonly gatewayData: Record<string, unknown>;
  readonly yookassaPaymentPayload?: unknown;
}

@Injectable()
export class PaymentProviderExecutionService {
  public constructor(
    private readonly httpService: HttpService,
    @Inject(paymentsConfig.KEY)
    private readonly configuration: ConfigType<typeof paymentsConfig>,
    private readonly paymentWebhookPayloadRedactionService: PaymentWebhookPayloadRedactionService,
  ) {}

  public async createCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
    /**
     * Provider payment_method.id for off-session charge (YooKassa autopay).
     * When set, YooKassa is called with `payment_method_id` instead of redirect.
     */
    readonly paymentMethodId?: string | null;
    /** Local SavedPaymentMethod.id — stored in gatewayData for audit only. */
    readonly savedPaymentMethodId?: string | null;
    /**
     * Per-request bind-card intent for interactive YooKassa. See
     * {@link resolveYookassaSavePaymentMethod}.
     */
    readonly savePaymentMethod?: boolean | null;
    /** Explicit user consent to bind the card for future autopay. */
    readonly savePaymentMethodConsent?: boolean | null;
    /**
     * Payer identity for the providers that put a buyer on the invoice:
     * Antilopay (`customer` is mandatory and must carry an email or a phone —
     * error 11), SeverPay (`client_email` is required and signed over) and
     * Lava (the address is the invoice recipient).
     *
     * Still optional, because it still does not reach this layer. `Transaction`
     * carries `userId` but no email, this service has no Prisma access, and
     * none of the three callers holds the user row: `PaymentsCheckoutService`,
     * `PaymentsRenewalCheckoutService` and `AddOnPurchaseService` each resolve
     * an id and stop (`select: { id: true }`, and only on the Telegram branch —
     * a request that supplies `userId` reads no user at all). Filling this in
     * therefore costs one extra query per checkout in all three, on the hot
     * path, for a column that is nullable anyway; declared here so that can be
     * done later without reshaping the gateway methods. Until then all three
     * gateways fall back to a routable per-payment address — see
     * {@link resolveCustomerEmail} — and none of them invents an `ip`.
     */
    readonly customerEmail?: string | null;
    /** Buyer's request IP, forwarded verbatim to providers that ask for it. */
    readonly customerIp?: string | null;
  }): Promise<ProviderCheckoutResult> {
    try {
      switch (input.gateway.type) {
        case PaymentGatewayType.YOOKASSA:
          return await this.createYookassaCheckout(input);
        case PaymentGatewayType.PLATEGA:
          return await this.createPlategaCheckout(input);
        case PaymentGatewayType.HELEKET:
          return await this.createHeleketCheckout(input);
        case PaymentGatewayType.CRYPTOMUS:
          return await this.createCryptomusCheckout(input);
        case PaymentGatewayType.MULENPAY:
          return await this.createMulenpayCheckout(input);
        case PaymentGatewayType.TELEGRAM_STARS:
          return await this.createTelegramStarsCheckout(input);
        case PaymentGatewayType.ANTILOPAY:
          return await this.createAntilopayCheckout(input);
        case PaymentGatewayType.OVERPAY:
          return await this.createOverpayCheckout(input);
        case PaymentGatewayType.PAYPALYCH:
          return await this.createPaypalychCheckout(input);
        case PaymentGatewayType.RIOPAY:
          return await this.createRiopayCheckout(input);
        case PaymentGatewayType.VALUTIX:
          return await this.createValutixCheckout(input);
        case PaymentGatewayType.WATA:
          return await this.createWataCheckout(input);
        case PaymentGatewayType.AURAPAY:
          return await this.createAurapayCheckout(input);
        case PaymentGatewayType.ROLLYPAY:
          return await this.createRollypayCheckout(input);
        case PaymentGatewayType.SEVERPAY:
          return await this.createSeverpayCheckout(input);
        case PaymentGatewayType.LAVA:
          return await this.createLavaCheckout(input);
        case PaymentGatewayType.CRYPTOPAY:
          return await this.createCryptopayCheckout(input);
        default:
          throw new NotFoundException('Payment gateway not supported');
      }
    } catch (error: unknown) {
      if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException(normalizePaymentProviderError(error));
    }
  }

  private async createYookassaCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
    readonly paymentMethodId?: string | null;
    readonly savedPaymentMethodId?: string | null;
    readonly savePaymentMethod?: boolean | null;
    readonly savePaymentMethodConsent?: boolean | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const shopId = requireSetting(settings, 'shopId');
    const apiKey = requireYookassaSecretKey(settings);
    const paymentMethodId =
      typeof input.paymentMethodId === 'string' && input.paymentMethodId.trim().length > 0
        ? input.paymentMethodId.trim()
        : null;
    // Interactive bind: gateway allow + per-request intent + explicit consent.
    // Off-session charges never re-request save. See resolveYookassaSavePaymentMethod.
    const saveDecision = resolveYookassaSavePaymentMethod({
      paymentMethodId,
      gatewayAllows: readBooleanSetting(settings, 'savePaymentMethod', true),
      requestSave: input.savePaymentMethod,
      consent: input.savePaymentMethodConsent,
    });
    const savePaymentMethod = saveDecision.save;

    const payload: Record<string, unknown> = {
      amount: {
        value: input.transaction.amount.toString(),
        currency: input.transaction.currency,
      },
      capture: true,
      description: input.description.slice(0, 128),
      metadata: {
        paymentId: input.transaction.paymentId,
        transactionId: input.transaction.id,
        userId: input.transaction.userId,
        ...(typeof input.savedPaymentMethodId === 'string' &&
        input.savedPaymentMethodId.length > 0
          ? { savedPaymentMethodId: input.savedPaymentMethodId }
          : {}),
        savePaymentMethod,
        ...(savePaymentMethod && saveDecision.consent
          ? {
              savePaymentMethodConsent: true,
              consentVersion: YOOKASSA_AUTOPAY_CONSENT_VERSION,
            }
          : {}),
      },
    };

    if (paymentMethodId !== null) {
      // Merchant-initiated charge with a previously saved instrument.
      payload.payment_method_id = paymentMethodId;
    } else {
      const resultUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
      payload.confirmation = {
        type: 'redirect',
        return_url: resultUrl,
      };
      if (savePaymentMethod) {
        payload.save_payment_method = true;
      }
    }

    const response = await firstValueFrom(
      this.httpService.post('https://api.yookassa.ru/v3/payments', payload, {
        auth: {
          username: shopId,
          password: apiKey,
        },
        headers: {
          'Idempotence-Key': input.transaction.paymentId,
        },
        validateStatus: () => true,
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ServiceUnavailableException(
        `YooKassa create payment failed: HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 300)}`,
      );
    }
    const data = response.data as Record<string, unknown>;
    const confirmation = readRecord(data.confirmation);
    const responseCheckoutUrl = readOptionalString(confirmation, ['confirmation_url']);
    const providerStatus = readOptionalString(data, ['status']);
    const isCanceled = isYookassaCanceled(providerStatus);
    const checkoutUrl = isCanceled ? null : responseCheckoutUrl;
    const gatewayId = readOptionalString(data, ['id']);
    if (gatewayId === null) {
      throw new ServiceUnavailableException('YooKassa create payment: missing payment id');
    }
    // Interactive checkout must always return a redirect URL. Off-session
    // charges often complete without confirmation (or only with 3DS).
    if (paymentMethodId === null && checkoutUrl === null && !isCanceled) {
      throw new ServiceUnavailableException('YooKassa create payment: missing confirmation_url');
    }
    const providerMode = checkoutUrl !== null ? 'REDIRECT' : 'IMMEDIATE';
    return {
      gatewayId,
      checkoutUrl,
      providerMode,
      providerStatus,
      yookassaPaymentPayload: data,
      gatewayData: {
        provider: 'YOOKASSA',
        providerStatus,
        providerResponse: this.redactProviderResponse(data),
        ...(isCanceled ? { cancellation_details: this.redactProviderResponse(readRecord(data['cancellation_details'])) } : {}),
        checkoutUrl,
        providerMode,
        savePaymentMethod,
        savePaymentMethodConsent: saveDecision.consent,
        // Only stamp consent audit when the user explicitly consented
        // (not for legacy gateway-default saves without a client checkbox).
        consentVersion: saveDecision.consent ? YOOKASSA_AUTOPAY_CONSENT_VERSION : null,
        consentAt: saveDecision.consent ? new Date().toISOString() : null,
        savePaymentMethodReason: saveDecision.reason,
        paymentMethodId,
        savedPaymentMethodId:
          typeof input.savedPaymentMethodId === 'string' && input.savedPaymentMethodId.length > 0
            ? input.savedPaymentMethodId
            : null,
      },
    };
  }

  private async createPlategaCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const merchantId = requireSetting(settings, 'merchantId');
    const secret = requireSetting(settings, 'secret');
    const paymentMethod = typeof settings.paymentMethod === 'number' ? settings.paymentMethod : 2;
    const successResultUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failResultUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);
    const payload = {
      paymentMethod,
      paymentDetails: {
        amount: Number(input.transaction.amount.toString()),
        currency: input.transaction.currency,
      },
      description: input.description.slice(0, 64),
      payload: input.transaction.paymentId,
      return: successResultUrl,
      failedUrl: failResultUrl,
    };
    const response = await firstValueFrom(
      this.httpService.post('https://app.platega.io/transaction/process', payload, {
        headers: {
          'X-MerchantId': merchantId,
          'X-Secret': secret,
        },
      }),
    );
    const data = response.data as Record<string, unknown>;
    const checkoutUrl =
      readOptionalString(data, ['redirect', 'paymentUrl', 'url']);
    return {
      gatewayId: readOptionalString(data, ['transactionId', 'id']),
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']),
      gatewayData: {
        provider: 'PLATEGA',
        providerStatus: readOptionalString(data, ['status']),
        providerResponse: this.redactProviderResponse(data),
        checkoutUrl,
      },
    };
  }

  private async createHeleketCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const merchantId = requireSetting(settings, 'merchantId');
    const apiKey = requireSetting(settings, 'apiKey');
    const resultUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const payload = {
      amount: input.transaction.amount.toString(),
      currency: input.transaction.currency === Currency.XTR ? Currency.USD : input.transaction.currency,
      order_id: input.transaction.paymentId,
      description: input.description.slice(0, 255),
      // Was unset, so the invoice took Heleket's 1-hour default and outlived
      // our 30-minute sweep. Heleket accepts 300–43200 seconds.
      lifetime: CHECKOUT_LIFETIME_SECONDS,
      url_success: resultUrl,
      url_return: resultUrl,
      // Heleket sends webhooks to this per-invoice address; a merchant-level
      // fallback is not documented. Cryptomus already received one — omitting
      // it here meant Heleket had no address to notify at all, and it also
      // disables `/v1/payment/resend`, the manual replay for a lost webhook.
      url_callback: this.buildWebhookUrl(PaymentGatewayType.HELEKET),
    };
    const serializedPayload = Buffer.from(JSON.stringify(payload), 'utf8');
    const sign = md5(`${serializedPayload.toString('base64')}${apiKey}`);
    const response = await firstValueFrom(
      this.httpService.post('https://api.heleket.com/v1/payment', payload, {
        headers: {
          merchant: merchantId,
          sign,
          'Content-Type': 'application/json',
        },
      }),
    );
    const data = response.data as Record<string, unknown>;
    const result = readRecord(data.result);
    const checkoutUrl = readOptionalString(result, ['url', 'payment_url', 'paymentUrl', 'invoice_url']);
    return {
      gatewayId: readOptionalString(result, ['uuid', 'id']),
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(result, ['status']),
      gatewayData: {
        provider: 'HELEKET',
        providerStatus: readOptionalString(result, ['status']),
        providerResponse: this.redactProviderResponse(data),
        checkoutUrl,
      },
    };
  }

  private async createCryptomusCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const merchantId = requireSetting(settings, 'merchantId');
    const apiKey = requireSetting(settings, 'apiKey');
    const resultUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const webhookUrl = this.buildWebhookUrl(input.gateway.type);
    const payload = {
      amount: input.transaction.amount.toString(),
      currency: input.transaction.currency === Currency.XTR ? Currency.USD : input.transaction.currency,
      order_id: input.transaction.paymentId,
      description: input.description.slice(0, 255),
      url_return: resultUrl,
      url_success: resultUrl,
      is_payment_multiple: false,
      // Was the provider default (3600). Aligned with our own pending sweep so
      // the invoice cannot outlive the draft we cancel. Cryptomus accepts
      // 300–43200 seconds.
      lifetime: CHECKOUT_LIFETIME_SECONDS,
      url_callback: webhookUrl,
    };
    const serializedPayload = Buffer.from(JSON.stringify(payload), 'utf8');
    const sign = md5(`${serializedPayload.toString('base64')}${apiKey}`);
    const response = await firstValueFrom(
      this.httpService.post('https://api.cryptomus.com/v1/payment', payload, {
        headers: {
          merchant: merchantId,
          sign,
          'Content-Type': 'application/json',
        },
      }),
    );
    const data = response.data as Record<string, unknown>;
    const result = readRecord(data.result);
    const checkoutUrl =
      readOptionalString(result, ['url', 'payment_url', 'address_qr_code']);
    return {
      gatewayId: readOptionalString(result, ['uuid', 'payment_uuid']),
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(result, ['status']),
      gatewayData: {
        provider: 'CRYPTOMUS',
        providerStatus: readOptionalString(result, ['status']),
        providerResponse: this.redactProviderResponse(data),
        checkoutUrl,
      },
    };
  }

  private async createCryptopayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiToken = requireSetting(settings, 'apiToken');
    const isTestnet = settings['isTestnet'] === true;
    const baseUrl = isTestnet ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api';
    const resultUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    // Our gateway currency is already a CryptoPay-supported crypto asset (the
    // supported-currencies catalog enforces this). USD is mapped to USDT
    // defensively in case an operator left a stale fiat currency on the row.
    const asset = input.transaction.currency === Currency.USD ? 'USDT' : input.transaction.currency;
    const payload: Record<string, unknown> = {
      currency_type: 'crypto',
      asset,
      amount: input.transaction.amount.toString(),
      description: input.description.slice(0, 1024),
      payload: input.transaction.paymentId,
      // Crypto Pay leaves the default undocumented when this is omitted, so an
      // invoice could stay payable indefinitely. Accepts 1–2678400 seconds.
      expires_in: CHECKOUT_LIFETIME_SECONDS,
    };
    // `paid_btn_url` must be an absolute http(s) URL; only attach the
    // post-payment "Return" button when we actually resolved one.
    if (typeof resultUrl === 'string' && /^https?:\/\//i.test(resultUrl)) {
      payload['paid_btn_name'] = 'callback';
      payload['paid_btn_url'] = resultUrl;
    }
    const response = await firstValueFrom(
      this.httpService.post(`${baseUrl}/createInvoice`, payload, {
        headers: {
          'Crypto-Pay-API-Token': apiToken,
          'Content-Type': 'application/json',
        },
      }),
    );
    const data = response.data as Record<string, unknown>;
    if (data['ok'] !== true) {
      throw new ServiceUnavailableException('CryptoPay createInvoice failed');
    }
    const result = readRecord(data['result']);
    const checkoutUrl = readOptionalString(result, ['bot_invoice_url', 'mini_app_invoice_url', 'web_app_invoice_url']);
    const invoiceId = readOptionalString(result, ['invoice_id']);
    return {
      gatewayId: invoiceId,
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(result, ['status']),
      gatewayData: {
        provider: 'CRYPTOPAY',
        providerStatus: readOptionalString(result, ['status']),
        providerResponse: this.redactProviderResponse(data),
        checkoutUrl,
      },
    };
  }

  private async createMulenpayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiKey = requireSetting(settings, 'apiKey');
    const shopId = requireSetting(settings, 'shopId');
    const secretKey = requireSetting(settings, 'secretKey');
    // MulenPay accepts roubles only — `currency` is an enum of exactly
    // `['rub']`, lower-case — which is why the literal below is not derived
    // from the transaction. That makes a non-RUB transaction a *silent*
    // mispricing rather than a rejected request: a $5 plan books
    // `amount = 5.00, currency = USD`, we would post `{currency: 'rub',
    // amount: '5'}`, and the buyer pays 5 ₽ while the row still records USD.
    // `GATEWAY_SUPPORTED_CURRENCIES.MULENPAY` now lists RUB alone, but a row
    // seeded before that still carries its old currency and nothing
    // re-validates it at checkout time, so refuse here as well: a ~100×
    // under-charge is far worse than a visible failure.
    if (input.transaction.currency !== Currency.RUB) {
      throw new BadRequestException('PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED');
    }
    // Amount as a decimal string in major units.
    const amount = input.transaction.amount.toString();
    const receiptDescription = input.description.slice(0, 128);
    const payload = {
      currency: 'rub',
      amount,
      // Our own id. It comes back in the webhook as `uuid`, and is the only way
      // to match a notification to a transaction — the previous `orderId` was
      // not a documented field, so nothing we sent survived the round trip.
      uuid: input.transaction.paymentId,
      shopId,
      description: input.description.slice(0, 255),
      // `sign` = sha1(currency + amount + shopId + secretKey). Note it covers
      // neither `uuid` nor `items`, so it authenticates the caller and the sum,
      // not the basket.
      sign: sha1(`rub${amount}${shopId}${secretKey}`),
      // Fiscal receipt is required by the schema. Codes come from gateway
      // settings because they follow the merchant's tax regime; the fallbacks
      // are MulenPay's own «без НДС» (1), «услуга» (4) and «полный расчёт» (4),
      // which match how this product sells subscriptions.
      items: [
        {
          description: receiptDescription,
          price: amount,
          quantity: 1,
          vat_code: Number(readOptionalString(settings, ['vatCode']) ?? '1'),
          payment_subject: Number(readOptionalString(settings, ['paymentSubject']) ?? '4'),
          payment_mode: Number(readOptionalString(settings, ['paymentMode']) ?? '4'),
        },
      ],
      language: 'ru',
    };
    const response = await firstValueFrom(
      // Base URL is `https://mulenpay.ru/api`; the previous path omitted `/api`
      // entirely. Auth is a bearer token, not the `api-key` headers we sent.
      this.httpService.post('https://mulenpay.ru/api/v2/payments', payload, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }),
    );
    const data = response.data as Record<string, unknown>;
    const checkoutUrl = readOptionalString(data, ['paymentUrl', 'url']);
    return {
      gatewayId: readOptionalString(data, ['uuid', 'id']),
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']),
      gatewayData: {
        provider: 'MULENPAY',
        providerStatus: readOptionalString(data, ['status']),
        providerResponse: this.redactProviderResponse(data),
        checkoutUrl,
      },
    };
  }

  private async createTelegramStarsCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const botToken = this.configuration.botToken;
    if (botToken === null) {
      throw new ServiceUnavailableException('Telegram bot token is not configured');
    }
    if (input.transaction.currency !== Currency.XTR) {
      throw new ServiceUnavailableException('Telegram Stars payments require XTR pricing');
    }
    const payload = {
      title: truncate(input.description, 32),
      description: truncate(input.description, 255),
      payload: input.transaction.paymentId,
      currency: 'XTR',
      prices: [
        {
          label: 'Telegram Stars',
          amount: Number(input.transaction.amount.toString()),
        },
      ],
    };
    const response = await firstValueFrom(
      this.httpService.post(
        `https://api.telegram.org/bot${botToken}/createInvoiceLink`,
        payload,
      ),
    );
    const data = response.data as Record<string, unknown>;
    if (data.ok !== true || typeof data.result !== 'string') {
      throw new ServiceUnavailableException('Telegram Stars invoice creation failed');
    }
    return {
      gatewayId: input.transaction.paymentId,
      checkoutUrl: data.result,
      providerMode: 'TELEGRAM_INVOICE',
      providerStatus: 'invoice_created',
      gatewayData: {
        provider: 'TELEGRAM_STARS',
        providerStatus: 'invoice_created',
        providerResponse: this.redactProviderResponse(data),
        checkoutUrl: data.result,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ANTILOPAY — https://lk.antilopay.com/api/v1/payment/create
  //  Auth: SHA256WithRSA signature in X-Apay-Sign header
  // ═══════════════════════════════════════════════════════════════════════════

  private async createAntilopayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
    readonly customerEmail?: string | null;
    readonly customerIp?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const crypto = await import('crypto');
    const settings = readGatewaySettings(input.gateway.settings);
    const projectIdentificator = requireSetting(settings, 'projectIdentificator');
    const secretId = requireSetting(settings, 'secretId');
    const privateKeyPem = this.toAntilopayPrivateKeyPem(requireSetting(settings, 'privateKey'));
    const vat = this.readAntilopayVat(settings);
    const customerIp = this.readAntilopayCustomerIp(input.customerIp);

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);

    const payload = {
      project_identificator: projectIdentificator,
      amount: Number(input.transaction.amount),
      order_id: input.transaction.paymentId,
      currency: 'rub',
      product_name: input.description.slice(0, 128),
      product_type: 'services',
      // Left out entirely unless the operator configured a rate — see
      // `antilopayVatSetting`. Sending nothing is correct for УСН/НПД; for a
      // merchant on ОСНО an absent rate is error 17 on every single checkout.
      ...(vat === null ? {} : { vat }),
      description: input.description.slice(0, 255),
      success_url: successUrl,
      fail_url: failUrl,
      customer: {
        // `customer` is mandatory here and must carry an email or a phone —
        // error 11. The callback echoes the block straight back to us, so this
        // is also the only handle tying a payer to a dispute; the single shared
        // literal that stood here («customer@rezeis.local») threw that away and
        // was a plausible error 12 («Данные Покупателя содержат ошибку») besides.
        email: this.resolveCustomerEmail(input),
        // Documented as optional, yet error 32 («Данные Покупателя должны
        // содержать ip») exists — some project configurations reject a buyer
        // block without it. Sent when the caller knows the address; never
        // invented, since a wrong IP is a worse answer than none.
        ...(customerIp === null ? {} : { ip: customerIp }),
      },
    };

    const bodyString = JSON.stringify(payload);
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(bodyString);
    const signature = sign.sign(privateKeyPem, 'base64');

    const response = await firstValueFrom(
      this.httpService.post('https://lk.antilopay.com/api/v1/payment/create', bodyString, {
        headers: {
          'Content-Type': 'application/json',
          'X-Apay-Secret-Id': secretId,
          'X-Apay-Sign': signature,
          'X-Apay-Sign-Version': '1',
        },
      }),
    );

    const data = response.data as Record<string, unknown>;
    if (data.code !== 0) {
      const providerError = redactPaymentDiagnosticMessage(String(data.error ?? 'unknown'), 120) ?? 'unknown';
      throw new BadRequestException(`Antilopay error ${data.code}: ${providerError}`);
    }

    return {
      gatewayId: readOptionalString(data, ['payment_id']),
      checkoutUrl: readOptionalString(data, ['payment_url']),
      providerMode: 'REDIRECT',
      providerStatus: 'PENDING',
      gatewayData: { provider: 'ANTILOPAY', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(data, ['payment_url']) },
    };
  }

  /**
   * Re-armors the stored Antilopay signing key before OpenSSL sees it.
   *
   * The value arrives through the admin form as whatever the operator had on
   * the clipboard, and OpenSSL 3 is unforgiving about the difference. Measured
   * on Node 24 / OpenSSL 3.5.5, wrapping the setting directly in armor signs
   * correctly for raw base64, for 64-column-wrapped base64 and even with
   * embedded spaces — but a value carrying a **trailing newline**, or one that
   * is **already a complete PEM** with its own `-----BEGIN…` lines, throws
   * `ERR_OSSL_UNSUPPORTED`. Both are precisely what copying a key out of a
   * cabinet or a `.pem` file produces, and both were rethrown upstream as a
   * bare 503: the gateway went dark with no diagnostic naming the key.
   *
   * So the setting is reduced to its base64 body and re-wrapped at 64 columns.
   * The `RSA PRIVATE KEY` label is deliberately kept — Antilopay issues a
   * PKCS#8 key (its own Java, Go and C# samples read it with
   * `PKCS8EncodedKeySpec` / `ParsePKCS8PrivateKey` / `ImportPkcs8PrivateKey`),
   * and OpenSSL 3 signs that body under this label exactly as the provider's
   * own PHP and Node samples do. The armor was never the defect.
   */
  private toAntilopayPrivateKeyPem(privateKey: string): string {
    const base64Body = privateKey
      .replace(/-----(?:BEGIN|END)[^-]*-----/g, '')
      .replace(/\s+/g, '');
    const wrappedBody = base64Body.match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN RSA PRIVATE KEY-----\n${wrappedBody}\n-----END RSA PRIVATE KEY-----\n`;
  }

  /**
   * VAT rate for the invoice — «Поле обязательное, если сно Мерчанта - ОСНО»
   * (Antilopay API, p.14), and its absence is error 17 for such a merchant.
   * Settings normalization stores a number, but a hand-edited row can hold the
   * numeric string an admin form posts. Anything else is treated as unset:
   * the enum is enforced at save time, so a stray value here is a legacy row,
   * and УСН/НПД merchants must send no rate at all.
   */
  private readAntilopayVat(settings: Record<string, unknown>): number | null {
    const raw = settings.vat;
    if (raw === 10 || raw === 22) {
      return raw;
    }
    if (typeof raw === 'string' && (raw.trim() === '10' || raw.trim() === '22')) {
      return Number(raw.trim());
    }
    return null;
  }

  /**
   * Normalizes a buyer IP for `customer.ip`. Dual-stack Node hands out the
   * IPv4-mapped form (`::ffff:203.0.113.7`) for an ordinary IPv4 client, which
   * is not what a provider expects to store, so it is unwrapped. Anything that
   * is not a valid address is dropped rather than forwarded — a malformed one
   * risks error 12 on a field that is documented as optional.
   */
  private readAntilopayCustomerIp(rawIp: string | null | undefined): string | null {
    const candidate = rawIp?.trim() ?? '';
    if (candidate.length === 0) {
      return null;
    }
    const unwrapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate)?.[1] ?? candidate;
    return isIP(unwrapped) === 0 ? null : unwrapped;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OVERPAY — https://checkout.overpay.io/ctp/api/checkouts
  //  Auth: Basic (shopId:secretKey)
  // ═══════════════════════════════════════════════════════════════════════════

  private async createOverpayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const shopId = requireSetting(settings, 'shopId');
    const secretKey = requireSetting(settings, 'secretKey');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);
    const webhookUrl = this.buildWebhookUrl(PaymentGatewayType.OVERPAY);

    const payload = {
      checkout: {
        test: false,
        transaction_type: 'payment',
        order: {
          amount: Math.round(Number(input.transaction.amount) * 100),
          currency: 'RUB',
          description: input.description.slice(0, 255),
          tracking_id: input.transaction.paymentId,
          // ISO-8601 timestamp. Overpay's default is 24 hours; this brings the
          // token's life down to our own sweep window.
          expired_at: checkoutExpiresAt(),
        },
        settings: {
          success_url: successUrl,
          decline_url: failUrl,
          fail_url: failUrl,
          notification_url: webhookUrl,
          language: 'ru',
          auto_return: 3,
        },
      },
    };

    const response = await firstValueFrom(
      this.httpService.post('https://checkout.overpay.io/ctp/api/checkouts', payload, {
        auth: { username: shopId, password: secretKey },
        headers: {
          'Content-Type': 'application/json',
          // Both are documented as required; the version header in particular
          // is not optional — the checkout contract differs between versions.
          Accept: 'application/json',
          'X-API-Version': '2',
        },
      }),
    );

    const data = response.data as Record<string, unknown>;
    const checkout = readRecord(data.checkout);

    return {
      gatewayId: readOptionalString(checkout, ['token']),
      checkoutUrl: readOptionalString(checkout, ['redirect_url']),
      providerMode: 'REDIRECT',
      providerStatus: 'PENDING',
      gatewayData: { provider: 'OVERPAY', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(checkout, ['redirect_url']) },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PAYPALYCH — https://paypalych.com/api/v1/bill/create
  //  Auth: Bearer token
  // ═══════════════════════════════════════════════════════════════════════════

  private async createPaypalychCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const shopId = requireSetting(settings, 'shopId');
    const apiKey = requireSetting(settings, 'apiKey');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);
    const webhookUrl = this.buildWebhookUrl(PaymentGatewayType.PAYPALYCH);

    const payload = {
      amount: Number(input.transaction.amount),
      order_id: input.transaction.paymentId,
      description: input.description.slice(0, 255),
      type: 'normal',
      // Seconds — not minutes, unlike AuraPay's and SeverPay's `lifetime`.
      // Pally's own reference states it outright, in both the Bill model and
      // the `bill/create` request table: «Время жизни счета на оплату в
      // секундах», integer, with 600 as the illustrated value. Worth stating
      // because reading it as minutes would make this a 30-HOUR bill, which is
      // precisely the case the checkout-lifetime invariant exists to prevent.
      // No minimum or maximum is documented, so an unset value left the bill's
      // life entirely up to the provider.
      ttl: CHECKOUT_LIFETIME_SECONDS,
      shop_id: shopId,
      currency_in: 'RUB',
      success_url: successUrl,
      fail_url: failUrl,
      webhook_url: webhookUrl,
    };

    const response = await firstValueFrom(
      // `paypalych.com` no longer resolves; the current documentation knows
      // only `pal24.pro`. Pally / PayPalych / Pal24 are one service.
      this.httpService.post('https://pal24.pro/api/v1/bill/create', payload, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      }),
    );

    const data = response.data as Record<string, unknown>;
    return {
      gatewayId: readOptionalString(data, ['bill_id', 'id']),
      checkoutUrl: readOptionalString(data, ['link_page_url', 'pay_url', 'link_url']),
      providerMode: 'REDIRECT',
      providerStatus: 'PENDING',
      gatewayData: { provider: 'PAYPALYCH', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(data, ['link_page_url', 'pay_url', 'link_url']) },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RIOPAY — https://api.riopay.online/v1/orders
  //  Auth: X-Api-Token header
  // ═══════════════════════════════════════════════════════════════════════════

  private async createRiopayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiToken = requireSetting(settings, 'apiToken');
    const serviceId = this.readRiopayEngineServiceId(settings);

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);
    const webhookUrl = this.buildWebhookUrl(PaymentGatewayType.RIOPAY);

    const payload = {
      amount: input.transaction.amount.toString(),
      externalId: input.transaction.paymentId,
      purpose: input.description.slice(0, 255),
      successUrl,
      failUrl,
      callbackUrl: webhookUrl,
      ...(serviceId === null ? {} : { serviceId }),
    };

    const response = await firstValueFrom(
      this.httpService.post('https://api.riopay.online/v1/orders', payload, {
        headers: { 'Content-Type': 'application/json', 'X-Api-Token': apiToken },
      }),
    );

    const data = response.data as Record<string, unknown>;
    return {
      gatewayId: readOptionalString(data, ['id']),
      checkoutUrl: readOptionalString(data, ['paymentLink']),
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']) ?? 'PENDING',
      gatewayData: { provider: 'RIOPAY', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(data, ['paymentLink']) },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  VALUTIX — https://api.panel.valutix.kz/v1/orders
  //  Same platform engine as RIOPAY. Auth: X-Api-Token header.
  //  Body mirrors RIOPAY but also carries externalUserId.
  // ═══════════════════════════════════════════════════════════════════════════

  private async createValutixCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiToken = requireSetting(settings, 'apiToken');
    const serviceId = this.readRiopayEngineServiceId(settings);

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);
    const webhookUrl = this.buildWebhookUrl(PaymentGatewayType.VALUTIX);

    const payload = {
      amount: input.transaction.amount.toString(),
      externalId: input.transaction.paymentId,
      externalUserId: input.transaction.userId,
      purpose: input.description.slice(0, 255),
      successUrl,
      failUrl,
      callbackUrl: webhookUrl,
      ...(serviceId === null ? {} : { serviceId }),
    };

    const response = await firstValueFrom(
      this.httpService.post('https://api.panel.valutix.kz/v1/orders', payload, {
        headers: { 'Content-Type': 'application/json', 'X-Api-Token': apiToken },
      }),
    );

    const data = response.data as Record<string, unknown>;
    return {
      gatewayId: readOptionalString(data, ['id']),
      checkoutUrl: readOptionalString(data, ['paymentLink']),
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']) ?? 'PENDING',
      gatewayData: { provider: 'VALUTIX', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(data, ['paymentLink']) },
    };
  }

  /**
   * RioPay/Valutix route each order through a `serviceId` — «сервис, через
   * который провести платёж». Newer accounts require it; legacy single-service
   * ones have nothing to pick, so an unset value is left out of the body
   * entirely rather than sent as null. Settings normalization stores a number,
   * but a hand-edited row can hold the numeric string an admin form posts.
   */
  private readRiopayEngineServiceId(settings: Record<string, unknown>): number | null {
    const raw = settings.serviceId;
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
      return raw;
    }
    if (typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim())) {
      return Number(raw.trim());
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  WATA — https://api.wata.pro/api/h2h/links
  //  Auth: Bearer JWT API key
  //  Docs: https://wata.pro/api
  // ═══════════════════════════════════════════════════════════════════════════

  private async createWataCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiKey = requireSetting(settings, 'apiKey');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);

    const payload = {
      amount: Number(input.transaction.amount),
      currency: input.transaction.currency === Currency.RUB ? 'RUB' : 'USD',
      orderId: input.transaction.paymentId,
      description: input.description.slice(0, 255),
      successRedirectUrl: successUrl,
      failRedirectUrl: failUrl,
      // An absolute timestamp here, not a duration. Wata's default is THREE
      // DAYS — by far the widest gap between a link we consider dead and one
      // the buyer can still pay. Accepts 10 minutes to 30 days.
      expirationDateTime: checkoutExpiresAt(),
    };

    const response = await firstValueFrom(
      this.httpService.post('https://api.wata.pro/api/h2h/links', payload, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      }),
    );

    const data = response.data as Record<string, unknown>;
    return {
      gatewayId: readOptionalString(data, ['id']),
      checkoutUrl: readOptionalString(data, ['url', 'paymentUrl']),
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']) ?? 'PENDING',
      gatewayData: { provider: 'WATA', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(data, ['url', 'paymentUrl']) },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  AURAPAY — https://app.aurapay.tech/invoice/create
  //  Auth: X-ApiKey + X-ShopId headers
  //  Docs: https://docs.aurapay.tech/
  // ═══════════════════════════════════════════════════════════════════════════

  private async createAurapayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiKey = requireSetting(settings, 'apiKey');
    const shopId = requireSetting(settings, 'shopId');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);
    const callbackUrl = this.buildWebhookUrl(PaymentGatewayType.AURAPAY);

    const payload = {
      amount: Number(input.transaction.amount),
      order_id: input.transaction.paymentId,
      success_url: successUrl,
      fail_url: failUrl,
      callback_url: callbackUrl,
      comment: input.description.slice(0, 255),
      // Minutes here, not seconds. Was the provider default (60); AuraPay
      // accepts 1–43200.
      lifetime: CHECKOUT_LIFETIME_MINUTES,
    };

    const response = await firstValueFrom(
      this.httpService.post('https://app.aurapay.tech/invoice/create', payload, {
        headers: { 'Content-Type': 'application/json', 'X-ApiKey': apiKey, 'X-ShopId': shopId },
      }),
    );

    const data = response.data as Record<string, unknown>;
    const paymentData = readRecord(data.payment_data);
    const checkoutUrl = readOptionalString(paymentData, ['url']);
    return {
      gatewayId: readOptionalString(data, ['id']),
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']) ?? 'PENDING',
      gatewayData: { provider: 'AURAPAY', providerResponse: this.redactProviderResponse(data), checkoutUrl },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ROLLYPAY — https://rollypay.io/api/v1/payments
  //  Auth: X-API-Key + X-Nonce per request
  //  Docs: https://docs.rollypay.io/api/payments
  // ═══════════════════════════════════════════════════════════════════════════

  private async createRollypayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const crypto = await import('crypto');
    const settings = readGatewaySettings(input.gateway.settings);
    const apiKey = requireSetting(settings, 'apiKey');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);

    const payload = {
      amount: input.transaction.amount.toString(),
      payment_currency: 'RUB',
      order_id: input.transaction.paymentId,
      description: input.description.slice(0, 255),
      success_redirect_url: successUrl,
      fail_redirect_url: failUrl,
    };

    const response = await firstValueFrom(
      this.httpService.post('https://rollypay.io/api/v1/payments', payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'X-Nonce': crypto.randomUUID(),
        },
      }),
    );

    const data = response.data as Record<string, unknown>;
    return {
      gatewayId: readOptionalString(data, ['payment_id']),
      checkoutUrl: readOptionalString(data, ['pay_url']),
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']) ?? 'PENDING',
      gatewayData: { provider: 'ROLLYPAY', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(data, ['pay_url']) },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SEVERPAY — https://severpay.io/api/merchant/payin/create
  //  Auth: HMAC-SHA256 sign in body (mid + salt + payload, sorted keys)
  //  Docs: https://docs.severpay.io/en/payin/create
  // ═══════════════════════════════════════════════════════════════════════════

  private async createSeverpayCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
    readonly customerEmail?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const crypto = await import('crypto');
    const settings = readGatewaySettings(input.gateway.settings);
    const mid = requireSetting(settings, 'mid');
    const secretToken = requireSetting(settings, 'secretToken');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    // `client_email` is required and is covered by the signature, so it cannot
    // simply be dropped. SeverPay itself sanctions a synthetic address — the
    // docs tell Telegram-authenticated services to derive one from the Telegram
    // identity — but the domain still has to exist, and `${userId}@rezeis.local`
    // did not. What the provider does with the address beyond identifying the
    // buyer is not documented either way, so this stays routable on principle.
    const customerEmail = this.resolveCustomerEmail(input);
    const salt = crypto.randomBytes(8).toString('hex');

    const baseBody: Record<string, unknown> = {
      mid: Number(mid),
      salt,
      order_id: input.transaction.paymentId,
      amount: Number(input.transaction.amount),
      currency: input.transaction.currency === Currency.RUB ? 'RUB' : 'USD',
      client_email: customerEmail,
      client_id: input.transaction.userId ?? input.transaction.paymentId,
      url_return: successUrl,
      // Minutes. Was the provider default (1440 = 24h); SeverPay accepts
      // 30–4320, so 30 is its floor — we cannot go below the sweep window here.
      lifetime: CHECKOUT_LIFETIME_MINUTES,
    };

    // SeverPay требует ksort + HMAC-SHA256(JSON, secretToken)
    const sorted: Record<string, unknown> = Object.fromEntries(
      Object.entries(baseBody).sort(([a], [b]) => a.localeCompare(b)),
    );
    const sign = crypto
      .createHmac('sha256', secretToken)
      .update(JSON.stringify(sorted))
      .digest('hex');
    const signedBody = { ...sorted, sign };

    const response = await firstValueFrom(
      this.httpService.post('https://severpay.io/api/merchant/payin/create', signedBody, {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const data = response.data as Record<string, unknown>;
    const dataObj = readRecord(data.data);
    const checkoutUrl = readOptionalString(dataObj, ['url']);

    return {
      gatewayId: readOptionalString(dataObj, ['uid', 'id']),
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: data.status === true ? 'PENDING' : 'FAILED',
      gatewayData: { provider: 'SEVERPAY', providerResponse: this.redactProviderResponse(data), checkoutUrl },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LAVA.TOP — https://gate.lava.top/api/v2/invoice
  //  Auth: X-Api-Key
  //  Docs: https://gate.lava.top/docs
  // ═══════════════════════════════════════════════════════════════════════════

  private async createLavaCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
    readonly customerEmail?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiKey = requireSetting(settings, 'apiKey');
    const offerId = requireSetting(settings, 'offerId');

    // The one gateway here where the address is not bookkeeping: Lava treats
    // it as the buyer's own, and it is the invoice recipient. Sending
    // `${userId}@rezeis.local` therefore did not merely look wrong — `.local`
    // is non-routable, so no Lava buyer could ever receive their invoice, for
    // every payment, silently. Failing on an unconfigured public domain (the
    // fallback's only new failure mode on this gateway) is the better answer
    // than posting another address that provably goes nowhere.
    const customerEmail = this.resolveCustomerEmail(input);

    const payload = {
      email: customerEmail,
      offerId,
      currency: input.transaction.currency === Currency.RUB ? 'RUB' : 'USD',
      periodicity: 'ONE_TIME',
      // Without this Lava charges the offer's own price. `offerId` is a single
      // per-gateway setting, so every plan would have been billed at one fixed
      // amount while we recorded the real one — a systematic mismatch, not an
      // edge case. Only honoured for products published with "Price on request
      // via API"; for the rest Lava ignores it and the offer price still wins.
      amount: Number(input.transaction.amount),
    };

    const response = await firstValueFrom(
      // v3 is the current route; v1 and v2 are marked `deprecated` in the spec.
      this.httpService.post('https://gate.lava.top/api/v3/invoice', payload, {
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      }),
    );

    const data = response.data as Record<string, unknown>;
    const checkoutUrl = readOptionalString(data, ['paymentUrl']);
    return {
      gatewayId: readOptionalString(data, ['id']),
      checkoutUrl,
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']) ?? 'PENDING',
      gatewayData: { provider: 'LAVA', providerResponse: this.redactProviderResponse(data), checkoutUrl },
    };
  }

  // ── Payer identity ──────────────────────────────────────────────────────
  // Antilopay, SeverPay and Lava each demand a buyer email on the invoice, so
  // the rule for producing one lives here rather than three times over.

  /**
   * The payer address to put on the invoice: the caller's when it has one,
   * otherwise a per-payment address under the operator's own public domain.
   *
   * The real account address does not reach this layer yet (see
   * `createCheckout`), so the fallback carries the whole burden, and the one
   * thing it must be is **routable**. What it replaced on all three gateways
   * was a `@rezeis.local` literal — `.local` is reserved for multicast DNS
   * (RFC 6762 §3) and resolves nowhere outside a LAN, so mail a provider sends
   * there fails by construction, not by bad luck. Keyed on the payment rather
   * than the user because a provider that echoes the buyer block back to us
   * (Antilopay's callback does) then names one payment, not just an account.
   */
  private resolveCustomerEmail(input: {
    readonly transaction: Transaction;
    readonly customerEmail?: string | null;
  }): string {
    const providedEmail = input.customerEmail?.trim();
    if (providedEmail !== undefined && providedEmail.length > 0) {
      return providedEmail;
    }
    return `${input.transaction.paymentId}@${this.resolvePublicMailDomain()}`;
  }

  /**
   * Bare host of the operator's configured public domain — the one routable
   * name this service is sure of. Scheme, port and path are stripped so the
   * setting can be the same `https://host` URL the URL builders take. Missing
   * gives the same 503 those builders give, rather than a made-up address.
   */
  private resolvePublicMailDomain(): string {
    const domain = this.configuration.domain;
    const host =
      domain === null
        ? ''
        : domain.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].split(':')[0].trim().toLowerCase();
    if (host.length === 0) {
      throw new ServiceUnavailableException('Admin public base URL is not configured');
    }
    return host;
  }

  // ── URL-resolution thin wrappers ────────────────────────────────────────
  // These delegate to the helpers in `payment-provider-execution.helpers.ts`
  // while keeping the call sites inside the per-gateway methods readable
  // (`this.resolveSuccessUrl(...)`).

  private resolveSuccessUrl(paymentId: string, override?: string | null): string {
    return resolveSuccessUrl(this.configuration.domain, paymentId, override);
  }

  private resolveFailUrl(
    paymentId: string,
    failOverride?: string | null,
    successOverride?: string | null,
  ): string {
    return resolveFailUrl(
      this.configuration.domain,
      paymentId,
      failOverride,
      successOverride,
    );
  }

  private buildResultUrl(paymentId: string): string {
    return buildResultUrl(this.configuration.domain, paymentId);
  }

  private buildWebhookUrl(gatewayType: PaymentGatewayType): string {
    return buildWebhookUrl(this.configuration.domain, gatewayType);
  }

  private redactProviderResponse(value: Record<string, unknown>): unknown {
    return this.paymentWebhookPayloadRedactionService.redact(value);
  }
}
