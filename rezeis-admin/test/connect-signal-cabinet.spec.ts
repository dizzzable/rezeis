import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';

/**
 * The cabinet's card read as a writer of the connection signal, and the
 * `connectHelp` flags it answers with — through the real `getAllSubscriptions`
 * / `getSubscription`.
 *
 * The Prisma double honours `where` (the state rows by subscription id, the
 * fan-out by panel identity), records every raw write, and the Remnawave double
 * is a Proxy that FAILS on any method other than the one card read — so "no
 * extra Remnawave call" is a property the test can lose.
 */

type Where = Record<string, unknown>;

interface SubRow {
  readonly id: string;
  readonly userId: string;
  readonly status: SubscriptionStatus;
  readonly isTrial: boolean;
  readonly planSnapshot: Record<string, unknown>;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
  readonly configUrl: string | null;
  readonly startedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface StateRow {
  readonly subscriptionId: string;
  readonly firstConnectedAt: Date | null;
  readonly checkedAt: Date | null;
  readonly helpOutcome: string | null;
  readonly bannerDismissedAt: Date | null;
}

function matches(where: Where | undefined, row: Record<string, unknown>): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Where[]).every((part) => matches(part, row));
    if (key === 'OR') return (condition as Where[]).some((part) => matches(part, row));
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>;
      if ('not' in operators) return value !== operators['not'];
      if ('in' in operators) return (operators['in'] as unknown[]).includes(value);
      throw new Error(`the double does not know ${JSON.stringify(condition)}`);
    }
    return value === condition;
  });
}

function subscription(id: string, overrides: Partial<SubRow> = {}): SubRow {
  return {
    id,
    userId: 'user-1',
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    planSnapshot: { name: 'Standard', type: 'UNLIMITED' },
    trafficLimit: null,
    deviceLimit: 3,
    remnawaveId: `rw-${id}`,
    remnawavePanelId: null,
    remnawavePanelUsername: null,
    configUrl: null,
    startedAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2027-09-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-10T00:00:00.000Z'),
    ...overrides,
  };
}

const NOT_CONNECTED = { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null, firstConnectedAt: null };

interface Harness {
  readonly service: InternalUserService;
  readonly writes: Array<{ readonly sql: string; readonly values: readonly unknown[] }>;
  readonly panelCalls: string[];
  readonly claims: Array<Record<string, unknown>>;
  readonly events: Array<{ readonly type: string; readonly metadata: Record<string, unknown> }>;
}

function harness(options: {
  readonly subscriptions: readonly SubRow[];
  readonly states?: readonly StateRow[];
  /** Per stored `remnawaveId`: the traffic block the card read answers with, `undefined` = the read failed. */
  readonly traffic?: Readonly<Record<string, unknown>>;
  readonly user?: Record<string, unknown>;
  readonly failStateRead?: boolean;
  /** Per stored `remnawaveId`: the status the card read reports (ACTIVE by default). */
  readonly panelStatus?: Readonly<Record<string, string>>;
}): Harness {
  const writes: Harness['writes'] = [];
  const panelCalls: string[] = [];
  const claims: Harness['claims'] = [];
  const events: Harness['events'] = [];
  const user = {
    id: 'user-1',
    telegramId: 858568447n,
    name: 'Anna',
    username: 'anna',
    firstTrafficAt: null,
    notificationPrefs: null,
    webAccount: null,
    ...options.user,
  };
  const prisma = {
    user: {
      findUnique: async () => user,
      updateMany: async (args: { where: Where; data: Record<string, unknown> }) => {
        claims.push({ where: args.where, data: args.data });
        return { count: 1 };
      },
    },
    subscription: {
      findMany: async (args: { where?: Where; select?: Record<string, boolean> }) =>
        options.subscriptions
          .filter((row) => matches(args.where, row as unknown as Record<string, unknown>))
          .map((row) => (args.select?.['id'] ? { id: row.id } : row)),
    },
    subscriptionConnectState: {
      findMany: async (args: { where: Where }) => {
        if (options.failStateRead === true) throw new Error('connection refused');
        return (options.states ?? []).filter((row) => matches(args.where, row as unknown as Record<string, unknown>));
      },
    },
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      writes.push({ sql: query.sql, values: query.values });
      return [];
    },
  };
  const remnawave = new Proxy(
    {
      getPanelUserUsage: async (identity: { remnawaveId: string }) => {
        panelCalls.push(identity.remnawaveId);
        if (!(identity.remnawaveId in (options.traffic ?? {}))) return null;
        return {
          username: `profile-${identity.remnawaveId}`,
          usedTrafficBytes: 0,
          status: options.panelStatus?.[identity.remnawaveId] ?? 'ACTIVE',
          expireAt: null,
          trafficLimitBytes: null,
          hwidDeviceLimit: null,
          userTraffic: options.traffic?.[identity.remnawaveId] ?? null,
        };
      },
    },
    {
      get(target, prop) {
        if (prop === 'then') return undefined;
        if (prop !== 'getPanelUserUsage') throw new Error(`unexpected Remnawave call: ${String(prop)}`);
        return target.getPanelUserUsage;
      },
    },
  );
  const systemEvents = {
    info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
      events.push({ type, metadata });
    },
  };
  const service = new InternalUserService(
    prisma as never,
    {} as never,
    {} as never,
    undefined,
    remnawave as never,
    systemEvents as never,
  );
  return { service, writes, panelCalls, claims, events };
}

