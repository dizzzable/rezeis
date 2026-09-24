import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { Logger, NotFoundException } from '@nestjs/common';
import { PaymentGatewayType, PaymentWebhookLifecycleStatus, Prisma } from '@prisma/client';
import { of } from 'rxjs';

import { PAYMENT_RECONCILIATION_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { AUTO_RETRY_BATCH, PaymentAutoRetryService } from '../src/modules/payments/services/payment-auto-retry.service';
import { PaymentOpsAlertService } from '../src/modules/payments/services/payment-ops-alert.service';
import { PaymentReconciliationService } from '../src/modules/payments/services/payment-reconciliation.service';
import { ProviderSubscriptionService } from '../src/modules/payments/services/provider-subscription.service';
import {
  autoRetryExhausted,
  autoRetryRuns,
  DISPUTE_RETRY_LADDER,
  isDisputeEventKey,
  ORDINARY_RETRY_LADDER,
} from '../src/modules/payments/utils/payment-webhook-auto-retry.util';

/**
 * How a failed event of the payment inbox is retried, and what its cards say.
 *
 * 1. A Platega dispute FAILED while Platega's API is down was retried twice in
 *    half an hour and then waited for a person to press «Повторить», with the
 *    commission, the cashback and the autopay all standing. It now climbs its
 *    own ladder, ten retries over about three days; every other event keeps
 *    the ladder it had.
 * 2. Every failed run sent a `notifyWebhookFailed` card, so an outage sent one
 *    per retry. Now one per event: at its first failure, saying what follows;
 *    then at most one more — when a later automatic run goes through, or when
 *    the last one fails.
 */

afterEach(() => mock.restoreAll());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-09-24T12:00:00.000Z');

interface InboxRow {
  readonly id: string;
  readonly providerEventId: string;
  status: PaymentWebhookLifecycleStatus;
  reconciliationAttempts: number;
  lastTransitionAt: Date;
}

/** The subset of Prisma's where-input `dueForAutoRetryWhere` builds, evaluated on a row. */
function matches(row: InboxRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Record<string, unknown>[]).every((part) => matches(row, part));
    if (key === 'OR') return (condition as Record<string, unknown>[]).some((part) => matches(row, part));
    if (key === 'NOT') return !matches(row, condition as Record<string, unknown>);
    const value = (row as unknown as Record<string, unknown>)[key];
    if (typeof condition !== 'object' || condition === null || condition instanceof Date) return value === condition;
    const ops = condition as { lte?: Date; gte?: Date; contains?: string };
    if (ops.lte !== undefined && !((value as Date).getTime() <= ops.lte.getTime())) return false;
    if (ops.gte !== undefined && !((value as Date).getTime() >= ops.gte.getTime())) return false;
    if (ops.contains !== undefined && !String(value).includes(ops.contains)) return false;
    return true;
  });
}

function retryWorld(rows: InboxRow[]) {
  const queued: Array<{ readonly name: string; readonly data: Record<string, unknown>; readonly options: Record<string, unknown> }> = [];
  const asked: Array<Record<string, unknown>> = [];
  const prisma = {
    paymentWebhookEvent: {
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy: Array<Record<string, 'asc' | 'desc'>>;
        take: number;
      }) => {
        asked.push(args);
        return rows
          .filter((row) => matches(row, args.where))
          .sort((a, b) => a.lastTransitionAt.getTime() - b.lastTransitionAt.getTime() || a.id.localeCompare(b.id))
          .slice(0, args.take)
          .map((row) => ({ id: row.id, reconciliationAttempts: row.reconciliationAttempts }));
      },
    },
  };
  const queue = {
    add: async (name: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
      queued.push({ name, data, options });
    },
  };
  const service = new PaymentAutoRetryService(prisma as never, queue as never);
  return { service, queued, asked };
}

const DISPUTE_KEY = 'subscription:platega-sub-1:dispute-callback:pl-tx-9';

function failed(id: string, providerEventId: string, runs: number, failedAgoMs: number): InboxRow {
  return {
    id,
    providerEventId,
    status: PaymentWebhookLifecycleStatus.FAILED,
    reconciliationAttempts: runs,
    lastTransitionAt: new Date(NOW.getTime() - failedAgoMs),
  };
}

