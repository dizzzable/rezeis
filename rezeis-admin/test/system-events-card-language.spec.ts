import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  EVENT_PRESENTATION,
  SystemEventsService,
  type SystemEventCategory,
  type SystemEventPayload,
  type SystemEventSeverity,
} from '../src/common/services/system-events.service';
import { AutomationActionRegistry } from '../src/modules/automations/actions/action-registry';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import type { TelegramDirectResult } from '../src/modules/notifications/telegram-direct.outcome';
import {
  buildRelayUndeliveredRecord,
  buildTelegramDirectUndeliveredRecord,
  describeRelayRepeats,
  describeTelegramDirectRepeats,
} from '../src/modules/notifications/undelivered-record';

/**
 * Russian cards, whoever raised the event
 * ═══════════════════════════════════════
 * A producer's `message` is the English text the audit log keeps, and it is not
 * translated there. So a card may print a message only when the message is not
 * a producer's log line — an operator's own automation text, or a sentence
 * written in Russian for the card (`EventPresentation.showMessage`).
 *
 * The first cut opted in by "the facts live only in the message" instead, and
 * put `Broadcast staging: 400 recipients`, `Batch: 46 sent, 4 failed`, ten
 * English paragraphs from the Remnawave sync jobs and `Automation rule "X"
 * fired` under Russian titles. Those facts are now read out of the metadata.
 *
 * Two guards:
 *
 *  - every type that opts in is rendered here, through its REAL producer where
 *    the producer is a pure function or a registry this spec can build — the
 *    automation defaults and the undelivered records — so a new opt-in, or an
 *    English default added upstream, fails this spec rather than a card;
 *  - every type that used to opt in is rendered from its producers' exact
 *    message and metadata, and must say its facts in Russian without the
 *    English sentence.
 *
 * "No English" means no English word outside `<code>` — where the card puts raw
 * data it does not translate (ids, statuses, a provider's own error text) — and
 * outside the hashtag and the markup. Product names are allowed, as are the
 * category and severity codes every card's context block has always printed.
 */

const ALLOWED_LATIN_WORDS: ReadonlySet<string> = new Set([
  // Product and service names.
  'Telegram',
  'Remnawave',
  'reiwa',
  'Reiwa',
  'rezeis',
  'Rezeis',
  'Kassa', // «ЮKassa»
  'Bedolaga',
  'Remnashop',
  'Altshop',
  'StealthNet',
  'x-ui', // «3x-ui»
  // Technical abbreviations the cards use as Russian does.
  'VPN',
  'ID',
  'UUID',
  'HTTP',
  'Chat', // «Chat ID», the name of the setting
  'UTC',
  'GMT',
  // The context block's category and severity codes.
  'INFO',
  'WARNING',
  'ERROR',
  'USER',
  'AUTH',
  'SUBSCRIPTION',
  'DEVICE',
  'PAYMENT',
  'REFERRAL',
  'PARTNER',
  'PROMOCODE',
  'SUPPORT',
  'FRAUD',
  'NODE',
  'REMNAWAVE',
  'SYSTEM',
  // Whatever a rule's `system_event` emits is filed under this one.
  'AUTOMATION',
]);

/** The Latin words a card says in its own voice. */
function englishWordsOn(card: string): string[] {
  const prose = card
    .split('\n')
    .filter((line) => !line.startsWith('#Event'))
    .join('\n')
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ');
  return (prose.match(/[A-Za-z][A-Za-z-]*/g) ?? []).filter((word) => !ALLOWED_LATIN_WORDS.has(word));
}

interface Rendered {
  readonly service: SystemEventsService;
  readonly cards: string[];
}

