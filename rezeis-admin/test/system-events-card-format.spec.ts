import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';

/**
 * Event-card enrichment
 * ─────────────────────
 * `formatTelegramMessage` is private, but every non-error event on the
 * token-less dev-fallback path is rendered to HTML and handed to the reiwa
 * relay via `BotNotifierClient.notifyDev({ text })`. We capture that text to
 * assert the enriched, per-type card layout (header, payment, plan, backup,
 * and the unknown-type fallback).
 */

function buildService(): {
  service: SystemEventsService;
  getLastText: () => string | null;
} {
  let lastText: string | null = null;

  const notifier = {
    notifyDev: async (input: { text: string }) => {
      lastText = input.text;
    },
    notifyDevDocument: async () => {
      /* not used for non-error events */
    },
  };

  const prisma = {
    settings: {
      findFirst: async () => ({
        systemNotifications: {
          telegram: { enabled: false, chatId: null, devChatId: null },
        },
      }),
    },
    adminAuditLog: { create: async () => ({}) },
  };

  const httpService = {
    post: () => {
      throw new Error('Bot API must not be called without a token');
    },
  };

  const moduleRef = {
    get: (token: unknown) => {
      if (token === BotNotifierClient) return notifier;
      throw new Error('not registered');
    },
  };

  const service = new SystemEventsService(
    prisma as never,
    { enabled: false, urls: [] } as never,
    httpService as never,
    moduleRef as never,
  );
  return { service, getLastText: () => lastText };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('SystemEventsService card formatting (enriched)', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('renders a per-type header (emoji + Russian title) instead of the raw message', async () => {
    const { service, getLastText } = buildService();
    service.info('payment.completed', 'PAYMENT', 'raw machine message', {
      paymentId: 'pay_123',
      gatewayType: 'YooKassa',
      amount: '199',
      currency: 'RUB',
    });
    await flush();
    const text = getLastText();
    assert.ok(text, 'card text should be captured');
    assert.ok(text.includes('#EventPaymentCompleted'));
    assert.ok(text.includes('Событие: Платёж получен!'));
    assert.ok(!text.includes('raw machine message'));
  });

  it('renders an enriched payment block with currency symbol, receipt and paid date', async () => {
    const { service, getLastText } = buildService();
    service.info('payment.completed', 'PAYMENT', 'paid', {
      paymentId: 'pay_456',
      gatewayType: 'YooKassa',
      amount: '299',
      currency: 'RUB',
      purchaseType: 'SUBSCRIPTION',
      receiptUrl: 'https://receipt.example/abc',
      paidAt: '2026-06-18T10:30:00.000Z',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('💰 <b>Платёж:</b>'));
    assert.ok(text.includes('YooKassa'));
    assert.ok(text.includes('299 ₽'));
    assert.ok(text.includes('https://receipt.example/abc'));
    assert.ok(text.includes('Оплачено:'));
  });

  it('renders an enriched plan/subscription block (plan type, RU traffic, humanized duration)', async () => {
    const { service, getLastText } = buildService();
    service.info('subscription.created', 'SUBSCRIPTION', 'created', {
      planName: 'Premium',
      planType: 'BOTH',
      durationDays: 30,
      deviceLimit: 5,
      trafficLimitBytes: 107374182400,
      isTrial: false,
      expireAt: '2026-07-18T00:00:00.000Z',
      subscriptionId: 'sub_abcdef123456',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('📦 <b>План / подписка:</b>'));
    assert.ok(text.includes('Premium'));
    assert.ok(text.includes('Трафик + устройства'));
    assert.ok(text.includes('100 ГБ'));
    assert.ok(text.includes('1 месяц'));
  });

  it('renders a backup block with human-readable size', async () => {
    const { service, getLastText } = buildService();
    service.info('system.backup_completed', 'SYSTEM', 'backup done', {
      filename: 'backup-2026-06-18.sql.gz',
      sizeBytes: 5242880,
      scope: 'full',
      initiatedBy: 'admin_123456789012',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('🗄 <b>Бэкап:</b>'));
    assert.ok(text.includes('backup-2026-06-18.sql.gz'));
    assert.ok(text.includes('5 МБ'));
  });

  it('renders a Remnawave profile block with login + uuid and combines user name with @username', async () => {
    const { service, getLastText } = buildService();
    service.info('subscription.created', 'SUBSCRIPTION', 'profile created', {
      userId: 'usr_abcdef123456',
      telegramId: '858568447',
      userName: 'Анна Вайгачева',
      username: 'annavaigacheva1414',
      remnawaveId: '0194f4b6-7cc7-7ecb-9f62-123456789abc',
      remnawaveUsername: 'anna_vpn',
    });
    await flush();
    const text = getLastText()!;
    // user name + handle on one line
    assert.ok(text.includes('Анна Вайгачева (@annavaigacheva1414)'));
    // dedicated remnawave block
    assert.ok(text.includes('🌐 <b>Профиль Remnawave:</b>'));
    assert.ok(text.includes('anna_vpn'));
    assert.ok(text.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'));
  });

  it('renders a node block for node events', async () => {
    const { service, getLastText } = buildService();
    service.emit({
      type: 'node.connection_lost',
      category: 'NODE',
      severity: 'WARNING',
      message: 'Remnawave: node.connection_lost',
      metadata: { nodeName: 'DE-1', countryCode: 'DE', nodeUuid: 'node-uuid-123456789' },
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('🖥 <b>Нода:</b>'));
    assert.ok(text.includes('DE-1'));
    assert.ok(text.includes('Нода офлайн'));
  });

  it('falls back to severity emoji + raw message for an unknown event type', async () => {
    const { service, getLastText } = buildService();
    service.info('custom.unmapped_event', 'SYSTEM', 'Something happened');
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('#EventCustomUnmapped_event'));
    assert.ok(text.includes('Something happened'));
    assert.ok(text.includes('<b>Контекст:</b>'));
  });

  it('renders a build-info block, preferring metadata over image env', async () => {
    const savedVersion = process.env.APP_VERSION;
    process.env.APP_VERSION = '9.9.9-image';
    try {
      const { service, getLastText } = buildService();
      service.info('subscription.created', 'SUBSCRIPTION', 'created', {
        planName: 'Premium',
        version: '1.2.3-reiwa',
        commit: 'abcdef123456789',
        branch: 'feature/x',
        source: 'bot',
      });
      await flush();
      const text = getLastText()!;
      assert.ok(text.includes('🏷 <b>Сборка:</b>'));
      // metadata wins over image env
      assert.ok(text.includes('1.2.3-reiwa'));
      assert.ok(!text.includes('9.9.9-image'));
      // commit is shortened to 12 chars
      assert.ok(text.includes('abcdef123456'));
      assert.ok(text.includes('feature/x'));
      // humanized source surfaced in context
      assert.ok(text.includes('Telegram-бот'));
    } finally {
      if (savedVersion === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = savedVersion;
    }
  });

  it('falls back to image env build info when metadata omits it', async () => {
    const savedVersion = process.env.APP_VERSION;
    process.env.APP_VERSION = '9.9.9-image';
    try {
      const { service, getLastText } = buildService();
      service.info('payment.completed', 'PAYMENT', 'paid', { amount: '100' });
      await flush();
      const text = getLastText()!;
      assert.ok(text.includes('🏷 <b>Сборка:</b>'));
      assert.ok(text.includes('9.9.9-image'));
    } finally {
      if (savedVersion === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = savedVersion;
    }
  });
});