async function dueIds(rows: InboxRow[]): Promise<string[]> {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    const w = retryWorld(rows);
    await w.service.retryFailedWebhooks();
    return w.queued.map((job) => String(job.data['eventId']));
  } finally {
    mock.timers.reset();
  }
}

describe('the automatic retry of a failed inbox event', () => {
  it('keeps the ladder every ordinary event had: 5 minutes, then 15, then no more', async () => {
    const ordinary = 'provider-event-1';
    assert.deepEqual(await dueIds([failed('a', ordinary, 1, 4 * MINUTE)]), [], 'retried before its 5 minutes');
    assert.deepEqual(await dueIds([failed('a', ordinary, 1, 5 * MINUTE)]), ['a']);
    assert.deepEqual(await dueIds([failed('a', ordinary, 2, 14 * MINUTE)]), [], 'retried before its 15 minutes');
    assert.deepEqual(await dueIds([failed('a', ordinary, 2, 15 * MINUTE)]), ['a']);
    assert.deepEqual(await dueIds([failed('a', ordinary, 3, 1 * HOUR)]), [], 'a third retry: the ladder has two');
    assert.equal(autoRetryRuns(ORDINARY_RETRY_LADDER), 3);
  });

  it('retries a dispute for days: ten retries, the last one about three days after the first failure', async () => {
    let elapsed = 0;
    for (let runs = 1; runs <= DISPUTE_RETRY_LADDER.delaysMs.length; runs += 1) {
      const wait = DISPUTE_RETRY_LADDER.delaysMs[runs - 1] as number;
      assert.deepEqual(await dueIds([failed('d', DISPUTE_KEY, runs, wait - MINUTE)]), [], `run ${runs + 1} came early`);
      assert.deepEqual(await dueIds([failed('d', DISPUTE_KEY, runs, wait)]), ['d'], `run ${runs + 1} never came`);
      elapsed += wait;
    }
    assert.deepEqual(
      await dueIds([failed('d', DISPUTE_KEY, autoRetryRuns(DISPUTE_RETRY_LADDER), 30 * HOUR)]),
      [],
      'retried past its last run',
    );
    assert.equal(autoRetryRuns(DISPUTE_RETRY_LADDER), 11);
    assert.ok(elapsed >= 24 * HOUR, `a dispute is retried for ${elapsed / HOUR} h, less than a day`);
    assert.ok(elapsed <= 4 * 24 * HOUR, `a dispute is retried for ${elapsed / HOUR} h`);
  });

  it('never gives a dispute the ordinary two retries, nor an ordinary event the dispute’s days', async () => {
    // Failed 3 hours ago on its third run: an ordinary event is past its
    // ladder, a dispute on that run is due after 30 minutes.
    assert.deepEqual(await dueIds([failed('a', 'provider-event-2', 3, 3 * HOUR)]), []);
    assert.deepEqual(await dueIds([failed('d', DISPUTE_KEY, 3, 3 * HOUR)]), ['d']);
  });

  it('runs an event whose enqueue failed at once, and leaves an old failure alone', async () => {
    assert.deepEqual(await dueIds([failed('e', 'provider-event-3', 0, 0)]), ['e']);
    assert.deepEqual(await dueIds([failed('old', 'provider-event-4', 1, 3 * HOUR)]), [], 'an ordinary failure older than 2 h');
    assert.deepEqual(await dueIds([failed('old', DISPUTE_KEY, 8, 49 * HOUR)]), [], 'a dispute failure older than 2 days');
  });

  it('queues a due event to run now, one job per run, the oldest failures first, a batch at a time', async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    try {
      const rows = Array.from({ length: AUTO_RETRY_BATCH + 5 }, (_, index) =>
        failed(`e-${String(index).padStart(2, '0')}`, 'provider-event', 1, (30 + index) * MINUTE),
      );
      const w = retryWorld(rows);
      await w.service.retryFailedWebhooks();

      assert.equal(w.queued.length, AUTO_RETRY_BATCH);
      assert.equal(w.queued[0]?.data['eventId'], `e-${String(AUTO_RETRY_BATCH + 4).padStart(2, '0')}`, 'not the oldest first');
      for (const job of w.queued) {
        assert.equal(job.name, PAYMENT_RECONCILIATION_JOB);
        assert.equal(job.options['delay'], undefined, 'a due event waited in the queue again');
        assert.equal(job.options['jobId'], `auto-retry-${String(job.data['eventId'])}-2`);
      }
      assert.deepEqual(w.asked[0]?.['orderBy'], [{ lastTransitionAt: 'asc' }, { id: 'asc' }]);
    } finally {
      mock.timers.reset();
    }
  });

  it('knows a dispute by the key its handling records it under', async () => {
    const envelopes: Array<Record<string, unknown>> = [];
    const service = new ProviderSubscriptionService(
      {} as never,
      {} as never,
      {
        recordReceived: async ({ envelope }: { envelope: Record<string, unknown> }) => {
          envelopes.push(envelope);
          return { event: { id: 'event-1', paymentId: envelope['paymentId'], gatewayType: envelope['gatewayType'] }, duplicate: false };
        },
        markEnqueued: async () => undefined,
      } as never,
      { add: async () => undefined } as never,
    );

    await service.recordDispute(
      PaymentGatewayType.PLATEGA,
      'platega-sub-1',
      { providerPaymentId: 'pl-tx-9', providerStatus: 'CHARGEBACKED' },
      { Id: 'pl-tx-9' },
    );

    assert.equal(envelopes.length, 1);
    assert.ok(isDisputeEventKey(String(envelopes[0]?.['providerEventId'])), String(envelopes[0]?.['providerEventId']));
    assert.equal(isDisputeEventKey('subscription:platega-sub-1:charge:2'), false, 'a charge is not a dispute');
    assert.equal(isDisputeEventKey('subscription:platega-sub-1:dispute:pl-tx-9'), false, 'a matched refund notice is not');
  });

  it('gives up on an event exactly where the retry stops picking it up', () => {
    for (const [key, ladder] of [
      ['provider-event-5', ORDINARY_RETRY_LADDER],
      [DISPUTE_KEY, DISPUTE_RETRY_LADDER],
    ] as const) {
      const runs = autoRetryRuns(ladder);
      assert.equal(autoRetryExhausted({ providerEventId: key }, runs - 1), false, `${key}: given up a run early`);
      assert.equal(autoRetryExhausted({ providerEventId: key }, runs), true, `${key}: never given up`);
    }
  });
});

