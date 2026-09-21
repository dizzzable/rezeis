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

function buildService(
  options: {
    readonly platformPolicy?: unknown;
    /** Admin id → login, for the `🛠 Админ` line. Absent means no admin table. */
    readonly admins?: Readonly<Record<string, string>>;
  } = {},
): {
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
        // Where the operator's time zone lives (`readPlatformBranding`). Absent
        // unless a case is about it — which is the state of every install that
        // never opened that setting.
        platformPolicy: options.platformPolicy ?? {},
      }),
    },
    adminAuditLog: { create: async () => ({}) },
    // Present ONLY when a case asks for it. `enrichAdminIdentity` swallows a
    // missing table, which is what every other case in this file relies on —
    // and is also why the absence has to be deliberate rather than incidental.
    ...(options.admins === undefined
      ? {}
      : {
          adminUser: {
            findUnique: async ({ where }: { where: { id: string } }) => {
              const login = options.admins?.[where.id];
              return login === undefined ? null : { login };
            },
          },
        }),
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

/** The `<b>Событие: …</b>` line — what an operator reads first. */
function headerOf(card: string): string | undefined {
  return card.split('\n').find((line) => line.includes('<b>Событие:'));
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

  it('heads the card with the per-type title, never with the raw message', async () => {
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
    assert.equal(headerOf(text), '💰 <b>Событие: Платёж получен!</b>');
    // Every fact is in the payment block: the log-line sentence adds nothing,
    // so it stays off the card.
    assert.ok(!text.includes('raw machine message'));
  });

  it('keeps the sentence off a WARNING card whose type does not opt in', async () => {
    // THE NOISE THIS PINS. Printing the message under the title on every
    // WARNING turned the busiest cards into a title, then the same fact again
    // as a log line or an enum. Each row is a producer's real sentence, and
    // each of these types has its facts in a block (or in its title) already.
    const noisy: ReadonlyArray<{
      readonly type: string;
      readonly category: 'REMNAWAVE' | 'NODE' | 'PAYMENT' | 'USER' | 'SYSTEM';
      readonly message: string;
      readonly metadata: Record<string, unknown>;
    }> = [
      { type: 'remnawave.user.expired', category: 'REMNAWAVE', message: 'Remnawave: user.expired', metadata: { remnawaveUsername: 'anna_vpn' } },
      { type: 'remnawave.user.limited', category: 'REMNAWAVE', message: 'Remnawave: user.limited', metadata: { remnawaveUsername: 'anna_vpn' } },
      { type: 'remnawave.user.disabled', category: 'REMNAWAVE', message: 'Remnawave: user.disabled', metadata: { remnawaveUsername: 'anna_vpn' } },
      { type: 'remnawave.user.bandwidth_threshold', category: 'REMNAWAVE', message: 'Remnawave: user.bandwidth_usage_threshold_reached', metadata: { remnawaveUsername: 'anna_vpn' } },
      { type: 'node.connection_lost', category: 'NODE', message: 'Remnawave: node.connection_lost', metadata: { nodeName: 'DE-1' } },
      { type: 'node.disabled', category: 'NODE', message: 'Remnawave: node.disabled', metadata: { nodeName: 'DE-1' } },
      { type: 'node.traffic_notify', category: 'NODE', message: 'Remnawave: node.traffic_notify', metadata: { nodeName: 'DE-1' } },
      { type: 'payment.failed', category: 'PAYMENT', message: 'Платёж не прошёл: NEW', metadata: { paymentId: 'pay-1', amount: '10' } },
      { type: 'user.deleted', category: 'USER', message: 'User account deleted', metadata: { userId: 'user-1' } },
      { type: 'user.blocked', category: 'USER', message: 'User blocked: 1234567890', metadata: { userId: 'user-1' } },
      {
        type: 'remnawave.hwid_average_high',
        category: 'REMNAWAVE',
        message: 'Panel-wide HWID average is 5.4 devices per user',
        metadata: { kind: 'hwid_average', averageDevicesPerUser: 5.4 },
      },
      {
        type: 'system.broadcast_sent',
        category: 'SYSTEM',
        message: 'Broadcast partially delivered: 360 sent, 40 failed',
        metadata: { broadcastId: 'bc-1', sentCount: 360, failedCount: 40 },
      },
      {
        type: 'system.backup_completed',
        category: 'SYSTEM',
        message: 'Backup stored locally — not delivered to Telegram (crypt_key_missing): b-2.sql.gz',
        metadata: { backupId: 'rec-2', filename: 'b-2.sql.gz', deliveredToTelegram: false, relayStatus: 'crypt_key_missing' },
      },
      {
        type: 'reiwa.relay_undelivered',
        category: 'SYSTEM',
        message: 'Reiwa relay did not deliver reiwa.channel.broadcast (rejected)',
        metadata: { relayEvent: 'reiwa.channel.broadcast', relayStatus: 'rejected' },
      },
    ];
    for (const event of noisy) {
      const { service, getLastText } = buildService();
      service.warn(event.type, event.category, event.message, event.metadata);
      await flush();
      const card = getLastText() ?? '';
      assert.ok(headerOf(card) !== undefined, `${event.type}: no card; got ${card}`);
      assert.ok(
        !card.includes(event.message),
        `${event.type}: the producer's sentence is back on the card:\n${card}`,
      );
    }
  });

  it('prints the message of an opted-in WARNING directly under its title, escaped', async () => {
    // The other half: a type whose message is written for the card. The
    // Telegram refusal it quotes is Telegram's own text, so it is `<code>`.
    const { service, getLastText } = buildService();
    service.warn(
      'telegram.direct_undelivered',
      'SYSTEM',
      'Панель не доставила карточку в Telegram: Telegram отклонил сообщение: Bad Request: <b> & more',
      { sourceEventType: 'payment.completed', chatId: '-100', detail: 'Bad Request: <b> & more' },
    );
    await flush();
    const text = getLastText()!;
    const lines = text.split('\n');
    const header = lines.findIndex((line) => line.includes('<b>Событие:'));
    assert.ok(header > 0, `no header line; got: ${text}`);
    // Directly under the title — not in some block further down, where it
    // would read as one more detail rather than as what happened.
    assert.equal(
      lines[header + 1],
      '<blockquote>Telegram отклонил сообщение: <code>Bad Request: &lt;b&gt; &amp; more</code></blockquote>',
    );
    // Said once: the details block does not repeat the quoted refusal.
    assert.ok(!text.includes('Подробности'), text);
  });

  it('prints a `warning`-only message at WARNING and not at INFO', async () => {
    const sentence = 'Панель не доставила карточку в Telegram: Не удалось связаться с Telegram';
    const { service, getLastText } = buildService();
    service.info('telegram.direct_undelivered', 'SYSTEM', sentence, { sourceEventType: 'x.y' });
    await flush();
    assert.ok(!getLastText()!.includes('Не удалось связаться с Telegram'), getLastText()!);

    service.warn('telegram.direct_undelivered', 'SYSTEM', sentence, { sourceEventType: 'x.y' });
    await flush();
    assert.ok(getLastText()!.includes('<blockquote>Не удалось связаться с Telegram</blockquote>'), getLastText()!);
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

  it('names the operator on a card an operator caused', async () => {
    // THE COMPLAINT THIS EXISTS FOR. «Подписка удалена!» arrived naming the
    // source — «Rezeis Админ-панель» — and stopping there, so on a panel with
    // more than one operator nobody could tell who had done it without going
    // to the audit log and matching timestamps.
    const { service, getLastText } = buildService({ admins: { 'adm-1': 'dizzable' } });
    service.emit({
      type: 'subscription.deleted',
      category: 'SUBSCRIPTION',
      severity: 'INFO',
      message: 'Subscription deleted',
      adminId: 'adm-1',
      metadata: { subscriptionId: 'sub-1', userId: 'usr-1', source: 'ADMIN_PANEL' },
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('🛠 Админ: <code>dizzable</code>'), text);
    // …and the source line it used to carry alone is still there: the two
    // answer different questions (WHERE from, WHO).
    assert.ok(text.includes('Rezeis Админ-панель'), text);
  });

  it('prints no operator line for an event no operator caused', async () => {
    // Anti-vacuity for the case above: if the line appeared unconditionally,
    // the assertion there would pass on a card that learned nothing. The
    // expiry sweep has no actor, and inventing one would be a lie.
    const { service, getLastText } = buildService({ admins: { 'adm-1': 'dizzable' } });
    service.info('subscription.deleted', 'SUBSCRIPTION', 'Subscription deleted', {
      subscriptionId: 'sub-1',
      userId: 'usr-1',
      source: 'EXPIRED_PROFILE_CLEANUP',
    });
    await flush();
    assert.ok(!getLastText()!.includes('🛠 Админ:'), getLastText()!);
  });

  it('keeps the card when the admin row is gone rather than printing an id', async () => {
    // A revoked account still has its id in the audit log. On the card that id
    // would be a cuid pointed at a person, which is worse than nothing.
    const { service, getLastText } = buildService({ admins: {} });
    service.emit({
      type: 'subscription.deleted',
      category: 'SUBSCRIPTION',
      severity: 'INFO',
      message: 'Subscription deleted',
      adminId: 'adm-gone',
      metadata: { subscriptionId: 'sub-1', userId: 'usr-1' },
    });
    await flush();
    const text = getLastText()!;
    assert.ok(!text.includes('🛠 Админ:'), text);
    assert.ok(text.includes('🌀 <b>Контекст:</b>'), text);
  });

  it('says how much of a promocode is left on the promocode card', async () => {
    // «Промокод создан» and «Промокод исчерпан» are about these two numbers,
    // and `promocode.archived` has carried the first since it was written with
    // nothing printing it.
    const { service, getLastText } = buildService();
    service.info('promocode.created', 'PROMOCODE', 'created', {
      promocodeId: 'promo-1',
      code: 'SUMMER',
      activationsCount: 0,
      maxActivations: 50,
    });
    await flush();
    const text = getLastText()!;
    assert.ok(text.includes('🧮 Активаций: 0'), text);
    assert.ok(text.includes('🎚 Лимит активаций: 50'), text);
  });

  it('says which kind of notification a payment webhook card is about', async () => {
    // Four very different things arrive on the same address: an ordinary
    // payment notification, a provider-subscription status, an autopay charge
    // and a zero-amount card binding. Without this line the card says only
    // «Вебхук платёжки» and an operator cannot tell an autopay charge from a
    // card being saved.
    const { service, getLastText } = buildService();
    service.info('payment.webhook_received', 'PAYMENT', 'accepted', {
      gatewayType: 'PLATEGA',
      webhookKind: 'subscription-charge',
      paymentId: 'pay-9',
    });
    await flush();
    assert.ok(getLastText()!.includes('📩 Вид: Списание по подписке'), getLastText()!);
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
    // Once, not twice. `countryCodeToFlag` returns the flag AND the code, so
    // appending the code beside it printed «Страна: 🇩🇪 DE DE» — which a bare
    // `/DE/` cannot see.
    assert.equal(
      (card.match(/\bDE\b/g) ?? []).length,
      1,
      'the country code is printed more than once',
    );
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
    // The BLOCK, not the word. `/block/` alone is satisfied by the
    // `<blockquote>` every card emits, and `/12/` and `/15/` collide with the
    // rendered timestamp — three assertions that could not fail. Pin the
    // heading and the line the operator actually reads.
    assert.match(card, /👥 <b>Массовая операция:<\/b>/, 'the bulk block is missing');
    assert.match(card, /Действие: <code>block<\/code>/, 'the action is missing');
    assert.match(card, /Успешно: 12 из 15/, 'the success ratio is missing');
    assert.match(card, /Ошибок: 2/, 'the failure count is missing');
    assert.match(card, /Пропущено: 1/, 'the skipped count is missing');
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

  it('keeps the raw machine message off a card whose blocks carry the facts', async () => {
    // The blocks exist so the header can stay; they must not smuggle the
    // message back in through a metadata key. (The WARNING half of this is
    // the first describe's case about types that do not opt in.)
    const { service, getLastText } = buildService();
    service.info('node.geo_concentration', 'NODE', 'RAW-MACHINE-SENTENCE', {
      country: 'DE',
      percentInCountry: 73,
      usersInCountry: 219,
      totalOnline: 300,
    });
    await flush();

    const card = getLastText() ?? '';
    assert.doesNotMatch(card, /RAW-MACHINE-SENTENCE/);
    assert.equal(headerOf(card), '🌍 <b>Событие: Концентрация онлайна в одной стране!</b>');
  });
});

/**
 * A failure must not be announced as the success it failed to be
 * ═══════════════════════════════════════════════════════════════
 * Several producers raise their FAILURES under the type of the success:
 * `system.backup_completed` for a backup that never reached Telegram,
 * `system.broadcast_sent` for one that reached part of its audience,
 * `broadcast.started` for a partial recall and for a stalled broadcast put back
 * in the queue. The card printed the success title for all of them and dropped
 * the message and the metadata that said otherwise, so an operator read
 * «Резервная копия создана!» about a backup that existed nowhere.
 *
 * These cases pin all three halves: a warning header of its own, the facts
 * (reason, counts, rule, chat) in the blocks and details, and the message under
 * the title for exactly the types whose facts live in the message alone.
 */
describe('a warning raised under a success type', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('names a backup the relay never confirmed as undelivered, with the real reason', async () => {
    // Emitted exactly as `BackupService.recordRelayNotDelivered` does it.
    const { service, getLastText } = buildService();
    service.warn(
      'system.backup_completed',
      'SYSTEM',
      'Backup stored locally — Telegram relay did not confirm delivery (unconfirmed): b-1.sql.gz',
      {
        backupId: 'rec-1',
        filename: 'b-1.sql.gz',
        deliveredToTelegram: false,
        relayStatus: 'unconfirmed',
        httpStatus: 502,
        detail: 'bad gateway from the cabinet',
      },
    );
    await flush();
    const card = getLastText()!;

    assert.equal(headerOf(card), '⚠️ <b>Событие: Резервная копия не доставлена в Telegram!</b>');
    assert.ok(!card.includes('Резервная копия создана'), `a success title on a failure; got: ${card}`);
    // Said once, in Russian, by the «Доставка» line — the English sentence
    // restating it is not printed.
    assert.ok(!card.includes('Telegram relay did not confirm delivery'));
    assert.ok(
      card.includes('📥 Доставка: только локально — reiwa не подтвердила отправку'),
      `the delivery line must name the relay outcome; got: ${card}`,
    );
    assert.ok(!card.includes('слишком большой'), 'the one reason this was NOT');
    assert.ok(card.includes('🌐 Ответ HTTP: 502'));
    // The cabinet's own words, untranslated, and marked as such.
    assert.ok(card.includes('🧾 Подробности: <code>bad gateway from the cabinet</code>'));
    // Stated once: the backup block already turned the status into words.
    assert.ok(!card.includes('Статус доставки'));
  });

  it('names each terminal reason the card of last resort can carry', async () => {
    // `attemptTelegramDelivery` passes `outcome.reason` as `relayStatus`.
    const { service, getLastText } = buildService();
    service.warn(
      'system.backup_completed',
      'SYSTEM',
      'Backup stored locally — not delivered to Telegram (crypt_key_missing): b-2.sql.gz',
      { backupId: 'rec-2', filename: 'b-2.sql.gz', deliveredToTelegram: false, relayStatus: 'crypt_key_missing' },
    );
    await flush();
    assert.ok(getLastText()!.includes('📥 Доставка: только локально — не задан REZEIS_CRYPT_KEY'));
  });

  it('does not name one half of `not_configured` as the reason', async () => {
    // `runTelegramDelivery` answers `not_configured` when delivery is switched
    // off AND when it is switched on with no Chat ID. «выключена» told the
    // operator whose switch was on that it was off.
    const { service, getLastText } = buildService();
    service.warn(
      'system.backup_completed',
      'SYSTEM',
      'Backup stored locally — not delivered to Telegram (not_configured): b-6.sql.gz',
      { backupId: 'rec-6', filename: 'b-6.sql.gz', deliveredToTelegram: false, relayStatus: 'not_configured' },
    );
    await flush();
    const card = getLastText()!;
    assert.ok(
      card.includes(
        '📥 Доставка: только локально — доставка в Telegram не настроена (выключена или не указан Chat ID)',
      ),
      `got: ${card}`,
    );
  });

  it('still says «too large» for the file that is too large', async () => {
    const { service, getLastText } = buildService();
    service.warn(
      'system.backup_completed',
      'SYSTEM',
      'Backup stored locally (too large for Telegram): b-3.sql.gz (60 MB)',
      {
        backupId: 'rec-3',
        filename: 'b-3.sql.gz',
        sizeBytes: 60 * 1024 * 1024,
        deliveredToTelegram: false,
        relayStatus: 'too_large_for_telegram',
      },
    );
    await flush();
    assert.ok(
      getLastText()!.includes('📥 Доставка: только локально — файл слишком большой для Telegram'),
    );
  });

  it('does not call a backup deleted by retention «stored locally»', async () => {
    // `applyRetention` removed the only copy: there is no local file either.
    const { service, getLastText } = buildService();
    service.warn(
      'system.backup_completed',
      'SYSTEM',
      'Retention deleted the only copy of b-4.sql.gz — it was never delivered off-site',
      {
        backupId: 'rec-4',
        filename: 'b-4.sql.gz',
        deliveredToTelegram: false,
        deliveryChannel: null,
        maxKeep: 3,
        deletedByRetention: true,
      },
    );
    await flush();
    const card = getLastText()!;
    assert.ok(!card.includes('Retention deleted the only copy'), 'restated by the delivery line');
    assert.ok(card.includes('🗂 Файл: <code>b-4.sql.gz</code>'));
    assert.ok(card.includes('📥 Доставка: копии больше нет'), `got: ${card}`);
    assert.ok(!card.includes('только локально'));
  });

  it('keeps the success title and no delivery line for a backup that simply completed', async () => {
    // The control: the warning header must be reachable only by a warning.
    const { service, getLastText } = buildService();
    service.info('system.backup_completed', 'SYSTEM', 'Backup completed: b-5.sql.gz (5 MB)', {
      backupId: 'rec-5',
      filename: 'b-5.sql.gz',
      sizeBytes: 5 * 1024 * 1024,
    });
    await flush();
    const card = getLastText()!;
    assert.equal(headerOf(card), '🗄 <b>Событие: Резервная копия создана!</b>');
    assert.ok(!card.includes('Доставка:'));
  });

  it('reports a partial broadcast as partial, with both counts', async () => {
    // `BroadcastDeliveryService.checkAndFinalize`, some recipients failed.
    const { service, getLastText } = buildService();
    service.warn(
      'system.broadcast_sent',
      'SYSTEM',
      'Broadcast partially delivered: 360 sent, 40 failed',
      { broadcastId: 'bc-1', sentCount: 360, failedCount: 40 },
    );
    await flush();
    const card = getLastText()!;
    assert.equal(headerOf(card), '⚠️ <b>Событие: Рассылка доставлена не всем!</b>');
    assert.ok(!card.includes('Рассылка отправлена'));
    assert.ok(card.includes('📬 Доставлено: 360'));
    assert.ok(card.includes('📭 Не доставлено: 40'));
    // The counts once, in the details — not again in the producer's sentence.
    assert.ok(!card.includes('360 sent'), `the counts are repeated:\n${card}`);
  });

  it('titles a batch that lost recipients as a failure, though it is INFO', async () => {
    // `BroadcastProcessor.handleBatch` raises every batch as INFO, failures or
    // not, so the severity cannot pick the header here — the metadata does.
    const { service, getLastText } = buildService();
    service.info('broadcast.batch_completed', 'SYSTEM', 'Batch: 46 sent, 4 failed', {
      broadcastId: 'bc-7',
      sent: 46,
      failed: 4,
      unresolved: 0,
      batchSize: 50,
    });
    await flush();
    const lossy = getLastText()!;
    assert.equal(headerOf(lossy), '⚠️ <b>Событие: Партия рассылки доставлена не всем!</b>');
    assert.ok(!lossy.includes('Партия рассылки отправлена'), `a success title on a failure:\n${lossy}`);
    // The counts in Russian, from the metadata — not the English sentence.
    assert.ok(lossy.includes('📬 Отправлено: 46'), lossy);
    assert.ok(lossy.includes('📭 Не доставлено: 4'), lossy);
    assert.ok(!lossy.includes('Batch: 46 sent'), lossy);

    // The control: a clean batch keeps its title.
    service.info('broadcast.batch_completed', 'SYSTEM', 'Batch: 50 sent, 0 failed', {
      broadcastId: 'bc-7',
      sent: 50,
      failed: 0,
      unresolved: 0,
      batchSize: 50,
    });
    await flush();
    assert.equal(headerOf(getLastText()!), '📬 <b>Событие: Партия рассылки отправлена!</b>');
  });

  it('titles a restore whose migrations did not run as exactly that', async () => {
    // `BackupProcessor` raises the restore as WARNING when `migrationsApplied`
    // is false: the data is in, the schema is not.
    const { service, getLastText } = buildService();
    service.warn(
      'system.restore_completed',
      'SYSTEM',
      'Database restored from b-8.sql.gz, but the pending migrations were not applied — restart the panel (API container) so its entrypoint applies them',
      { filename: 'b-8.sql.gz', migrationsApplied: false, success: true },
    );
    await flush();
    const warned = getLastText()!;
    assert.equal(headerOf(warned), '⚠️ <b>Событие: База восстановлена, но миграции не применены!</b>');
    assert.ok(!warned.includes('База восстановлена из копии'), `a success title on a failure:\n${warned}`);
    assert.ok(warned.includes('🧱 Миграции: не применены'), warned);
    assert.ok(!warned.includes('pending migrations were not applied'), warned);

    service.info('system.restore_completed', 'SYSTEM', 'Database restored from b-9.sql.gz', {
      filename: 'b-9.sql.gz',
      migrationsApplied: true,
      success: true,
    });
    await flush();
    assert.equal(headerOf(getLastText()!), '♻️ <b>Событие: База восстановлена из копии!</b>');
  });

  it('reports a partial recall and a revived broadcast as problems, not as a start', async () => {
    const { service, getLastText } = buildService();
    service.warn(
      'broadcast.started',
      'SYSTEM',
      'Recall removed 3 of 5 messages in this batch; 2 could not be deleted',
      { broadcastId: 'bc-2', deleted: 3, failed: 2 },
    );
    await flush();
    const recall = getLastText()!;
    assert.equal(headerOf(recall), '⚠️ <b>Событие: Проблема с рассылкой!</b>');
    assert.ok(recall.includes('🗑 Удалено у получателей: 3'), recall);
    assert.ok(recall.includes('⚠️ Не удалось удалить: 2'), recall);
    assert.ok(!recall.includes('Recall removed'), recall);

    // `BroadcastReconcilerService.revive`, which carries the reason as `detail`.
    service.warn('broadcast.started', 'SYSTEM', 'Broadcast bc-3 was picked up again: 12 recipients still undispatched', {
      broadcastId: 'bc-3',
      attempts: 1,
      detail: '12 recipients still undispatched',
    });
    await flush();
    const revived = getLastText()!;
    assert.equal(headerOf(revived), '⚠️ <b>Событие: Проблема с рассылкой!</b>');
    assert.ok(!revived.includes('Рассылка запущена'));
    assert.ok(revived.includes('🆔 ID: <code>bc-3</code>'), revived);
    assert.ok(revived.includes('🔁 Попытка возобновления: 1'), revived);
    assert.ok(!revived.includes('was picked up again'), revived);
    // Once, as the raw reason it is.
    assert.equal(
      revived.split('12 recipients still undispatched').length - 1,
      1,
      `the reason is repeated:\n${revived}`,
    );
    assert.ok(revived.includes('🧾 Подробности: <code>12 recipients still undispatched</code>'), revived);
    assert.ok(!revived.includes('Почему'), 'a reason is not an explanation');
  });

  it('still prints a detail the printed message does not contain', async () => {
    // The dedupe is by content, not by "a message was printed".
    const { service, getLastText } = buildService();
    service.warn('telegram.direct_undelivered', 'SYSTEM', 'Панель не доставила карточку в Telegram: Telegram не ответил вовремя', {
      sourceEventType: 'payment.completed',
      chatId: '-100',
      detail: 'TimeoutError',
    });
    await flush();
    assert.ok(getLastText()!.includes('🧾 Подробности: <code>TimeoutError</code>'), getLastText()!);
  });

  it('states the audience of a starting broadcast in Russian, from its metadata', async () => {
    // `BroadcastDeliveryService.stageRecipients`: the size used to reach the
    // card only as `Broadcast staging: 400 recipients`.
    const { service, getLastText } = buildService();
    service.info('broadcast.started', 'SYSTEM', 'Broadcast staging: 400 recipients', {
      broadcastId: 'bc-4',
      recipientCount: 400,
      channelPost: 'disabled',
    });
    await flush();
    const card = getLastText()!;
    assert.equal(headerOf(card), '📣 <b>Событие: Рассылка запущена!</b>');
    assert.ok(card.includes('👥 Получателей: 400'), card);
    assert.ok(card.includes('📡 Пост в канал: не отправлен: связь панели с reiwa не настроена'), card);
    assert.ok(!card.includes('Broadcast staging'), card);
  });

  it('delivers the text and the rule name of an automation notification', async () => {
    // `ActionRegistry.notifyTelegram` — the text IS the notification.
    const { service, getLastText } = buildService();
    service.warn('automation.telegram_notify', 'SYSTEM', 'Узел DE-1 снова в строю', {
      ruleId: 'rule-1',
      ruleName: 'Сообщать о нодах',
      trigger: 'node.connection_restored',
      automationChainDepth: 1,
    });
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('<blockquote>Узел DE-1 снова в строю</blockquote>'), `got: ${card}`);
    assert.ok(card.includes('🤖 Правило: Сообщать о нодах'));
    assert.ok(card.includes('⚡ Сработало на: <code>node.connection_restored</code>'), card);
  });

  it('delivers an automation text past the cap on producer sentences whole', async () => {
    // `params.text` is the operator's own notification, not a log line, and
    // nothing bounds it. The 1000-character cap on a producer's sentence cut
    // the notification itself and kept the frame around it.
    const text = `Нода DE-1 недоступна. ${'Подробности инцидента для дежурного. '.repeat(70)}`.trim();
    assert.ok(text.length > 2000, 'the fixture must be past the sentence cap');
    const { service, getLastText } = buildService();
    service.warn('automation.telegram_notify', 'SYSTEM', text, { ruleName: 'Сообщать о нодах' });
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes(`<blockquote>${text}</blockquote>`), `the text was cut:\n${card.slice(0, 400)}`);
    assert.ok(card.includes('🤖 Правило: Сообщать о нодах'));
  });

  it('shortens an automation text past Telegram’s limit, and keeps the rule and the context', async () => {
    // Left to the card clipper, the text — directly under the title — kept
    // itself and cut everything after it: «🤖 Правило», «Контекст», «Сборка».
    // The text is the part that gives way.
    const unit = 'Строка уведомления. ';
    const { service, getLastText } = buildService();
    service.warn('automation.telegram_notify', 'SYSTEM', unit.repeat(400).trim(), {
      ruleId: 'rule-9',
      ruleName: 'Длинное правило',
      trigger: 'node.connection_lost',
    });
    await flush();
    const card = getLastText()!;
    assert.ok(card.length <= 4096, `${card.length} > 4096`);
    assert.ok(card.includes('🤖 Правило: Длинное правило'), `the rule was cut off:\n${card.slice(-600)}`);
    assert.ok(card.includes('⚡ Сработало на: <code>node.connection_lost</code>'), card.slice(-600));
    assert.ok(card.includes('🌀 <b>Контекст:</b>'), `the context was cut off:\n${card.slice(-600)}`);
    assert.ok(card.includes('🏗 <b>Сборка:</b>'), card.slice(-600));
    // The text says it was shortened, inside its own quote.
    assert.ok(/…<\/blockquote>/.test(card), 'a shortened text must say so');
    assert.equal(
      card.split('<blockquote>').length,
      card.split('</blockquote>').length,
      'a quote was left open',
    );
    // Still well past the 1000 characters the sentence cap used to leave: the
    // text is bounded by the room the card leaves, not by a cap for log lines.
    const kept = card.split(unit.trim()).length - 1;
    assert.ok(kept * unit.length > 3000, `only ${kept * unit.length} characters of the text survived`);
  });

  it('names the card, the chat and the reason of an undelivered panel card', async () => {
    // `TelegramDirectProcessor.recordUndelivered`.
    const { service, getLastText } = buildService();
    service.warn(
      'telegram.direct_undelivered',
      'SYSTEM',
      'Панель не доставила карточку в Telegram: Telegram отклонил токен бота — проверьте «Настройки» → «Токен бота»',
      {
        sourceEventType: 'payment.completed',
        sendKind: 'message',
        chatId: '-1001234567890',
        telegramStatus: 'unauthorized',
        httpStatus: 401,
        detail: 'Unauthorized',
        attemptsMade: 4,
        attempts: 4,
      },
    );
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('Telegram отклонил токен бота'), `the reason is missing; got: ${card}`);
    // The sentence opens with the card's own title; under that title it is
    // printed from the colon on, not with the title said twice.
    const lines = card.split('\n');
    const header = lines.findIndex((line) => line.includes('<b>Событие:'));
    assert.equal(
      lines[header + 1],
      '<blockquote>Telegram отклонил токен бота — проверьте «Настройки» → «Токен бота»</blockquote>',
    );
    assert.ok(card.includes('🏷 Карточка события: <code>payment.completed</code>'));
    assert.ok(card.includes('💬 Чат: <code>-1001234567890</code>'));
    assert.ok(card.includes('🌐 Ответ HTTP: 401'));
    assert.ok(card.includes('🔂 Попыток: 4 из 4'), card);
  });

  it('gives an undelivered panel card its topic and its repeat count, said once', async () => {
    // A coalesced alert (`createUndeliveredRecorder`) appends the count to its
    // sentence and sets `repeatsSincePreviousAlert`. The details block states
    // the count on both undelivered cards; this one prints its sentence too,
    // so the appended copy is not repeated in it.
    const { service, getLastText } = buildService();
    service.warn(
      'telegram.direct_undelivered',
      'SYSTEM',
      'Панель не доставила карточку в Telegram: Не удалось связаться с Telegram; таких же с прошлого оповещения: 6',
      {
        sourceEventType: 'payment.completed',
        chatId: '-1001234567890',
        topicId: 42,
        telegramStatus: 'failed',
        attemptsMade: 4,
        attempts: 4,
        repeatsSincePreviousAlert: 6,
      },
    );
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('<blockquote>Не удалось связаться с Telegram</blockquote>'), card);
    assert.ok(card.includes('🔁 Таких же с прошлого оповещения: 6'), card);
    assert.equal(card.split(': 6').length - 1, 1, `the count is said twice:\n${card}`);
    assert.ok(card.includes('🧵 Топик: <code>42</code>'), card);
  });

  it('names what an undelivered relay lost: the broadcast, the chat, the topic, how often', async () => {
    // `buildRelayUndeliveredRecord`, coalesced. A broadcast's channel copy is
    // relayed under `broadcast-channel:<broadcastId>`, and a lost one raises no
    // card of its own any more — so this card has to say which broadcast.
    const { service, getLastText } = buildService();
    service.warn(
      'reiwa.relay_undelivered',
      'SYSTEM',
      'Reiwa relay did not deliver reiwa.channel.broadcast (rejected); 37 more like it since the previous alert',
      {
        relayEvent: 'reiwa.channel.broadcast',
        relayStatus: 'rejected',
        httpStatus: 400,
        detail: 'chat not found',
        attemptsMade: 1,
        attempts: 4,
        relayEventId: 'broadcast-channel:bc-77',
        chatId: '-1005550001',
        topicId: 9,
        repeatsSincePreviousAlert: 37,
      },
    );
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('📨 Маршрут реле: <code>reiwa.channel.broadcast</code>'));
    assert.ok(card.includes('📡 Статус доставки: <code>rejected</code>'));
    assert.ok(card.includes('🧾 Подробности: <code>chat not found</code>'), card);
    assert.ok(card.includes('📣 Пост в канал рассылки: <code>bc-77</code>'), card);
    assert.ok(card.includes('💬 Чат: <code>-1005550001</code>'), card);
    assert.ok(card.includes('🧵 Топик: <code>9</code>'), card);
    assert.ok(card.includes('🔁 Таких же с прошлого оповещения: 37'), card);
    assert.ok(card.includes('🔂 Попыток: 1 из 4'), card);

    // Any other relayed message is named by its key.
    service.warn('reiwa.relay_undelivered', 'SYSTEM', 'Reiwa relay did not deliver reiwa.dev.notify (timeout)', {
      relayEvent: 'reiwa.dev.notify',
      relayStatus: 'timeout',
      attemptsMade: 4,
      attempts: 4,
      relayEventId: 'sysevt:payment.completed:2026-09-14T10:00:00.000Z:dev-0123456789abcdef',
    });
    await flush();
    assert.ok(
      getLastText()!.includes(
        '🔑 Ключ события: <code>sysevt:payment.completed:2026-09-14T10:00:00.000Z:dev-0123456789abcdef</code>',
      ),
      getLastText()!,
    );
  });

  it('says the queue refused the job when the send was the direct fallback', async () => {
    // `undelivered-record.ts`: a producer whose job Redis would not take makes
    // one direct attempt, and `enqueueError` is what tells that road apart.
    const { service, getLastText } = buildService();
    service.warn('reiwa.relay_undelivered', 'SYSTEM', 'Reiwa relay did not deliver reiwa.dev.notify (failed)', {
      relayEvent: 'reiwa.dev.notify',
      relayStatus: 'failed',
      attemptsMade: 1,
      attempts: 1,
      enqueueError: 'Connection is closed <redis>',
    });
    await flush();
    assert.ok(
      getLastText()!.includes(
        '🧯 Очередь не приняла задачу: <code>Connection is closed &lt;redis&gt;</code>',
      ),
    );
  });

  it('states a Remnawave sync job’s facts in Russian, and prints a producer’s note', async () => {
    // The jobs' sentences are English audit-log paragraphs. The counts are in
    // the metadata; the instruction a warning exists to give is the producer's
    // Russian `note`.
    const instruction =
      'Expired-profile cleanup: left 3 expired subscription(s) alone — their panel link was lost. ' +
      'Run the panel-link reconciliation; they retire normally once relinked.';
    const { service, getLastText } = buildService();
    service.warn('system.remnawave_sync', 'SYSTEM', instruction, {
      subscriptions: 3,
      note: 'Запустите сверку привязок к панели: после неё подписки удалятся как обычно.',
    });
    await flush();
    const warning = getLastText()!;
    assert.ok(!warning.includes('Expired-profile cleanup'), warning);
    assert.ok(warning.includes('📦 Подписок: 3'), warning);
    assert.ok(
      warning.includes('📝 Заметка: Запустите сверку привязок к панели: после неё подписки удалятся как обычно.'),
      warning,
    );

    service.info('system.remnawave_sync', 'SYSTEM', 'Panel link reconciliation: linked 5 of 9 rows', {
      dryRun: false,
      scanned: 9,
      linked: 5,
    });
    await flush();
    const report = getLastText()!;
    assert.ok(!report.includes('Panel link reconciliation'), report);
    assert.ok(report.includes('🔎 Проверено строк: 9'), report);
    assert.ok(report.includes('🔗 Привязано: 5'), report);
    assert.ok(report.includes('🧪 Пробный прогон: нет'), report);
  });
});

