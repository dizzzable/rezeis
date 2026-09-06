import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * Event-card enrichment
 * ─────────────────────
 * `formatTelegramMessage` is private, but every non-error event on the
 * token-less dev-fallback path is rendered to HTML and handed to the reiwa
 * relay as `reiwa.dev.notify`. We capture that text to assert the enriched,
 * per-type card layout (header, payment, plan, backup, and the unknown-type
 * fallback).
 *
 * The firehose rides the durable relay queue now. Which road it takes is
 * `system-events-dev-fallback.spec.ts`'s subject; this suite only wants the
 * rendered card, so the stub captures it off either one.
 */

function buildService(): {
  service: SystemEventsService;
  getLastText: () => string | null;
} {
  let lastText: string | null = null;

  // Error-report events take the OTHER branch: the `.txt` goes as a document
  // and the very same rendered card rides along as its caption. Capturing it
  // rather than discarding it is what lets this suite assert the layout of an
  // error card at all — `system.error` never reaches the inline-card path, so
  // a no-op double left every such assertion reading `null`.
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') lastText = (meta['text'] as string | undefined) ?? null;
    else if (event === 'reiwa.dev.notify.document') {
      lastText = (meta['caption'] as string | undefined) ?? null;
    }
  };
  const notifier = {
    deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
      capture(event, meta);
      return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
    },
  };
  const relayQueue = {
    enqueue: async (event: string, meta: Record<string, unknown>) => {
      capture(event, meta);
      return true;
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
      if (token === ReiwaRelayQueueService) return relayQueue;
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
      assert.ok(text.includes('🏗 <b>Сборка:</b>'));
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
      assert.ok(text.includes('🏗 <b>Сборка:</b>'));
      assert.ok(text.includes('9.9.9-image'));
    } finally {
      if (savedVersion === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = savedVersion;
    }
  });

  it('renders first-traffic card with status, used traffic and remaining time', async () => {
    const { service, getLastText } = buildService();
    const expireAt = new Date(Date.now() + 30 * 24 * 60 * 60_000 + 17 * 60 * 60_000).toISOString();
    service.info('user.first_traffic', 'USER', 'User started using traffic', {
      userId: 'user-1',
      telegramId: '706093898',
      userName: 'Игорь Высоких',
      username: 'vs7ka',
      subscriptionId: '64d8eb5d-3226-4ea3-a256-91c6d0c31c7f',
      status: 'ACTIVE',
      usedTrafficBytes: 5_263_000,
      trafficLimitBytes: 100 * 1024 ** 3,
      deviceLimit: 1,
      expireAt,
      remnawaveId: 'panel-uuid-abc',
      remnawaveUsername: 'igor_vpn',
      source: 'REMNAWAVE_WEBHOOK',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('#EventUserFirst_traffic'));
    assert.ok(text.includes('Событие: Пользователь начал использовать трафик!'));
    assert.ok(text.includes('👤 <b>Пользователь:</b>'));
    assert.ok(text.includes('Игорь Высоких (@vs7ka)'));
    assert.ok(text.includes('📦 <b>План / подписка:</b>'));
    assert.ok(text.includes('64d8eb5d-3226-4ea3-a256-91c6d0c31c7f'));
    assert.ok(text.includes('Статус: Активна'));
    assert.ok(text.includes('Трафик:'));
    assert.ok(text.includes('100 ГБ'));
    assert.ok(text.includes('Лимит устройств: 1'));
    assert.ok(text.includes('Осталось:'));
    // Traffic is owned by the subscription block — no duplicate in Remnawave block.
    assert.ok(text.includes('🌐 <b>Профиль Remnawave:</b>'));
    assert.ok(!text.includes('📊 Трафик:') || text.indexOf('📊 Трафик:') === text.lastIndexOf('📊 Трафик:'));
    assert.ok(text.includes('Вебхук Remnawave'));
  });

  /**
   * `code` is a generic metadata key. Three unrelated domains put a value in it
   * — a promocode, an anti-fraud detector, a diagnostic from the upgrade path —
   * and the promocode block used to claim all of them by asking "is this NOT
   * fraud?". These four cases pin the allow-list that replaced it: exactly one
   * category renders the block, and the other two say what they actually are.
   */
  it('renders a fraud signal transition as a signal block, not as a promocode', async () => {
    const { service, getLastText } = buildService();
    service.info('fraud.signal_transitioned', 'FRAUD', 'Fraud signal NODES_OFFLINE → DISMISSED', {
      signalId: 'ckv1s2t3u4v5w6x7y8z9',
      code: 'NODES_OFFLINE',
      previousStatus: 'OPEN',
      newStatus: 'DISMISSED',
      adminId: 'admin-7',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('Событие: Антифрод: изменён статус сигнала!'));
    assert.ok(text.includes('🔁 <b>Сигнал:</b>'), 'the status change needs a block of its own');
    assert.ok(text.includes('NODES_OFFLINE'));
    assert.ok(
      text.includes('Статус: Открыт → Отклонён'),
      `both statuses must be shown in Russian; got: ${text}`,
    );
    assert.ok(
      !text.includes('Промокод'),
      'a detector code captioned as a coupon is the defect this replaces',
    );
  });

  it('gives no promocode block to a `code` from a category that does not own one', async () => {
    // This pins the RULE, not a reproduction: with `fraud.signal_transitioned`
    // emitting FRAUD again, no shipping emitter is mislabelled today, and the
    // one diagnostic that carries a `code` under SYSTEM (`system.error` from the
    // upgrade path) never reaches this renderer at all — error events are drawn
    // by `formatErrorEventCardHtml`, which has no promocode block.
    //
    // The rule still needs a guard because `POST /api/internal/events` accepts a
    // free-form type with any category and unconstrained metadata, which is
    // exactly the shape below. Under the old deny-list this card came back
    // captioned «🎟 Промокод».
    const { service, getLastText } = buildService();
    service.info('reiwa.device_limit_hit', 'USER', 'relayed from reiwa', {
      code: 'DEVICE_LIMIT',
      userId: 'user-1',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(!text.includes('Промокод'), `a relayed code is not a coupon; got: ${text}`);
    // …and the card is still delivered and still names its own event, so this
    // cannot be satisfied by dropping the message on the floor.
    assert.ok(text.includes('relayed from reiwa'));
  });

  it('still renders the promocode block for an actual promocode event', async () => {
    // The other half of the allow-list: tightening the gate must not silence
    // the one category that owns this block. Without this the fix could be
    // "delete the block" and the two tests above would still pass.
    const { service, getLastText } = buildService();
    service.info('promocode.activated', 'PROMOCODE', 'activated', {
      code: 'SUMMER25',
      rewardType: 'DISCOUNT',
      rewardValue: '25%',
      userId: 'user-1',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('🎟 <b>Промокод:</b>'));
    assert.ok(text.includes('SUMMER25'));
    assert.ok(text.includes('25%'));
  });

  it('escapes a promocode that carries HTML, because the card is sent in HTML mode', async () => {
    const { service, getLastText } = buildService();
    service.info('promocode.activated', 'PROMOCODE', 'activated', {
      code: '<b>OOPS</b>',
      rewardType: 'DISCOUNT',
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('&lt;b&gt;OOPS&lt;/b&gt;'), `promocode must be escaped; got: ${text}`);
    // The `<code>` wrapper the renderer itself writes is still real markup.
    assert.ok(text.includes('🎫 Код: <code>&lt;b&gt;OOPS&lt;/b&gt;</code>'));
  });
});

/**
 * Three alerts that arrived as a frame with no facts
 * ═══════════════════════════════════════════════════
 * The card prints a per-type header INSTEAD of the raw message — the case at
 * the top of this file pins exactly that, and it is right: `event.message` is
 * a machine sentence and the header is written for a person.
 *
 * It works because every fact an operator needs is picked out of `metadata`
 * by a curated block. For these three there was no such block, and their
 * facts lived only in the message. So the operator received
 * «Концентрация онлайна в одной стране» and was told neither the country nor
 * the share — an alert that names a problem and withholds every fact about
 * it, which is worse than no alert because it looks like one.
 */
describe('an alert whose facts live only in its metadata', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('names the country and the share for a geo-concentration alert', async () => {
    const { service, getLastText } = buildService();
    service.info(
      'node.geo_concentration',
      'NODE',
      '73% of online users (219/300) are connected through DE nodes',
      {
        kind: 'geo_concentration',
        band: 70,
        country: 'DE',
        usersInCountry: 219,
        totalOnline: 300,
        percentInCountry: 73,
      },
    );
    await flush();

    const card = getLastText() ?? '';
    assert.match(card, /DE/, 'the country is missing');
    assert.match(card, /73/, 'the share is missing');
    assert.match(card, /219/, 'the head count is missing');
    assert.match(card, /300/, 'the total is missing');
  });

  it('reads `country`, which is the key the detector actually emits', async () => {
    // The Node block above reads `countryCode`. The detector has always
    // emitted `country`, so even the flag never rendered — a near-miss the
    // card could not report on itself.
    const { service, getLastText } = buildService();
    service.info('node.geo_concentration', 'NODE', 'x', {
      country: 'NL',
      percentInCountry: 51,
      usersInCountry: 10,
      totalOnline: 20,
    });
    await flush();

    assert.match(getLastText() ?? '', /NL/);
  });

  it('names the average for a panel-wide HWID alert', async () => {
    // `kind` here is `hwid_average`, not `fraudKind` — which is why the fraud
    // block skipped it and the number went nowhere.
    const { service, getLastText } = buildService();
    service.warn(
      'remnawave.hwid_average_high',
      'REMNAWAVE',
      'Panel-wide HWID average is 4.2 devices per user',
      {
        kind: 'hwid_average',
        band: 4,
        averageDevicesPerUser: 4.2,
        totalHwidDevices: 8400,
        totalUniqueDevices: 2000,
      },
    );
    await flush();

    const card = getLastText() ?? '';
    assert.match(card, /4\.2/, 'the average is missing');
    assert.match(card, /8400/, 'the device total is missing');
  });

  it('names the action and the ratio for a bulk operation', async () => {
    const { service, getLastText } = buildService();
    service.info('system.bulk_users_executed', 'SYSTEM', 'Bulk user operation "block" executed', {
      action: 'block',
      adminId: 'admin-1',
      batchId: 'batch-1',
      total: 15,
      succeeded: 12,
      failed: 2,
      skipped: 1,
    });
    await flush();

    const card = getLastText() ?? '';
    assert.match(card, /block/, 'the action is missing');
    assert.match(card, /12/, 'the success count is missing');
    assert.match(card, /15/, 'the total is missing');
  });

  it('leaves a clean bulk run without an error line', async () => {
    const { service, getLastText } = buildService();
    service.info('system.bulk_users_executed', 'SYSTEM', 'x', {
      action: 'unblock',
      batchId: 'batch-2',
      total: 5,
      succeeded: 5,
      failed: 0,
      skipped: 0,
    });
    await flush();

    const card = getLastText() ?? '';
    assert.match(card, /unblock/);
    assert.doesNotMatch(card, /Ошибок/, 'zero failures must not print a failure line');
    assert.doesNotMatch(card, /Пропущено/);
  });

  it('still keeps the raw machine message out of the card', async () => {
    // The blocks exist so the header can stay; they must not smuggle the
    // message back in through a metadata key.
    const { service, getLastText } = buildService();
    service.info('node.geo_concentration', 'NODE', 'RAW-MACHINE-SENTENCE', {
      country: 'DE',
      percentInCountry: 73,
      usersInCountry: 219,
      totalOnline: 300,
    });
    await flush();

    assert.doesNotMatch(getLastText() ?? '', /RAW-MACHINE-SENTENCE/);
  });
});
