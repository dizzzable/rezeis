import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AddOnType, type Prisma } from '@prisma/client';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import {
  ADD_ON_EXPIRY_NOTICE_JOB_ID,
  ADD_ON_EXPIRY_NOTICE_QUEUE,
  ADD_ON_EXPIRY_NOTICE_TICK_JOB,
} from '../src/modules/add-on-entitlements/addon-expiry-notice.constants';
import { AddOnExpiryNoticeProcessor } from '../src/modules/add-on-entitlements/addon-expiry-notice.processor';
import {
  addOnNoticeType,
  AddOnExpiryNoticeService,
  decideAddOnNotice,
  type AddOnNoticeRow,
} from '../src/modules/add-on-entitlements/services/addon-expiry-notice.service';
import {
  resolveNotificationCategory,
  resolveTerminalRouteFor,
} from '../src/modules/bot-map/services/notification-target-resolver';
import { buttonTargetProblem } from '../src/modules/bot-map/services/menu-button-route';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import {
  isSubscriberMailableType,
  isSubscriberNotificationEnabled,
  readSubscriberNotificationPrefs,
  SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES,
} from '../src/modules/notifications/utils/notification-toggle.util';
import { buildAddOnFacts } from '../src/modules/notifications/utils/subscription-facts.util';
import { admitThroughBullMq, OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * The customer's notices before and at a dated add-on's end — the parts that
 * need no database: when a pass is queued and under which id, which template
 * says what, how the words are made, and what the customer can switch off.
 * The pass itself — the selection, the once, the channels — is proved against
 * PostgreSQL in `addon-expiry-notice-postgres.spec.ts`.
 */

const NOTICE_TYPES = [
  'addon_ends_in_3_days',
  'addon_ended',
  'addon_devices_ends_in_3_days',
  'addon_devices_ended',
  'addon_devices_auto_ends_in_3_days',
  'addon_devices_auto_ended',
] as const;

const ENV = ['ADDON_ENTITLEMENT_DIRECT_PURCHASE', 'RUID_PROCESS_ROLE'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  delete process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
  process.env.RUID_PROCESS_ROLE = 'worker';
  _resetProcessRoleCacheForTests();
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetProcessRoleCacheForTests();
});

type Moment = 'endsSoon' | 'ended';
/** A selection: the add-ons due (`due`), or the decided notices whose channels never ran (`undelivered`). */
type Selection = 'due' | 'undelivered';

/**
 * The service over a queue that holds jobs in memory and a database with one
 * row for each moment and selection named in `rows`: a selection's SQL names
 * its moment by the states it reads, and the outbox's by the outcome it reads.
 * Each read is kept — its moment, its selection and how many rows it asked for.
 */
function build(rows: Partial<Record<Moment, Selection>> = {}) {
  const queue = new OfflineBullMqQueue<unknown>(ADD_ON_EXPIRY_NOTICE_QUEUE);
  const reads: Array<{ readonly moment: Moment; readonly selection: Selection; readonly limit: unknown }> = [];
  const prisma = {
    $queryRaw: async (sql: Prisma.Sql) => {
      const text = sql.strings.join('');
      const moment: Moment = text.includes("IN ('EXPIRING', 'EXPIRED')") ? 'ended' : 'endsSoon';
      const selection: Selection = text.includes(`->>'outcome'`) ? 'undelivered' : 'due';
      reads.push({ moment, selection, limit: sql.values[sql.values.length - 1] });
      if (rows[moment] !== selection) return [];
      return selection === 'due' ? [{ id: `due-${moment}` }] : [{ entitlementId: `sent-${moment}`, notificationEventId: 'n1' }];
    },
  };
  const service = new AddOnExpiryNoticeService(prisma as never, {} as never, {} as never, queue.asQueue());
  return { queue, service, reads: () => reads };
}