/**
 * The fact a review card exists for
 * ═════════════════════════════════
 * Three `PaymentReconciliationService` warnings each hang on one figure the
 * booked sum does not show — what the provider notified, what was refunded —
 * and the payment block printed only «💷 Сумма». So «Оплачена неверная сумма!»
 * arrived over «499.00 ₽» and nothing on the card said 120 had arrived.
 *
 * And the manual-review hold is one mechanism for every "money situation a
 * human must settle": a completion YooKassa refused to confirm is held under
 * `payment.amount_mismatch` too, and must not be titled as an underpayment.
 *
 * Metadata copied from the producers named in each case.
 */
describe('a payment card that needs a review', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  const booked = {
    userId: 'user-1',
    paymentId: 'pay-1',
    gatewayType: 'CRYPTOMUS',
    amount: '499.00',
    currency: 'RUB',
  };

  it('shows what arrived on a held underpayment', async () => {
    // `flagAmountMismatchForReview` → `holdPaymentForManualReview`.
    const { service, getLastText } = buildService();
    service.warn('payment.amount_mismatch', 'PAYMENT', 'Оплачена неверная сумма: NEW', {
      ...booked,
      notifiedAmount: '120.00',
      providerStatus: 'wrong_amount',
      needsManualReview: true,
    });
    await flush();
    const card = getLastText()!;
    assert.equal(headerOf(card), '⚠️ <b>Событие: Оплачена неверная сумма!</b>');
    assert.ok(card.includes('💷 Сумма: 499.00 ₽'), card);
    assert.ok(card.includes('📨 Сумма в уведомлении: 120.00 ₽'), card);
    assert.ok(card.includes('📡 Статус у провайдера: <code>wrong_amount</code>'), card);
  });

  it('titles a completion the provider refused to confirm as exactly that', async () => {
    // `flagUnconfirmedCompletionForReview`: same hold, same type, a different
    // situation — told apart by `verificationReason`, which only it sets.
    const { service, getLastText } = buildService();
    service.warn('payment.amount_mismatch', 'PAYMENT', 'Платёж не подтверждён провайдером: NEW', {
      ...booked,
      gatewayType: 'YOOKASSA',
      providerStatus: 'canceled',
      notificationClaimedStatus: 'succeeded',
      verificationReason: 'PAYMENT_VERIFICATION_PROVIDER_CANCELED',
      needsManualReview: true,
    });
    await flush();
    const card = getLastText()!;
    assert.equal(headerOf(card), '🛡 <b>Событие: Платёж не подтверждён провайдером!</b>');
    assert.ok(!card.includes('Оплачена неверная сумма'), `titled as an underpayment:\n${card}`);
    assert.ok(card.includes('🛡 Проверка у провайдера: ЮKassa сообщает, что платёж отменён'), card);
    assert.ok(card.includes('📨 Статус в уведомлении: <code>succeeded</code>'), card);
    assert.ok(card.includes('📡 Статус у провайдера: <code>canceled</code>'), card);
  });

  it('shows how much of a payment a partial refund returned', async () => {
    // `applyRefundEvent`, partial branch.
    const { service, getLastText } = buildService();
    service.warn('payment.refund_partial', 'PAYMENT', 'Частичный возврат платежа: NEW', {
      ...booked,
      refundedAmount: '100',
      refundedAmountTotal: '150.00',
      providerStatus: 'refunded',
      refund: true,
      partial: true,
      needsManualReview: true,
    });
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('↩️ Возвращено сейчас: 100 ₽'), card);
    assert.ok(card.includes('↩️ Возвращено всего: 150.00 ₽'), card);
  });

  it('shows the notified sum beside the booked one on a short notification', async () => {
    // `alertNotifiedAmountShortfall`.
    const { service, getLastText } = buildService();
    service.warn('payment.notified_amount_short', 'PAYMENT', 'Сумма в уведомлении меньше суммы заказа: NEW', {
      ...booked,
      notifiedAmount: '480.00',
      providerStatus: 'paid',
      needsManualReview: false,
    });
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('💷 Сумма: 499.00 ₽'), card);
    assert.ok(card.includes('📨 Сумма в уведомлении: 480.00 ₽'), card);
    assert.ok(card.includes('📡 Статус у провайдера: <code>paid</code>'), card);
  });
});

