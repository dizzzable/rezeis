import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { ConnectAudienceService } from '../src/modules/connect-audience/services/connect-audience.service';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';
import { HintAudienceService } from '../src/modules/user-hints/services/hint-audience.service';
import { UserHintDeliveryService } from '../src/modules/user-hints/services/user-hint-delivery.service';

/**
 * THE HINT QUEUE, against a real PostgreSQL.
 *
 * Every other spec of the queue runs on a fake Prisma, and the queue is nothing
 * but queries: a `count` that decides "once", an `updateMany` that decides what
 * a repeated test run lapses, two more that decide supersession, and a
 * `findFirst` that decides what the customer is handed. A fake obeys the terms
 * it was written to understand — the unit spec's own fake read `dismissedAt`
 * as `actedAt` too until this change, so a statement missing one of them looked
 * correct — and only an engine says what those `where`s mean. So each case puts
 * the rows that must be left alone beside the rows that must change, and reads
 * every one of them back.
 *
 * A closed delivery is created with `shownAt` NULL wherever the case is about
 * `dismissedAt` or `actedAt`: the cabinet stamps "shown" fire-and-forget, so
 * that row is real, and it is the only one that tells the three terms apart.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it. Every row belongs to a user or a hint this run created under its
 * own prefix, and all of them are removed in `after`.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `uhd-${process.pid}-${Date.now()}`;
const HOUR_MS = 60 * 60 * 1000;
/**
 * How long a racing raise waits after each of its queue statements. Two raises
 * started together then read the queue inside each other's window by
 * construction rather than by luck, and a missing lock cannot pass by
 * scheduling — the same idea as the hold in `settings-row-lock-postgres.spec.ts`.
 */
const PAUSE_MS = 150;

let prisma: PrismaService;
let service: UserHintDeliveryService;
/** The same service, over a client whose transactions pause after every queue statement. */
let racing: UserHintDeliveryService;
/**
 * Pauses the racing client has actually taken. Each race asserts it grew, so a
 * wrapper that stopped intercepting — and with it the forced overlap — fails
 * loudly instead of letting a missing lock pass on a lucky schedule.
 */
let pausesTaken = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Functions come back bound to the real object, so a proxy never stands in as `this`. */
function passThrough<T extends object>(target: T, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property);
  return typeof value === 'function' ? value.bind(target) : value;
}

/** A transaction client whose `userHintDelivery` statements each wait `PAUSE_MS` after they return. */
function pausingQueueStatements(tx: Prisma.TransactionClient): Prisma.TransactionClient {
  const deliveries = new Proxy(tx.userHintDelivery, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result: unknown = await value.apply(target, args);
        pausesTaken += 1;
        await sleep(PAUSE_MS);
        return result;
      };
    },
  });
  return new Proxy(tx, {
    get: (target, property) => (property === 'userHintDelivery' ? deliveries : passThrough(target, property)),
  });
}

/**
 * The real client, except that the callback of every interactive transaction
 * receives a pausing transaction client. The lock, the queries and the
 * transaction boundaries are all PostgreSQL's own.
 */
function withPausingTransactions(client: PrismaService): PrismaService {
  return new Proxy(client, {
    get(target, property) {
      if (property !== '$transaction') return passThrough(target, property);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: never) =>
        target.$transaction((tx) => work(pausingQueueStatements(tx)), options);
    },
  });
}

const created = {
  users: [] as string[],
  hints: [] as string[],
};

let counter = 0;
const next = (): number => ++counter;

/** The audience of a cabinet that says nothing about itself: any surface, MODAL. */
const SILENT_CABINET = { surface: null, formFactor: null, modes: null };