function isCheckWrite(write: { readonly sql: string }): boolean {
  return !/"connected_source"/.test(write.sql) && /WHERE "st"\."first_connected_at" IS NULL/.test(write.sql);
}
function isEvidenceWrite(write: { readonly sql: string }): boolean {
  return /"connected_source"/.test(write.sql) && /LEAST\(/.test(write.sql);
}

const QUERY = { userId: 'user-1' } as never;

describe('the cabinet read writes the connection signal', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-19T12:00:00.000Z') });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('makes no Remnawave call beyond the card read it already made', async () => {
    const h = harness({
      subscriptions: [subscription('a'), subscription('b'), subscription('c', { remnawaveId: null })],
      traffic: { 'rw-a': NOT_CONNECTED, 'rw-b': NOT_CONNECTED },
    });

    await h.service.getAllSubscriptions(QUERY);

    // One read per subscription that HAS a profile, and nothing else (the
    // Proxy throws on any other method).
    assert.deepStrictEqual(h.panelCalls.sort(), ['rw-a', 'rw-b']);
  });

  it('stamps "still not connected" at most once per subscription per ten minutes', async () => {
    const h = harness({ subscriptions: [subscription('a')], traffic: { 'rw-a': NOT_CONNECTED } });

    await h.service.getAllSubscriptions(QUERY);
    await h.service.getAllSubscriptions(QUERY);
    await h.service.getSubscription(QUERY);
    assert.equal(h.writes.filter(isCheckWrite).length, 1, 'three loads inside ten minutes: one write');

    mock.timers.tick(9 * 60_000 + 59_000);
    await h.service.getAllSubscriptions(QUERY);
    assert.equal(h.writes.filter(isCheckWrite).length, 1, 'still inside the ten minutes');

    mock.timers.tick(1_000);
    await h.service.getAllSubscriptions(QUERY);
    assert.equal(h.writes.filter(isCheckWrite).length, 2, 'ten minutes on: the next stamp');
  });

  it('does not stamp over a verification someone else made minutes ago', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      states: [
        {
          subscriptionId: 'a',
          firstConnectedAt: null,
          checkedAt: new Date('2026-09-19T11:55:00.000Z'),
          helpOutcome: null,
          bannerDismissedAt: null,
        },
      ],
      traffic: { 'rw-a': NOT_CONNECTED },
    });

    await h.service.getAllSubscriptions(QUERY);

    assert.equal(h.writes.length, 0);
  });

  it('writes a proven connection at once, even right after a stamp — and only once', async () => {
    const connected = {
      usedTrafficBytes: 0,
      lifetimeUsedTrafficBytes: 1_000_000,
      onlineAt: '2026-09-19T11:58:00.000Z',
      firstConnectedAt: '2026-09-19T11:57:00.000Z',
    };
    const traffic: Record<string, unknown> = { 'rw-a': NOT_CONNECTED };
    const states: StateRow[] = [];
    const h = harness({ subscriptions: [subscription('a')], states, traffic });

    await h.service.getAllSubscriptions(QUERY);
    assert.equal(h.writes.filter(isCheckWrite).length, 1);

    traffic['rw-a'] = connected;
    mock.timers.tick(60_000);
    await h.service.getAllSubscriptions(QUERY);
    const evidence = h.writes.filter(isEvidenceWrite);
    assert.equal(evidence.length, 1, 'the connection is not held back by the stamp throttle');
    assert.ok(evidence[0]!.values.includes('cabinet'));
    assert.ok(
      evidence[0]!.values.some((v) => v instanceof Date && v.toISOString() === '2026-09-19T11:57:00.000Z'),
      'dated by the panel’s own first connection',
    );

    // Stored as connected now: nothing more to write, ever.
    states.push({
      subscriptionId: 'a',
      firstConnectedAt: new Date('2026-09-19T11:57:00.000Z'),
      checkedAt: new Date('2026-09-19T12:01:00.000Z'),
      helpOutcome: null,
      bannerDismissedAt: null,
    });
    mock.timers.tick(30 * 60_000);
    await h.service.getAllSubscriptions(QUERY);
    assert.equal(h.writes.filter(isEvidenceWrite).length, 1);
  });

  it('fans the write out over every row the panel identity names', async () => {
    const twin = subscription('twin', { remnawaveId: 'rw-a', userId: 'user-2' });
    const h = harness({ subscriptions: [subscription('a'), twin], traffic: { 'rw-a': NOT_CONNECTED } });

    await h.service.getSubscription(QUERY);

    const check = h.writes.find(isCheckWrite);
    assert.ok(check);
    assert.ok(check.values.includes('a') && check.values.includes('twin'));
  });

  it('writes nothing on an unknown read — a failed read, or a row without a block', async () => {
    const h = harness({
      subscriptions: [subscription('a'), subscription('b')],
      traffic: { 'rw-b': null },
    });

    await h.service.getAllSubscriptions(QUERY);

    assert.equal(h.writes.length, 0);
  });
});