function renderingService(): Rendered {
  const cards: string[] = [];
  const service = new SystemEventsService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: { telegram: { enabled: false, chatId: null, devChatId: null } },
          platformPolicy: {},
        }),
      },
      adminAuditLog: { create: async () => ({}) },
    } as never,
    { enabled: false, urls: [] } as never,
    {
      post: () => {
        throw new Error('Bot API must not be called without a token');
      },
    } as never,
    {
      get: (token: unknown) => {
        const capture = (event: string, meta: Record<string, unknown>): void => {
          if (event === 'reiwa.dev.notify') cards.push(String(meta['text']));
        };
        if (token === ReiwaRelayQueueService) {
          return {
            enqueue: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return true;
            },
          };
        }
        // The relay's own undelivered alert skips the queue it reports on
        // (`isRelayLoopGuardedEvent`) and goes to the notifier directly.
        if (token === BotNotifierClient) {
          return {
            deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
              capture(event, meta);
              return { status: 'confirmed', messageId: 1, httpStatus: 200, detail: null };
            },
          };
        }
        throw new Error('not registered');
      },
    } as never,
  );
  return { service, cards };
}

async function renderCard(event: SystemEventPayload): Promise<string> {
  const { service, cards } = renderingService();
  service.emit(event);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cards.length, 1, `${event.type}: expected one card, got ${cards.length}`);
  return cards[0]!;
}

interface Fixture {
  /** Where the producer lives, so a reader can check the copy against it. */
  readonly producer: string;
  readonly type: string;
  readonly category?: SystemEventCategory;
  readonly severity: SystemEventSeverity;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
  /** A fact the card must now state, in Russian. */
  readonly says: readonly string[];
}

/**
 * The producers of every type that used to print its English sentence,
 * copied from the emit sites named in `producer`.
 */
