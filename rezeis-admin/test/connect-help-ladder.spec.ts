import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it, mock } from 'node:test';

import { EMAIL_QUEUE } from '../src/modules/email/email.constants';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  type DefaultNotificationTemplate,
} from '../src/modules/notifications/catalog/default-templates.catalog';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import {
  LADDER_BOT_DEADLINE_MS,
  LADDER_MAX_BOT_DEFERRALS,
  UserNotificationsService,
  type DeliverFirstReachableInput,
  type DeliverFirstReachableResult,
  type LadderAttempt,
} from '../src/modules/notifications/services/user-notifications.service';
import { OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * «Помощь с подключением»: the FIRST channel that reaches the customer, and
 * only that one — `UserNotificationsService.deliverFirstReachable`.
 *
 * Every rung is driven through the real thing that decides it:
 *
 *   bot    the real `BotNotifierClient` against a stubbed `fetch` that answers
 *          what the cabinet answers — 200 with Telegram's message id, a bodiless
 *          204, a 422 refusal, a 503, a dropped connection, a hang — so the
 *          ladder reads the status the client really produces, not one a
 *          double invented;
 *   push   a double of `WebPushService.sendToUser` returning each of its four
 *          shapes (delivered, none delivered, no browser, not configured);
 *   email  the real `EmailDeliveryService` on a queue that runs BullMQ's own
 *          admission check, so the job id is proven acceptable to the library,
 *          not to a fake that takes anything.
 *
 * The Prisma double honours `where` and `select` where they are the gate (the
 * verified-address lookup, the user's columns): a double that ignores them
 * makes "only verified addresses" and "reads the customer's switch"
 * unobservable.
 */

const EVENT_ID = 'cmf0connecthelpevent0001';
const SUBSCRIPTION_ID = 'cmf0connecthelpsub000001';

type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

const CONFIRMED: FetchStub = async () =>
  new Response(JSON.stringify({ messageId: 4242 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const UNCONFIRMED_204: FetchStub = async () => new Response(null, { status: 204 });
const REFUSED_422: FetchStub = async () =>
  new Response(JSON.stringify({ message: 'refused', detail: 'Bad Request: chat not found' }), {
    status: 422,
    statusText: 'Unprocessable Entity',
  });
const REFUSED_401: FetchStub = async () => new Response('{}', { status: 401, statusText: 'Unauthorized' });
const BUSY_503: FetchStub = async () =>
  new Response('{}', { status: 503, statusText: 'Service Unavailable', headers: { 'retry-after': '3' } });
const CONNECTION_DROPPED: FetchStub = async () => {
  throw new TypeError('fetch failed');
};

interface Recorded {
  readonly fetchCalls: Array<{ readonly url: string; readonly body: Record<string, unknown> }>;
  readonly feedRows: Array<{ readonly userId: string; readonly type: string; readonly payload: unknown }>;
  readonly feedUpdates: Array<{ readonly id: string; readonly payload: Record<string, unknown> }>;
  readonly pushCalls: Array<Record<string, unknown>>;
  readonly relayEnqueues: string[];
  readonly templateLookups: string[];
  readonly writtenIds: string[];
}

interface HarnessOptions {
  readonly type?: 'connect_help' | 'connect_help_trial';
  readonly fetch?: FetchStub;
  /** The relay's configuration, as `REIWA_URL` + `WEBHOOK_SECRET_HEADER` say. */
  readonly relayConfigured?: boolean;
  readonly user?: {
    readonly telegramId: bigint | null;
    readonly isBotBlocked: boolean;
    readonly name: string;
    readonly language: 'RU' | 'EN';
    readonly notificationPrefs: Record<string, unknown> | null;
  };
  readonly push?: { readonly attempted: number; readonly delivered: number; readonly disabled: boolean } | 'throws';
  readonly smtp?: { readonly enabled: boolean; readonly notifyUsers: boolean };
  readonly email?: { readonly address: string; readonly verified: boolean } | null;
  /** Replace a catalogue template (or remove it with `null`). */
  readonly templates?: Partial<Record<string, (DefaultNotificationTemplate & { isActive?: boolean }) | null>>;
}

const LIVE_USER = {
  telegramId: 777000111n,
  isBotBlocked: false,
  name: 'Анна',
  language: 'RU' as const,
  notificationPrefs: null,
};

function catalogue(type: string): DefaultNotificationTemplate {
  const template = DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === type);
  assert.ok(template, `${type} is not in the shipped catalogue`);
  return template;
}

function harness(options: HarnessOptions = {}) {
  const recorded: Recorded = {
    fetchCalls: [],
    feedRows: [],
    feedUpdates: [],
    pushCalls: [],
    relayEnqueues: [],
    templateLookups: [],
    writtenIds: [],
  };
  const user = options.user ?? LIVE_USER;
  const fetchStub = options.fetch ?? CONFIRMED;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    recorded.fetchCalls.push({ url: String(input), body });
    return fetchStub(String(input), init ?? {});
  }) as typeof globalThis.fetch;
  if (options.relayConfigured === false) {
    delete process.env.REIWA_URL;
    delete process.env.WEBHOOK_SECRET_HEADER;
  } else {
    process.env.REIWA_URL = 'https://reiwa.example.test';
    process.env.WEBHOOK_SECRET_HEADER = 'ladder-test-secret';
  }
  const botNotifier = new BotNotifierClient();

  const smtp = options.smtp ?? { enabled: true, notifyUsers: true };
  const email = options.email === undefined ? { address: 'anna@example.com', verified: true } : options.email;
  const prisma = {
    userNotificationEvent: {
      create: async (args: { data: { userId: string; type: string; payload: unknown } }) => {
        recorded.feedRows.push(args.data);
        return { id: EVENT_ID };
      },
      update: async (args: { where: { id: string }; data: { payload: Record<string, unknown> } }) => {
        recorded.feedUpdates.push({ id: args.where.id, payload: args.data.payload });
        return { id: args.where.id };
      },
      count: async () => 3,
    },
    user: {
      findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        if (args.where.id !== 'user-anna') return null;
        const row: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(user)) {
          if (args.select?.[key] === true) row[key] = value;
        }
        return row;
      },
    },
    webAccount: {
      // THE VERIFICATION GATE IS THIS WHERE: honoured, or "only verified
      // addresses" would pass for any implementation.
      findFirst: async (args: { where: Record<string, unknown> }) => {
        if (email === null || args.where['userId'] !== 'user-anna') return null;
        const demandsVerified = args.where['emailVerifiedAt'] !== undefined;
        if (demandsVerified && !email.verified) return null;
        return { email: email.address };
      },
    },
    settings: {
      findUnique: async () => ({ platformPolicy: { projectName: 'Reiwa' } }),
      // `EmailDeliveryService` reads its SMTP switches from here.
      findFirst: async () => ({
        systemNotifications: { email: { enabled: smtp.enabled, notifyUsers: smtp.notifyUsers, host: 'smtp.test' } },
        brandingSettings: null,
      }),
    },
  };
  const templates = {
    getByType: async (type: string) => {
      recorded.templateLookups.push(type);
      const override = options.templates?.[type];
      if (override === null) return null;
      const source = override ?? DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === type);
      if (source === undefined) return null;
      return {
        id: `tpl-${type}`,
        type: source.type,
        title: source.title,
        body: source.body,
        titleEn: source.titleEn ?? null,
        bodyEn: source.bodyEn ?? null,
        buttons: source.buttons ?? [],
        bannerUrl: null,
        isActive: (source as { isActive?: boolean }).isActive ?? true,
      };
    },
  };
  const pushResult = options.push ?? { attempted: 1, delivered: 1, disabled: false };
  const webPush = {
    sendToUser: async (call: Record<string, unknown>) => {
      recorded.pushCalls.push(call);
      if (pushResult === 'throws') throw new Error('push service exploded');
      return { ...pushResult, failed: pushResult.attempted - pushResult.delivered };
    },
  };
  const relayQueue = {
    enqueue: async (event: string) => {
      recorded.relayEnqueues.push(event);
      return true;
    },
  };
  const customEmoji = {
    substituteTelegramHtml: async (text: string) => text,
    substituteFallbacks: async (text: string) => text,
  };
  const queue = new OfflineBullMqQueue<unknown>(EMAIL_QUEUE);
  const emailDelivery = new EmailDeliveryService(
    {} as never,
    prisma as never,
    {} as never,
    undefined,
    queue.asQueue(),
  );
  const service = new UserNotificationsService(
    prisma as never,
    templates as never,
    botNotifier,
    webPush as never,
    customEmoji as never,
    relayQueue as never,
    undefined,
    undefined,
    emailDelivery,
  );
  const deliver = (
    input: Pick<DeliverFirstReachableInput, 'eventId' | 'deferrals' | 'beforeSend' | 'afterSend' | 'skipChannels'> = {},
  ) =>
    service.deliverFirstReachable({
      userId: 'user-anna',
      type: options.type ?? 'connect_help',
      payload: { subscriptionId: SUBSCRIPTION_ID, kind: 'paid', plan: 'Премиум', planName: 'Премиум' },
      eventId: input.eventId,
      deferrals: input.deferrals,
      beforeSend: input.beforeSend,
      afterSend: input.afterSend,
      skipChannels: input.skipChannels,
      onFeedRowWritten: async (id) => {
        // Before any channel runs: nothing may have left yet.
        assert.equal(recorded.fetchCalls.length, 0, 'the bot was asked before the feed row id was reported');
        assert.equal(recorded.pushCalls.length, 0, 'push went out before the feed row id was reported');
        recorded.writtenIds.push(id);
      },
    });
  return { recorded, deliver, queue };
}

