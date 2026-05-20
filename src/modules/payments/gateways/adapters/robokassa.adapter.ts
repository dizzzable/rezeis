/**
 * Robokassa payment gateway adapter.
 *
 * Docs: https://docs.robokassa.ru/
 * Auth: MD5 signature (MerchantLogin:Amount:InvId:Password1).
 *
 * Settings shape:
 *   merchantLogin: string
 *   password1: string — for creating payments
 *   password2: string — for verifying webhooks (Result URL)
 *   isTest: boolean
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

@Injectable()
export class RobokassaAdapter implements IPaymentGateway {
  readonly type = 'ROBOKASSA';
  private readonly logger = new Logger(RobokassaAdapter.name);

  async createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult> {
    const merchantLogin = settings['merchantLogin'] as string;
    const password1 = settings['password1'] as string;
    const isTest = settings['isTest'] as boolean ?? false;

    const amount = input.amount.toFixed(2);
    const invId = 0; // 0 = auto-assign

    // Signature: MerchantLogin:OutSum:InvId:Password1:Shp_paymentId=xxx
    const signStr = `${merchantLogin}:${amount}:${invId}:${password1}:Shp_paymentId=${input.paymentId}`;
    const signature = crypto.createHash('md5').update(signStr).digest('hex');

    const params = new URLSearchParams({
      MerchantLogin: merchantLogin,
      OutSum: amount,
      InvId: String(invId),
      Description: input.description.slice(0, 100),
      SignatureValue: signature,
      'Shp_paymentId': input.paymentId,
      ...(isTest ? { IsTest: '1' } : {}),
      ...(input.customerEmail ? { Email: input.customerEmail } : {}),
    });

    const paymentUrl = `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`;

    return {
      externalPaymentId: input.paymentId,
      paymentUrl,
    };
  }

  async verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult> {
    const password2 = settings['password2'] as string;
    const body = req.body;
    const outSum = body.OutSum ?? body.out_summ;
    const invId = body.InvId ?? body.inv_id;
    const receivedSig = (body.SignatureValue ?? body.crc ?? '').toLowerCase();
    const shpPaymentId = body['Shp_paymentId'] ?? body['shp_paymentid'] ?? '';

    const signStr = `${outSum}:${invId}:${password2}:Shp_paymentId=${shpPaymentId}`;
    const expected = crypto.createHash('md5').update(signStr).digest('hex').toLowerCase();

    return { valid: expected === receivedSig };
  }

  async parseWebhook(req: Request): Promise<NormalizedWebhookEvent> {
    const body = req.body;
    return {
      paymentId: body['Shp_paymentId'] ?? body['shp_paymentid'] ?? '',
      externalPaymentId: String(body.InvId ?? body.inv_id ?? ''),
      status: 'SUCCESS', // Robokassa only sends Result URL on success
      amount: parseFloat(body.OutSum ?? body.out_summ ?? '0'),
      currency: 'RUB',
      eventType: 'result',
      raw: body,
    };
  }
}
