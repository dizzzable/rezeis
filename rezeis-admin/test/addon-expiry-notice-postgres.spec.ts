import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import {
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
} from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  ADD_ON_NOTICE_COMMAND_KEY,
  ADD_ON_NOTICE_DELIVERED_KEY,
} from '../src/modules/add-on-entitlements/addon-expiry-notice.constants';
import {
  AddOnExpiryNoticeService,
  selectAddOnNoticeCandidates,
  selectUndeliveredAddOnNotices,
} from '../src/modules/add-on-entitlements/services/addon-expiry-notice.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * A DATED ADD-ON'S CUSTOMER NOTICES, AGAINST POSTGRESQL — three days before the
 * end and at it, once each, whatever happens.
 *
 * The selection is SQL and the "once" is a unique key on the add-on's event
 * log, written in the same transaction as the notice's feed row; the channels
 * are an outbox on the same log, sent again after a crash; the end a notice
 * names is the one the add-on has, not one the next alignment moves. All of it
 * is what this file proves, with the real `UserNotificationsService` behind the
 * sender and its channels — the bot's relay, web push, the letter — caught at
 * their edges, and the real tail alignment where an end moves.
 *
 * The pass reads the whole table, as the worker does, so this file's add-ons
 * live in 2090: whatever else the database holds, it is not due then.
 * Assertions are about this file's rows only.
 *
 * Runs only with TEST_DATABASE_URL; list it in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `p10notice-${process.pid}-${Date.now()}`;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const GIB = 1024n * 1024n * 1024n;
