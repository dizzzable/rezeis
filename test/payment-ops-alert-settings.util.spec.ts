import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mergePaymentOpsAlertSettings,
  readPaymentOpsAlertSettings,
} from '../src/common/utils/payment-ops-alert-settings.util';

describe('payment ops alert settings utilities', () => {
  it('reads defaults when settings are missing', () => {
    assert.deepStrictEqual(readPaymentOpsAlertSettings({}), {
      enabled: false,
      chatId: null,
      threadId: null,
      hashtag: '#payments_ops',
    });
  });

  it('merges and normalizes Telegram alert settings', () => {
    const result = mergePaymentOpsAlertSettings({
      systemNotifications: {
        email: { enabled: true },
      },
      patch: {
        enabled: true,
        chatId: ' -1001234567890 ',
        threadId: ' 55 ',
        hashtag: 'Payment Ops!',
      },
    });

    assert.deepStrictEqual(result, {
      email: { enabled: true },
      paymentOps: {
        enabled: true,
        chatId: '-1001234567890',
        threadId: '55',
        hashtag: '#payment_ops_',
      },
    });
  });
});
