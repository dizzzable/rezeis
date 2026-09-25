import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';
import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';
import {
  readRemnawaveProfileFacts,
  stampRemnawaveProfileFacts,
} from '../src/modules/remnawave/utils/remnawave-profile-facts.util';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';
import { NOT_IN_TERM_MODEL } from './helpers/term-model-hooks';

/**
 * THE PROFILE FACTS ARE STAMPED FROM EVERY FULL USER THE PANEL SEES
 * ═════════════════════════════════════════════════════════════════
 * `createdAt` (MONTH_ROLLING's anchor) and `lastTrafficResetAt` (the reset the
 * boundary sweep confirms) reach the subscription from the CREATE, PATCH and
 * reset answers in profile sync, from every user webhook, from ↻ and from the
 * Remnawave importer — WHATEVER THE SUBSCRIPTION'S STATUS. Until 25.09.2026
 * the anchor was stamped only while the row was ACTIVE, so a LIMITED customer,
 * the one who wants more traffic, could be left without one (W7 test 8).
 *
 * What the statement itself does — never null over a value, the reset only
 * forward, a repeat writing nothing — is proved on PostgreSQL in
 * `remnawave-reset-facts-postgres.spec.ts`. Here: that every caller REACHES it
 * with the facts of the answer it just got.
 */

const CREATED_AT = new Date('2025-03-20T09:15:00.000Z');
const LAST_RESET = new Date('2026-09-25T00:10:00.123Z');
/** A reset later than {@link LAST_RESET}: what a traffic-reset answer reports. */
const RESET_JUST_NOW = new Date('2026-09-25T06:41:07.456Z');

interface StampCall {
  readonly ids: readonly string[];
  readonly values: readonly unknown[];
}

/** A `$executeRaw` that records the facts stamps it is handed, and answers 1 for anything else. */
function stampRecorder() {
  const stamps: StampCall[] = [];
  const $executeRaw = async (query: unknown) => {
    const sql = query as Prisma.Sql;
    if (typeof sql?.sql === 'string' && sql.sql.includes('remnawave_last_traffic_reset_at')) {
      const ids = sql.values.find((value): value is string[] => Array.isArray(value)) ?? [];
      stamps.push({ ids, values: sql.values });
      return 1;
    }
    return 1;
  };
  return { stamps, $executeRaw };
}

function carries(stamp: StampCall | undefined, date: Date | null): boolean {
  if (stamp === undefined) return false;
  return stamp.values.some((value) => (date === null ? value === null : value instanceof Date && value.getTime() === date.getTime()));
}

describe('readRemnawaveProfileFacts — the two facts off whatever Remnawave sent', () => {
  it('reads ISO strings and Dates alike', () => {
    assert.deepEqual(
      readRemnawaveProfileFacts({ createdAt: '2025-03-20T09:15:00.000Z', lastTrafficResetAt: LAST_RESET }),
      { createdAt: CREATED_AT, lastTrafficResetAt: LAST_RESET },
    );
  });

  it('answers null for a field that is missing, empty or unreadable — never Invalid Date', () => {
    assert.deepEqual(readRemnawaveProfileFacts({ createdAt: '', lastTrafficResetAt: 'yesterday' }), {
      createdAt: null,
      lastTrafficResetAt: null,
    });
    assert.deepEqual(readRemnawaveProfileFacts({ createdAt: new Date(Number.NaN) }), {
      createdAt: null,
      lastTrafficResetAt: null,
    });
    for (const nothing of [null, undefined, 'user', 42, []]) {
      assert.deepEqual(readRemnawaveProfileFacts(nothing), { createdAt: null, lastTrafficResetAt: null });
    }
  });
});

describe('stampRemnawaveProfileFacts — one statement, and none when there is nothing to say', () => {
  it('sends one statement naming the rows and both facts', async () => {
    const recorder = stampRecorder();
    await stampRemnawaveProfileFacts(recorder as never, ['sub-a', 'sub-b'], { createdAt: CREATED_AT, lastTrafficResetAt: LAST_RESET });
    assert.equal(recorder.stamps.length, 1);
    assert.deepEqual(recorder.stamps[0]!.ids, ['sub-a', 'sub-b']);
    assert.ok(carries(recorder.stamps[0], CREATED_AT));
    assert.ok(carries(recorder.stamps[0], LAST_RESET));
  });

  it('sends nothing for no rows, or for an answer that carried neither fact', async () => {
    const recorder = stampRecorder();
    assert.equal(await stampRemnawaveProfileFacts(recorder as never, [], { createdAt: CREATED_AT, lastTrafficResetAt: null }), 0);
    assert.equal(await stampRemnawaveProfileFacts(recorder as never, ['sub-a'], { createdAt: null, lastTrafficResetAt: null }), 0);
    assert.equal(recorder.stamps.length, 0);
  });
});