describe('the pass and its id', () => {
  it('uses a fixed id BullMQ admits: no colon, not an integer', async () => {
    // Literal, not the constant: the check must not move with the value.
    assert.equal(ADD_ON_EXPIRY_NOTICE_JOB_ID, 'add-on-expiry-notice-tick');
    const job = await admitThroughBullMq(ADD_ON_EXPIRY_NOTICE_QUEUE, ADD_ON_EXPIRY_NOTICE_TICK_JOB, {}, {
      jobId: ADD_ON_EXPIRY_NOTICE_JOB_ID,
    });
    assert.equal(job.id, ADD_ON_EXPIRY_NOTICE_JOB_ID);
  });

  it('queues one pass, a second enqueue while it exists adds nothing, and the id is free again once it ends', async () => {
    const { queue, service } = build();
    assert.equal(await service.enqueueTick(), true);
    assert.equal(await service.enqueueTick(), true);
    assert.deepEqual(queue.refused, []);
    assert.deepEqual(queue.heldIds(), [ADD_ON_EXPIRY_NOTICE_JOB_ID]);
    assert.deepEqual(queue.admitted.map((add) => add.collapsed), [false, true]);
    assert.equal(queue.admitted[0]!.opts.removeOnComplete, true);
    assert.equal(queue.admitted[0]!.opts.removeOnFail, true);
  });

  it('never throws when Redis is down; the next cron retries', async () => {
    const { queue, service } = build();
    queue.goDown();
    assert.equal(await service.enqueueTick(), false);
  });

  it('queues a pass on the worker when an add-on’s moment is due — whatever stage 2 says', async () => {
    // Stage 2 unset (off in this release), off in so many words, and on: the
    // notices follow the add-on's row, as the sweep that ends it does.
    for (const stage2 of [undefined, 'false', 'true']) {
      if (stage2 === undefined) delete process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE;
      else process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = stage2;
      const soon = build({ endsSoon: 'due' });
      assert.equal(await soon.service.schedule(), true, `stage 2 ${String(stage2)}`);
      assert.deepEqual(soon.queue.heldIds(), [ADD_ON_EXPIRY_NOTICE_JOB_ID]);
    }
    // One that has ended is due too: the check reads both moments.
    const ended = build({ ended: 'due' });
    assert.equal(await ended.service.schedule(), true);
    assert.deepEqual(ended.queue.heldIds(), [ADD_ON_EXPIRY_NOTICE_JOB_ID]);
    // And so is a notice decided before whose channels a crash cut off, with
    // nothing else due: the pass that sends them again must run.
    for (const moment of ['endsSoon', 'ended'] as const) {
      const cutOff = build({ [moment]: 'undelivered' });
      assert.equal(await cutOff.service.schedule(), true, moment);
      assert.deepEqual(cutOff.queue.heldIds(), [ADD_ON_EXPIRY_NOTICE_JOB_ID]);
    }

    process.env.RUID_PROCESS_ROLE = 'api';
    _resetProcessRoleCacheForTests();
    const api = build({ endsSoon: 'due' });
    assert.equal(await api.service.schedule(), false);
    assert.deepEqual(api.queue.heldIds(), []);
    assert.deepEqual(api.reads(), [], 'the API process does not even look');
  });

  it('is cheap while nothing is due: one row asked of each selection, and no pass queued', async () => {
    const { queue, service, reads } = build();
    assert.equal(await service.schedule(), false);
    assert.deepEqual(queue.heldIds(), []);
    assert.deepEqual(reads(), [
      { moment: 'endsSoon', selection: 'undelivered', limit: 1 },
      { moment: 'endsSoon', selection: 'due', limit: 1 },
      { moment: 'ended', selection: 'undelivered', limit: 1 },
      { moment: 'ended', selection: 'due', limit: 1 },
    ]);
  });

  it('never throws when the database is down; the next cron looks again', async () => {
    const queue = new OfflineBullMqQueue<unknown>(ADD_ON_EXPIRY_NOTICE_QUEUE);
    const down = {
      $queryRaw: async () => {
        throw new Error('connection refused');
      },
    };
    const service = new AddOnExpiryNoticeService(down as never, {} as never, {} as never, queue.asQueue());
    assert.equal(await service.schedule(), false);
    assert.deepEqual(queue.heldIds(), []);
  });

  it('runs a pass whatever stage 2 says: one queued before stage 2 went off still reads both moments — the outbox first', async () => {
    process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = 'false';
    const { service, reads } = build();
    assert.deepEqual(await service.runTick(), {
      sent: 0,
      skipped: 0,
      templateOff: 0,
      lost: 0,
      moved: 0,
      resent: 0,
      errors: 0,
    });
    assert.deepEqual(
      reads().map((read) => `${read.moment}:${read.selection}`),
      ['endsSoon:undelivered', 'endsSoon:due', 'ended:undelivered', 'ended:due'],
    );
  });

  it('runs a pass for the one job it knows', async () => {
    const ran: string[] = [];
    const processor = new AddOnExpiryNoticeProcessor({ runTick: async () => void ran.push('tick') } as never);
    await processor.process({ name: ADD_ON_EXPIRY_NOTICE_TICK_JOB } as never);
    await processor.process({ name: 'something-else' } as never);
    assert.deepEqual(ran, ['tick']);
  });
});