function channels(result: DeliverFirstReachableResult): string[] {
  return result.attempts.map((attempt) => `${attempt.channel}:${attempt.result}`);
}

let realFetch: typeof globalThis.fetch;
let savedEnv: { REIWA_URL?: string; WEBHOOK_SECRET_HEADER?: string };

before(() => {
  realFetch = globalThis.fetch;
  savedEnv = { REIWA_URL: process.env.REIWA_URL, WEBHOOK_SECRET_HEADER: process.env.WEBHOOK_SECRET_HEADER };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the bot rung', () => {
  it('stops at the bot when Telegram returned a message id — push and e-mail are never asked', async () => {
    const { recorded, deliver, queue } = harness({ fetch: CONFIRMED });
    const result = await deliver();

    assert.equal(result.outcome, 'bot');
    assert.deepEqual(channels(result), ['bot:confirmed']);
    assert.equal(recorded.pushCalls.length, 0);
    assert.equal(queue.admitted.length, 0);
    // Synchronous, direct, and never through the relay queue: the ladder has
    // to read the answer before it may choose the next rung.
    assert.deepEqual(recorded.relayEnqueues, []);
    assert.equal(recorded.fetchCalls.length, 1);
    const metadata = recorded.fetchCalls[0].body['metadata'] as Record<string, unknown>;
    assert.equal(metadata['eventId'], EVENT_ID, 'the bot deduplicates on the feed row id');
    assert.equal(metadata['telegramId'], '777000111');
    assert.equal(metadata['parseMode'], 'HTML');
    assert.deepEqual(
      (metadata['buttons'] as Array<Record<string, unknown>>).map((button) => button['webAppPath']),
      ['/dashboard?connect=help', '/support'],
    );
  });

  for (const [label, stub, result] of [
    ['a bodiless 204 (blocked or never started)', UNCONFIRMED_204, 'unconfirmed'],
    ['a 422 refusal of the message', REFUSED_422, 'rejected'],
    ['a 401 refusal of the signature', REFUSED_401, 'rejected'],
  ] as const) {
    it(`goes on to push after ${label}`, async () => {
      const { recorded, deliver } = harness({ fetch: stub });
      const outcome = await deliver();

      assert.equal(outcome.outcome, 'push');
      assert.deepEqual(channels(outcome), [`bot:${result}`, 'push:delivered']);
      assert.equal(recorded.pushCalls.length, 1);
    });
  }

  it('goes on without calling a relay that is not configured', async () => {
    const { recorded, deliver } = harness({ relayConfigured: false });
    const outcome = await deliver();

    assert.equal(outcome.outcome, 'push');
    assert.equal(recorded.fetchCalls.length, 0);
    assert.deepEqual(outcome.attempts[0], {
      channel: 'bot',
      result: 'unavailable',
      at: outcome.attempts[0].at,
      detail: 'relay_off',
    });
  });

  for (const [label, user, detail] of [
    ['has no Telegram', { ...LIVE_USER, telegramId: null }, 'no_telegram'],
    ['has a non-positive Telegram id', { ...LIVE_USER, telegramId: -100n }, 'no_telegram'],
    ['blocked the bot', { ...LIVE_USER, isBotBlocked: true }, 'bot_blocked'],
  ] as const) {
    it(`skips the bot, unasked, when the customer ${label}`, async () => {
      const { recorded, deliver } = harness({ user });
      const outcome = await deliver();

      assert.equal(recorded.fetchCalls.length, 0);
      assert.equal(outcome.attempts[0].result, 'unavailable');
      assert.equal(outcome.attempts[0].detail, detail);
      assert.equal(outcome.outcome, 'push');
    });
  }

  for (const [label, stub, result] of [
    ['a dropped connection', CONNECTION_DROPPED, 'failed'],
    ['a 503 from the cabinet', BUSY_503, 'rejected'],
  ] as const) {
    it(`defers after ${label}: the link, not the person — push is not tried`, async () => {
      const { recorded, deliver } = harness({ fetch: stub });
      const outcome = await deliver({ deferrals: 0 });

      assert.equal(outcome.outcome, 'deferred');
      assert.equal(outcome.eventId, EVENT_ID);
      assert.deepEqual(channels(outcome), [`bot:${result}`]);
      assert.equal(recorded.pushCalls.length, 0);
    });
  }

  it(`defers up to ${LADDER_MAX_BOT_DEFERRALS} times, then goes on without the bot`, async () => {
    assert.equal(LADDER_MAX_BOT_DEFERRALS, 3);
    for (const deferrals of [0, 1, 2]) {
      const { deliver } = harness({ fetch: CONNECTION_DROPPED });
      assert.equal((await deliver({ eventId: EVENT_ID, deferrals })).outcome, 'deferred', `deferrals=${deferrals}`);
    }
    const { recorded, deliver } = harness({ fetch: CONNECTION_DROPPED });
    const outcome = await deliver({ eventId: EVENT_ID, deferrals: 3 });

    assert.equal(outcome.outcome, 'push');
    assert.deepEqual(channels(outcome), ['bot:failed', 'push:delivered']);
    assert.equal(recorded.pushCalls.length, 1);
  });

  it("reads the client's own timeout as a deferral", async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const hangs: FetchStub = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        asked();
      });
    const { deliver } = harness({ fetch: hangs });
    const pending = deliver();
    await reached;
    mock.timers.tick(10_000);
    const outcome = await pending;

    assert.equal(outcome.outcome, 'deferred');
    assert.deepEqual(channels(outcome), ['bot:timeout']);
  });

  it(`counts no answer within ${LADDER_BOT_DEADLINE_MS} ms as a timeout, whatever the client does`, async () => {
    assert.equal(LADDER_BOT_DEADLINE_MS, 15_000);
    mock.timers.enable({ apis: ['setTimeout'] });
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => {
      asked = resolve;
    });
    // Never settles and ignores the abort: only the ladder's own deadline ends it.
    const deaf: FetchStub = () =>
      new Promise<Response>(() => {
        asked();
      });
    const { deliver } = harness({ fetch: deaf });
    const pending = deliver();
    await reached;
    mock.timers.tick(LADDER_BOT_DEADLINE_MS);
    const outcome = await pending;

    assert.equal(outcome.outcome, 'deferred');
    assert.equal(outcome.attempts[0].result, 'timeout');
  });
});