/**
 * Metadata is operator- and client-controlled; the card is HTML
 * ══════════════════════════════════════════════════════════════
 * A HWID is whatever the VPN client sent, an `error` is an exception message
 * quoting whatever it choked on. Interpolated raw, a `<` either forged markup
 * or — far more often — made Telegram refuse the whole card.
 */
describe('values a card does not control', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('escapes the HWID, the error, the action and the attempt', async () => {
    const { service, getLastText } = buildService();
    service.info('user_hwid_revoked', 'DEVICE', 'x', {
      hwid: '<i>hw</i>',
      remainingDevices: '<i>2</i>',
      error: 'unexpected <html> & friends',
      action: '<b>revoke</b>',
      attempt: '<u>3</u>',
    });
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('🧬 HWID: <code>&lt;i&gt;hw&lt;/i&gt;</code>'), `got: ${card}`);
    assert.ok(card.includes('📱 Осталось устройств: &lt;i&gt;2&lt;/i&gt;'));
    assert.ok(card.includes('💬 Сообщение: <code>unexpected &lt;html&gt; &amp; friends</code>'));
    assert.ok(card.includes('🧷 Действие: <code>&lt;b&gt;revoke&lt;/b&gt;</code>'));
    assert.ok(card.includes('🔁 Попытка: &lt;u&gt;3&lt;/u&gt;'));
    for (const raw of ['<i>', '<html>', '<b>revoke', '<u>']) {
      assert.ok(!card.includes(raw), `${raw} reached the card unescaped`);
    }
  });

  it('cannot close a link attribute with a quote in the URL', async () => {
    const { service, getLastText } = buildService();
    service.info('payment.completed', 'PAYMENT', 'paid', {
      paymentId: 'pay-1',
      amount: '10',
      receiptUrl: 'https://receipt.example/r?a="x"&b=1',
    });
    await flush();
    assert.ok(
      getLastText()!.includes('<a href="https://receipt.example/r?a=&quot;x&quot;&amp;b=1">Чек</a>'),
    );
  });
});