const FORMERLY_PRINTED: readonly Fixture[] = [
  {
    producer: 'BroadcastDeliveryService.stageRecipients',
    type: 'broadcast.started',
    severity: 'INFO',
    message: 'Broadcast staging: 400 recipients',
    metadata: { broadcastId: 'bc-1', recipientCount: 400, channelPost: 'queued' },
    says: ['👥 Получателей: 400', '📡 Пост в канал: поставлен в очередь'],
  },
  {
    producer: 'BroadcastProcessor.handleStart',
    type: 'broadcast.started',
    severity: 'INFO',
    message: 'Broadcast delivery started: 400 recipients in 8 batches',
    metadata: { broadcastId: 'bc-1', totalMessages: 400, batches: 8 },
    says: ['👥 Получателей: 400', '📦 Партий: 8'],
  },
  {
    producer: 'BroadcastDeliveryService.deleteBatch (partial recall)',
    type: 'broadcast.started',
    severity: 'WARNING',
    message: 'Recall removed 3 of 5 messages in this batch; 2 could not be deleted',
    metadata: { broadcastId: 'bc-2', deleted: 3, failed: 2 },
    says: ['🗑 Удалено у получателей: 3', '⚠️ Не удалось удалить: 2'],
  },
  {
    producer: 'BroadcastReconcilerService.revive',
    type: 'broadcast.started',
    severity: 'WARNING',
    message: 'Broadcast bc-3 was picked up again: 12 recipients still undispatched',
    metadata: { broadcastId: 'bc-3', attempts: 1, detail: '12 recipients still undispatched' },
    says: ['🔁 Попытка возобновления: 1'],
  },
  {
    producer: 'BroadcastProcessor.handleBatch',
    type: 'broadcast.batch_completed',
    severity: 'INFO',
    message: 'Batch: 46 sent, 4 failed',
    metadata: { broadcastId: 'bc-4', sent: 46, failed: 4, unresolved: 0, batchSize: 50 },
    says: ['📬 Отправлено: 46', '📭 Не доставлено: 4'],
  },
  {
    producer: 'BroadcastDeliveryService.stageRecipients (channel copy dropped)',
    type: 'broadcast.channel_post_undelivered',
    severity: 'WARNING',
    message: 'Broadcast channel post not delivered (dropped)',
    metadata: { broadcastId: 'bc-5', channelPost: 'dropped' },
    says: ['📡 Пост в канал: не доставлен'],
  },
  {
    producer: 'BroadcastDeliveryService.stageRecipients (relay not configured)',
    type: 'broadcast.channel_post_undelivered',
    severity: 'WARNING',
    message: 'Broadcast channel post not delivered (disabled)',
    metadata: { broadcastId: 'bc-6', channelPost: 'disabled' },
    says: ['📡 Пост в канал: не отправлен: связь панели с reiwa не настроена'],
  },
  {
    producer: 'BackupProcessor.handleRestore (migrations not applied)',
    type: 'system.restore_completed',
    severity: 'WARNING',
    message:
      'Database restored from b-1.sql.gz, but the pending migrations were not applied — ' +
      'restart the panel (API container) so its entrypoint applies them',
    metadata: {
      filename: 'b-1.sql.gz',
      initiatedBy: 'admin-1',
      success: true,
      migrationsApplied: false,
      customEmojiAssets: null,
      allowForeignArchive: false,
    },
    says: ['🧱 Миграции: не применены'],
  },
  {
    producer: 'BackupProcessor.handleRestore',
    type: 'system.restore_completed',
    severity: 'INFO',
    message: 'Database restored from b-2.sql.gz',
    metadata: { filename: 'b-2.sql.gz', initiatedBy: 'admin-1', success: true, migrationsApplied: true },
    says: ['🧱 Миграции: применены'],
  },
  {
    producer: 'ImportProcessor.handleRun',
    type: 'import.completed',
    severity: 'INFO',
    message: 'Import completed: bedolaga (import)',
    metadata: {
      importRecordId: 'imp-1',
      sourceType: 'bedolaga',
      mode: 'import',
      result: {
        importRecordId: 'imp-1',
        fetched: 13,
        created: 10,
        updated: 3,
        skipped: 0,
        subscriptionsCreated: 9,
        subscriptionsUpdated: 1,
        errors: ['row 4: no telegram id'],
      },
    },
    says: [
      '📦 Источник: Bedolaga',
      '📥 Прочитано записей: 13',
      '🆕 Создано пользователей: 10',
      '📦 Создано подписок: 9',
      '⚠️ Ошибок: 1',
    ],
  },
  {
    producer: 'ImportProcessor.handleAssignPlan',
    type: 'import.plan_assigned',
    severity: 'INFO',
    message: 'Bulk plan assignment: 7 updated',
    metadata: {
      importRecordId: 'imp-2',
      planId: 'plan-1',
      updated: 7,
      skippedDeleted: 1,
      skippedAlreadyAssigned: 2,
      skippedNoSubscription: 0,
      errors: 0,
      syncJobsCreated: 7,
    },
    says: ['✅ Тариф назначен подпискам: 7', '⏭ Уже на этом тарифе: 2'],
  },
  {
    producer: 'ImportProcessor.enqueuePostImportSync',
    type: 'import.sync_enqueued',
    severity: 'INFO',
    message: 'Post-import Remnawave sync enqueued: 5 subscription(s)',
    metadata: { importRecordId: 'imp-3', sourceType: '3xui', mode: 'sync', enqueued: 5, skipped: 4, total: 9 },
    says: ['🔄 Поставлено в очередь: 5 из 9', '⏭ Пропущено — синхронизация уже идёт: 4'],
  },
  {
    producer: 'ExpiredProfileCleanupService.softDeleteDetachedExpired',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message:
      'Expired-profile cleanup: left 3 expired subscription(s) alone — their panel link was lost, so ' +
      'their panel profile is probably still live and unbilled. Soft-deleting them would strand the ' +
      'profile and put the row out of reach of the panel-link repair. Run the panel-link ' +
      'reconciliation; they retire normally once relinked.',
    metadata: { subscriptions: 3 },
    says: ['📦 Подписок: 3'],
  },
  {
    producer: 'ExpiredProfileCleanupService.scheduleExpiredCleanup (stale identity)',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message:
      'Expired-profile cleanup: refused 2 of 9 candidate(s) — their stored Remnawave identity is a 2.x ' +
      'uuid and the panel is 3.x, so deleting would remove whatever the address fallback resolves to ' +
      'instead of the profile the row was written for. Run the panel-link reconciliation; they retire ' +
      'normally once the identity is repaired.',
    metadata: { subscriptions: 2 },
    says: ['📦 Подписок: 2'],
  },
  {
    producer: 'DuplicateSubscriptionMergeService.merge',
    type: 'system.remnawave_sync',
    severity: 'INFO',
    message: 'Duplicate subscription merge: merged 2 of 3 pairs',
    metadata: {
      dryRun: false,
      pairsExamined: 3,
      merged: 2,
      wouldMerge: 0,
      refused: 1,
      hasMore: false,
      stoppedEarly: false,
    },
    says: ['🔎 Пар проверено: 3', '🔗 Объединено: 2', '⛔ Отказано: 1'],
  },
  {
    producer: 'RemnawaveApiService.emitPanelUserShapeDrift',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message: 'Remnawave user row shape drift on a 3.x panel — 1 unrecognised field(s): vlessUuid2',
    metadata: {
      unknownFields: ['vlessUuid2'],
      missingFields: [],
      panelEra: '3.x',
      panelVersion: '3.3.1',
      signature: 'era=3.x|+vlessUuid2',
      suppressedSinceLastReport: 4,
    },
    says: ['🧬 Незнакомые поля: <code>vlessUuid2</code>', '🔁 Таких же с прошлого оповещения: 4'],
  },
  {
    producer: 'SubscriptionDeletionService.publishStalePanelLinkRefusal',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message: 'Subscription deletion refused: the stored panel link is stale',
    metadata: {
      subscriptionId: 'sub-1',
      userId: 'user-1',
      remnawaveId: '0194f4b6-7cc7-7ecb-9f62-123456789abc',
      source: 'SELF_SERVICE_DELETE',
      code: 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK',
    },
    says: ['🚫 Удаление профиля на панели отклонено: сохранённая привязка устарела'],
  },
  {
    producer: 'SubscriptionDeletionService.publishOrphanRiskEvent',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message: 'Subscription deleted with an orphaned Remnawave profile',
    metadata: { subscriptionId: 'sub-2', userId: 'user-2', panelUsername: 'anna_vpn', source: 'ADMIN_PANEL' },
    says: ['🃏 Профиль на панели: <code>anna_vpn</code>'],
  },
  {
    producer: 'AdminUserSubscriptionsController (sync enqueue failed)',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message: 'Admin subscription update queued for deferred Remnawave sync',
    metadata: { subscriptionId: 'sub-3', syncJobId: 'job-3', error: 'Connection is closed.' },
    says: ['🔄 Задача синхронизации: <code>job-3</code>'],
  },
  {
    producer: 'AdminUserSubscriptionsController (no panel link)',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message: 'Admin subscription update saved locally only — no Remnawave link to push it through',
    metadata: { subscriptionId: 'sub-4', userId: 'user-4', remnawavePanelUsername: 'boris_vpn' },
    says: ['🃏 Профиль на панели: <code>boris_vpn</code>'],
  },
  {
    producer: 'PaymentReconciliationService (refund revocation without a panel id)',
    type: 'system.remnawave_sync',
    severity: 'WARNING',
    message:
      "Refunded transaction tx-1: subscription sub-5 was expired locally but carries no Remnawave id, so " +
      "the panel was never told. The profile (panel username 'anna') is still live for a refunded " +
      'purchase — cut it off by hand.',
    metadata: { transactionId: 'tx-1', subscriptionId: 'sub-5', panelUsername: 'anna' },
    says: ['🧾 Транзакция: <code>tx-1</code>', '🃏 Профиль на панели: <code>anna</code>'],
  },
  {
    producer: 'PanelLinkReconciliationService.reconcile',
    type: 'system.remnawave_sync',
    severity: 'INFO',
    message: 'Panel link reconciliation: linked 5 of 9 rows',
    metadata: {
      dryRun: false,
      scanned: 9,
      linked: 5,
      wouldLink: 0,
      unrepaired: 4,
      hasMore: true,
      panelEra: '3.x',
      staleIdentityScanned: 2,
      duplicatePairs: 1,
      sharedIdentityPairs: 0,
    },
    says: ['🔎 Проверено строк: 9', '🔗 Привязано: 5', '🛠 Не удалось исправить: 4'],
  },
];