async function createUser(label: string): Promise<string> {
  const id = `${prefix}-user-${label}-${next()}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: label } });
  created.users.push(id);
  return id;
}

async function createHint(
  label: string,
  data: Partial<Prisma.UserHintUncheckedCreateInput> = {},
): Promise<{ readonly id: string; readonly key: string }> {
  const hint = await prisma.userHint.create({
    data: {
      key: `${prefix}-${label}-${next()}`,
      titleRu: `Заголовок: ${label}`,
      bodyRu: `Текст: ${label}`,
      ttlHours: 48,
      ...data,
    },
    select: { id: true, key: true },
  });
  created.hints.push(hint.id);
  return hint;
}

interface DeliveryFixture {
  readonly expiresAt: Date;
  readonly shownAt?: Date;
  readonly dismissedAt?: Date;
  readonly actedAt?: Date;
}

async function createDelivery(userId: string, hintId: string, fixture: DeliveryFixture): Promise<string> {
  const row = await prisma.userHintDelivery.create({
    data: { userId, hintId, source: `${prefix}-fixture`, ...fixture },
    select: { id: true },
  });
  return row.id;
}

interface DeliveryState {
  readonly userId: string;
  readonly hintId: string;
  readonly expiresAt: Date;
  readonly shownAt: Date | null;
  readonly dismissedAt: Date | null;
  readonly actedAt: Date | null;
}

/** The rows as the table holds them now, by id. The queue deletes nothing, so every one must still be there. */
async function statesOf(ids: readonly string[]): Promise<Map<string, DeliveryState>> {
  const rows = await prisma.userHintDelivery.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      userId: true,
      hintId: true,
      expiresAt: true,
      shownAt: true,
      dismissedAt: true,
      actedAt: true,
    },
  });
  assert.equal(rows.length, ids.length, 'a delivery row disappeared');
  return new Map(rows.map(({ id, ...state }) => [id, state]));
}

/**
 * Every delivery `nextFor` hands this customer, closing each one as the cabinet
 * does, until it has nothing left to hand out.
 */
async function handedOut(userId: string, now: Date): Promise<string[]> {
  const handed: string[] = [];
  for (let round = 0; round < 20; round += 1) {
    const hint = await service.nextFor({ userId, locale: 'ru', audience: SILENT_CABINET, now });
    if (hint === null) return handed;
    handed.push(hint.deliveryId);
    await service.close(hint.deliveryId, userId, 'dismissed');
  }
  assert.fail(`nextFor kept handing out deliveries after ${handed.length}: a closed one came back`);
}

run('the hint queue on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    service = new UserHintDeliveryService(prisma);
    racing = new UserHintDeliveryService(withPausingTransactions(prisma));
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.userHintDelivery.deleteMany({
      where: { OR: [{ userId: { in: created.users } }, { hintId: { in: created.hints } }] },
    });
    await prisma.userHint.deleteMany({ where: { id: { in: created.hints } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await prisma.$disconnect();
  });

  it('answers queued, and the row it names is the row in the table', async () => {
    const user = await createUser('queued');
    const hint = await createHint('queued', { ttlHours: 36 });
    const now = new Date();

    const outcome = await service.raiseWithOutcome({
      userId: user,
      hintKey: hint.key,
      source: `${prefix}-rule`,
      now,
    });

    assert.ok(outcome.kind === 'queued', `answered ${outcome.kind}`);
    const rows = await prisma.userHintDelivery.findMany({
      where: { userId: user },
      select: {
        id: true,
        hintId: true,
        source: true,
        expiresAt: true,
        shownAt: true,
        dismissedAt: true,
        actedAt: true,
      },
    });
    assert.deepEqual(rows, [
      {
        id: outcome.delivery.id,
        hintId: hint.id,
        source: `${prefix}-rule`,
        expiresAt: new Date(now.getTime() + 36 * HOUR_MS),
        shownAt: null,
        dismissedAt: null,
        actedAt: null,
      },
    ]);
  });

  it('answers hint_missing and hint_inactive, and writes nothing for either', async () => {
    const user = await createUser('refused');
    const switchedOff = await createHint('switched-off', { isActive: false });

    assert.deepEqual(
      await service.raiseWithOutcome({ userId: user, hintKey: `${prefix}-never-authored`, source: 's' }),
      { kind: 'hint_missing' },
    );
    assert.deepEqual(
      await service.raiseWithOutcome({ userId: user, hintKey: switchedOff.key, source: 's', showAgain: true }),
      { kind: 'hint_inactive' },
    );
    assert.equal(await prisma.userHintDelivery.count({ where: { userId: user } }), 0);
  });

  it('counts a lapsed and a dismissed earlier delivery as "once", and only for that customer', async () => {
    const hint = await createHint('once');
    const now = new Date();
    const lapsedFor = await createUser('once-lapsed');
    await createDelivery(lapsedFor, hint.id, { expiresAt: new Date(now.getTime() - HOUR_MS) });
    const dismissedFor = await createUser('once-dismissed');
    await createDelivery(dismissedFor, hint.id, {
      expiresAt: new Date(now.getTime() + 24 * HOUR_MS),
      dismissedAt: new Date(now.getTime() - HOUR_MS),
    });
    const firstTime = await createUser('once-first-time');

    for (const userId of [lapsedFor, dismissedFor]) {
      assert.deepEqual(
        await service.raiseWithOutcome({ userId, hintKey: hint.key, source: 's', now, showAgain: false }),
        { kind: 'already_delivered' },
        `${userId} would have been sent a once-only hint a second time`,
      );
      assert.equal(await prisma.userHintDelivery.count({ where: { userId } }), 1);
    }
    // Two other customers' deliveries of the same hint do not stop a first one.
    const first = await service.raiseWithOutcome({ userId: firstTime, hintKey: hint.key, source: 's', now });
    assert.equal(first.kind, 'queued');
  });

  it('with showAgain, queues past "once" and replaces only this customer’s waiting copy of this hint', async () => {
    // No group on either hint, so supersession cannot touch a row here: every
    // change below is the showAgain statement's alone.
    const hint = await createHint('again');
    const otherHint = await createHint('again-other');
    const me = await createUser('again-me');
    const someoneElse = await createUser('again-someone-else');
    const now = new Date();
    const at = (hours: number): Date => new Date(now.getTime() + hours * HOUR_MS);

    const rows = {
      myWaitingCopy: await createDelivery(me, hint.id, { expiresAt: at(24) }),
      myShownCopy: await createDelivery(me, hint.id, { expiresAt: at(24), shownAt: at(-3) }),
      myDismissedCopy: await createDelivery(me, hint.id, { expiresAt: at(24), dismissedAt: at(-2) }),
      myActedCopy: await createDelivery(me, hint.id, { expiresAt: at(24), actedAt: at(-2) }),
      myLapsedCopy: await createDelivery(me, hint.id, { expiresAt: at(-1) }),
      myOtherHint: await createDelivery(me, otherHint.id, { expiresAt: at(24) }),
      theirWaitingCopy: await createDelivery(someoneElse, hint.id, { expiresAt: at(24) }),
    };
    const ids = Object.values(rows);
    const initial = await statesOf(ids);

    // What every automatic run does: "once" refuses, and no row is rewritten.
    assert.deepEqual(
      await service.raiseWithOutcome({ userId: me, hintKey: hint.key, source: 'rule:spec', now, showAgain: false }),
      { kind: 'already_delivered' },
    );
    assert.deepEqual(await statesOf(ids), initial, 'a refused raise rewrote rows');

    const outcome = await service.raiseWithOutcome({
      userId: me,
      hintKey: hint.key,
      source: 'rule:spec:manual',
      now,
      showAgain: true,
    });

    assert.ok(outcome.kind === 'queued', `answered ${outcome.kind}: showAgain did not queue past "once"`);
    const settled = await statesOf(ids);
    for (const [label, id] of Object.entries(rows)) {
      const expected =
        id === rows.myWaitingCopy ? { ...initial.get(id), expiresAt: now } : initial.get(id);
      assert.deepEqual(
        settled.get(id),
        expected,
        id === rows.myWaitingCopy ? `${label} was not lapsed` : `${label} was rewritten`,
      );
    }
    // Handed this hint once — the fresh copy — beside the other hint they were already owed.
    assert.deepEqual(
      (await handedOut(me, now)).sort(),
      [outcome.delivery.id, rows.myOtherHint].sort(),
    );
  });

  it('with showAgain, still supersedes the group, and leaves the group’s closed deliveries alone', async () => {
    const group = `${prefix}-group`;
    const hint = await createHint('group-again', { groupKey: group });
    const sibling = await createHint('group-sibling', { groupKey: group });
    const me = await createUser('group-me');
    const someoneElse = await createUser('group-someone-else');
    const now = new Date();
    const at = (hours: number): Date => new Date(now.getTime() + hours * HOUR_MS);

    const rows = {
      // Already had it once, so only showAgain gets a new copy through.
      myClosedCopy: await createDelivery(me, hint.id, { expiresAt: at(24), shownAt: at(-5), dismissedAt: at(-4) }),
      myWaitingCopy: await createDelivery(me, hint.id, { expiresAt: at(24) }),
      mySiblingWaiting: await createDelivery(me, sibling.id, { expiresAt: at(24) }),
      mySiblingShown: await createDelivery(me, sibling.id, { expiresAt: at(24), shownAt: at(-2) }),
      mySiblingDismissed: await createDelivery(me, sibling.id, { expiresAt: at(24), dismissedAt: at(-1) }),
      theirSiblingWaiting: await createDelivery(someoneElse, sibling.id, { expiresAt: at(24) }),
      theirWaitingCopy: await createDelivery(someoneElse, hint.id, { expiresAt: at(24) }),
    };
    const ids = Object.values(rows);
    const initial = await statesOf(ids);

    const outcome = await service.raiseWithOutcome({
      userId: me,
      hintKey: hint.key,
      source: 'rule:spec:manual',
      now,
      showAgain: true,
    });

    assert.ok(outcome.kind === 'queued', `answered ${outcome.kind}: showAgain did not queue past "once"`);
    // This customer's WAITING deliveries in the group lapse — the sibling's by
    // supersession, which showAgain must not switch off. Everything closed, and
    // everybody else's, stays exactly as it was.
    const lapsed = new Set([rows.myWaitingCopy, rows.mySiblingWaiting]);
    const settled = await statesOf(ids);
    for (const [label, id] of Object.entries(rows)) {
      const expected = lapsed.has(id) ? { ...initial.get(id), expiresAt: now } : initial.get(id);
      assert.deepEqual(
        settled.get(id),
        expected,
        lapsed.has(id) ? `${label} was not lapsed` : `${label} was rewritten`,
      );
    }
    assert.deepEqual(await handedOut(me, now), [outcome.delivery.id]);
  });

  it('without showAgain, lets a repeatable hint stack exactly as it always has', async () => {
    const hint = await createHint('repeatable', { isRepeatable: true });
    const me = await createUser('repeatable-me');
    const now = new Date();
    const earlier = await createDelivery(me, hint.id, { expiresAt: new Date(now.getTime() + 24 * HOUR_MS) });
    const initial = await statesOf([earlier]);

    const outcome = await service.raiseWithOutcome({
      userId: me,
      hintKey: hint.key,
      source: 'rule:spec',
      now,
      showAgain: false,
    });

    assert.ok(outcome.kind === 'queued', `answered ${outcome.kind}`);
    assert.deepEqual(await statesOf([earlier]), initial, 'the earlier copy was lapsed without showAgain');
    assert.deepEqual((await handedOut(me, now)).sort(), [earlier, outcome.delivery.id].sort());
  });

  // ── Two raises for one customer at the same time ─────────────────────────
  //
  // Each raise reads the queue and then writes it. Started together, and with
  // every queue statement followed by a pause, the second raise reads the queue
  // while the first is still between its read and its write — unless the lock
  // on the customer makes it wait for the first to commit.

  it('queues a once-only hint ONCE when two raises for one customer overlap', async () => {
    const hint = await createHint('race-once');
    const me = await createUser('race-once');
    const now = new Date();
    const pausesBefore = pausesTaken;

    const outcomes = await Promise.all([
      racing.raiseWithOutcome({ userId: me, hintKey: hint.key, source: `${prefix}-race-a`, now }),
      racing.raiseWithOutcome({ userId: me, hintKey: hint.key, source: `${prefix}-race-b`, now }),
    ]);

    // Count + insert for one, count for the other: the overlap was forced.
    assert.ok(pausesTaken - pausesBefore >= 3, `only ${pausesTaken - pausesBefore} pauses — the race was not forced`);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ['already_delivered', 'queued']);
    assert.equal(
      await prisma.userHintDelivery.count({ where: { userId: me, hintId: hint.id } }),
      1,
      'both overlapping raises queued the once-only hint',
    );
  });

  it('leaves ONE waiting copy when two showAgain runs for one customer overlap', async () => {
    const hint = await createHint('race-again');
    const me = await createUser('race-again');
    const now = new Date();
    const earlier = await createDelivery(me, hint.id, { expiresAt: new Date(now.getTime() + 24 * HOUR_MS) });
    const pausesBefore = pausesTaken;

    const outcomes = await Promise.all([
      racing.raiseWithOutcome({ userId: me, hintKey: hint.key, source: `${prefix}-race-a`, now, showAgain: true }),
      racing.raiseWithOutcome({ userId: me, hintKey: hint.key, source: `${prefix}-race-b`, now, showAgain: true }),
    ]);

    // Lapse + insert, twice.
    assert.ok(pausesTaken - pausesBefore >= 4, `only ${pausesTaken - pausesBefore} pauses — the race was not forced`);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['queued', 'queued']);
    const waiting = await prisma.userHintDelivery.findMany({
      where: { userId: me, hintId: hint.id, shownAt: null, dismissedAt: null, actedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    assert.equal(waiting.length, 1, 'two overlapping showAgain runs left more than one waiting copy');
    assert.notEqual(waiting[0]?.id, earlier, 'the copy left waiting is the old one');
    assert.deepEqual(await handedOut(me, now), [waiting[0]?.id]);
  });

  it('leaves ONE waiting delivery in a group when two of its hints are raised for one customer at once', async () => {
    // Two DIFFERENT hints of one group — the reason the lock is on the
    // customer and not on the hint.
    const group = `${prefix}-race-group`;
    const first = await createHint('race-group-first', { groupKey: group });
    const second = await createHint('race-group-second', { groupKey: group });
    const me = await createUser('race-group');
    const now = new Date();
    const pausesBefore = pausesTaken;

    const outcomes = await Promise.all([
      racing.raiseWithOutcome({ userId: me, hintKey: first.key, source: `${prefix}-race-a`, now }),
      racing.raiseWithOutcome({ userId: me, hintKey: second.key, source: `${prefix}-race-b`, now }),
    ]);

    // Count, both supersession statements and the insert, twice.
    assert.ok(pausesTaken - pausesBefore >= 8, `only ${pausesTaken - pausesBefore} pauses — the race was not forced`);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['queued', 'queued']);
    const rows = await prisma.userHintDelivery.findMany({
      where: { userId: me },
      select: { id: true, expiresAt: true },
    });
    assert.equal(rows.length, 2, 'each raise writes its own delivery');
    assert.equal(
      rows.filter((row) => row.expiresAt.getTime() > now.getTime()).length,
      1,
      'two waiting deliveries in one group for one customer',
    );
    assert.equal((await handedOut(me, now)).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// «Купил, но не подключился» in the queue: the `@connect` door, the stale
// pop-up guard, and the hint audiences through the real audience service.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A second client of its own: the block above disconnects its client in its
 * own `after`. Rows are this block's, under `prefix`, and removed in `after`.
 *
 * Instants are BOUND everywhere: the guard reads no clock, the lapse writes the
 * bound `now`, and the audiences run on a synthetic clock years from today
 * (2033) so that no row another spec left behind can fall inside a window.
 * Run it on a UTC database AND on one whose `timezone` is not UTC.
 */
run('the connect door, the stale pop-up guard and the hint audiences on PostgreSQL', () => {
  let db: PrismaService;
  let queue: UserHintDeliveryService;
  const door = `${prefix}-door`;
  const made = { users: [] as string[], hints: [] as string[] };
  let seq = 0;
  const id = (label: string): string => `${door}-${label}-${++seq}`;

  /** A cabinet that says nothing about itself — and therefore opens no door. */
  const OLD_CABINET = { surface: null, formFactor: null, modes: null };
  /** The same cabinet, declaring `@connect` in `x-reiwa-hint-doors`. */
  const CONNECTING_CABINET = { ...OLD_CABINET, doors: ['@connect'] };

  async function person(label: string, prefs?: Prisma.InputJsonValue): Promise<string> {
    const userId = id(`user-${label}`);
    await db.user.create({
      data: {
        id: userId,
        referralCode: `${userId}-ref`,
        name: label,
        ...(prefs === undefined ? {} : { notificationPrefs: prefs }),
      },
    });
    made.users.push(userId);
    return userId;
  }

  async function authored(
    label: string,
    data: Partial<Prisma.UserHintUncheckedCreateInput> = {},
  ): Promise<{ readonly id: string; readonly key: string }> {
    const hint = await db.userHint.create({
      data: { key: id(label), titleRu: `Заголовок: ${label}`, bodyRu: `Текст: ${label}`, ttlHours: 48, ...data },
      select: { id: true, key: true },
    });
    made.hints.push(hint.id);
    return hint;
  }

  /**
   * A delivery waiting for `userId`. `queuedMinutesAgo` sets its place in the
   * queue explicitly: two rows created in one millisecond tie on `createdAt`,
   * and the queue's order between them would be the database's to choose.
   */
  async function waiting(userId: string, hintId: string, now: Date, queuedMinutesAgo = 5): Promise<string> {
    const row = await db.userHintDelivery.create({
      data: {
        userId,
        hintId,
        source: `${door}-fixture`,
        expiresAt: new Date(now.getTime() + 24 * HOUR_MS),
        createdAt: new Date(now.getTime() - queuedMinutesAgo * 60 * 1000),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function subscription(input: {
    readonly userId: string;
    readonly createdAt: Date;
    readonly status?: 'ACTIVE' | 'LIMITED' | 'EXPIRED';
    readonly isTrial?: boolean;
  }): Promise<string> {
    const subscriptionId = id('sub');
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "subscriptions" ("id", "user_id", "status", "is_trial", "plan_snapshot", "remnawave_id",
                                   "created_at", "updated_at")
      VALUES (${subscriptionId}, ${input.userId}, ${input.status ?? 'ACTIVE'}::"SubscriptionStatus",
              ${input.isTrial ?? false}, ${JSON.stringify({ name: 'Standard' })}::jsonb, ${subscriptionId},
              ${input.createdAt}, ${input.createdAt})
    `);
    return subscriptionId;
  }

  async function payment(input: {
    readonly userId: string;
    readonly subscriptionId: string;
    readonly purchaseType: 'NEW' | 'RENEW';
    readonly createdAt: Date;
  }): Promise<void> {
    const transactionId = id('tx');
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "transactions"
        ("id", "payment_id", "user_id", "subscription_id", "status", "purchase_type", "gateway_type", "currency",
         "amount", "plan_snapshot", "fulfilled_at", "created_at", "updated_at")
      VALUES (${transactionId}, ${`${transactionId}-pay`}, ${input.userId}, ${input.subscriptionId},
              'COMPLETED'::"TransactionStatus", ${input.purchaseType}::"PurchaseType",
              'PLATEGA'::"PaymentGatewayType", 'RUB'::"Currency", 499, ${JSON.stringify({})}::jsonb,
              ${input.createdAt}::timestamptz, ${input.createdAt}, ${input.createdAt})
    `);
  }

  async function connectState(
    subscriptionId: string,
    input: {
      readonly checkedAt?: Date | null;
      readonly firstConnectedAt?: Date | null;
      readonly profileMissingAt?: Date | null;
      readonly helpDecidedAt?: Date | null;
      readonly helpOutcome?: string | null;
    },
  ): Promise<void> {
    const at = input.checkedAt ?? new Date();
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_connect_states"
        ("subscription_id", "first_connected_at", "checked_at", "profile_missing_at", "help_decided_at", "help_kind",
         "help_outcome", "created_at", "updated_at")
      VALUES (${subscriptionId}, ${input.firstConnectedAt ?? null}::timestamptz, ${input.checkedAt ?? null}::timestamptz,
              ${input.profileMissingAt ?? null}::timestamptz, ${input.helpDecidedAt ?? null}::timestamptz,
              ${input.helpDecidedAt === undefined || input.helpDecidedAt === null ? null : 'paid'},
              ${input.helpOutcome ?? null}, ${at}, ${at})
    `);
  }

  /**
   * The cabinet's dashboard read — the real `InternalUserService.getAllSubscriptions`,
   * on this database — with Remnawave answering every profile with `traffic`.
   * It is what writes the connection signal on a page load
   * (`resolveConnectHelp` → `recordCabinetSignal`).
   */
  async function cabinetRead(userId: string, traffic: Record<string, unknown>): Promise<void> {
    const remnawave = {
      getPanelUserUsage: async () => ({
        username: 'profile',
        usedTrafficBytes: 0,
        status: 'ACTIVE',
        expireAt: null,
        trafficLimitBytes: null,
        hwidDeviceLimit: null,
        userTraffic: traffic,
      }),
    };
    const cabinet = new InternalUserService(db, {} as never, {} as never, undefined, remnawave as never, undefined);
    await cabinet.getAllSubscriptions({ userId } as never);
  }

  const NEVER_CONNECTED = { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null };

  async function expiresAtOf(deliveryId: string): Promise<Date> {
    const row = await db.userHintDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { expiresAt: true } });
    return row.expiresAt;
  }

  before(async () => {
    process.env.DATABASE_URL = testUrl;
    db = new PrismaService();
    await db.$connect();
    queue = new UserHintDeliveryService(db);
  });

  after(async () => {
    if (db === undefined) return;
    await db.userHintDelivery.deleteMany({
      where: { OR: [{ userId: { in: made.users } }, { hintId: { in: made.hints } }] },
    });
    await db.userHint.deleteMany({ where: { id: { in: made.hints } } });
    const like = `${door}-%`;
    await db.$executeRaw(Prisma.sql`DELETE FROM "transactions" WHERE "id" LIKE ${like}`);
    await db.$executeRaw(Prisma.sql`DELETE FROM "subscriptions" WHERE "id" LIKE ${like}`);
    await db.user.deleteMany({ where: { id: { in: made.users } } });
    await db.$disconnect();
  });

  // ── The door ───────────────────────────────────────────────────────────────

  it('holds a `@connect` hint from a cabinet that did not declare the door, and delivers it to one that did', async () => {
    const me = await person('door');
    const hint = await authored('door', { ctaKind: 'ROUTE', ctaLabelRu: 'Подключить', ctaTarget: '@connect' });
    const now = new Date();
    const deliveryId = await waiting(me, hint.id, now);
    const before = await expiresAtOf(deliveryId);

    assert.equal(
      await queue.nextFor({ userId: me, locale: 'ru', audience: OLD_CABINET, now }),
      null,
      'a door was handed to a cabinet that would navigate to "@connect" as a path',
    );
    assert.deepEqual(await expiresAtOf(deliveryId), before, 'holding the hint rewrote it');
    assert.equal(
      await queue.nextFor({ userId: me, locale: 'ru', audience: { ...OLD_CABINET, doors: ['@CONNECT'] }, now }),
      null,
      'a door opened under another case',
    );

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now });
    assert.equal(next?.deliveryId, deliveryId);
    assert.equal(next?.ctaTarget, '@connect');
  });

  it('delivers a hint with NO button — a NULL target — to either cabinet', async () => {
    // The NOT-LIKE-NULL trap: `NOT (cta_target LIKE '@%')` is NULL for a NULL
    // target, and a filter made of that alone holds every button-less hint.
    for (const audience of [OLD_CABINET, CONNECTING_CABINET]) {
      const me = await person('no-button');
      const hint = await authored('no-button');
      const now = new Date();
      const deliveryId = await waiting(me, hint.id, now);

      const next = await queue.nextFor({ userId: me, locale: 'ru', audience, now });

      assert.equal(next?.deliveryId, deliveryId, `held from ${JSON.stringify(audience)}`);
    }
  });

  it('delivers a ROUTE with a NULL target — a row only another hand writes — to a doorless cabinet', async () => {
    // The row the explicit `cta_target IS NULL` arm exists for: it is a ROUTE,
    // so the first arm does not pass it, and `NOT LIKE` is NULL for it.
    const me = await person('route-null');
    const hint = await authored('route-null', { ctaKind: 'ROUTE', ctaLabelRu: 'Куда-то', ctaTarget: null });
    const now = new Date();
    const deliveryId = await waiting(me, hint.id, now);

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: OLD_CABINET, now });

    assert.equal(next?.deliveryId, deliveryId, 'the door filter held a row it has no business holding');
  });

  it('delivers an ordinary route and an external link to a doorless cabinet', async () => {
    for (const data of [
      { ctaKind: 'ROUTE' as const, ctaLabelRu: 'Тарифы', ctaTarget: '/plans' },
      { ctaKind: 'EXTERNAL' as const, ctaLabelRu: 'Канал', ctaTarget: 'https://t.me/example' },
    ]) {
      const me = await person(`button-${data.ctaKind}`);
      const hint = await authored(`button-${data.ctaKind}`, data);
      const now = new Date();
      const deliveryId = await waiting(me, hint.id, now);

      const next = await queue.nextFor({ userId: me, locale: 'ru', audience: OLD_CABINET, now });

      assert.equal(next?.deliveryId, deliveryId, `${data.ctaTarget} was held`);
    }
  });

  // ── The stale pop-up guard ─────────────────────────────────────────────────

  /** A connect-help pop-up waiting for `userId`, and a plain hint queued after it. */
  async function queued(userId: string, now: Date): Promise<{ readonly popup: string; readonly plain: string }> {
    const popupHint = await authored('connect-help', {
      groupKey: 'connect-help',
      isRepeatable: true,
      ctaKind: 'ROUTE',
      ctaLabelRu: 'Подключить',
      ctaTarget: '@connect',
    });
    const plainHint = await authored('plain');
    // The pop-up first in the queue, so the guard is what decides whether the
    // plain hint behind it is reached.
    const popup = await waiting(userId, popupHint.id, now, 2);
    const plain = await waiting(userId, plainHint.id, now, 1);
    return { popup, plain };
  }

  it('shows the pop-up when the message was switched off (`skipped_template_off`) and a fresh read says not connected', async () => {
    // THE case a guard on "help is pending" gets wrong: the operator switched
    // the message template off and relies on this very pop-up, and pending
    // help does not count that outcome.
    const me = await person('template-off');
    const now = new Date();
    const subscriptionId = await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    await connectState(subscriptionId, {
      checkedAt: new Date(now.getTime() - 5 * 60 * 1000),
      helpDecidedAt: new Date(now.getTime() - 2 * HOUR_MS),
      helpOutcome: 'skipped_template_off',
    });
    const { popup } = await queued(me, now);

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now });

    assert.equal(next?.deliveryId, popup, 'the pop-up the operator relies on was closed');
  });

  /** The pop-up and the plain hint: the plain one handed over, the pop-up neither shown nor closed. */
  async function assertHeld(me: string, popup: string, plain: string, now: Date, popupBefore: Date): Promise<void> {
    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now });
    assert.equal(next?.deliveryId, plain, 'a held pop-up was handed over, or blocked the hint behind it');
    assert.deepEqual(await expiresAtOf(popup), popupBefore, 'a held pop-up was closed as lapsed');
    const untouched = await db.userHintDelivery.findUniqueOrThrow({
      where: { id: popup },
      select: { shownAt: true, dismissedAt: true, actedAt: true },
    });
    assert.deepEqual(untouched, { shownAt: null, dismissedAt: null, actedAt: null });
  }

  it('HOLDS it for a live subscription the panel never read: not shown, not closed, and the next hint offered', async () => {
    // No state row: not KNOWN to have connected — and nothing to show it on.
    const me = await person('no-state');
    const now = new Date();
    await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS), status: 'LIMITED' });
    const { popup, plain } = await queued(me, now);

    await assertHeld(me, popup, plain, now, await expiresAtOf(popup));
  });

  it('HOLDS it on a read older than fifteen minutes — the customer may have connected since', async () => {
    const me = await person('stale-read');
    const now = new Date();
    const subscriptionId = await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    await connectState(subscriptionId, {
      checkedAt: new Date(now.getTime() - 16 * 60 * 1000),
      helpDecidedAt: new Date(now.getTime() - 2 * HOUR_MS),
      helpOutcome: 'bot',
    });
    const { popup, plain } = await queued(me, now);

    await assertHeld(me, popup, plain, now, await expiresAtOf(popup));
  });

  it('HOLDS it when the profile was reported missing after the fresh read', async () => {
    const me = await person('missing-after-read');
    const now = new Date();
    const subscriptionId = await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    await connectState(subscriptionId, {
      checkedAt: new Date(now.getTime() - 5 * 60 * 1000),
      profileMissingAt: new Date(now.getTime() - 60 * 1000),
    });
    const { popup, plain } = await queued(me, now);

    await assertHeld(me, popup, plain, now, await expiresAtOf(popup));
  });

  it('a customer who connected with no webhook: HELD before the cabinet read, LAPSED after it wrote the connection', async () => {
    // The finding: the help was decided, the probe re-reads only hourly now,
    // the webhook was lost — and the stored row still says "not connected".
    const me = await person('connected-no-webhook');
    const now = new Date();
    const subscriptionId = await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    await connectState(subscriptionId, {
      checkedAt: new Date(now.getTime() - 50 * 60 * 1000),
      helpDecidedAt: new Date(now.getTime() - 55 * 60 * 1000),
      helpOutcome: 'bot',
    });
    const { popup, plain } = await queued(me, now);

    // The hint ask of the page load, answered before the dashboard's read.
    await assertHeld(me, popup, plain, now, await expiresAtOf(popup));

    // The dashboard's read, on the same page load: Remnawave says it connected.
    const connectedAt = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    await cabinetRead(me, { usedTrafficBytes: 4096, lifetimeUsedTrafficBytes: 4096, onlineAt: connectedAt, firstConnectedAt: connectedAt });
    const written = await db.subscriptionConnectState.findUniqueOrThrow({
      where: { subscriptionId },
      select: { firstConnectedAt: true, connectedSource: true },
    });
    assert.ok(written.firstConnectedAt !== null, 'the cabinet read did not write the connection');
    assert.equal(written.connectedSource, 'cabinet');

    // The cabinet's follow-up ask: the pop-up is no longer true, and goes.
    const later = new Date();
    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now: later });
    assert.equal(next?.deliveryId, plain);
    assert.deepEqual(await expiresAtOf(popup), later, 'the pop-up for a connected customer was not closed');
  });

  it('a customer who did NOT connect: HELD before the cabinet read, SHOWN after it wrote a fresh read', async () => {
    const me = await person('not-connected-stale');
    const now = new Date();
    const subscriptionId = await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    await connectState(subscriptionId, {
      checkedAt: new Date(now.getTime() - 50 * 60 * 1000),
      helpDecidedAt: new Date(now.getTime() - 55 * 60 * 1000),
      helpOutcome: 'push',
    });
    const { popup, plain } = await queued(me, now);
    await assertHeld(me, popup, plain, now, await expiresAtOf(popup));

    await cabinetRead(me, NEVER_CONNECTED);

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now: new Date() });
    assert.equal(next?.deliveryId, popup, 'the cabinet read did not refresh the read the pop-up waits for');
  });

  it('lapses it once the customer connected, and hands over the next hint untouched', async () => {
    const me = await person('connected');
    const now = new Date();
    const subscriptionId = await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    await connectState(subscriptionId, {
      checkedAt: new Date(now.getTime() - HOUR_MS),
      firstConnectedAt: new Date(now.getTime() - 3 * HOUR_MS),
      helpDecidedAt: new Date(now.getTime() - 5 * HOUR_MS),
      helpOutcome: 'bot',
    });
    const { popup, plain } = await queued(me, now);
    const plainBefore = await expiresAtOf(plain);

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now });

    assert.equal(next?.deliveryId, plain, 'the stale pop-up was handed over, or blocked the hint behind it');
    assert.deepEqual(await expiresAtOf(popup), now, 'the stale pop-up was not closed as lapsed');
    assert.deepEqual(await expiresAtOf(plain), plainBefore, 'a hint outside the group was rewritten');
    const closed = await db.userHintDelivery.findUniqueOrThrow({
      where: { id: popup },
      select: { shownAt: true, dismissedAt: true, actedAt: true },
    });
    assert.deepEqual(closed, { shownAt: null, dismissedAt: null, actedAt: null });
  });

  it('lapses it when nothing of theirs is live any more', async () => {
    const me = await person('expired');
    const now = new Date();
    await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS), status: 'EXPIRED' });
    const { popup, plain } = await queued(me, now);

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now });

    assert.equal(next?.deliveryId, plain);
    assert.deepEqual(await expiresAtOf(popup), now);
  });

  it('lapses it for somebody who switched «Помощь с подключением» off, though they never connected', async () => {
    const me = await person('opted-out', { connect_help: false });
    const now = new Date();
    await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    const { popup, plain } = await queued(me, now);

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now });

    assert.equal(next?.deliveryId, plain);
    assert.deepEqual(await expiresAtOf(popup), now);
  });

  it('leaves a hint outside the group alone for a connected customer', async () => {
    const me = await person('outside');
    const now = new Date();
    const subscriptionId = await subscription({ userId: me, createdAt: new Date(now.getTime() - 30 * HOUR_MS) });
    await connectState(subscriptionId, { checkedAt: now, firstConnectedAt: new Date(now.getTime() - HOUR_MS) });
    const plainHint = await authored('outside-plain', { groupKey: 'connect-helpful' });
    const plain = await waiting(me, plainHint.id, now);
    const before = await expiresAtOf(plain);

    const next = await queue.nextFor({ userId: me, locale: 'ru', audience: CONNECTING_CABINET, now });

    assert.equal(next?.deliveryId, plain, '"connect-helpful" is not the connect-help group');
    assert.deepEqual(await expiresAtOf(plain), before);
  });

  // ── The hint audiences, through the real audience service ──────────────────

  it('resolves the two new audiences and the legacy one from real rows', async () => {
    const NOW = new Date('2033-05-20T12:00:00.000Z');
    const at = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR_MS);
    const read = at(1);

    // Paid, bought inside the 24–72 h window, read after the purchase: in.
    const paid = await person('aud-paid');
    const paidSub = await subscription({ userId: paid, createdAt: at(48) });
    await payment({ userId: paid, subscriptionId: paidSub, purchaseType: 'NEW', createdAt: at(48) });
    await connectState(paidSub, { checkedAt: read });

    // Paid and already helped by the automatic message: STILL in — the pop-up
    // is shown after the message on purpose.
    const helped = await person('aud-helped');
    const helpedSub = await subscription({ userId: helped, createdAt: at(50) });
    await payment({ userId: helped, subscriptionId: helpedSub, purchaseType: 'NEW', createdAt: at(50) });
    await connectState(helpedSub, { checkedAt: read, helpDecidedAt: at(20), helpOutcome: 'bot' });

    // Paid inside the window by a RENEWAL of a subscription created long
    // before it: the paid window is the payment's time, not the subscription's.
    const renewed = await person('aud-renewed');
    const renewedSub = await subscription({ userId: renewed, createdAt: at(400) });
    await payment({ userId: renewed, subscriptionId: renewedSub, purchaseType: 'NEW', createdAt: at(400) });
    await payment({ userId: renewed, subscriptionId: renewedSub, purchaseType: 'RENEW', createdAt: at(30) });
    await connectState(renewedSub, { checkedAt: read });

    // Trial, granted inside the window: in the trial bucket only.
    const trial = await person('aud-trial');
    const trialSub = await subscription({ userId: trial, createdAt: at(40), isTrial: true });
    await connectState(trialSub, { checkedAt: read });

    // Out: connected; never read; granted outside the window.
    const connected = await person('aud-connected');
    const connectedSub = await subscription({ userId: connected, createdAt: at(48) });
    await payment({ userId: connected, subscriptionId: connectedSub, purchaseType: 'NEW', createdAt: at(48) });
    await connectState(connectedSub, { checkedAt: read, firstConnectedAt: at(10) });
    const unread = await person('aud-unread');
    const unreadSub = await subscription({ userId: unread, createdAt: at(48) });
    await payment({ userId: unread, subscriptionId: unreadSub, purchaseType: 'NEW', createdAt: at(48) });
    const old = await person('aud-old-trial');
    const oldSub = await subscription({ userId: old, createdAt: at(100), isTrial: true });
    await connectState(oldSub, { checkedAt: read });

    const HEALTH = { state: 'live' } as never;
    const audiences = new HintAudienceService(new ConnectAudienceService(db, { current: async () => HEALTH } as never));
    const ids = async (audience: 'purchase-not-connected' | 'trial-not-connected' | 'paid-not-connected') => {
      const outcome = await audiences.resolve({ audience, afterHours: 24, beforeHours: 72, now: NOW });
      assert.equal(outcome.kind, 'ok', `${audience}: ${JSON.stringify(outcome)}`);
      return [...(outcome as { userIds: readonly string[] }).userIds].sort();
    };

    assert.deepEqual(await ids('purchase-not-connected'), [paid, helped, renewed].sort());
    assert.deepEqual(await ids('trial-not-connected'), [trial]);
    assert.deepEqual(await ids('paid-not-connected'), [paid, helped, renewed, trial].sort());
  });

  it('stands the audiences down on a blind signal before reading a row', async () => {
    const blind = new HintAudienceService(
      new ConnectAudienceService(db, { current: async () => ({ state: 'blind' }) } as never),
    );

    const outcome = await blind.resolve({ audience: 'paid-not-connected', now: new Date('2033-05-20T12:00:00.000Z') });

    assert.equal(outcome.kind, 'blind');
  });

  it('stands them down on webhooks alone too', async () => {
    const webhooksOnly = new HintAudienceService(
      new ConnectAudienceService(db, { current: async () => ({ state: 'webhooks_only' }) } as never),
    );

    const outcome = await webhooksOnly.resolve({ audience: 'paid-not-connected', now: new Date('2033-05-20T12:00:00.000Z') });

    assert.equal(outcome.kind, 'blind');
  });

  it('never names somebody who switched «Помощь с подключением» off — paid or trial — and still names the rest', async () => {
    const NOW = new Date('2033-07-11T12:00:00.000Z');
    const at = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR_MS);
    const read = at(1);

    const optedOut = await person('aud-opted-out', { connect_help: false });
    const optedOutSub = await subscription({ userId: optedOut, createdAt: at(48) });
    await payment({ userId: optedOut, subscriptionId: optedOutSub, purchaseType: 'NEW', createdAt: at(48) });
    await connectState(optedOutSub, { checkedAt: read });

    const optedOutTrial = await person('aud-opted-out-trial', { connect_help: false, payment_failed: true });
    const optedOutTrialSub = await subscription({ userId: optedOutTrial, createdAt: at(40), isTrial: true });
    await connectState(optedOutTrialSub, { checkedAt: read });

    // Other switches off, or connect_help explicitly on: still in.
    const otherSwitch = await person('aud-other-switch', { payment_failed: false, connect_help: true });
    const otherSub = await subscription({ userId: otherSwitch, createdAt: at(47) });
    await payment({ userId: otherSwitch, subscriptionId: otherSub, purchaseType: 'NEW', createdAt: at(47) });
    await connectState(otherSub, { checkedAt: read });

    const audiences = new HintAudienceService(
      new ConnectAudienceService(db, { current: async () => ({ state: 'live' }) } as never),
    );
    const outcome = await audiences.resolve({ audience: 'paid-not-connected', afterHours: 24, beforeHours: 72, now: NOW });
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
    const named = (outcome as { userIds: readonly string[] }).userIds;
    assert.ok(!named.includes(optedOut), 'a paid customer who switched the help off was named');
    assert.ok(!named.includes(optedOutTrial), 'a trial customer who switched the help off was named');
    assert.ok(named.includes(otherSwitch), 'another switch was read as the help being off');
  });
});
