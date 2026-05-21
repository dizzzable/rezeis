import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwError } from 'rxjs';

import {
  AdminUserSupportMessageDeliveryException,
  AdminUserSupportMessageDeliveryService,
} from '../src/modules/users/services/admin-user-support-message-delivery.service';

describe('AdminUserSupportMessageDeliveryService', () => {
  it('sanitizes Telegram support message failures', async () => {
    const warnings: string[] = [];
    const rawTelegramError = new Error(
      'support delivery failed bot-token chat 12345 https://api.telegram.org/botsecret/sendMessage recovery payload secret',
    );
    Object.assign(rawTelegramError, { response: { status: 403 } });
    const service = new AdminUserSupportMessageDeliveryService(
      { post: () => throwError(() => rawTelegramError) } as never,
      { botToken: 'bot-token' } as never,
    );
    (service as unknown as { readonly logger: { warn: (message: string) => void } }).logger.warn = (message: string): void => {
      warnings.push(message);
    };

    await assert.rejects(
      () => service.send({ telegramId: '12345', text: 'Support answer' }),
      (error: unknown) => error instanceof AdminUserSupportMessageDeliveryException
        && error.deliveryState === 'definitely-not-delivered',
    );

    assert.deepStrictEqual(warnings, [
      'Unable to send support message to Telegram: TELEGRAM_RECIPIENT_UNAVAILABLE (status 403)',
    ]);
    const serialized = JSON.stringify(warnings);
    assert.equal(serialized.includes('bot-token'), false);
    assert.equal(serialized.includes('12345'), false);
    assert.equal(serialized.includes('api.telegram.org'), false);
    assert.equal(serialized.includes('payload secret'), false);
  });
});