// ── One card per event ───────────────────────────────────────────────────────

interface Card {
  readonly kind: 'failed' | 'recovered' | 'given-up';
  readonly eventId: string;
  readonly runs?: number;
  readonly retry?: { readonly automatic: boolean; readonly dispute: boolean };
}

function cardsWorld(options: { readonly providerEventId?: string; readonly alertThrows?: boolean } = {}) {
  const event = {
    id: 'event-1',
    gatewayType: PaymentGatewayType.PLATEGA,
    paymentId: 'payment-1',
    providerEventId: options.providerEventId ?? 'provider-event-1',
    eventStatus: 'CONFIRMED',
    status: PaymentWebhookLifecycleStatus.ENQUEUED as PaymentWebhookLifecycleStatus,
    reconciliationAttempts: 0,
    lastError: null as string | null,
    rawPayload: { status: 'CONFIRMED' } as Prisma.JsonValue,
    receivedAt: NOW,
    replayCount: 0,
    lastTransitionAt: NOW,
    updatedAt: NOW,
  };
  /** Whether the payment the event names can be found: not, while the outage lasts. */
  const outage = { on: true };
  const cards: Card[] = [];
  const prisma = {
    paymentWebhookEvent: { findUnique: async () => ({ ...event }) },
    transaction: {
      findUnique: async () =>
        outage.on
          ? null
          : {
              id: 'tx-1',
              paymentId: 'payment-1',
              userId: 'user-1',
              status: 'COMPLETED',
              fulfilledAt: new Date(NOW.getTime() - HOUR),
              gatewayType: PaymentGatewayType.PLATEGA,
              gatewayData: {},
              planSnapshot: {},
              amount: new Prisma.Decimal('299'),
              currency: 'RUB',
              purchaseType: 'NEW',
            },
      findFirst: async () => null,
    },
  };
  const inbox = {
    incrementReconciliationAttempts: async () => {
      event.reconciliationAttempts += 1;
    },
    markProcessing: async () => {
      event.status = PaymentWebhookLifecycleStatus.PROCESSING;
    },
    markProcessed: async () => {
      event.status = PaymentWebhookLifecycleStatus.PROCESSED;
    },
    markFailed: async (_id: string, lastError: string) => {
      event.status = PaymentWebhookLifecycleStatus.FAILED;
      event.lastError = lastError;
      return { ...event };
    },
  };
  const tell = (card: Card): void => {
    if (options.alertThrows === true) throw new Error('Telegram is not answering');
    cards.push(card);
  };
  const alerts = {
    notifyWebhookFailed: async (input: { event: { id: string }; retry?: Card['retry'] }) =>
      tell({ kind: 'failed', eventId: input.event.id, retry: input.retry }),
    notifyWebhookRecovered: async (input: { event: { id: string }; runs: number }) =>
      tell({ kind: 'recovered', eventId: input.event.id, runs: input.runs }),
    notifyWebhookGivenUp: async (input: { event: { id: string }; runs: number }) =>
      tell({ kind: 'given-up', eventId: input.event.id, runs: input.runs }),
  };
  const reconciliation = new PaymentReconciliationService(
    prisma as never,
    inbox as never,
    {} as never,
    alerts as never,
    {} as never,
    {} as never,
    {} as never,
    { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
    {} as never,
    {} as never,
    { disableAutopayForProviderMethod: async () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  /** One run, as the worker makes it; a failed run rejects, as the worker's job does. */
  const run = async (): Promise<'processed' | 'failed'> => {
    try {
      await reconciliation.reconcileWebhookEvent(event.id);
      return 'processed';
    } catch {
      return 'failed';
    }
  };
  /** An operator's «Повторить»: the event is ENQUEUED again before its run. */
  const replay = (): void => {
    event.status = PaymentWebhookLifecycleStatus.ENQUEUED;
    event.replayCount += 1;
  };
  return { event, outage, cards, run, replay, reconciliation };
}

describe('one failure card per inbox event', () => {
  const quiet = (): void => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(Logger.prototype, 'log', () => undefined);
  };

  it('an outage the retries outlast: one card at the first failure, one when a retry goes through', async () => {
    quiet();
    const w = cardsWorld();

    assert.equal(await w.run(), 'failed');
    assert.deepEqual(w.cards, [{ kind: 'failed', eventId: 'event-1', retry: { automatic: true, dispute: false } }]);
    assert.equal(await w.run(), 'failed', 'the first automatic retry');
    assert.equal(w.cards.length, 1, 'a card for every retry that failed again');

    w.outage.on = false;
    assert.equal(await w.run(), 'processed');
    assert.deepEqual(w.cards.slice(1), [{ kind: 'recovered', eventId: 'event-1', runs: 3 }]);
  });

  it('an outage longer than the retries: one card at the first failure, one when the last retry fails', async () => {
    quiet();
    const w = cardsWorld();

    for (let run = 1; run <= autoRetryRuns(ORDINARY_RETRY_LADDER); run += 1) {
      assert.equal(await w.run(), 'failed');
    }

    assert.deepEqual(w.cards, [
      { kind: 'failed', eventId: 'event-1', retry: { automatic: true, dispute: false } },
      { kind: 'given-up', eventId: 'event-1', runs: 3 },
    ]);
  });

  it('a dispute says it is retried for days, and is given up only after its eleventh run', async () => {
    quiet();
    const w = cardsWorld({ providerEventId: DISPUTE_KEY });

    for (let run = 1; run < autoRetryRuns(DISPUTE_RETRY_LADDER); run += 1) {
      await w.run();
    }
    assert.deepEqual(w.cards, [{ kind: 'failed', eventId: 'event-1', retry: { automatic: true, dispute: true } }]);

    await w.run();
    assert.deepEqual(w.cards.slice(1), [{ kind: 'given-up', eventId: 'event-1', runs: 11 }]);
  });

  it('tells the first failure of an event whose enqueue failed: nothing was told of it before', async () => {
    quiet();
    // FAILED without a run: its enqueue failed at the ingress, which tells nobody.
    const failing = cardsWorld();
    failing.event.status = PaymentWebhookLifecycleStatus.FAILED;
    assert.equal(await failing.run(), 'failed');
    assert.deepEqual(failing.cards, [{ kind: 'failed', eventId: 'event-1', retry: { automatic: true, dispute: false } }]);

    const through = cardsWorld();
    through.event.status = PaymentWebhookLifecycleStatus.FAILED;
    through.outage.on = false;
    assert.equal(await through.run(), 'processed');
    assert.deepEqual(through.cards, [], 'a "went through" card for a failure nobody was told of');
  });

  it('tells an operator’s «Повторить» that fails, and that no automatic retry follows once they are spent', async () => {
    quiet();
    const w = cardsWorld();
    for (let run = 1; run <= autoRetryRuns(ORDINARY_RETRY_LADDER); run += 1) await w.run();
    const told = w.cards.length;

    w.replay();
    assert.equal(await w.run(), 'failed');

    assert.deepEqual(w.cards.slice(told), [
      { kind: 'failed', eventId: 'event-1', retry: { automatic: false, dispute: false } },
    ]);
  });

  it('keeps the run’s own error when the card cannot be sent', async () => {
    quiet();
    const w = cardsWorld({ alertThrows: true });

    await assert.rejects(
      w.reconciliation.reconcileWebhookEvent('event-1'),
      (error: unknown) => error instanceof NotFoundException && error.message === 'Payment transaction not found',
    );
    assert.equal(w.event.status, PaymentWebhookLifecycleStatus.FAILED);
  });
});

// ── What the cards say ───────────────────────────────────────────────────────

function alertService(): { service: PaymentOpsAlertService; texts: string[] } {
  const texts: string[] = [];
  const service = new PaymentOpsAlertService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: { paymentOps: { enabled: true, chatId: '998877', threadId: null, hashtag: '#payments_ops' } },
        }),
      },
    } as never,
    {
      post: (_url: string, payload: { text: string }) => {
        texts.push(payload.text);
        return of({ data: { ok: true } });
      },
    } as never,
    { botToken: 'bot-token', adminPublicBaseUrl: null } as never,
  );
  return { service, texts };
}