// ── Profile sync ────────────────────────────────────────────────────────────

/** A user row as `PanelUsersClient` hands one back, with both facts. */
function panelRow(patch: Record<string, unknown> = {}) {
  return {
    id: 4711,
    username: 'rz_facts',
    description: null,
    subscriptionUrl: 'https://sub.example/facts',
    createdAt: CREATED_AT.toISOString(),
    lastTrafficResetAt: LAST_RESET.toISOString(),
    trafficLimitBytes: 0,
    hwidDeviceLimit: null,
    ...patch,
  };
}

function panelOk(patch: Record<string, unknown> = {}) {
  return { kind: 'ok' as const, data: { response: panelRow(patch) } };
}

/**
 * A processor over one UPDATE (or TRAFFIC_RESET) job whose subscription is in
 * `status` when the answer comes back — the status the row lock reads.
 */
function updateJobProcessor(options: {
  readonly status: SubscriptionStatus;
  readonly action?: SyncAction;
  readonly payload?: Record<string, unknown>;
  readonly answer?: Record<string, unknown>;
  readonly resetAnswer?: Record<string, unknown>;
}) {
  const recorder = stampRecorder();
  const termAnchors: Array<{ where: unknown; data: { resetAnchorAt: Date } }> = [];
  const job = {
    id: 'sync-job-facts',
    action: options.action ?? SyncAction.UPDATE,
    status: SyncJobStatus.PENDING,
    attempts: 0,
    supersededAt: null,
    payload: options.payload ?? {},
    subscription: {
      id: 'subscription-facts',
      userId: 'user-facts',
      remnawaveId: '4711',
      remnawavePanelId: 4711,
      remnawavePanelUsername: 'rz_facts',
      configUrl: null,
      trafficLimit: 50,
      deviceLimit: 2,
      internalSquads: [],
      externalSquad: null,
      status: options.status,
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      planSnapshot: { trafficLimitStrategy: 'MONTH_ROLLING' },
    },
  };
  const tx = {
    $executeRaw: recorder.$executeRaw,
    $queryRaw: async () => [{ status: options.status }],
    subscriptionTerm: {
      updateMany: async (input: { where: unknown; data: { resetAnchorAt: Date } }) => {
        termAnchors.push(input);
        return { count: 1 };
      },
    },
    profileSyncJob: {
      findMany: async () => [],
      create: async () => ({ id: 'compensating-delete' }),
    },
  };
  const processor = new ProfileSyncProcessor(
    {
      profileSyncJob: {
        findUnique: async () => job,
        updateMany: async () => ({ count: 1 }),
        update: async () => undefined,
      },
      subscription: { updateMany: async () => ({ count: 0 }), findUnique: async () => null },
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    } as never,
    {
      updateUser: async () => panelOk(options.answer),
      resetTraffic: async () => panelOk(options.resetAnswer ?? { lastTrafficResetAt: RESET_JUST_NOW.toISOString() }),
    } as never,
    {
      generateProfileName: async () => ({ username: 'rz_facts', description: 'facts' }),
      getContactInfo: async () => ({ email: null, telegramId: null }),
    } as never,
    { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    { enqueue: async () => undefined } as never,
  );
  return { processor, stamps: recorder.stamps, termAnchors };
}

describe('profile sync — the PATCH answer is stamped whatever the status', () => {
  for (const status of [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.LIMITED,
    SubscriptionStatus.EXPIRED,
    SubscriptionStatus.DISABLED,
  ]) {
    it(`stamps both facts, and the rolling anchor, while ${status}`, async () => {
      const { processor, stamps, termAnchors } = updateJobProcessor({ status });

      await processor.process({ data: { syncJobId: 'sync-job-facts' } } as never);

      assert.equal(stamps.length, 1, 'one stamp of the answer');
      assert.deepEqual(stamps[0]!.ids, ['subscription-facts']);
      assert.ok(carries(stamps[0], CREATED_AT), 'the profile createdAt');
      assert.ok(carries(stamps[0], LAST_RESET), 'the profile lastTrafficResetAt');
      assert.deepEqual(termAnchors, [
        {
          where: {
            subscriptionId: 'subscription-facts',
            status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
            trafficResetStrategy: TrafficLimitStrategy.MONTH_ROLLING,
          },
          data: { resetAnchorAt: CREATED_AT },
        },
      ]);
    });
  }

  it('stamps nothing on a row deleted while the PATCH ran: it is retired', async () => {
    const { processor, stamps, termAnchors } = updateJobProcessor({ status: SubscriptionStatus.DELETED });
    await processor.process({ data: { syncJobId: 'sync-job-facts' } } as never);
    assert.deepEqual(stamps, []);
    assert.deepEqual(termAnchors, []);
  });

  it('stamps the reset a renewal made, from the reset answer rather than the PATCH before it', async () => {
    const { processor, stamps } = updateJobProcessor({
      status: SubscriptionStatus.LIMITED,
      payload: { resetTraffic: true },
    });

    await processor.process({ data: { syncJobId: 'sync-job-facts' } } as never);

    assert.equal(stamps.length, 1);
    assert.ok(carries(stamps[0], RESET_JUST_NOW), 'the reset the renewal just made');
    assert.ok(!carries(stamps[0], LAST_RESET), 'not the PATCH answer from before it');
  });

  it('writes no anchor for an answer without a createdAt, and never null over the stored one', async () => {
    const { processor, stamps, termAnchors } = updateJobProcessor({
      status: SubscriptionStatus.LIMITED,
      answer: { createdAt: undefined },
    });
    await processor.process({ data: { syncJobId: 'sync-job-facts' } } as never);
    assert.equal(stamps.length, 1, 'the reset is still a fact worth stamping');
    assert.ok(carries(stamps[0], LAST_RESET));
    assert.deepEqual(termAnchors, []);
  });
});

describe('profile sync — the operator\'s «Сбросить» answer is stamped', () => {
  it('records the reset the TRAFFIC_RESET job just made, on a LIMITED row', async () => {
    const { processor, stamps } = updateJobProcessor({
      status: SubscriptionStatus.LIMITED,
      action: SyncAction.TRAFFIC_RESET,
    });

    await processor.process({ data: { syncJobId: 'sync-job-facts' } } as never);

    assert.equal(stamps.length, 1);
    assert.deepEqual(stamps[0]!.ids, ['subscription-facts']);
    assert.ok(carries(stamps[0], RESET_JUST_NOW));
  });
});

describe('profile sync — the CREATE answer is stamped', () => {
  it('records the new profile facts with the link, on a LIMITED row', async () => {
    const recorder = stampRecorder();
    const termAnchors: unknown[] = [];
    const processor = new ProfileSyncProcessor(
      {
        profileSyncJob: {
          findUnique: async () => ({
            id: 'sync-job-create',
            action: SyncAction.CREATE,
            status: SyncJobStatus.PENDING,
            attempts: 0,
            subscription: {
              id: 'subscription-created',
              userId: 'user-created',
              remnawaveId: null,
              status: SubscriptionStatus.LIMITED,
              trafficLimit: 5,
              deviceLimit: 1,
              internalSquads: [],
              externalSquad: null,
              expiresAt: new Date('2027-02-01T00:00:00.000Z'),
              planSnapshot: { trafficLimitStrategy: 'MONTH_ROLLING' },
            },
          }),
          updateMany: async () => ({ count: 1 }),
          update: async () => undefined,
        },
        subscription: { update: async () => undefined, updateMany: async () => ({ count: 1 }) },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            $executeRaw: recorder.$executeRaw,
            $queryRaw: async () => [{ status: SubscriptionStatus.LIMITED }],
            subscription: { update: async () => undefined },
            subscriptionTerm: {
              updateMany: async (input: unknown) => {
                termAnchors.push(input);
                return { count: 1 };
              },
            },
            profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused' }) },
          }),
      } as never,
      {
        getUserByUsername: async () => ({
          kind: 'rejected',
          status: 404,
          code: 'A063',
          detail: 'User with specified params not found',
          retryAfterMs: null,
        }),
        createUser: async () => panelOk({ id: 4472, username: 'rz_created', lastTrafficResetAt: null }),
      } as never,
      {
        generateProfileName: async () => ({ username: 'rz_created', description: 'created' }),
        getContactInfo: async () => ({ email: null, telegramId: null }),
      } as never,
      { error: () => undefined, info: () => undefined, warn: () => undefined } as never,
    );

    await processor.process({ data: { syncJobId: 'sync-job-create' } } as never);

    assert.equal(recorder.stamps.length, 1);
    assert.deepEqual(recorder.stamps[0]!.ids, ['subscription-created']);
    assert.ok(carries(recorder.stamps[0], CREATED_AT));
    assert.equal(termAnchors.length, 1, 'the rolling term takes the new profile anchor too');
  });
});

