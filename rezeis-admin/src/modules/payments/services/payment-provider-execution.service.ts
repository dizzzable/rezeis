import { Buffer } from 'node:buffer';
import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Currency, PaymentGateway, PaymentGatewayType, Transaction } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';

import { paymentsConfig } from '../../../common/config/payments.config';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';
import {
  buildResultUrl,
  buildWebhookUrl,
  md5,
  readOptionalString,
  readRecord,
  requireSetting,
  resolveFailUrl,
  resolveSuccessUrl,
  truncate,
} from './payment-provider-execution.helpers';

interface ProviderCheckoutResult {
  readonly gatewayId: string | null;
  readonly checkoutUrl: string | null;
  readonly providerMode: string;
  readonly providerStatus: string | null;
  readonly gatewayData: Record<string, unknown>;
}

@Injectable()
export class PaymentProviderExecutionService {
  public constructor(
    private readonly httpService: HttpService,
    @Inject(paymentsConfig.KEY)
    private readonly configuration: ConfigType<typeof paymentsConfig>,
  ) {}

  public async createCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    switch (input.gateway.type) {
      case PaymentGatewayType.YOOKASSA:
        return this.createYookassaCheckout(input);
      case PaymentGatewayType.PLATEGA:
        return this.createPlategaCheckout(input);
      case PaymentGatewayType.HELEKET:
        return this.createHeleketCheckout(input);
      case PaymentGatewayType.CRYPTOMUS:
        return this.createCryptomusCheckout(input);
      case PaymentGatewayType.MULENPAY:
        return this.createMulenpayCheckout(input);
      case PaymentGatewayType.TELEGRAM_STARS:
        return this.createTelegramStarsCheckout(input);
      case PaymentGatewayType.ANTILOPAY:
        return this.createAntilopayCheckout(input);
      case PaymentGatewayType.OVERPAY:
        return this.createOverpayCheckout(input);
      case PaymentGatewayType.PAYPALYCH:
        return this.createPaypalychCheckout(input);
      case PaymentGatewayType.RIOPAY:
        return this.createRiopayCheckout(input);
      default:
        throw new NotFoundException('Payment gateway not supported');
    }
  }

  private async createYookassaCheckout(input: {
    readonly gateway: PaymentGateway;
    readonly transaction: Transaction;
    readonly description: string;
    readonly successUrl?: string | null;
    readonly failUrl?: string | null;
  }): Promise<ProviderCheckoutResult> {
    const settings = readGatewaySettings(input.gateway.settings);
    const shopId = requireSetting(settings, 'shopId');
    const apiKey = requireSetting(settings, 'apiKey');
    const resultUrl = this.resolveSuccessUrl(input.transaction.paymentId, input.successUrl);
    const payload = {
      amount: {
        value: input.transaction.amount.toString(),
        currency: input.transaction.currency,
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: resultUrl,
      },
      description: input.description.slice(0, 128),
      metadata: {
        paymentId: input.transaction.paymentId,
        transactionId: input.transaction.id,
      },
    };
    const response = await firstValueFrom(
      this.httpService.post('https://api.yookassa.ru/v3/payments', payload, {
        auth: {
          username: shopId,
          password: apiKey,
        },
        headers: {
          'Idempotence-Key': input.transaction.paymentId,
        },
      }),
    );
    const data = response.data as Record<string, unknown>;
    const confirmation = readRecord(data.confirmation);
    return {
      gatewayId: readOptionalString(data, ['id']),
      checkoutUrl: readOptionalString(confirmation, ['confirmation_url']),
      providerMode: 'REDIRECT',
      providerStatus: readOptionalString(data, ['status']),
      gatewayData: {
        provider: 'YOOKASSA',
        providerStatus: readOptionalString(data, ['status']),
        providerResponse: data,
        checkoutUrl: readOptionalString(confirmation, ['confirmation_url']),
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
        providerResponse: data,
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
        providerResponse: data,
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
        providerResponse: data,
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
        providerResponse: data,
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
        providerResponse: data,
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
      throw new BadRequestException(`Antilopay error ${data.code}: ${data.error ?? 'unknown'}`);
    }

    return {
      gatewayId: readOptionalString(data, ['payment_id']),
      checkoutUrl: readOptionalString(data, ['payment_url']),
      providerMode: 'REDIRECT',
      providerStatus: 'PENDING',
      gatewayData: { provider: 'ANTILOPAY', providerResponse: data, checkoutUrl: readOptionalString(data, ['payment_url']) },
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
      gatewayData: { provider: 'OVERPAY', providerResponse: data, checkoutUrl: readOptionalString(checkout, ['redirect_url']) },
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
      gatewayData: { provider: 'PAYPALYCH', providerResponse: data, checkoutUrl: readOptionalString(data, ['link_url', 'link_page_url', 'pay_url']) },
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
      gatewayData: { provider: 'RIOPAY', providerResponse: data, checkoutUrl: readOptionalString(data, ['paymentLink']) },
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
}