/**
 * «15:30» — in which zone?
 * ════════════════════════
 * Card times were `toLocaleString('ru-RU')` in the CONTAINER's zone, which is
 * UTC under compose, with nothing on the card saying so. The panel already has
 * the operator's zone — `platformPolicy.timezone`, the one customer
 * notifications are written in — so the card uses it and names it.
 */
describe('times on a card', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it("are written in the operator's zone and name it", async () => {
    const { service, getLastText } = buildService({ platformPolicy: { timezone: 'Europe/Moscow' } });
    service.emit({
      type: 'payment.completed',
      category: 'PAYMENT',
      severity: 'INFO',
      message: 'paid',
      metadata: { paymentId: 'pay-1', amount: '10', paidAt: '2026-09-14T15:30:00.000Z' },
      timestamp: '2026-09-14T15:31:00.000Z',
    });
    await flush();
    const card = getLastText()!;
    assert.ok(card.includes('⏰ Время: 14.09.2026, 18:31:00 GMT+3'), `got: ${card}`);
    assert.ok(card.includes('⏰ Оплачено: 14.09.2026, 18:30:00 GMT+3'));
  });

  it('say UTC when no zone is set, and when the stored one is not a zone', async () => {
    // Run in a process zone that is NOT UTC. The suite runs under `TZ=UTC`,
    // where "UTC" and "whatever zone the container is in" print the same
    // string — so a card that fell back to the container's zone passed this
    // case exactly as well as one that says UTC. Tokyo is nine hours away and
    // has no daylight saving to make the expectation depend on the date.
    const savedZone = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      assert.equal(
        new Date('2026-09-14T15:31:00.000Z').getHours(),
        0,
        'the process zone did not change, so this case would prove nothing',
      );
      for (const platformPolicy of [{}, { timezone: 'Mars/Olympus_Mons' }]) {
        const { service, getLastText } = buildService({ platformPolicy });
        service.emit({
          type: 'payment.completed',
          category: 'PAYMENT',
          severity: 'INFO',
          message: 'paid',
          metadata: { paymentId: 'pay-1', amount: '10' },
          timestamp: '2026-09-14T15:31:00.000Z',
        });
        await flush();
        const card = getLastText()!;
        assert.ok(
          card.includes('⏰ Время: 14.09.2026, 15:31:00 UTC'),
          `${JSON.stringify(platformPolicy)}: got ${card}`,
        );
      }
    } finally {
      if (savedZone === undefined) delete process.env.TZ;
      else process.env.TZ = savedZone;
    }
  });
});