const EVENT = {
  id: 'event-1',
  paymentId: 'payment-1',
  providerEventId: 'provider-event-1',
  gatewayType: PaymentGatewayType.PLATEGA,
  status: 'FAILED',
  lastError: 'Platega is not answering',
  updatedAt: NOW,
} as never;

describe('the failure cards say what follows', () => {
  it('the first failure: the panel retries by itself, for half an hour or, for a dispute, about three days', async () => {
    const { service, texts } = alertService();

    await service.notifyWebhookFailed({ event: EVENT, retry: { automatic: true, dispute: false } });
    await service.notifyWebhookFailed({ event: EVENT, retry: { automatic: true, dispute: true } });

    assert.match(texts[0] ?? '', /retry:auto/);
    assert.match(texts[0] ?? '', /Панель повторит обработку сама в ближайшие полчаса\./);
    assert.match(texts[0] ?? '', /Следующая карточка придёт, только когда обработка пройдёт или повторы кончатся\./);
    assert.match(texts[1] ?? '', /Панель будет повторять обработку сама около трёх суток\./);
  });

  it('a failure with no retry left names the button', async () => {
    const { service, texts } = alertService();

    await service.notifyWebhookFailed({ event: EVENT, retry: { automatic: false, dispute: false } });

    assert.match(texts[0] ?? '', /retry:manual/);
    assert.match(texts[0] ?? '', /Повторите вручную: «Платежи» → «Вебхуки» → «Повторить»\./);
  });

  it('the closing cards: went through, and given up', async () => {
    const { service, texts } = alertService();

    await service.notifyWebhookRecovered({ event: EVENT, runs: 3 });
    await service.notifyWebhookGivenUp({ event: EVENT, runs: 11 });

    assert.match(texts[0] ?? '', /#event_webhook_recovered/);
    assert.match(texts[0] ?? '', /Обработка прошла с попытки №3 — делать ничего не нужно\./);
    assert.match(texts[1] ?? '', /#event_webhook_given_up/);
    assert.match(texts[1] ?? '', /Автоматические повторы кончились \(попыток: 11\)\. Повторите вручную: «Платежи» → «Вебхуки» → «Повторить»\./);
    assert.match(texts[1] ?? '', /error:/);
  });

  it('names the tab and the button as the panel shows them', () => {
    const ru = readFileSync(resolve(__dirname, '..', 'web/src/i18n/ru.ts'), 'utf8');
    const payments = readFileSync(resolve(__dirname, '..', 'web/src/i18n/features/payments.ru.ts'), 'utf8');
    assert.match(ru, /payments: 'Платежи'/);
    assert.match(ru, /webhooks: 'Вебхуки'/);
    assert.match(payments, /action: 'Повторить'/);
  });
});
