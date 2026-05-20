import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwError } from 'rxjs';

import {
  TelegramPasswordRecoveryDeliveryException,
  TelegramPasswordRecoveryDeliveryService,
} from '../src/modules/internal-user/services/telegram-password-recovery-delivery.service';

describe('TelegramPasswordRecoveryDeliveryService', () => {
  it('sanitizes Telegram password recovery failures', async () => {
    const warnings: string[] = [];
    const rawTelegramError = new Error(
      'password recovery failed bot-token chat 12345 reset-code 777777 https://api.telegram.org/botsecret/sendMessage payload secret',
    );
    Object.assign(rawTelegramError, { response: { status: 400 } });
    const service = new TelegramPasswordRecoveryDeliveryService(
      { post: () => throwError(() => rawTelegramError) } as never,
      { botToken: 'bot-token' } as never,
    );
    (service as unknown as { readonly logger: { warn: (message: string) => void } }).logger.warn = (message: string): void => {
      warnings.push(message);
    };

    await assert.rejects(
      () => service.sendLinkedAccountPasswordResetLink({
        telegramId: '12345',
        code: '777777',
        resetUrl: 'https://ruid.example/reset?token=secret',
        expiresAt: new Date('2026-05-06T10:00:00.000Z'),
      }),
      (error: unknown) => error instanceof TelegramPasswordRecoveryDeliveryException
        && error.deliveryState === 'definitely-not-delivered',
    );

    assert.deepStrictEqual(warnings, [
      'Unable to send linked-account password reset message to Telegram: TELEGRAM_RECIPIENT_UNAVAILABLE (status 400)',
    ]);
    const serialized = JSON.stringify(warnings);
    assert.equal(serialized.includes('bot-token'), false);
    assert.equal(serialized.includes('12345'), false);
    assert.equal(serialized.includes('777777'), false);
    assert.equal(serialized.includes('token=secret'), false);
    assert.equal(serialized.includes('api.telegram.org'), false);
  });
});