describe('a card that used to print a producer’s English sentence', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  for (const fixture of FORMERLY_PRINTED) {
    it(`says it in Russian: ${fixture.type} from ${fixture.producer}`, async () => {
      const card = await renderCard({
        type: fixture.type,
        category: fixture.category ?? 'SYSTEM',
        severity: fixture.severity,
        message: fixture.message,
        metadata: fixture.metadata,
      });
      assert.ok(!card.includes(fixture.message), `the English sentence is on the card:\n${card}`);
      for (const fact of fixture.says) {
        assert.ok(card.includes(fact), `missing «${fact}»:\n${card}`);
      }
      assert.deepStrictEqual(englishWordsOn(card), [], `English words on the card:\n${card}`);
    });
  }
});

const AUTOMATION_CONTEXT = {
  ruleId: 'rule-1',
  ruleName: 'Сообщать о нодах',
  trigger: 'node.connection_lost',
  triggerData: { metadata: {} },
};

/** The events the real `AutomationActionRegistry` raises for one action. */
async function automationEvents(action: {
  readonly type: string;
  readonly params: Record<string, unknown>;
}): Promise<SystemEventPayload[]> {
  const raised: SystemEventPayload[] = [];
  const events = {
    describeTelegramDelivery: async () => ({ deliverable: true, reason: null }),
    warn: (type: string, category: SystemEventCategory, message: string, metadata: Record<string, unknown>) =>
      raised.push({ type, category, severity: 'WARNING', message, metadata }),
    emit: (event: SystemEventPayload) => raised.push(event),
  };
  const registry = new AutomationActionRegistry(
    {} as never,
    {} as never,
    events as never,
    {} as never,
    {} as never,
    {} as never,
    { starsWebhookSecret: null } as never,
  );
  const result = await registry.execute(0, action as never, AUTOMATION_CONTEXT as never);
  assert.equal(result.status, 'success', `the action did not run: ${JSON.stringify(result)}`);
  return raised;
}