describe('the push rung', () => {
  it('stops at push when at least one browser took it', async () => {
    const { recorded, deliver, queue } = harness({
      fetch: UNCONFIRMED_204,
      push: { attempted: 2, delivered: 1, disabled: false },
    });
    const outcome = await deliver();

    assert.equal(outcome.outcome, 'push');
    assert.equal(outcome.attempts[1].detail, '1/2');
    assert.equal(queue.admitted.length, 0, 'e-mail was sent after push delivered');
    const call = recorded.pushCalls[0];
    // The cabinet's one deep link for this help, naming THIS subscription.
    assert.equal(call['url'], `/dashboard?connect=help&subscriptionId=${SUBSCRIPTION_ID}`);
    assert.equal(call['tag'], `connect_help:${EVENT_ID}`);
    assert.equal(call['ttlSeconds'], undefined, 'the day-long default TTL');
    assert.equal(call['title'], 'Не получилось подключиться?');
  });

  for (const [label, push, result, detail] of [
    ['delivered to none of its browsers', { attempted: 2, delivered: 0, disabled: false }, 'failed', '0/2'],
    ['has no browser bound', { attempted: 0, delivered: 0, disabled: false }, 'unavailable', 'no_subscription'],
    ['is on an install without VAPID keys', { attempted: 0, delivered: 0, disabled: true }, 'unavailable', 'not_configured'],
  ] as const) {
    it(`goes on to e-mail when push ${label}`, async () => {
      const { deliver } = harness({ fetch: UNCONFIRMED_204, push });
      const outcome = await deliver();

      assert.equal(outcome.outcome, 'email');
      assert.deepEqual(outcome.attempts[1], {
        channel: 'push',
        result,
        at: outcome.attempts[1].at,
        detail,
      });
    });
  }

  it('goes on when the push service throws', async () => {
    const { deliver } = harness({ fetch: UNCONFIRMED_204, push: 'throws' });
    const outcome = await deliver();

    assert.equal(outcome.outcome, 'email');
    assert.equal(outcome.attempts[1].result, 'failed');
  });
});

