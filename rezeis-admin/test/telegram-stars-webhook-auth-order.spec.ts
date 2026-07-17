import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';

import { TelegramStarsWebhookService } from '../src/modules/payments/services/telegram-stars-webhook.service';

describe('TelegramStarsWebhookService authentication order', () => {
  it('rejects an unauthenticated pre-checkout query before database or Telegram side effects', async () => {
    let transactionLookups = 0;
    let telegramCalls = 0;
    const service = new TelegramStarsWebhookService(
      {
        transaction: {
          findUnique: async () => {
            transactionLookups += 1;
            return { id: 'tx-1' };
          },
        },
      } as never,
      {
        post: () => {
          telegramCalls += 1;
          return of({ data: { ok: true } });
        },
      } as never,
      {
        verifyWebhookSignature: async () => {
          throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
        },
      } as never,
    );

    await assert.rejects(
      () =>
        service.handleTelegramUpdate({
          rawBody: Buffer.from(
            JSON.stringify({
              pre_checkout_query: {
                id: 'precheckout-1',
                invoice_payload: 'payment-1',
              },
            }),
            'utf8',
          ),
          headers: {},
          clientIp: null,
          botToken: 'bot-token',
        }),
      ForbiddenException,
    );
    assert.equal(transactionLookups, 0);
    assert.equal(telegramCalls, 0);
  });
});
