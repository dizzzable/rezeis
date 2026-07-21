import { Buffer } from 'node:buffer';
import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Currency, PaymentGateway, PaymentGatewayType, Transaction } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';

import { paymentsConfig } from '../../../common/config/payments.config';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import { normalizePaymentProviderError, redactPaymentDiagnosticMessage } from '../utils/payment-provider-error.util';
import {
  buildResultUrl,
  buildWebhookUrl,
  md5,
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
 * 5. Request omitted → legacy gateway default (true), without consent stamp
 *    (older clients); new cabinets always send an explicit boolean + consent
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
  // Legacy clients that omit the field: keep previous gateway-default behaviour.
  return { save: true, consent: false, reason: 'legacy_gateway_default' };
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
      url_success: resultUrl,
      url_return: resultUrl,
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
      lifetime: 3600,
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
    const successResultUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failResultUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);
    const webhookUrl = this.buildWebhookUrl(input.gateway.type);
    const payload = {
      amount: input.transaction.amount.toString(),
      currency: input.transaction.currency,
      description: input.description.slice(0, 255),
      successUrl: successResultUrl,
      failUrl: failResultUrl,
      callbackUrl: webhookUrl,
      orderId: input.transaction.paymentId,
    };
    const response = await firstValueFrom(
      this.httpService.post('https://mulenpay.ru/v2/payments', payload, {
        headers: {
          'api-key': apiKey,
          'X-API-Key': apiKey,
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
  }): Promise<ProviderCheckoutResult> {
    const crypto = await import('crypto');
    const settings = readGatewaySettings(input.gateway.settings);
    const projectIdentificator = requireSetting(settings, 'projectIdentificator');
    const secretId = requireSetting(settings, 'secretId');
    const privateKeyBase64 = requireSetting(settings, 'privateKey');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const failUrl = this.resolveFailUrl(input.transaction.paymentId, input.failUrl, input.successUrl);

    const payload = {
      project_identificator: projectIdentificator,
      amount: Number(input.transaction.amount),
      order_id: input.transaction.paymentId,
      currency: 'rub',
      product_name: input.description.slice(0, 128),
      product_type: 'services',
      description: input.description.slice(0, 255),
      success_url: successUrl,
      fail_url: failUrl,
      customer: { email: 'customer@rezeis.local' },
    };

    const bodyString = JSON.stringify(payload);
    const privateKeyPem = `-----BEGIN RSA PRIVATE KEY-----\n${privateKeyBase64}\n-----END RSA PRIVATE KEY-----`;
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  OVERPAY (beGateway) — https://checkout.begateway.com/ctp/api/checkouts
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
      this.httpService.post('https://checkout.begateway.com/ctp/api/checkouts', payload, {
        auth: { username: shopId, password: secretKey },
        headers: { 'Content-Type': 'application/json' },
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
      shop_id: shopId,
      currency_in: 'RUB',
      success_url: successUrl,
      fail_url: failUrl,
      webhook_url: webhookUrl,
    };

    const response = await firstValueFrom(
      this.httpService.post('https://paypalych.com/api/v1/bill/create', payload, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      }),
    );

    const data = response.data as Record<string, unknown>;
    return {
      gatewayId: readOptionalString(data, ['bill_id', 'id']),
      checkoutUrl: readOptionalString(data, ['link_url', 'link_page_url', 'pay_url']),
      providerMode: 'REDIRECT',
      providerStatus: 'PENDING',
      gatewayData: { provider: 'PAYPALYCH', providerResponse: this.redactProviderResponse(data), checkoutUrl: readOptionalString(data, ['link_url', 'link_page_url', 'pay_url']) },
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  WATA — https://api.wata.pro/api/v1/links
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
    };

    const response = await firstValueFrom(
      this.httpService.post('https://api.wata.pro/api/v1/links', payload, {
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
      lifetime: 60,
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
  }): Promise<ProviderCheckoutResult> {
    const crypto = await import('crypto');
    const settings = readGatewaySettings(input.gateway.settings);
    const mid = requireSetting(settings, 'mid');
    const secretToken = requireSetting(settings, 'secretToken');

    const successUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const customerEmail = `${input.transaction.userId ?? 'customer'}@rezeis.local`;
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
      lifetime: 1440,
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
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const apiKey = requireSetting(settings, 'apiKey');
    const offerId = requireSetting(settings, 'offerId');

    const customerEmail = `${input.transaction.userId ?? 'customer'}@rezeis.local`;

    const payload = {
      email: customerEmail,
      offerId,
      currency: input.transaction.currency === Currency.RUB ? 'RUB' : 'USD',
      periodicity: 'ONE_TIME',
    };

    const response = await firstValueFrom(
      this.httpService.post('https://gate.lava.top/api/v2/invoice', payload, {
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