describe('whether a moment is due, on the row read again when it is decided', () => {
  const NOW = new Date('2090-03-10T12:00:00.000Z');
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const row = (over: {
    readonly state?: AddOnNoticeRow['state'];
    readonly endsIn?: number;
    readonly activatedIn?: number | null;
    readonly status?: AddOnNoticeRow['subscription']['status'];
    readonly subscriptionEndsIn?: number | null;
  }): AddOnNoticeRow => ({
    id: 'e-1',
    subscriptionId: 's-1',
    type: AddOnType.EXTRA_TRAFFIC,
    state: over.state ?? 'ACTIVE',
    receiptName: 'x',
    totalValue: 1n,
    activatedAt: over.activatedIn === null ? null : new Date(NOW.getTime() + (over.activatedIn ?? -20 * DAY)),
    expiresAt: new Date(NOW.getTime() + (over.endsIn ?? 2 * DAY)),
    subscription: {
      userId: 'u-1',
      status: over.status ?? 'ACTIVE',
      expiresAt:
        over.subscriptionEndsIn === null ? null : new Date(NOW.getTime() + (over.subscriptionEndsIn ?? 20 * DAY)),
      planSnapshot: {},
      trafficLimit: 100,
      deviceLimit: 3,
      remnawavePanelUsername: null,
    },
  });

  it('«three days out»: an ACTIVE add-on ending inside them, bought before them, on a live subscription', () => {
    assert.equal(decideAddOnNotice(row({}), 'endsSoon', NOW), 'send');
    assert.equal(decideAddOnNotice(row({ status: 'LIMITED' }), 'endsSoon', NOW), 'send');
    // Ended meanwhile, moved out of the window, or the window not reached yet.
    assert.equal(decideAddOnNotice(row({ state: 'EXPIRING' }), 'endsSoon', NOW), 'notDue');
    assert.equal(decideAddOnNotice(row({ endsIn: -HOUR }), 'endsSoon', NOW), 'notDue');
    assert.equal(decideAddOnNotice(row({ endsIn: 3 * DAY + HOUR }), 'endsSoon', NOW), 'notDue');
    // Bought inside those three days: its checkout has just shown the date.
    assert.equal(decideAddOnNotice(row({ activatedIn: -HOUR }), 'endsSoon', NOW), 'notDue');
    // A subscription the operator switched off, or one that is gone.
    assert.equal(decideAddOnNotice(row({ status: 'DISABLED' }), 'endsSoon', NOW), 'notDue');
    assert.equal(decideAddOnNotice(row({ status: 'DELETED' }), 'endsSoon', NOW), 'notDue');
  });

  it('«has ended»: sent while the subscription goes on; recorded without a notice when it ended too', () => {
    const ended = { state: 'EXPIRED' as const, endsIn: -HOUR };
    assert.equal(decideAddOnNotice(row(ended), 'ended', NOW), 'send');
    assert.equal(decideAddOnNotice(row({ ...ended, state: 'EXPIRING' }), 'ended', NOW), 'send');
    assert.equal(decideAddOnNotice(row({ ...ended, subscriptionEndsIn: null }), 'ended', NOW), 'send');
    assert.equal(decideAddOnNotice(row({ ...ended, subscriptionEndsIn: -HOUR }), 'ended', NOW), 'skip');
    assert.equal(decideAddOnNotice(row({ ...ended, status: 'EXPIRED' }), 'ended', NOW), 'skip');
    // Not ended by the sweep: still ACTIVE, or taken back.
    assert.equal(decideAddOnNotice(row({ endsIn: -HOUR }), 'ended', NOW), 'notDue');
    assert.equal(decideAddOnNotice(row({ ...ended, state: 'REVERSED' }), 'ended', NOW), 'notDue');
    // Out of the three days after the end.
    assert.equal(decideAddOnNotice(row({ ...ended, endsIn: -3 * DAY - HOUR }), 'ended', NOW), 'notDue');
  });
});