// ── The webhook ─────────────────────────────────────────────────────────────

function webhookOver(rows: ReadonlyArray<{ id: string }>) {
  const recorder = stampRecorder();
  const finds: unknown[] = [];
  const prisma = {
    remnawaveWebhookEvent: { create: async () => ({}) },
    subscription: {
      findMany: async (input: unknown) => {
        finds.push(input);
        return rows;
      },
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
    },
    user: { findFirst: async () => null, findUnique: async () => null },
    subscriptionConnectState: { findUnique: async () => null },
    $executeRaw: recorder.$executeRaw,
    $queryRaw: async () => [],
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new RemnawaveWebhookService(
    prisma as never,
    { webhookSecret: 'secret' } as never,
    { emit: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    { getPanelUserUsage: async () => null } as never,
    { build: async () => ({}) } as never,
    { create: async () => undefined } as never,
  );
  return { service, stamps: recorder.stamps, finds };
}

describe('the Remnawave webhook — every user event carries the facts', () => {
  it('stamps the rows the event names, a LIMITED one lifted by a scheduled reset included', async () => {
    const { service, stamps, finds } = webhookOver([{ id: 'sub-limited' }]);

    await service.handleEvent(
      'user.enabled',
      {
        scope: 'user',
        event: 'user.enabled',
        timestamp: '2026-09-25T00:10:01.000Z',
        data: {
          id: 4711,
          status: 'ACTIVE',
          createdAt: CREATED_AT.toISOString(),
          lastTrafficResetAt: LAST_RESET.toISOString(),
        },
      },
      null,
    );

    assert.equal(stamps.length, 1);
    assert.deepEqual(stamps[0]!.ids, ['sub-limited']);
    assert.ok(carries(stamps[0], CREATED_AT));
    assert.ok(carries(stamps[0], LAST_RESET));
    // Through the identity rule every consumer here shares, and never a DELETED row.
    const where = (finds[finds.length - 1] as { where: Record<string, unknown> }).where;
    assert.deepEqual(where, {
      OR: [{ remnawaveId: '4711' }, { remnawavePanelId: 4711 }],
      status: { not: SubscriptionStatus.DELETED },
    });
  });

  it('costs no statement for an event that carries neither fact', async () => {
    const { service, stamps } = webhookOver([{ id: 'sub-any' }]);
    await service.handleEvent('user.modified', { scope: 'user', data: { id: 4711, status: 'ACTIVE' } }, null);
    assert.deepEqual(stamps, []);
  });
});

// ── ↻ and the importer ──────────────────────────────────────────────────────

describe('↻ — the refresh stamps what it read', () => {
  it('stamps both facts of the profile it read, whatever the row status', async () => {
    const recorder = stampRecorder();
    const stored: Record<string, unknown> = {
      remnawaveId: 'rem-user-1',
      remnawavePanelId: 4471,
      remnawavePanelUsername: 'rz_bob_1',
      userId: 'user-1',
      status: SubscriptionStatus.LIMITED,
      trafficLimit: 10,
      deviceLimit: 1,
      internalSquads: [],
      externalSquad: null,
      expiresAt: new Date('2027-03-01T00:00:00.000Z'),
      planSnapshot: {},
      configUrl: null,
    };
    const db = {
      subscription: {
        findUnique: async () => ({ ...stored }),
        update: async () => ({ ...stored }),
      },
      adminAuditLog: { create: async () => ({}) },
      $executeRaw: recorder.$executeRaw,
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
    };
    const controller = new AdminUserSubscriptionsController(
      db as never,
      {
        getPanelUserOutcome: async () => ({
          kind: 'ok',
          user: {
            uuid: '4471',
            username: 'rz_bob_1',
            status: 'LIMITED',
            subscriptionUrl: 'https://panel.example.test/sub/fresh',
            telegramId: null,
            panelId: 4471,
            email: null,
            expireAt: '2027-03-01T00:00:00.000Z',
            createdAt: CREATED_AT.toISOString(),
            lastTrafficResetAt: LAST_RESET.toISOString(),
            trafficLimitBytes: 0,
            hwidDeviceLimit: 0,
            trafficLimitStrategy: 'MONTH_ROLLING',
            tag: null,
            description: null,
            activeInternalSquads: [],
            externalSquadUuid: null,
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      NOT_IN_TERM_MODEL as never,
    );

    await controller.syncSubscription('sub-refreshed', { id: 'admin-1' } as never, {
      headers: {},
      ip: '10.0.0.7',
      socket: { remoteAddress: null },
    } as never);

    assert.equal(recorder.stamps.length, 1);
    assert.deepEqual(recorder.stamps[0]!.ids, ['sub-refreshed']);
    assert.ok(carries(recorder.stamps[0], CREATED_AT));
    assert.ok(carries(recorder.stamps[0], LAST_RESET));
  });
});

describe('the Remnawave importer — a matched row is stamped, a new row is born with the facts', () => {
  function importerOver(existing: Record<string, unknown> | null) {
    const recorder = stampRecorder();
    const creates: Array<Record<string, unknown>> = [];
    const prisma = {
      subscription: {
        findFirst: async () => existing,
        update: async () => existing,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          creates.push(data);
          return { id: 'created-sub' };
        },
      },
      user: { findUnique: async () => ({ currentSubscriptionId: 'already' }) },
      $executeRaw: recorder.$executeRaw,
    };
    const service = new RemnawaveImporterService(prisma as never, {} as never);
    return { service, stamps: recorder.stamps, creates };
  }

  const PANEL_USER = {
    uuid: '4480',
    username: 'rz_imported',
    status: 'LIMITED',
    subscriptionUrl: 'https://panel.example.test/sub/imported',
    telegramId: null,
    panelId: 4480,
    email: null,
    expireAt: '2027-04-01T00:00:00.000Z',
    createdAt: CREATED_AT.toISOString(),
    lastTrafficResetAt: LAST_RESET.toISOString(),
    trafficLimitBytes: 0,
    hwidDeviceLimit: 0,
    trafficLimitStrategy: 'MONTH_ROLLING',
    tag: null,
    description: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  };

  type SyncSubscription = (
    userId: string,
    panelUser: unknown,
    importRecordId: string | null,
    readAt: Date,
  ) => Promise<'created' | 'updated' | 'skipped'>;

  it('stamps a row it matched', async () => {
    const { service, stamps } = importerOver({
      id: 'matched-sub',
      userId: 'user-1',
      planSnapshot: {},
      remnawaveId: '4480',
      trafficLimit: null,
      deviceLimit: 0,
      expiresAt: new Date('2027-04-01T00:00:00.000Z'),
    });
    const sync = (service as unknown as { syncSubscription: SyncSubscription }).syncSubscription.bind(service);
    assert.equal(await sync('user-1', PANEL_USER, null, new Date('2026-09-25T06:00:00.000Z')), 'updated');
    assert.equal(stamps.length, 1);
    assert.deepEqual(stamps[0]!.ids, ['matched-sub']);
    assert.ok(carries(stamps[0], CREATED_AT));
    assert.ok(carries(stamps[0], LAST_RESET));
  });

  it('creates a row with both facts', async () => {
    const { service, creates } = importerOver(null);
    const sync = (service as unknown as { syncSubscription: SyncSubscription }).syncSubscription.bind(service);
    assert.equal(await sync('user-1', PANEL_USER, null, new Date('2026-09-25T06:00:00.000Z')), 'created');
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0]!['remnawaveProfileCreatedAt'], CREATED_AT);
    assert.deepEqual(creates[0]!['remnawaveLastTrafficResetAt'], LAST_RESET);
  });
});