describe('connectHelp on the cabinet payload', () => {
  function stateOf(id: string, overrides: Partial<StateRow> = {}): StateRow {
    return {
      subscriptionId: id,
      firstConnectedAt: null,
      checkedAt: new Date(Date.now() - 2 * 60_000),
      helpOutcome: 'banner',
      bannerDismissedAt: null,
      ...overrides,
    };
  }

  it('is null for everyone until help was given — the state of every install today', async () => {
    const h = harness({
      subscriptions: [subscription('a'), subscription('b')],
      states: [stateOf('b', { helpOutcome: null })],
      traffic: { 'rw-a': NOT_CONNECTED, 'rw-b': NOT_CONNECTED },
    });

    const { subscriptions } = await h.service.getAllSubscriptions(QUERY);

    assert.deepStrictEqual(
      subscriptions.map((row) => row.connectHelp),
      [null, null],
    );
  });

  it('shows the banner where the ladder ended at it, and pending elsewhere', async () => {
    const h = harness({
      subscriptions: [subscription('a'), subscription('b'), subscription('c')],
      states: [stateOf('a'), stateOf('b', { helpOutcome: 'push' }), stateOf('c', { bannerDismissedAt: new Date() })],
      traffic: { 'rw-a': NOT_CONNECTED, 'rw-b': NOT_CONNECTED, 'rw-c': NOT_CONNECTED },
    });

    const { subscriptions } = await h.service.getAllSubscriptions(QUERY);
    const byId = new Map(subscriptions.map((row) => [row.id, row.connectHelp]));

    assert.deepStrictEqual(byId.get('a'), { pending: true, banner: true });
    assert.deepStrictEqual(byId.get('b'), { pending: true, banner: false });
    assert.deepStrictEqual(byId.get('c'), { pending: true, banner: false });
  });

  it('clears the moment this very read proves a connection', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      states: [stateOf('a')],
      traffic: {
        'rw-a': { usedTrafficBytes: 10, lifetimeUsedTrafficBytes: 10, onlineAt: null, firstConnectedAt: null },
      },
    });

    const { subscriptions } = await h.service.getAllSubscriptions(QUERY);

    assert.equal(subscriptions[0]!.connectHelp, null);
    assert.equal(h.writes.filter(isEvidenceWrite).length, 1, 'and the connection is written');
  });

  it('is null when the panel says the subscription is not live, whatever the local row says', async () => {
    const h = harness({
      subscriptions: [subscription('a'), subscription('b')],
      states: [stateOf('a'), stateOf('b')],
      traffic: { 'rw-a': NOT_CONNECTED, 'rw-b': NOT_CONNECTED },
      panelStatus: { 'rw-b': 'EXPIRED' },
    });

    const { subscriptions } = await h.service.getAllSubscriptions(QUERY);
    const byId = new Map(subscriptions.map((row) => [row.id, row]));

    // Control: the same state on a live card IS pending.
    assert.deepStrictEqual(byId.get('a')!.connectHelp, { pending: true, banner: true });
    assert.equal(byId.get('b')!.status, SubscriptionStatus.EXPIRED);
    assert.equal(byId.get('b')!.connectHelp, null);
  });

  it('is null for a subscription that is not live and has no profile to read', async () => {
    const h = harness({
      subscriptions: [subscription('a', { status: SubscriptionStatus.EXPIRED, remnawaveId: null })],
      states: [stateOf('a')],
    });

    const { subscriptions } = await h.service.getAllSubscriptions(QUERY);

    assert.equal(subscriptions[0]!.status, SubscriptionStatus.EXPIRED);
    assert.equal(subscriptions[0]!.connectHelp, null);
  });

  it('keeps the banner off for a customer who switched the help off, still pending', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      states: [stateOf('a')],
      traffic: { 'rw-a': NOT_CONNECTED },
      user: { notificationPrefs: { connect_help: false } },
    });

    const { subscriptions } = await h.service.getAllSubscriptions(QUERY);

    assert.deepStrictEqual(subscriptions[0]!.connectHelp, { pending: true, banner: false });
  });

  it('answers null for all and still returns the cards when the state cannot be read', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      states: [stateOf('a')],
      traffic: { 'rw-a': NOT_CONNECTED },
      failStateRead: true,
    });

    const { subscriptions } = await h.service.getAllSubscriptions(QUERY);

    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0]!.profileName, 'profile-rw-a');
    assert.equal(subscriptions[0]!.connectHelp, null);
    assert.equal(h.writes.length, 0);
  });

  it('carries the field on the single-subscription read too', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      states: [stateOf('a', { helpOutcome: 'email' })],
      traffic: { 'rw-a': NOT_CONNECTED },
    });

    const current = await h.service.getSubscription(QUERY);

    assert.deepStrictEqual(current?.connectHelp, { pending: true, banner: false });
  });
});