describe('which template a notice is sent with', () => {
  it('picks traffic’s, or the devices’ for stage 6 as it is set', () => {
    assert.equal(addOnNoticeType('endsSoon', AddOnType.EXTRA_TRAFFIC, false), 'addon_ends_in_3_days');
    assert.equal(addOnNoticeType('ended', AddOnType.EXTRA_TRAFFIC, true), 'addon_ended');
    assert.equal(addOnNoticeType('endsSoon', AddOnType.EXTRA_DEVICES, false), 'addon_devices_ends_in_3_days');
    assert.equal(addOnNoticeType('ended', AddOnType.EXTRA_DEVICES, false), 'addon_devices_ended');
    assert.equal(addOnNoticeType('endsSoon', AddOnType.EXTRA_DEVICES, true), 'addon_devices_auto_ends_in_3_days');
    assert.equal(addOnNoticeType('ended', AddOnType.EXTRA_DEVICES, true), 'addon_devices_auto_ended');
  });

  it('ships all six in the catalogue — seeded on boot, so «Карта бота» lists and edits them — in Russian and English', () => {
    for (const type of NOTICE_TYPES) {
      const template = DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === type);
      assert.ok(template !== undefined, type);
      for (const text of [template.body, template.bodyEn ?? '']) {
        for (const placeholder of ['{{addon}}', '{{addonValue}}', '{{plan}}', '{{endsDateTime}}']) {
          assert.ok(text.includes(placeholder), `${type}: ${placeholder}`);
        }
      }
      assert.ok((template.titleEn ?? '').length > 0 && (template.bodyEn ?? '').length > 0, type);
      // «Купить снова» opens the add-on page, and every button is one the bot opens.
      assert.deepEqual(template.buttons?.[0], {
        labelRu: '🔁 Купить снова',
        labelEn: '🔁 Buy again',
        kind: 'webApp',
        target: '/addons',
      });
      for (const button of template.buttons ?? []) {
        if (button.kind === 'webApp') assert.equal(buttonTargetProblem('notificationWebApp', button.target), null);
      }
    }
  });

  it('says what the end does to the devices as stage 6 has it', () => {
    const body = (type: string) => DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === type)!;
    for (const type of ['addon_devices_ends_in_3_days', 'addon_devices_ended']) {
      assert.match(body(type).body, /новые устройства сверх лимита подключить не получится/i, type);
      assert.match(body(type).bodyEn ?? '', /new devices over the limit will not connect/i, type);
      assert.doesNotMatch(body(type).body, /отключ/, type);
    }
    assert.match(body('addon_devices_auto_ends_in_3_days').body, /лишние устройства отключатся сами — сначала самые новые/);
    assert.match(body('addon_devices_auto_ended').body, /Лишние устройства отключаются сами — сначала самые новые/);
    for (const type of ['addon_devices_auto_ends_in_3_days', 'addon_devices_auto_ended']) {
      assert.match(body(type).bodyEn ?? '', /disconnected automatically, newest first/, type);
    }
    // Where the customer chooses which stay: the cabinet's own names for the way there.
    assert.match(body('addon_devices_auto_ends_in_3_days').body, /«Подписка» → «Управление устройствами»/);
    assert.match(body('addon_devices_auto_ends_in_3_days').bodyEn ?? '', /“Subscription” → “Manage devices”/);
  });

  it('sits with the subscription’s notices on the map, and leads to the add-on page', () => {
    for (const type of NOTICE_TYPES) {
      assert.equal(resolveNotificationCategory(type), 'expires', type);
      assert.equal(resolveTerminalRouteFor(type), '/addons', type);
    }
  });
});

describe('what the customer can switch off', () => {
  it('two switches for six templates: «за 3 дня» and «закончилась», each mailable', () => {
    assert.ok(SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES.includes('addon_ends_in_3_days'));
    assert.ok(SUBSCRIBER_MUTABLE_NOTIFICATION_TYPES.includes('addon_ended'));
    for (const type of NOTICE_TYPES) assert.equal(isSubscriberMailableType(type), true, type);

    const soonOff = { addon_ends_in_3_days: false };
    for (const type of ['addon_ends_in_3_days', 'addon_devices_ends_in_3_days', 'addon_devices_auto_ends_in_3_days']) {
      assert.equal(isSubscriberNotificationEnabled(soonOff, type), false, type);
    }
    for (const type of ['addon_ended', 'addon_devices_ended', 'addon_devices_auto_ended']) {
      assert.equal(isSubscriberNotificationEnabled(soonOff, type), true, type);
      assert.equal(isSubscriberNotificationEnabled({ addon_ended: false }, type), false, type);
    }
    assert.deepEqual(readSubscriberNotificationPrefs({ addon_ended: false, addon_devices_ended: false }), { addon_ended: false });
  });
});