/** The text the rule editor's «new rule» draft saves unless someone replaces it. */
function ruleEditorDraftText(): string {
  const page = readFileSync(
    join(__dirname, '..', 'web', 'src', 'features', 'automations', 'automations-page.tsx'),
    'utf8',
  );
  const draft = /type: 'notify_telegram', params: \{ text: '([^']*)' \}/.exec(page);
  assert.ok(draft !== null, 'the rule editor draft was not found — this spec reads the wrong thing');
  return draft[1]!;
}

const TELEGRAM_OUTCOMES: readonly TelegramDirectResult[] = [
  { status: 'unauthorized', httpStatus: 401, detail: 'Unauthorized', retryAfterSeconds: null, migrateToChatId: null },
  { status: 'flood_wait', httpStatus: 429, detail: 'Too Many Requests: retry after 42', retryAfterSeconds: 42, migrateToChatId: null },
  { status: 'rejected', httpStatus: 400, detail: 'Bad Request: chat not found', retryAfterSeconds: null, migrateToChatId: null },
  {
    status: 'rejected',
    httpStatus: 400,
    detail: 'Bad Request: group chat was upgraded to a supergroup chat',
    retryAfterSeconds: null,
    migrateToChatId: '-1009876543210',
  },
  { status: 'upstream_error', httpStatus: 502, detail: 'Bad Gateway', retryAfterSeconds: null, migrateToChatId: null },
  { status: 'failed', httpStatus: null, detail: 'TimeoutError', retryAfterSeconds: null, migrateToChatId: null },
  { status: 'disabled', httpStatus: null, detail: null, retryAfterSeconds: null, migrateToChatId: null },
];

