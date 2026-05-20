import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSafeTelegramDeliveryWarning,
  resolveTelegramDeliveryFailureCode,
} from '../src/common/utils/telegram-delivery-error.util';

describe('telegram delivery error utilities', () => {
  it('builds bounded warnings without raw Telegram error payloads', () => {
    const rawError = new Error(
      'telegram token bot123:secret-token chat 123456 user@example.com payload forbidden',
    );
    Object.assign(rawError, { response: { status: 403, data: { token: 'secret-token' } } });

    const warning = buildSafeTelegramDeliveryWarning({
      operation: 'Unable to send Telegram message',
      error: rawError,
    });

    assert.equal(
      warning,
      'Unable to send Telegram message: TELEGRAM_RECIPIENT_UNAVAILABLE (status 403)',
    );
    const serialized = JSON.stringify(warning);
    assert.equal(serialized.includes('secret-token'), false);
    assert.equal(serialized.includes('user@example.com'), false);
    assert.equal(serialized.includes('payload forbidden'), false);
  });

  it('returns a generic code for unknown Telegram failures', () => {
    assert.equal(resolveTelegramDeliveryFailureCode(new Error('socket timeout')), 'TELEGRAM_DELIVERY_FAILED');
  });
});