describe('the cabinet read fills User.firstTrafficAt', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-19T12:00:00.000Z') });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('claims with the evidence’s own time and announces a fresh first connection', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      traffic: {
        'rw-a': {
          usedTrafficBytes: 5,
          lifetimeUsedTrafficBytes: 5,
          onlineAt: null,
          firstConnectedAt: '2026-09-19T10:00:00.000Z',
        },
      },
    });

    await h.service.getAllSubscriptions(QUERY);

    assert.deepStrictEqual(h.claims, [
      { where: { id: 'user-1', firstTrafficAt: null }, data: { firstTrafficAt: new Date('2026-09-19T10:00:00.000Z') } },
    ]);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0]!.type, 'user.first_traffic');
    assert.equal(h.events[0]!.metadata['userId'], 'user-1');
    assert.equal(h.events[0]!.metadata['subscriptionId'], 'a');
  });

  it('fills a months-old connection silently', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      traffic: {
        'rw-a': {
          usedTrafficBytes: 0,
          lifetimeUsedTrafficBytes: 5,
          onlineAt: null,
          firstConnectedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    await h.service.getAllSubscriptions(QUERY);

    assert.equal(h.claims.length, 1);
    assert.equal(h.events.length, 0);
  });

  it('does not claim for a person whose column is already filled', async () => {
    const h = harness({
      subscriptions: [subscription('a')],
      user: { firstTrafficAt: new Date('2026-01-01T00:00:00.000Z') },
      traffic: {
        'rw-a': { usedTrafficBytes: 5, lifetimeUsedTrafficBytes: 5, onlineAt: null, firstConnectedAt: null },
      },
    });

    await h.service.getAllSubscriptions(QUERY);

    assert.equal(h.claims.length, 0);
    assert.equal(h.events.length, 0);
  });
});