describe('a card that prints its message', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('is one of the types rendered below — a new opt-in has to be added here', () => {
    const optedIn = Object.entries(EVENT_PRESENTATION)
      .filter(([, presentation]) => presentation.showMessage !== undefined)
      .map(([type]) => type)
      .sort();
    assert.deepStrictEqual(optedIn, [
      'automation.custom',
      'automation.telegram_notify',
      'telegram.direct_undelivered',
    ]);
  });

  it('prints an operator’s automation text, and never the rule’s English default', async () => {
    // The operator's text is printed as written — in whatever language they
    // wrote it; this one is Russian so the check below sees only the card.
    const written = await automationEvents({
      type: 'notify_telegram',
      params: { text: 'Узел во Франкфурте снова в строю' },
    });
    const writtenCard = await renderCard(written[0]!);
    assert.ok(writtenCard.includes('<blockquote>Узел во Франкфурте снова в строю</blockquote>'), writtenCard);

    const defaults = [
      ...(await automationEvents({ type: 'notify_telegram', params: {} })),
      ...(await automationEvents({ type: 'system_event', params: {} })),
      ...(await automationEvents({ type: 'notify_telegram', params: { text: ruleEditorDraftText() } })),
    ];
    assert.equal(defaults.length, 3);
    for (const event of [written[0]!, ...defaults]) {
      const card = event === written[0] ? writtenCard : await renderCard(event);
      assert.ok(card.includes('🤖 Правило: Сообщать о нодах'), card);
      assert.ok(card.includes('⚡ Сработало на: <code>node.connection_lost</code>'), card);
      assert.deepStrictEqual(englishWordsOn(card), [], `${event.message}:\n${card}`);
    }
  });

  it('prints a panel card Telegram refused in Russian, for every outcome, with its repeat count', async () => {
    for (const outcome of TELEGRAM_OUTCOMES) {
      const record = buildTelegramDirectUndeliveredRecord({
        data: {
          kind: 'message',
          chatId: '-1001234567890',
          topicId: 42,
          text: '<b>card</b>',
          parseMode: 'HTML',
          sourceEventType: 'payment.completed',
        },
        outcome,
        attemptsMade: 4,
        attempts: 4,
      });
      // As `createUndeliveredRecorder` hands on an alert that stands for repeats.
      const card = await renderCard({
        type: 'telegram.direct_undelivered',
        category: 'SYSTEM',
        severity: 'WARNING',
        message: `${record.message}${describeTelegramDirectRepeats(3)}`,
        metadata: { ...record.metadata, repeatsSincePreviousAlert: 3 },
      });
      assert.deepStrictEqual(englishWordsOn(card), [], `${outcome.status}:\n${card}`);
      assert.ok(card.includes('🔁 Таких же с прошлого оповещения: 3'), card);
      assert.equal(card.split('таких же с прошлого оповещения').length - 1, 0, `repeated in the sentence:\n${card}`);
    }
  });

  it('keeps a relay card Russian too, which prints no message', async () => {
    const record = buildRelayUndeliveredRecord({
      event: 'reiwa.channel.broadcast',
      metadata: { eventId: 'broadcast-channel:bc-9', chatId: '-100555' },
      outcome: {
        status: 'rejected',
        messageId: null,
        httpStatus: 422,
        detail: 'HTTP 422 Unprocessable Entity: Bad Request: chat not found',
      },
      attemptsMade: 1,
      attempts: 4,
    });
    const card = await renderCard({
      type: 'reiwa.relay_undelivered',
      category: 'SYSTEM',
      severity: 'WARNING',
      message: `${record.message}${describeRelayRepeats(37)}`,
      metadata: { ...record.metadata, repeatsSincePreviousAlert: 37 },
    });
    assert.deepStrictEqual(englishWordsOn(card), [], card);
    assert.ok(!card.includes('Reiwa relay did not deliver'), card);
  });
});