/** The pass's "now": far enough out that only this file's add-ons are due. */
const NOW = new Date('2090-03-10T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

let prisma: PrismaService;
const users: string[] = [];

interface Sent {
  readonly relayed: Array<{
    readonly text: string;
    readonly telegramId: string;
    readonly buttons: unknown;
    readonly eventId: string;
  }>;
  readonly pushes: Array<{ readonly title: string; readonly body: string; readonly url: string; readonly userId: string }>;
  readonly letters: Array<{ readonly to: string; readonly subject: string; readonly text: string; readonly locale?: string }>;
}

/** The real notification service; the channels are caught where they leave the panel. */
function notificationsCatching(sent: Sent): UserNotificationsService {
  const templates = {
    getByType: async (type: string) => {
      const template = DEFAULT_NOTIFICATION_TEMPLATES.find((entry) => entry.type === type);
      return template === undefined
        ? null
        : {
            id: `tpl-${type}`,
            type,
            title: template.title,
            body: template.body,
            titleEn: template.titleEn ?? null,
            bodyEn: template.bodyEn ?? null,
            buttons: template.buttons ?? [],
            bannerUrl: null,
            isActive: true,
          };
    },
  };
  return new UserNotificationsService(
    prisma,
    templates as never,
    { isEnabled: true, notifyUser: async () => undefined } as never,
    {
      resolveBrandName: async () => 'Winger VPN',
      sendToUser: async (payload: { title: string; body: string; url: string; userId: string }) => {
        sent.pushes.push(payload);
        return { attempted: 1, delivered: 1, failed: 0, disabled: false };
      },
    } as never,
    { substituteTelegramHtml: async (text: string) => text, substituteFallbacks: async (text: string) => text } as never,
    {
      enqueue: async (_event: string, job: { text: string; telegramId: string; buttons?: unknown; eventId: string }) => {
        sent.relayed.push({ text: job.text, telegramId: job.telegramId, buttons: job.buttons, eventId: job.eventId });
        return true;
      },
    } as never,
    undefined,
    undefined,
    {
      getSmtpSettings: async () => ({ enabled: true, notifyUsers: true }),
      send: async (letter: { to: string; subject: string; text: string; locale?: string }) => {
        sent.letters.push({ to: letter.to, subject: letter.subject, text: letter.text, locale: letter.locale });
      },
    } as never,
  );
}

/**
 * The sender, over the real notification service. `gate` is awaited where the
 * sender asks for the template — after it selected and read the add-on again,
 * right before its claim — which is where a test holds two runners together,
 * or moves the add-on under the pass. `wrap` stands in for the notification
 * service's own failures.
 */
function sender(
  sent: Sent,
  gate?: () => Promise<void>,
  active: boolean = true,
  wrap: (real: UserNotificationsService) => UserNotificationsService = (real) => real,
): AddOnExpiryNoticeService {
  return new AddOnExpiryNoticeService(
    prisma,
    {
      getByType: async (type: string) => {
        if (gate !== undefined) await gate();
        return DEFAULT_NOTIFICATION_TEMPLATES.some((entry) => entry.type === type) ? { isActive: active } : null;
      },
    } as never,
    wrap(notificationsCatching(sent)),
    { add: async () => undefined } as never,
  );
}

/**
 * The worker dying between a notice's commit and its channels: the feed row and
 * the decision are written, and nothing is sent — the `deliver` a pass awaits
 * after the commit fails as a killed process would never run it.
 */
function diesBeforeTheChannels(real: UserNotificationsService): UserNotificationsService {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'createInTransaction') {
        return async (...args: Parameters<UserNotificationsService['createInTransaction']>) => {
          const created = await target.createInTransaction(...args);
          return {
            eventId: created.eventId,
            deliver: () => Promise.reject(new Error('the worker died before the channels ran')),
          };
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** What reached this customer: the relays to their Telegram, the pushes to them, the letters to them. */
function reached(sent: Sent, customerId: string, telegramId: string): { relayed: number; pushes: number; letters: number } {
  return {
    relayed: sent.relayed.filter((job) => job.telegramId === telegramId).length,
    pushes: sent.pushes.filter((push) => push.userId === customerId).length,
    letters: sent.letters.filter((letter) => letter.to === `${customerId}@example.test`).length,
  };
}

/** Lets through only once `parties` callers have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const everyone = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await everyone;
  };
}

const nothingSent = (): Sent => ({ relayed: [], pushes: [], letters: [] });

interface CustomerFixture {
  readonly tag: string;
  readonly language?: 'RU' | 'EN';
  readonly email?: string | null;
}

let telegramIds = 900_000_000_000 + (process.pid % 1000) * 1000 + (Date.now() % 997);

/** A customer with a linked Telegram, and a verified address unless `email` is null. */
async function customer(fixture: CustomerFixture): Promise<string> {
  const id = `${prefix}-${fixture.tag}`;
  telegramIds += 1;
  await prisma.user.create({
    data: { id, referralCode: id, name: 'Вася', telegramId: BigInt(telegramIds), language: fixture.language ?? 'RU' },
  });
  users.push(id);
  const email = fixture.email === undefined ? `${id}@example.test` : fixture.email;
  if (email !== null) {
    await prisma.webAccount.create({ data: { userId: id, email, emailVerifiedAt: at(-30 * DAY_MS) } });
  }
  return id;
}

interface AddOnFixture {
  readonly type?: AddOnType;
  readonly state?: AddOnEntitlementState;
  /** When the add-on ends, from NOW. */
  readonly endsIn: number;
  /** When it was activated, from NOW; 20 days before NOW unless said. */
  readonly activatedIn?: number;
  readonly expiresAt?: 'none';
  /**
   * An add-on until the next traffic reset, bound to a reset epoch `cycle`
   * long: it ends half an hour after the epoch's reset — or, `capped`, a day
   * before the reset, with the subscription (stage 4's rule).
   */
  readonly reset?: { readonly cycle: number; readonly capped?: boolean };
}

/**
 * A subscription in the model — its term, and the add-ons given — for a
 * customer. Its own expiry is `subscriptionEndsIn` from NOW, and so is its
 * term's end unless `termEndsIn` says otherwise: a term the drift sweep has not
 * caught up with yet.
 */
async function subscriptionWith(
  userId: string,
  tag: string,
  addOns: readonly AddOnFixture[],
  options: {
    readonly subscriptionEndsIn?: number;
    readonly termEndsIn?: number;
    readonly status?: SubscriptionStatus;
  } = {},
): Promise<{ readonly subscriptionId: string; readonly addOnIds: string[] }> {
  const subscriptionId = `${prefix}-${tag}`;
  const expiresAt = at(options.subscriptionEndsIn ?? 20 * DAY_MS);
  const termEndsAt = options.termEndsIn === undefined ? expiresAt : at(options.termEndsIn);
  await prisma.subscription.create({
    data: {
      id: subscriptionId,
      userId,
      status: options.status ?? SubscriptionStatus.ACTIVE,
      planSnapshot: { name: 'Pro', trafficLimit: 100, deviceLimit: 3 },
      trafficLimit: 110,
      deviceLimit: 5,
      expiresAt,
    },
  });
  await prisma.subscriptionTerm.create({
    data: {
      id: `${subscriptionId}-term`,
      subscriptionId,
      generation: 1,
      status: SubscriptionTermStatus.ACTIVE,
      planSnapshot: {},
      startsAt: at(-30 * DAY_MS),
      endsAt: termEndsAt,
      baseTrafficLimitBytes: 100n * GIB,
      baseDeviceLimit: 3,
      trafficResetStrategy: 'NO_RESET',
    },
  });
  const payment = await prisma.transaction.create({
    data: {
      paymentId: `${subscriptionId}-pay`,
      userId,
      status: 'COMPLETED',
      purchaseType: 'ADDITIONAL',
      channel: 'WEB',
      gatewayType: 'YOOKASSA',
      currency: 'USD',
      amount: new Prisma.Decimal('1.00'),
      planSnapshot: {},
    },
  });
  const addOnIds: string[] = [];
  for (const [index, addOn] of addOns.entries()) {
    const id = `${subscriptionId}-addon-${index}`;
    const devices = (addOn.type ?? AddOnType.EXTRA_TRAFFIC) === AddOnType.EXTRA_DEVICES;
    const activatedAt = at(addOn.activatedIn ?? -20 * DAY_MS);
    let expiryEpochId: string | null = null;
    if (addOn.reset !== undefined) {
      // The reset the add-on ends with: its end minus the half-hour margin, or
      // a day past its end for one the subscription caps.
      const plannedEndsAt = at(addOn.endsIn - 30 * MINUTE_MS + (addOn.reset.capped === true ? DAY_MS : 0));
      expiryEpochId = `${id}-epoch`;
      await prisma.subscriptionResetEpoch.create({
        data: {
          id: expiryEpochId,
          termId: `${subscriptionId}-term`,
          ordinal: index + 1,
          startsAt: new Date(plannedEndsAt.getTime() - addOn.reset.cycle),
          plannedEndsAt,
        },
      });
    }
    await prisma.addOnEntitlement.create({
      data: {
        id,
        subscriptionId,
        termId: `${subscriptionId}-term`,
        sourceTransactionId: payment.id,
        sourceLineKey: `line-${index}`,
        catalogRevision: 1,
        receiptName: devices ? 'Больше устройств' : 'Доп. трафик',
        type: addOn.type ?? AddOnType.EXTRA_TRAFFIC,
        valuePerUnit: devices ? 2 : 10,
        totalValue: devices ? 2n : 10n * GIB,
        lifetime: addOn.reset === undefined ? AddOnLifetime.UNTIL_SUBSCRIPTION_END : AddOnLifetime.UNTIL_NEXT_RESET,
        expiryEpochId,
        unitAmount: new Prisma.Decimal('1.00'),
        totalAmount: new Prisma.Decimal('1.00'),
        currency: 'USD',
        purchasedAt: activatedAt,
        scheduledActivationAt: activatedAt,
        activatedAt,
        expiresAt: addOn.expiresAt === 'none' ? null : at(addOn.endsIn),
        state: addOn.state ?? AddOnEntitlementState.ACTIVE,
      },
    });
    addOnIds.push(id);
  }
  return { subscriptionId, addOnIds };
}

async function noticesOf(userId: string) {
  return prisma.userNotificationEvent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
}

/** The decisions recorded for an add-on's notices (not the records that their channels ran). */
async function recordsOf(entitlementId: string) {
  return prisma.addOnEntitlementEvent.findMany({
    where: { entitlementId, commandKey: { in: Object.values(ADD_ON_NOTICE_COMMAND_KEY) } },
  });
}

/** The records that a notice's channels ran — the outbox's other half. */
async function deliveredOf(entitlementId: string) {
  return prisma.addOnEntitlementEvent.findMany({
    where: { entitlementId, commandKey: { in: Object.values(ADD_ON_NOTICE_DELIVERED_KEY) } },
  });
}

async function telegramOf(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { telegramId: true } });
  return String(user.telegramId);
}

/** What the next tail alignment does — the drift sweep's step for one subscription. */
async function align(subscriptionId: string): Promise<void> {
  await prisma.$transaction((tx) => new SubscriptionTermService().alignTailToExpiryInTransaction(tx, subscriptionId));
}

const afterNow = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

const FLAGS = ['ADDON_ENTITLEMENT_DIRECT_PURCHASE', 'ADDON_DEVICE_CLEANUP_AUTO'] as const;
const savedFlags: Record<string, string | undefined> = {};

run('the customer’s notices before and at a dated add-on’s end — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.webAccount.deleteMany({ where: { userId: { in: users } } });
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    for (const key of FLAGS) savedFlags[key] = process.env[key];
    process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = 'true';
    // Stage 6 explicitly OFF unless a case turns it on: unset is ON since the
    // 24.09.2026 flip.
    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'false';
  });

  afterEach(() => {
    for (const key of FLAGS) {
      if (savedFlags[key] === undefined) delete process.env[key];
      else process.env[key] = savedFlags[key];
    }
  });

  it('tells the customer once, three days out — bot, push and letter — and a second pass and a restart tell nothing', async () => {
    const userId = await customer({ tag: 'once' });
    const { subscriptionId, addOnIds } = await subscriptionWith(userId, 'once-sub', [{ endsIn: 2 * DAY_MS }]);

    const sent = nothingSent();
    const report = await sender(sent).runTick(NOW);
    assert.ok(report.sent >= 1);

    const notices = await noticesOf(userId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.type, 'addon_ends_in_3_days');
    const payload = notices[0]!.payload as Record<string, unknown>;
    assert.equal(payload['subscriptionId'], subscriptionId);
    assert.equal(payload['title'], '⏳ Дополнительный трафик заканчивается через 3 дня');
    assert.equal(payload['text'], [
      'Опция «Доп. трафик» (+10 ГБ) к подписке «Pro» действует до 12 марта, 12:00. ',
      'После этого лимит трафика станет меньше на 10 ГБ.\n\n',
      'Продление подписки опцию не продлевает: когда она закончится, её можно купить снова.',
    ].join(''));

    const mine = (list: Sent['relayed']) => list.filter((job) => job.text.includes('Доп. трафик'));
    assert.equal(mine(sent.relayed).length, 1);
    assert.deepEqual(
      (mine(sent.relayed)[0]!.buttons as Array<{ text: string; webAppPath?: string }>).map((b) => b.webAppPath ?? null),
      [`/addons?subscriptionId=${subscriptionId}`, null],
    );
    assert.ok(sent.pushes.some((push) => push.url === `/addons?subscriptionId=${subscriptionId}`));
    assert.ok(sent.letters.some((letter) => letter.to === `${userId}@example.test`));

    const records = await recordsOf(addOnIds[0]!);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.commandKey, ADD_ON_NOTICE_COMMAND_KEY.endsSoon);
    assert.equal((records[0]!.metadata as Record<string, unknown>)['notificationEventId'], notices[0]!.id);
    const delivered = await deliveredOf(addOnIds[0]!);
    assert.equal(delivered.length, 1, 'its channels ran, and that is recorded');
    assert.equal((delivered[0]!.metadata as Record<string, unknown>)['attempt'], 'first');

    // The next pass, then a restart — a new sender over the same database.
    const again = nothingSent();
    await sender(again).runTick(NOW);
    await sender(again).runTick(new Date(NOW.getTime() + HOUR_MS));
    assert.equal((await noticesOf(userId)).length, 1);
    assert.equal(mine(again.relayed).length, 0);
    assert.equal((await recordsOf(addOnIds[0]!)).length, 1);
  });

  it('tells a customer who has no address by the bot and push, and sends no letter', async () => {
    const userId = await customer({ tag: 'no-email', email: null });
    await subscriptionWith(userId, 'no-email-sub', [{ endsIn: 2 * DAY_MS }]);

    const sent = nothingSent();
    await sender(sent).runTick(NOW);

    assert.equal((await noticesOf(userId)).length, 1);
    assert.equal(sent.relayed.filter((job) => job.text.includes('Доп. трафик')).length >= 1, true);
    assert.equal(sent.letters.some((letter) => letter.to.startsWith(userId)), false);
  });

  it('writes to an English customer in English', async () => {
    const userId = await customer({ tag: 'english', language: 'EN' });
    await subscriptionWith(userId, 'english-sub', [{ type: AddOnType.EXTRA_DEVICES, endsIn: 2 * DAY_MS }]);

    const sent = nothingSent();
    await sender(sent).runTick(NOW);

    const [notice] = await noticesOf(userId);
    const payload = notice!.payload as Record<string, unknown>;
    assert.equal(payload['title'], '⏳ Extra devices end in 3 days');
    assert.match(String(payload['text']), /The add-on “Больше устройств” \(\+2 devices\) to your “Pro” subscription runs until 12 March, 12:00\./);
    assert.match(String(payload['text']), /new devices over the limit will not connect/);
    // The letter too, and its branded layout says it is English.
    const letter = sent.letters.find((entry) => entry.to === `${userId}@example.test`);
    assert.equal(letter?.subject, '⏳ Extra devices end in 3 days');
    assert.equal(letter?.locale, 'en');
  });

  it('says what happens to the devices by stage 6: new ones refused while it is off, the extra ones disconnected while it is on', async () => {
    const off = await customer({ tag: 'devices-off' });
    await subscriptionWith(off, 'devices-off-sub', [{ type: AddOnType.EXTRA_DEVICES, endsIn: 2 * DAY_MS }]);
    await sender(nothingSent()).runTick(NOW);
    const [manual] = await noticesOf(off);
    assert.equal(manual!.type, 'addon_devices_ends_in_3_days');
    assert.match(String((manual!.payload as Record<string, unknown>)['text']), /\(\+2 устройства\)/);
    assert.match(String((manual!.payload as Record<string, unknown>)['text']), /новые устройства сверх лимита подключить не получится/);

    process.env.ADDON_DEVICE_CLEANUP_AUTO = 'true';
    const on = await customer({ tag: 'devices-on' });
    await subscriptionWith(on, 'devices-on-sub', [{ type: AddOnType.EXTRA_DEVICES, endsIn: 2 * DAY_MS }]);
    await sender(nothingSent()).runTick(NOW);
    const [auto] = await noticesOf(on);
    assert.equal(auto!.type, 'addon_devices_auto_ends_in_3_days');
    const text = String((auto!.payload as Record<string, unknown>)['text']);
    assert.match(text, /лишние устройства отключатся сами — сначала самые новые/);
    assert.match(text, /«Подписка» → «Управление устройствами»/);
  });

  it('tells nothing of an add-on that never ends — one bought before the model, or one without an end', async () => {
    const userId = await customer({ tag: 'legacy' });
    // A legacy add-on is in the limit columns only (110 GB over a 100 GB plan):
    // no entitlement row. And one row with no end at all.
    await subscriptionWith(userId, 'legacy-sub', [{ endsIn: 2 * DAY_MS, expiresAt: 'none' }], {
      subscriptionEndsIn: 2 * DAY_MS,
    });

    await sender(nothingSent()).runTick(NOW);
    assert.deepEqual(await noticesOf(userId), []);
  });

  it('does not tell «three days out» of an add-on bought inside those three days', async () => {
    const userId = await customer({ tag: 'fresh' });
    const { addOnIds } = await subscriptionWith(userId, 'fresh-sub', [{ endsIn: 2 * DAY_MS, activatedIn: -HOUR_MS }]);

    await sender(nothingSent()).runTick(NOW);
    assert.deepEqual(await noticesOf(userId), []);
    assert.deepEqual(await recordsOf(addOnIds[0]!), []);
  });

  it('tells that it has ended while the subscription goes on, and records — without a notice — one that ended with its subscription', async () => {
    const goesOn = await customer({ tag: 'ended-live' });
    const live = await subscriptionWith(goesOn, 'ended-live-sub', [
      { state: AddOnEntitlementState.EXPIRED, endsIn: -HOUR_MS },
    ]);
    const ends = await customer({ tag: 'ended-too' });
    const both = await subscriptionWith(
      ends,
      'ended-too-sub',
      [{ state: AddOnEntitlementState.EXPIRED, endsIn: -HOUR_MS }],
      { subscriptionEndsIn: -HOUR_MS, status: SubscriptionStatus.EXPIRED },
    );
    // An add-on bought to the end of the term ends with it, and the pass can
    // come before the subscription's own sweep marks it expired: its end, not
    // its status, says it is over.
    const unswept = await customer({ tag: 'ended-unswept' });
    const same = await subscriptionWith(
      unswept,
      'ended-unswept-sub',
      [{ state: AddOnEntitlementState.EXPIRED, endsIn: -HOUR_MS }],
      { subscriptionEndsIn: -HOUR_MS },
    );

    const sent = nothingSent();
    await sender(sent).runTick(NOW);

    const [ended] = await noticesOf(goesOn);
    assert.equal(ended!.type, 'addon_ended');
    assert.match(String((ended!.payload as Record<string, unknown>)['text']), /закончилась 10 марта, 11:00/);
    assert.equal((await recordsOf(live.addOnIds[0]!)).length, 1);

    assert.deepEqual(await noticesOf(ends), []);
    const [record] = await recordsOf(both.addOnIds[0]!);
    assert.equal((record!.metadata as Record<string, unknown>)['outcome'], 'subscription_ended');

    assert.deepEqual(await noticesOf(unswept), []);
    const [unsweptRecord] = await recordsOf(same.addOnIds[0]!);
    assert.equal((unsweptRecord!.metadata as Record<string, unknown>)['outcome'], 'subscription_ended');

    await sender(nothingSent()).runTick(NOW);
    assert.equal((await noticesOf(goesOn)).length, 1);
  });

  it('tells traffic that ends with the traffic reset in the reset’s words on a monthly reset, and nothing on a daily or weekly one', async () => {
    const WEEK_MS = 7 * DAY_MS;
    const monthly = await customer({ tag: 'reset-month' });
    const month = await subscriptionWith(monthly, 'reset-month-sub', [{ endsIn: 2 * DAY_MS, reset: { cycle: 30 * DAY_MS } }]);
    const monthlyEnded = await customer({ tag: 'reset-month-ended' });
    const monthEnded = await subscriptionWith(monthlyEnded, 'reset-month-ended-sub', [
      { endsIn: -HOUR_MS, state: AddOnEntitlementState.EXPIRED, reset: { cycle: 31 * DAY_MS } },
    ]);
    // Bought five days before a weekly reset — outside the three days — and a
    // daily one that has just ended: told nothing, and nothing recorded.
    const weekly = await customer({ tag: 'reset-week' });
    const week = await subscriptionWith(weekly, 'reset-week-sub', [
      { endsIn: 2 * DAY_MS, activatedIn: -5 * DAY_MS, reset: { cycle: WEEK_MS } },
    ]);
    const daily = await customer({ tag: 'reset-day' });
    const day = await subscriptionWith(daily, 'reset-day-sub', [
      { endsIn: -HOUR_MS, state: AddOnEntitlementState.EXPIRED, reset: { cycle: DAY_MS } },
    ]);
    // A weekly add-on the subscription's earlier end caps ends with the
    // subscription: the ordinary words, renewal sentence and all.
    const capped = await customer({ tag: 'reset-capped' });
    const cap = await subscriptionWith(capped, 'reset-capped-sub', [
      { endsIn: 2 * DAY_MS, activatedIn: -4 * DAY_MS, reset: { cycle: WEEK_MS, capped: true } },
    ]);

    // The selections — SQL — agree with the decision: the quiet ones are not
    // even selected, so they never come back to fill a pass.
    const soon = await selectAddOnNoticeCandidates(prisma, 'endsSoon', NOW, 10_000);
    const ended = await selectAddOnNoticeCandidates(prisma, 'ended', NOW, 10_000);
    assert.ok(soon.includes(month.addOnIds[0]!));
    assert.ok(soon.includes(cap.addOnIds[0]!));
    assert.ok(ended.includes(monthEnded.addOnIds[0]!));
    assert.equal(soon.includes(week.addOnIds[0]!), false, 'a weekly reset add-on was selected');
    assert.equal(ended.includes(day.addOnIds[0]!), false, 'a daily reset add-on was selected');

    await sender(nothingSent()).runTick(NOW);

    const [soonNotice] = await noticesOf(monthly);
    assert.equal(soonNotice!.type, 'addon_reset_ends_in_3_days');
    const soonPayload = soonNotice!.payload as Record<string, unknown>;
    // The reset itself (11:30 UTC), not the take-off half an hour later.
    assert.equal(soonPayload['addonResetAt'], '2090-03-12T11:30:00.000Z');
    assert.equal(
      soonPayload['text'],
      'Опция «Доп. трафик» (+10 ГБ) к подписке «Pro» действует до сброса трафика 12 марта в 11:30 по UTC; ' +
        'после сброса лимит вернётся к тарифу.',
    );

    const [endedNotice] = await noticesOf(monthlyEnded);
    assert.equal(endedNotice!.type, 'addon_reset_ended');
    assert.match(
      String((endedNotice!.payload as Record<string, unknown>)['text']),
      /закончилась со сбросом трафика 10 марта в 10:30 по UTC: лимит вернулся к тарифу\.\n\nЕё можно купить снова\./,
    );

    assert.deepEqual(await noticesOf(weekly), []);
    assert.deepEqual(await recordsOf(week.addOnIds[0]!), []);
    assert.deepEqual(await noticesOf(daily), []);
    assert.deepEqual(await recordsOf(day.addOnIds[0]!), []);

    const [cappedNotice] = await noticesOf(capped);
    assert.equal(cappedNotice!.type, 'addon_ends_in_3_days');
    assert.equal((cappedNotice!.payload as Record<string, unknown>)['addonResetAt'], undefined);
    assert.match(String((cappedNotice!.payload as Record<string, unknown>)['text']), /Продление подписки опцию не продлевает/);
  });

  it('selects only what is due, so a row that will never be due does not come back every pass and fill it', async () => {
    const userId = await customer({ tag: 'select' });
    const { addOnIds: soon } = await subscriptionWith(userId, 'select-soon', [
      { endsIn: 2 * DAY_MS }, // due
      { endsIn: 2 * DAY_MS, activatedIn: -HOUR_MS }, // bought inside the three days
      { endsIn: 4 * DAY_MS }, // not yet
      { endsIn: 2 * DAY_MS, state: AddOnEntitlementState.EXPIRED }, // not ACTIVE
    ]);
    const { addOnIds: disabled } = await subscriptionWith(userId, 'select-disabled', [{ endsIn: 2 * DAY_MS }], {
      status: SubscriptionStatus.DISABLED,
    });
    const { addOnIds: ended } = await subscriptionWith(userId, 'select-ended', [
      { endsIn: -HOUR_MS, state: AddOnEntitlementState.EXPIRED }, // due
      { endsIn: -HOUR_MS, state: AddOnEntitlementState.EXPIRING }, // due: a device reduction under way
      { endsIn: -4 * DAY_MS, state: AddOnEntitlementState.EXPIRED }, // too long ago
      { endsIn: -HOUR_MS, state: AddOnEntitlementState.REVERSED }, // taken back, not ended
    ]);
    const mine = new Set([...soon, ...disabled, ...ended]);
    const selected = async (moment: 'endsSoon' | 'ended') =>
      (await selectAddOnNoticeCandidates(prisma, moment, NOW, 10_000)).filter((id) => mine.has(id));

    assert.deepEqual(await selected('endsSoon'), [soon[0]]);
    assert.deepEqual((await selected('ended')).sort(), [ended[0], ended[1]].sort());

    // Decided: out of the selection for good.
    await sender(nothingSent()).runTick(NOW);
    assert.deepEqual(await selected('endsSoon'), []);
    assert.deepEqual(await selected('ended'), []);
  });

  it('sends one notice when two runners take the same add-on at once — the other’s feed row rolls back', async () => {
    const userId = await customer({ tag: 'race' });
    const { addOnIds } = await subscriptionWith(userId, 'race-sub', [{ endsIn: 2 * DAY_MS }]);

    const first = nothingSent();
    const second = nothingSent();
    // Both have selected the add-on and read it again before either claims it.
    const together = barrier(2);
    const [a, b] = await Promise.all([
      sender(first, together).runTick(NOW),
      sender(second, together).runTick(NOW),
    ]);

    assert.equal((await noticesOf(userId)).length, 1);
    assert.equal((await recordsOf(addOnIds[0]!)).length, 1);
    const relayed = [...first.relayed, ...second.relayed].filter((job) => job.text.includes('Доп. трафик'));
    assert.equal(relayed.length, 1);
    assert.equal(a.lost + b.lost, 1);
  });

  it('waits while the template is switched off, and sends once it is on again', async () => {
    const userId = await customer({ tag: 'template-off' });
    const { addOnIds } = await subscriptionWith(userId, 'template-off-sub', [{ endsIn: 2 * DAY_MS }]);

    const off = await sender(nothingSent(), undefined, false).runTick(NOW);
    assert.ok(off.templateOff >= 1);
    assert.deepEqual(await noticesOf(userId), []);
    assert.deepEqual(await recordsOf(addOnIds[0]!), [], 'decided while the template was off');

    await sender(nothingSent()).runTick(NOW);
    assert.equal((await noticesOf(userId)).length, 1);
  });

  it('tells the customer of a dated add-on with stage 2 off — the notices follow the row, not the flag', async () => {
    // Sold while stage 2 was on, and stage 2 turned off since: the boundary
    // sweep still ends it (it reads no flag), so its customer is still told —
    // three days out and at the end.
    const userId = await customer({ tag: 'model-off' });
    const { addOnIds } = await subscriptionWith(userId, 'model-off-sub', [
      { endsIn: 2 * DAY_MS },
      { endsIn: -HOUR_MS, state: AddOnEntitlementState.EXPIRED },
    ]);

    process.env.ADDON_ENTITLEMENT_DIRECT_PURCHASE = 'false';
    const report = await sender(nothingSent()).runTick(NOW);

    assert.ok(report.sent >= 2);
    assert.deepEqual((await noticesOf(userId)).map((notice) => notice.type).sort(), [
      'addon_ended',
      'addon_ends_in_3_days',
    ]);
    for (const addOnId of addOnIds) {
      const [record] = await recordsOf(addOnId);
      assert.equal((record!.metadata as Record<string, unknown>)['outcome'], 'sent');
    }
  });

  // ── The end it names ────────────────────────────────────────────────────

  it('waits for the drift sweep before telling «three days out» of an end about to move — then names the end it moved to', async () => {
    // Bonus days moved the subscription's expiry; the hourly drift sweep has
    // not caught the term up. The add-on ended with its term, so it moves too.
    const userId = await customer({ tag: 'drift-within' });
    const { subscriptionId, addOnIds } = await subscriptionWith(userId, 'drift-within-sub', [{ endsIn: DAY_MS }], {
      subscriptionEndsIn: 2 * DAY_MS + 12 * HOUR_MS,
      termEndsIn: DAY_MS,
    });
    const selected = async () =>
      (await selectAddOnNoticeCandidates(prisma, 'endsSoon', NOW, 10_000)).filter((id) => id === addOnIds[0]);

    assert.deepEqual(await selected(), [], 'not due while its end is about to move');
    await sender(nothingSent()).runTick(NOW);
    assert.deepEqual(await noticesOf(userId), []);
    assert.deepEqual(await recordsOf(addOnIds[0]!), [], 'not decided: it is looked at again');

    await align(subscriptionId);
    assert.deepEqual(await selected(), [addOnIds[0]]);
    await sender(nothingSent()).runTick(NOW);
    const [notice] = await noticesOf(userId);
    assert.match(String((notice!.payload as Record<string, unknown>)['text']), /действует до 13 марта, 00:00/);
  });

  it('says nothing now of an end the drift sweep moves beyond three days — and names the new end when it is three days out', async () => {
    const userId = await customer({ tag: 'drift-beyond' });
    const { subscriptionId } = await subscriptionWith(userId, 'drift-beyond-sub', [{ endsIn: 2 * DAY_MS }], {
      subscriptionEndsIn: 9 * DAY_MS,
      termEndsIn: 2 * DAY_MS,
    });

    await sender(nothingSent()).runTick(NOW);
    assert.deepEqual(await noticesOf(userId), [], 'not the end it had');
    await align(subscriptionId);
    await sender(nothingSent()).runTick(NOW);
    assert.deepEqual(await noticesOf(userId), [], 'its end is nine days out now');

    await sender(nothingSent()).runTick(afterNow(6 * DAY_MS + HOUR_MS));
    const [notice] = await noticesOf(userId);
    assert.match(String((notice!.payload as Record<string, unknown>)['text']), /действует до 19 марта, 12:00/);
  });

  it('tells «three days out» of an add-on with its own earlier end while its term drifts — the alignment leaves that end', async () => {
    const userId = await customer({ tag: 'drift-own' });
    const { subscriptionId, addOnIds } = await subscriptionWith(userId, 'drift-own-sub', [{ endsIn: DAY_MS }], {
      subscriptionEndsIn: 9 * DAY_MS,
      termEndsIn: 2 * DAY_MS,
    });

    await sender(nothingSent()).runTick(NOW);
    assert.equal((await noticesOf(userId)).length, 1);
    await align(subscriptionId);
    const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnIds[0]! } });
    assert.equal(addOn.expiresAt?.getTime(), at(DAY_MS).getTime(), 'and the real alignment did leave it');
  });

  it('does not name an end that moved while the pass was deciding — the claim rolls back, and the new end is told when due', async () => {
    const userId = await customer({ tag: 'moved-under' });
    const { addOnIds } = await subscriptionWith(userId, 'moved-under-sub', [{ endsIn: 2 * DAY_MS }]);
    let moved = false;
    // What an alignment or the operator does to the row between the pass's
    // read and its claim: a new end, and a new version.
    const moveIt = async (): Promise<void> => {
      if (moved) return;
      moved = true;
      await prisma.addOnEntitlement.update({
        where: { id: addOnIds[0]! },
        data: { expiresAt: at(5 * DAY_MS), version: { increment: 1 } },
      });
    };

    const report = await sender(nothingSent(), moveIt).runTick(NOW);
    assert.ok(report.moved >= 1);
    assert.deepEqual(await noticesOf(userId), [], 'no notice names the old end');
    assert.deepEqual(await recordsOf(addOnIds[0]!), [], 'not decided: a later pass looks at the new end');

    await sender(nothingSent()).runTick(afterNow(2 * DAY_MS + HOUR_MS));
    const [notice] = await noticesOf(userId);
    assert.match(String((notice!.payload as Record<string, unknown>)['text']), /действует до 15 марта, 12:00/);
  });

  it('does not name an end the next alignment moves when bonus days land while the pass is deciding', async () => {
    // The add-on ends with its term and its subscription; bonus days move the
    // subscription between the pass's read and its claim.
    const userId = await customer({ tag: 'bonus-under' });
    const { subscriptionId, addOnIds } = await subscriptionWith(userId, 'bonus-under-sub', [{ endsIn: 2 * DAY_MS }], {
      subscriptionEndsIn: 2 * DAY_MS,
    });
    let given = false;
    const bonusDays = async (): Promise<void> => {
      if (given) return;
      given = true;
      await prisma.subscription.update({ where: { id: subscriptionId }, data: { expiresAt: at(9 * DAY_MS) } });
    };

    const report = await sender(nothingSent(), bonusDays).runTick(NOW);
    assert.ok(report.moved >= 1);
    assert.deepEqual(await noticesOf(userId), []);
    assert.deepEqual(await recordsOf(addOnIds[0]!), []);

    await align(subscriptionId);
    const addOn = await prisma.addOnEntitlement.findUniqueOrThrow({ where: { id: addOnIds[0]! } });
    assert.equal(addOn.expiresAt?.getTime(), at(9 * DAY_MS).getTime(), 'the real alignment moved it, as the check said');
  });

  // ── The channels, at least once ────────────────────────────────────────

  it('sends a notice’s channels again after the worker died between its commit and its channels — once, on the same feed row', async () => {
    const userId = await customer({ tag: 'crash' });
    const telegramId = await telegramOf(userId);
    const { addOnIds } = await subscriptionWith(userId, 'crash-sub', [{ endsIn: 2 * DAY_MS }]);
    const nothing = { relayed: 0, pushes: 0, letters: 0 };

    const lost = nothingSent();
    const died = await sender(lost, undefined, true, diesBeforeTheChannels).runTick(NOW);
    assert.ok(died.sent >= 1 && died.errors >= 1);
    const [notice] = await noticesOf(userId);
    assert.ok(notice !== undefined, 'the feed row is written with the decision');
    assert.deepEqual(reached(lost, userId, telegramId), nothing);
    assert.equal((await recordsOf(addOnIds[0]!)).length, 1);
    assert.deepEqual(await deliveredOf(addOnIds[0]!), [], 'nothing says its channels ran');

    const pending = async (when: Date) =>
      (await selectUndeliveredAddOnNotices(prisma, 'endsSoon', when, 10_000))
        .filter((row) => row.entitlementId === addOnIds[0])
        .map((row) => row.notificationEventId);
    assert.deepEqual(await pending(afterNow(5 * MINUTE_MS)), [], 'decided too recently: a pass may still be delivering it');
    assert.deepEqual(await pending(afterNow(3 * DAY_MS)), [], 'its end has passed: not sent late');
    assert.deepEqual(await pending(afterNow(20 * MINUTE_MS)), [notice.id]);

    // A restart before the wait is over sends nothing.
    const early = nothingSent();
    await sender(early).runTick(afterNow(5 * MINUTE_MS));
    assert.deepEqual(reached(early, userId, telegramId), nothing);

    // After it: once, on the feed row the decision wrote.
    const again = nothingSent();
    const resent = await sender(again).runTick(afterNow(20 * MINUTE_MS));
    assert.ok(resent.resent >= 1);
    assert.deepEqual(reached(again, userId, telegramId), { relayed: 1, pushes: 1, letters: 1 });
    assert.equal(again.relayed.find((job) => job.telegramId === telegramId)?.eventId, notice.id);
    assert.equal((await noticesOf(userId)).length, 1, 'no second feed row');
    const [delivered] = await deliveredOf(addOnIds[0]!);
    assert.equal((delivered!.metadata as Record<string, unknown>)['attempt'], 'again');

    // And never a third time, across another restart.
    const afterwards = nothingSent();
    await sender(afterwards).runTick(afterNow(HOUR_MS));
    assert.deepEqual(reached(afterwards, userId, telegramId), nothing);
    assert.equal((await recordsOf(addOnIds[0]!)).length, 1);
  });

  it('records a notice whose feed row is gone instead of looking for it every pass', async () => {
    const userId = await customer({ tag: 'row-gone' });
    const telegramId = await telegramOf(userId);
    const { addOnIds } = await subscriptionWith(userId, 'row-gone-sub', [{ endsIn: 2 * DAY_MS }]);
    await sender(nothingSent(), undefined, true, diesBeforeTheChannels).runTick(NOW);
    await prisma.userNotificationEvent.deleteMany({ where: { userId } });

    const again = nothingSent();
    await sender(again).runTick(afterNow(20 * MINUTE_MS));
    assert.deepEqual(reached(again, userId, telegramId), { relayed: 0, pushes: 0, letters: 0 });
    const [delivered] = await deliveredOf(addOnIds[0]!);
    assert.equal((delivered!.metadata as Record<string, unknown>)['attempt'], 'row_gone');
    assert.deepEqual(
      (await selectUndeliveredAddOnNotices(prisma, 'endsSoon', afterNow(30 * MINUTE_MS), 10_000)).filter(
        (row) => row.entitlementId === addOnIds[0],
      ),
      [],
    );
  });
});