describe('the e-mail rung', () => {
  const NO_PUSH = { attempted: 0, delivered: 0, disabled: false } as const;

  it('queues one letter under email:notify:<eventId> — three parts, admitted by BullMQ itself', async () => {
    const { deliver, queue } = harness({ fetch: UNCONFIRMED_204, push: NO_PUSH });
    const outcome = await deliver();

    assert.equal(outcome.outcome, 'email');
    assert.equal(queue.refused.length, 0, `BullMQ refused: ${JSON.stringify(queue.refused)}`);
    assert.equal(queue.admitted.length, 1);
    const jobId = queue.admitted[0].jobId;
    assert.equal(jobId, `email:notify:${EVENT_ID}`);
    assert.equal(jobId.split(':').length, 3, 'BullMQ accepts a colon only in a three-part id');
    const letter = queue.admitted[0].data as Record<string, unknown>;
    assert.equal(letter['to'], 'anna@example.com');
    assert.equal(letter['subject'], 'Не получилось подключиться?');
  });

  it('keeps one letter when a resumed ladder reaches e-mail again with the same event id', async () => {
    const { deliver, queue } = harness({ fetch: UNCONFIRMED_204, push: NO_PUSH });
    await deliver({ eventId: EVENT_ID });
    await deliver({ eventId: EVENT_ID });

    assert.equal(queue.admitted.length, 2);
    assert.equal(queue.admitted[1].collapsed, true, 'the second letter was not collapsed into the first');
  });

  for (const [label, options, detail] of [
    ['the operator never switched mail to customers on', { smtp: { enabled: true, notifyUsers: false } }, 'notify_users_off'],
    ['SMTP is off (the owner’s production)', { smtp: { enabled: false, notifyUsers: true } }, 'smtp_off'],
    ['the address is not verified', { email: { address: 'anna@example.com', verified: false } }, 'no_verified_email'],
    ['there is no address', { email: null }, 'no_verified_email'],
  ] as const) {
    it(`ends at the banner when ${label}`, async () => {
      const { deliver, queue } = harness({ fetch: UNCONFIRMED_204, push: NO_PUSH, ...options });
      const outcome = await deliver();

      assert.equal(outcome.outcome, 'banner');
      assert.equal(queue.admitted.length, 0);
      assert.deepEqual(channels(outcome), ['bot:unconfirmed', 'push:unavailable', 'email:unavailable']);
      assert.equal(outcome.attempts[2].detail, detail);
    });
  }
});

