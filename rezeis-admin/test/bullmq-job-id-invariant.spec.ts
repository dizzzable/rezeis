import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

import { Job } from 'bullmq';

import { toBullMqJobId } from '../src/common/queue/bullmq-job-id';
import { BROADCAST_DELIVERY_QUEUE } from '../src/modules/broadcast/broadcast.constants';
import { BroadcastQueueService } from '../src/modules/broadcast/services/broadcast-queue.service';
import { EMAIL_QUEUE } from '../src/modules/email/email.constants';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import {
  REIWA_RELAY_EVENTS,
  REIWA_RELAY_QUEUE,
  type ReiwaRelayJobData,
} from '../src/modules/notifications/reiwa-relay.constants';
import type { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import type { TelegramDirectClient } from '../src/modules/notifications/services/telegram-direct.client';
import { TelegramDirectQueueService } from '../src/modules/notifications/services/telegram-direct-queue.service';
import {
  TELEGRAM_DIRECT_QUEUE,
  type TelegramDirectJobData,
} from '../src/modules/notifications/telegram-direct.constants';
import { MOY_NALOG_QUEUE } from '../src/modules/payments/constants/moy-nalog.constant';
import { PAYMENT_RECONCILIATION_QUEUE } from '../src/modules/payments/constants/payment-reconciliation.constant';
import { MoyNalogQueueService } from '../src/modules/payments/services/moy-nalog-queue.service';
import { PaymentAutoRetryService } from '../src/modules/payments/services/payment-auto-retry.service';
import { PaymentWebhookOpsService } from '../src/modules/payments/services/payment-webhook-ops.service';
import { PROFILE_SYNC_QUEUE } from '../src/modules/profile-sync/profile-sync.constants';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import { WebhookQueueService } from '../src/modules/webhooks/services/webhook-queue.service';
import { WEBHOOK_DELIVERY_QUEUE } from '../src/modules/webhooks/webhooks.constants';
import { admitThroughBullMq, OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * Every job id a producer mints is one BullMQ will take
 * ═════════════════════════════════════════════════════
 * BullMQ refuses a custom job id containing `:` unless it splits into exactly
 * three parts, and one that reads as an integer. For as long as nothing checked
 * that, the relay and Telegram producers minted ids of two and five parts and
 * the broadcast start job one of two: subscriber notifications and operator
 * cards all left on the one-attempt fallback, and "send broadcast" answered
 * 500. Every spec was green, because every fake queue accepted everything.
 *
 * Three parts, and they fail for different reasons on purpose:
 *
 *  1. THE HARNESS IS BULLMQ. `admitThroughBullMq` runs the library's own
 *     `Queue#addJob` and `Job#validateOptions`. If an upgrade moved the check
 *     out of its reach, the harness would go lenient in silence — so it is
 *     first shown refusing what BullMQ refuses, and seen calling the method.
 *  2. EVERY PRODUCER, DRIVEN. Each one is run through its real code with the
 *     most hostile logical keys the tree produces, on a queue that answers
 *     like BullMQ. Dedup is asserted too: an id BullMQ accepts but that merges
 *     two events, or splits one, is the same defect in another shape.
 *  3. THE TREE, SCANNED. A producer added next month is on nobody's list. The
 *     scan finds every file that mints a job id and requires it to be one of
 *     the producers driven here.
 */

const CUID = 'cmf0notificationrow000001';

/** Logical keys the tree actually mints, and the shapes BullMQ is fussiest about. */
const HOSTILE_KEYS: readonly string[] = [
  CUID,
  `${CUID}:operator-mirror`,
  `broadcast-channel:${CUID}`,
  'sysevt:payment.completed:2026-09-14T10:00:00.000Z:direct-0123456789abcdef',
  `sysevt:${'reiwa.ingest.x'.repeat(10)}:2026-09-14T10:00:00.000Z:relay-document-0123456789abcdef`,
  'payops:0123456789abcdef0123456789abcdef',
  'payops-test:4a9a3c1e-7a0b-4a51-9d0e-3f0b5a3b1c2d',
  '12345',
  '0',
  '0:zero',
];

describe('the harness refuses exactly what BullMQ refuses', () => {
  it('refuses the id shapes the producers used to mint, with BullMQ’s own words', async () => {
    const refusals: Array<[string, RegExp]> = [
      [`reiwa.user.notify:${CUID}`, /Custom Id cannot contain :/],
      [`telegram.direct:sysevt:a.b:2026-09-14T10:00:00.000Z:direct-0`, /Custom Id cannot contain :/],
      [`broadcast-start:${CUID}`, /Custom Id cannot contain :/],
      ['12345', /Custom Id cannot be integers/],
      ['0:zero', /JobId cannot be '0' or start with 0:/],
    ];
    for (const [jobId, message] of refusals) {
      await assert.rejects(() => admitThroughBullMq('q', 'job', {}, { jobId }), message, jobId);
    }
  });

  it('accepts what BullMQ accepts', async () => {
    for (const jobId of [`email:notify:${CUID}`, `deliver__${CUID}`, toBullMqJobId('scope', 'a:b')]) {
      const job = await admitThroughBullMq('q', 'job', {}, { jobId });
      assert.equal(job.id, jobId);
    }
  });

  it('reaches Job#validateOptions itself, not a copy of it', async () => {
    const prototype = Job.prototype as unknown as { validateOptions: (...args: unknown[]) => void };
    const original = prototype.validateOptions;
    let calls = 0;
    prototype.validateOptions = function counted(this: unknown, ...args: unknown[]): void {
      calls += 1;
      original.apply(this, args);
    };
    try {
      await admitThroughBullMq('q', 'job', {}, { jobId: 'plain' });
    } finally {
      prototype.validateOptions = original;
    }
    assert.equal(calls, 1, 'the harness no longer runs BullMQ’s validation — every fake is lenient again');
  });
});

describe('toBullMqJobId', () => {
  it('turns every hostile key into an id BullMQ takes', async () => {
    for (const key of [...HOSTILE_KEYS, '', '🙂:ключ:∞', 'x'.repeat(10_000)]) {
      const jobId = toBullMqJobId('reiwa.user.notify', key);
      assert.equal(jobId.includes(':'), false, key);
      await admitThroughBullMq('q', 'job', {}, { jobId });
    }
  });

  it('is the same id for the same key, and a different id for any other key or scope', () => {
    const keys = [...HOSTILE_KEYS, 'a:b', 'a_b', 'a%3Ab', 'a__b', ''];
    const ids = new Set<string>();
    for (const scope of ['reiwa.dev.notify', 'reiwa.dev.notify.document']) {
      for (const key of keys) {
        assert.equal(toBullMqJobId(scope, key), toBullMqJobId(scope, key));
        ids.add(toBullMqJobId(scope, key));
      }
    }
    assert.equal(ids.size, keys.length * 2, 'two keys or two scopes collapsed onto one job');
  });

  it('refuses a scope that would put the colon back', () => {
    assert.throws(() => toBullMqJobId('broadcast-start:', CUID), /scope/);
    assert.throws(() => toBullMqJobId('', CUID), /scope/);
  });
});

/** Accepted-ids check shared by every producer below. */
function assertAdmittedAndDistinct(queue: OfflineBullMqQueue<unknown>, expectedJobs: number, label: string): void {
  assert.deepStrictEqual(queue.refused, [], `${label}: BullMQ refused ${JSON.stringify(queue.refused)}`);
  assert.equal(queue.heldIds().length, expectedJobs, `${label}: distinct keys must be distinct jobs`);
}

describe('every producer mints ids BullMQ accepts and dedups on', () => {
  it('ReiwaRelayQueueService, for every event and every key', async () => {
    const queue = new OfflineBullMqQueue<ReiwaRelayJobData>(REIWA_RELAY_QUEUE);
    const service = new ReiwaRelayQueueService(
      queue.asQueue(),
      {
        isEnabled: true,
        deliverRelayEvent: async () => {
          throw new Error('a refused job must not be the reason this passes');
        },
      } as unknown as BotNotifierClient,
      () => undefined,
      { broadcast: { updateMany: async () => ({ count: 0 }) } } as never,
    );

    for (const event of REIWA_RELAY_EVENTS) {
      for (const eventId of HOSTILE_KEYS) {
        assert.equal(await service.enqueue(event, { eventId }), true, `${event} / ${eventId}`);
        await service.enqueue(event, { eventId });
      }
    }

    assertAdmittedAndDistinct(queue as OfflineBullMqQueue<unknown>, REIWA_RELAY_EVENTS.length * HOSTILE_KEYS.length, 'relay');
    assert.equal(queue.admitted.filter((call) => call.collapsed).length, REIWA_RELAY_EVENTS.length * HOSTILE_KEYS.length);
  });

  it('TelegramDirectQueueService, for every key', async () => {
    const queue = new OfflineBullMqQueue<TelegramDirectJobData>(TELEGRAM_DIRECT_QUEUE);
    const service = new TelegramDirectQueueService(
      queue.asQueue(),
      {
        send: async () => {
          throw new Error('a refused job must not be the reason this passes');
        },
      } as unknown as TelegramDirectClient,
      () => undefined,
    );
    const card: TelegramDirectJobData = {
      kind: 'message',
      chatId: '-100',
      topicId: null,
      text: 'card',
      parseMode: 'HTML',
      sourceEventType: 'payment.completed',
    };

    for (const eventId of HOSTILE_KEYS) {
      assert.equal(await service.enqueue(card, eventId), true, eventId);
      await service.enqueue(card, eventId);
    }

    assertAdmittedAndDistinct(queue as OfflineBullMqQueue<unknown>, HOSTILE_KEYS.length, 'telegram-direct');
  });

  it('BroadcastQueueService.enqueueStart', async () => {
    const queue = new OfflineBullMqQueue<unknown>(BROADCAST_DELIVERY_QUEUE);
    const service = new BroadcastQueueService(queue.asQueue(), {} as never);

    for (const broadcastId of [CUID, '12345', 'a:b']) {
      await service.enqueueStart({ broadcastId, adminId: null });
      assert.equal(await service.hasPendingStart(broadcastId), true, broadcastId);
    }

    assertAdmittedAndDistinct(queue, 3, 'broadcast start');
  });

  it('EmailDeliveryService.send, with the dedupe keys the tree passes', async () => {
    // Not migrated to `toBullMqJobId` (a different owner's file): `email:${key}`
    // is three parts for both keys in use, which BullMQ accepts today. This is
    // what fails first if a key grows a second colon, or BullMQ drops the
    // three-part exemption its source says it will.
    const queue = new OfflineBullMqQueue<unknown>(EMAIL_QUEUE);
    const service = new EmailDeliveryService(
      {} as never,
      {
        settings: {
          findFirst: async () => ({ systemNotifications: { email: { enabled: true } }, brandingSettings: null }),
        },
      } as never,
      {} as never,
      undefined,
      queue.asQueue(),
    );
    const letter = { to: 'ann@example.com', subject: 's', templateType: 't', variables: {} };

    for (const dedupeKey of [`notify:${CUID}`, `broadcast:${CUID}`]) {
      await service.send({ ...letter, dedupeKey });
      await service.send({ ...letter, dedupeKey });
    }

    assertAdmittedAndDistinct(queue, 2, 'email');
  });

  it('ProfileSyncQueueService.enqueue', async () => {
    const queue = new OfflineBullMqQueue<unknown>(PROFILE_SYNC_QUEUE);
    const service = new ProfileSyncQueueService({} as never, queue.asQueue());

    await service.enqueue(CUID);
    await service.enqueue(CUID);
    await service.enqueue('12345', true);

    assertAdmittedAndDistinct(queue, 2, 'profile sync');
  });

  it('WebhookQueueService', async () => {
    const queue = new OfflineBullMqQueue<unknown>(WEBHOOK_DELIVERY_QUEUE);
    const service = new WebhookQueueService(queue.asQueue());

    await service.enqueueImmediate(CUID);
    await service.enqueueImmediate(CUID);
    await service.enqueueDelayed(CUID, 30);

    assertAdmittedAndDistinct(queue, 2, 'webhooks');
  });

  it('MoyNalogQueueService', async () => {
    const queue = new OfflineBullMqQueue<unknown>(MOY_NALOG_QUEUE);
    const service = new MoyNalogQueueService(queue.asQueue());

    await service.enqueueRegisterIncome(CUID);
    await service.enqueueRegisterIncome(CUID);
    await service.enqueueCancelIncome(CUID);

    assertAdmittedAndDistinct(queue, 2, 'moy nalog');
  });

  it('PaymentAutoRetryService', async () => {
    const queue = new OfflineBullMqQueue<unknown>(PAYMENT_RECONCILIATION_QUEUE);
    const service = new PaymentAutoRetryService(
      {
        paymentWebhookEvent: {
          findMany: async () => [
            { id: CUID, reconciliationAttempts: 0 },
            { id: CUID, reconciliationAttempts: 1 },
          ],
        },
      } as never,
      queue.asQueue(),
    );

    await service.retryFailedWebhooks();

    assertAdmittedAndDistinct(queue, 2, 'payment auto-retry');
  });

  it('PaymentWebhookOpsService.replayEvent', async () => {
    const queue = new OfflineBullMqQueue<unknown>(PAYMENT_RECONCILIATION_QUEUE);
    const event = {
      id: CUID,
      gatewayType: 'YOOKASSA',
      paymentId: 'payment-1',
      providerEventId: 'provider-event-1',
      eventStatus: 'payment.succeeded',
      status: 'FAILED',
      attempts: 1,
      rawPayload: {},
      payloadHash: 'hash',
      processedAt: null,
      receivedAt: new Date('2026-09-14T00:00:00.000Z'),
      lastTransitionAt: new Date('2026-09-14T00:00:00.000Z'),
      lastReplayedAt: null,
      reconciliationAttempts: 1,
      replayCount: 0,
      lastError: null,
    };
    const service = new PaymentWebhookOpsService(
      {
        paymentWebhookEvent: { findUnique: async () => event },
        adminAuditLog: { create: async () => ({}) },
      } as never,
      { markReplayRequested: async () => event, markFailed: async () => event } as never,
      { redact: (payload: unknown) => payload } as never,
      { notifyWebhookReplay: async () => undefined } as never,
      queue.asQueue(),
    );

    await service.replayEvent({
      eventId: CUID,
      reason: 'invariant',
      force: false,
      currentAdmin: { id: 'admin-1' } as never,
      requestMetadata: { requestId: 'request-1', remoteAddress: null, userAgent: null },
    });

    assertAdmittedAndDistinct(queue, 1, 'payment webhook replay');
  });
});

// ── The tree ─────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * The producers driven above. A file enters this list by getting a case in the
 * describe block above — not by being added here to quiet the scan.
 */
const DRIVEN_PRODUCERS: readonly string[] = [
  'src/modules/broadcast/services/broadcast-queue.service.ts',
  'src/modules/email/services/email-delivery.service.ts',
  'src/modules/notifications/services/reiwa-relay-queue.service.ts',
  'src/modules/notifications/services/telegram-direct-queue.service.ts',
  'src/modules/payments/services/moy-nalog-queue.service.ts',
  'src/modules/payments/services/payment-auto-retry.service.ts',
  'src/modules/payments/services/payment-webhook-ops.service.ts',
  'src/modules/profile-sync/profile-sync-queue.service.ts',
  'src/modules/webhooks/services/webhook-queue.service.ts',
];

/**
 * A job id being MINTED: `jobId:` or `jobId =` followed by a template literal
 * or a call. That is every custom id in the tree — `\`deliver__${id}\``,
 * `startJobId(id)`, `buildReconciliationJobId(id)`, `toBullMqJobId(…)` — and it
 * leaves out the shapes that only carry an id BullMQ assigned (`jobId: job.id
 * ?? filename`), a type (`jobId: string`), or a destructured result.
 */
const MINTS_A_JOB_ID = /\bjobId\s*(?::|=)\s*(?:`|[A-Za-z_$][\w$]*\s*\()/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no producer mints a job id this file does not drive', () => {
  it('can see a minted id when it is shown one, and not otherwise', () => {
    // A scan that finds nothing agrees with an empty tree forever.
    for (const minted of [
      'jobId: `deliver__${deliveryId}`,',
      'const jobId = buildReconciliationJobId(event.id);',
      'jobId: startJobId(data.broadcastId),',
      '...(eventId !== null ? { jobId: toBullMqJobId(event, eventId) } : {}),',
    ]) {
      assert.equal(MINTS_A_JOB_ID.test(minted), true, minted);
    }
    for (const carried of [
      'return { jobId: job.id ?? filename, provenance };',
      'readonly jobId: string;',
      'const { jobId, provenance } = await this.backupService.restoreBackup(filename);',
      'const jobId = started?.response?.jobId;',
      'jobId: input.jobId,',
    ]) {
      assert.equal(MINTS_A_JOB_ID.test(carried), false, carried);
    }
  });

  it('finds exactly the producers driven above', () => {
    const minting = walk(SRC_ROOT)
      .filter((file) => MINTS_A_JOB_ID.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .sort();

    assert.ok(minting.length >= 9, `the scan found only ${minting.length} producers — the scan is wrong`);
    assert.deepStrictEqual(
      minting,
      [...DRIVEN_PRODUCERS].sort(),
      'a file mints a BullMQ job id that no case above sends through BullMQ’s validation ' +
        '(or a listed file stopped minting one). Drive it above; if its keys are caller-minted, ' +
        'build the id with `toBullMqJobId`.',
    );
  });
});