describe('the words, in the customer’s language', () => {
  it('says the add-on’s size and its end', () => {
    const endsAt = '2090-03-12T12:00:00.000Z';
    assert.deepEqual(buildAddOnFacts({ type: 'EXTRA_TRAFFIC', total: 10, endsAt, timezone: 'Europe/Moscow' }, 'ru'), {
      addonAmount: '10 ГБ',
      addonValue: '+10 ГБ',
      endsDate: '12 марта',
      endsTime: '15:00',
      endsDateTime: '12 марта, 15:00',
    });
    const devices = (total: number, locale: 'ru' | 'en') =>
      buildAddOnFacts({ type: 'EXTRA_DEVICES', total, endsAt }, locale)['addonValue'];
    assert.deepEqual([1, 2, 5, 11, 21, 22].map((n) => devices(n, 'ru')), [
      '+1 устройство',
      '+2 устройства',
      '+5 устройств',
      '+11 устройств',
      '+21 устройство',
      '+22 устройства',
    ]);
    assert.deepEqual([1, 2].map((n) => devices(n, 'en')), ['+1 device', '+2 devices']);
    assert.equal(buildAddOnFacts({ type: 'EXTRA_TRAFFIC', total: 1.5, endsAt }, 'en')['addonAmount'], '1.5 GB');
  });

  it('says nothing for a payload without an add-on', () => {
    assert.deepEqual(buildAddOnFacts({ type: undefined, total: undefined, endsAt: undefined }, 'ru'), {});
  });
});

describe('«Купить снова» on the subscription the notice is about', () => {
  function relayingService(template: { buttons: unknown }) {
    const relayed: Array<{ buttons?: Array<{ webAppPath?: string }> }> = [];
    const pushed: Array<{ url: string }> = [];
    const prisma = {
      userNotificationEvent: {
        create: async (args: { data: { userId: string; type: string; payload: unknown } }) => ({
          id: 'evt-1',
          userId: args.data.userId,
          type: args.data.type,
          payload: args.data.payload,
        }),
        count: async () => 0,
        update: async () => ({}),
      },
      user: {
        findUnique: async () => ({
          telegramId: 42n,
          isBotBlocked: false,
          name: 'Вася',
          username: null,
          language: 'RU',
          notificationPrefs: null,
        }),
      },
      settings: { findUnique: async () => null },
    };
    const service = new UserNotificationsService(
      prisma as never,
      {
        getByType: async (type: string) => ({
          type,
          title: 'T',
          body: 'B',
          titleEn: null,
          bodyEn: null,
          isActive: true,
          bannerUrl: null,
          ...template,
        }),
      } as never,
      {} as never,
      {
        sendToUser: async (payload: { url: string }) => {
          pushed.push(payload);
          return { attempted: 1, delivered: 1, failed: 0, disabled: false };
        },
      } as never,
      { substituteTelegramHtml: async (text: string) => text, substituteFallbacks: async (text: string) => text } as never,
      {
        enqueue: async (_event: string, job: { buttons?: Array<{ webAppPath?: string }> }) => {
          relayed.push(job);
          return true;
        },
      } as never,
    );
    return { service, relayed, pushed };
  }

  it('opens the add-on page on that subscription — in the bot and from the push — and leaves any other button as saved', async () => {
    const { service, relayed, pushed } = relayingService({
      buttons: [
        { labelRu: 'Купить снова', kind: 'webApp', target: '/addons' },
        { labelRu: 'Своя', kind: 'webApp', target: 'addons?utm=bot' },
        { labelRu: 'Уже с подпиской', kind: 'webApp', target: '/addons?subscriptionId=other' },
        { labelRu: 'Устройства', kind: 'webApp', target: '/subscription/devices' },
      ],
    });
    const notice = await service.createInTransaction(
      { userNotificationEvent: { create: async () => ({ id: 'evt-1', userId: 'u-1', type: 'addon_ended', payload: { subscriptionId: 'sub-1' } }) } } as never,
      { userId: 'u-1', type: 'addon_ended', payload: { subscriptionId: 'sub-1' } },
    );
    assert.equal(notice.eventId, 'evt-1');
    assert.equal(relayed.length, 0, 'a channel ran before the caller committed');
    await notice.deliver();

    assert.deepEqual(
      relayed[0]?.buttons?.map((button) => button.webAppPath),
      ['/addons?subscriptionId=sub-1', 'addons?utm=bot&subscriptionId=sub-1', '/addons?subscriptionId=other', '/subscription/devices'],
    );
    assert.equal(pushed[0]?.url, '/addons?subscriptionId=sub-1');
  });
});