describe('a push or a letter is on record before and after it is asked', () => {
  const NO_PUSH = { attempted: 0, delivered: 0, disabled: false } as const;

  it('announces each step before asking it, with the steps so far, and its answer before going on', async () => {
    const { recorded, deliver, queue } = harness({ fetch: UNCONFIRMED_204, push: NO_PUSH });
    const log: string[] = [];
    const outcome = await deliver({
      beforeSend: async (channel, attempts) => {
        log.push(`before ${channel} [${attempts.map((a) => `${a.channel}:${a.result}`).join(',')}]`);
        // Nothing of this channel may have left yet.
        log.push(`asked so far: push ${recorded.pushCalls.length}, letters ${queue.admitted.length}`);
        return true;
      },
      afterSend: async (attempt: LadderAttempt) => {
        log.push(`after ${attempt.channel}:${attempt.result}`);
      },
    });

    assert.equal(outcome.outcome, 'email');
    assert.deepEqual(log, [
      'before push [bot:unconfirmed]',
      'asked so far: push 0, letters 0',
      'after push:unavailable',
      'before email [bot:unconfirmed,push:unavailable]',
      'asked so far: push 1, letters 0',
      'after email:queued',
    ]);
  });

  it('puts a bot message on record before it returns, and nothing about a bot that did not take it', async () => {
    const delivered = harness({ fetch: CONFIRMED });
    const seen: string[] = [];
    const outcome = await delivered.deliver({
      afterSend: async (attempt, attempts) => {
        seen.push(`${attempt.channel}:${attempt.result} of [${attempts.map((a) => a.result).join(',')}]`);
      },
    });
    assert.equal(outcome.outcome, 'bot');
    assert.deepEqual(seen, ['bot:confirmed of [confirmed]']);

    const deferred = harness({ fetch: BUSY_503 });
    const unseen: string[] = [];
    const later = await deferred.deliver({
      afterSend: async (attempt) => {
        unseen.push(attempt.result);
      },
    });
    assert.equal(later.outcome, 'deferred');
    assert.deepEqual(unseen, []);
  });

  it('asks nothing more, and answers busy, when a step is refused', async () => {
    for (const refused of ['push', 'email'] as const) {
      const { recorded, deliver, queue } = harness({ fetch: UNCONFIRMED_204, push: NO_PUSH });
      const outcome = await deliver({ beforeSend: async (channel) => channel !== refused });

      assert.equal(outcome.outcome, 'busy', `${refused} refused`);
      assert.equal(recorded.pushCalls.length, refused === 'push' ? 0 : 1, `${refused} refused`);
      assert.equal(queue.admitted.length, 0, `a letter went out with ${refused} refused`);
    }
  });

  it('never asks a step a dead run began, and goes on without it', async () => {
    const { recorded, deliver, queue } = harness({ fetch: UNCONFIRMED_204 });
    const outcome = await deliver({ eventId: EVENT_ID, skipChannels: ['push'] });

    assert.equal(outcome.outcome, 'email');
    assert.equal(recorded.pushCalls.length, 0, 'the push a dead run began was asked again');
    assert.deepEqual(channels(outcome), ['bot:unconfirmed', 'email:queued']);
    assert.equal(queue.admitted.length, 1);

    const { recorded: again, deliver: deliverAgain, queue: noLetters } = harness({ fetch: UNCONFIRMED_204 });
    const banner = await deliverAgain({ eventId: EVENT_ID, skipChannels: ['push', 'email'] });
    assert.equal(banner.outcome, 'banner');
    assert.equal(again.pushCalls.length, 0);
    assert.equal(noLetters.admitted.length, 0);
  });
});

