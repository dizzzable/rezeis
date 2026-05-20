/**
 * T-Bank (ex-Tinkoff) payment gateway adapter.
 *
 * Docs: https://www.tbank.ru/kassa/dev/payments/
 * Auth: TerminalKey + Password → SHA-256 token.
 *
 * Settings shape:
 *   terminalKey: string
 *   password: string
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'node:crypto';
import type {
  GatewayCheckoutInput,
  GatewayCheckoutResult,
  IPaymentGateway,
  NormalizedWebhookEvent,
  WebhookVerifyResult,
} from '../gateway.interface';

const BASE_URL = 'https://securepay.tinkoff.ru/v2';

@Injectable()
export class TbankAdapter implements IPaymentGateway {
  readonly type = 'TBANK';
  private readonly logger = new Logger(TbankAdapter.name);

  private generateToken(params: Record<string, string | number>, password: string): string {
    const sorted = { ...params, Password: password };
    const keys = Object.keys(sorted).sort();
    const concatenated = keys.map((k) => sorted[k]).join('');
    return crypto.createHash('sha256').update(concatenated).digest('hex');
  }

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const terminalKey = settings['terminalKey'] as string;
    const password = settings['password'] as string;
    const amountKopecks = Math.round(input.amount * 100);

    const params: Record<string, string | number> = {
      TerminalKey: terminalKey,
      Amount: amountKopecks,
      OrderId: input.paymentId,
      Description: input.description.slice(0, 250),
    };

    const token = this.generateToken(params, password);

    const body: Record<string, unknown> = {
      ...params,
      Token: token,
      SuccessURL: input.successUrl,
      FailURL: input.failUrl,
    };

    if (input.customerEmail) {
      body.Receipt = {
        Email: input.customerEmail,
        Taxation: 'usn_income',
        Items: [{ Name: input.description.slice(0, 64), Price: amountKopecks, Quantity: 1, Amount: amountKopecks, Tax: 'none' }],
      };
    }

    const res = await fetch(`${BASE_URL}/Init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json() as { Success: boolean; PaymentURL?: string; PaymentId?: string; ErrorCode?: string; Message?: string };
    if (!data.Success) throw new Error(`T-Bank Init failed: ${data.ErrorCode} ${data.Message}`);

    return {
      externalPaymentId: data.PaymentId ?? input.paymentId,
      paymentUrl: data.PaymentURL ?? '',
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const password = settings['password'] as string;
    const body = req.body;
    const receivedToken = body.Token;
    if (!receivedToken) return { valid: false, reason: 'No Token in body' };

    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(body)) {
      if (k !== 'Token' && k !== 'Receipt' && typeof v !== 'object') params[k] = v as string | number;
    }

    const expected = this.generateToken(params, password);
    return { valid: expected === receivedToken };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    const statusMap: Record<string, 'SUCCESS' | 'FAILED' | 'PENDING' | 'REFUNDED'> = {
      CONFIRMED: 'SUCCESS', AUTHORIZED: 'PENDING', REJECTED: 'FAILED', REFUNDED: 'REFUNDED', REVERSED: 'REFUNDED',
    };

    return {
      paymentId: body.OrderId ?? '',
      externalPaymentId: String(body.PaymentId ?? ''),
      status: statusMap[body.Status] ?? 'PENDING',
      amount: body.Amount ? body.Amount / 100 : undefined,
      currency: 'RUB',
      eventType: body.Status,
      raw: body,
    };
  }
}