describe('the feed row, the switch and the template', () => {
  it('writes the feed row first, with the subscription and the rendered words', async () => {
    const { recorded, deliver } = harness();
    const outcome = await deliver();

    assert.equal(outcome.eventId, EVENT_ID);
    assert.deepEqual(recorded.writtenIds, [EVENT_ID]);
    assert.equal(recorded.feedRows.length, 1);
    assert.equal(recorded.feedRows[0].type, 'connect_help');
    assert.equal((recorded.feedRows[0].payload as Record<string, unknown>)['subscriptionId'], SUBSCRIPTION_ID);
    assert.equal(recorded.feedUpdates[0].payload['title'], 'Не получилось подключиться?');
    assert.match(String(recorded.feedUpdates[0].payload['text']), /Подписка «Премиум» оплачена/);
  });

  it('resumes on an earlier feed row: no second row, the same id to the bot', async () => {
    const { recorded, deliver } = harness({ fetch: CONFIRMED });
    const outcome = await deliver({ eventId: 'cmf0earliereventrow00001', deferrals: 1 });

    assert.equal(outcome.eventId, 'cmf0earliereventrow00001');
    assert.equal(recorded.feedRows.length, 0);
    assert.deepEqual(recorded.writtenIds, []);
    const metadata = recorded.fetchCalls[0].body['metadata'] as Record<string, unknown>;
    assert.equal(metadata['eventId'], 'cmf0earliereventrow00001');
  });

  for (const type of ['connect_help', 'connect_help_trial'] as const) {
    it(`a customer who switched «Помощь с подключением» off gets the feed row and nothing else (${type})`, async () => {
      const { recorded, deliver, queue } = harness({
        type,
        user: { ...LIVE_USER, notificationPrefs: { connect_help: false } },
      });
      const outcome = await deliver();

      assert.equal(outcome.outcome, 'opted_out');
      assert.deepEqual(outcome.attempts, []);
      assert.equal(recorded.feedRows.length, 1, 'the feed row must be written anyway');
      assert.equal(recorded.feedUpdates.length, 1, 'with its words');
      assert.equal(recorded.fetchCalls.length, 0);
      assert.equal(recorded.pushCalls.length, 0);
      assert.equal(queue.admitted.length, 0);
    });
  }

  it('sends nothing and writes nothing when the template is switched off', async () => {
    const { recorded, deliver } = harness({
      templates: { connect_help: { ...catalogue('connect_help'), isActive: false } },
    });
    const outcome = await deliver();

    assert.equal(outcome.outcome, 'skipped_template_off');
    assert.equal(outcome.eventId, null);
    assert.equal(recorded.feedRows.length, 0);
    assert.equal(recorded.fetchCalls.length, 0);
  });

  it('sends nothing when the template is missing', async () => {
    const { deliver } = harness({ templates: { connect_help: null } });
    assert.equal((await deliver()).outcome, 'skipped_template_off');
  });

  it('renders a trial with ITS template — never the paid text that says «оплачена»', async () => {
    const { recorded, deliver } = harness({ type: 'connect_help_trial', fetch: CONFIRMED });
    await deliver();

    // By the exact type: the alias map sends `connect_help_trial` to the paid
    // key, and a lookup through it would find the paid template first.
    assert.deepEqual(recorded.templateLookups, ['connect_help_trial']);
    const text = String((recorded.fetchCalls[0].body['metadata'] as Record<string, unknown>)['text']);
    assert.match(text, /уже работает/);
    assert.doesNotMatch(text, /оплачена/);
  });

  it('writes to an English-speaking customer in English', async () => {
    const { recorded, deliver } = harness({ user: { ...LIVE_USER, language: 'EN' }, fetch: CONFIRMED });
    await deliver();

    const metadata = recorded.fetchCalls[0].body['metadata'] as Record<string, unknown>;
    assert.match(String(metadata['text']), /Couldn't connect\?/);
    assert.deepEqual(
      (metadata['buttons'] as Array<Record<string, unknown>>).map((button) => button['text']),
      ['📲 Connect', '💬 Support'],
    );
  });
});
