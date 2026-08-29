import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { BulkUserOperationsService } from '../src/modules/users/services/bulk-user-operations.service';

/**
 * The bulk actions that reach the VPN panel and the subscription rows.
 *
 * ── What is worth pinning ────────────────────────────────────────────────
 *
 * A bulk run reports per row, so the interesting cases are the ones where a
 * plausible implementation reports the wrong thing: an account with no
 * subscriptions counted as a success, a partial failure counted as either a
 * success or a total failure, and a compensation that lands in the past.
 */

const ADMIN = { id: 'admin-1' } as never;
const REQUEST_METADATA = { requestId: null, remoteAddress: null, userAgent: null };
const NOW = Date.now();

function buildService(options: {
  readonly subscriptions?: ReadonlyArray<Record<string, unknown>>;
  readonly panelThrowsOn?: number;
  readonly withoutPanel?: boolean;
  /** 1-based index of the `subscription.update` call that should throw. */
  readonly updateThrowsOn?: number;
} = {}) {
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const syncJobs: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  let panelCall = 0;

  const prisma = {
    user: {
      findFirst: async () => ({ id: 'user-1', telegramId: 42n, isBlocked: false }),
    },
    subscription: {
      findMany: async () =>
        options.subscriptions ?? [
          {
            id: 'sub-1',
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date(NOW + 5 * 24 * 60 * 60 * 1000),
            remnawaveId: '4711',
            remnawavePanelId: 4711,
            remnawavePanelUsername: 'rz_one',
          },
        ],
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        if (options.updateThrowsOn === updates.length) {
          throw new Error('serialization failure');
        }
        return {};
      },
    },
    profileSyncJob: {
      create: async (args: { data: Record<string, unknown> }) => {
        syncJobs.push(args.data);
        return { id: `job-${syncJobs.length}` };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audit.push(args.data);
        return args.data;
      },
    },
  };

  const remnawave = {
    getPanelShape: async () => ({ addressing: 'numeric', connectionsApi: 'connections' }),
    resetPanelUserTraffic: async () => {
      panelCall += 1;
      calls.push('reset')
      if (options.panelThrowsOn === panelCall) throw new Error('panel refused');
    },
    deleteAllPanelUserDevices: async () => {
      panelCall += 1;
      calls.push('revoke')
      if (options.panelThrowsOn === panelCall) throw new Error('panel refused');
      return { total: 0 };
    },
  };

  const service = new BulkUserOperationsService(
    prisma as never,
    { warn: () => undefined, info: () => undefined } as never,
    { deleteUser: async () => undefined } as never,
    { block: async () => undefined, unblock: async () => undefined } as never,
    // Grants everything: these specs are about what the bulk actions DO, not
    // about who may run them. The permission split has its own spec.
      { hasPermission: async () => true } as never,
    options.withoutPanel === true ? undefined : (remnawave as never),
    { enqueue: async () => undefined } as never,
  );

  const run = (action: string, payload?: Record<string, unknown>) =>
    service.execute({
      userIds: ['user-1'],
      action: action as never,
      payload,
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
    });

  return { run, calls, updates, syncJobs, audit };
}

describe('resetting traffic in bulk', () => {
  it('resets every linked profile and records what landed', async () => {
    const { run, calls, audit } = buildService();
    const result = await run('reset_traffic');

    assert.deepStrictEqual(calls, ['reset']);
    assert.equal(result.succeeded, 1);
    assert.equal((audit[0]['metadata'] as { profiles: number }).profiles, 1);
  });

  it('reports a partial failure as an error, not as a success', async () => {
    // Two profiles, one refused. Reporting `ok` would tell an operator their
    // reset reached everybody; reporting a bare failure would hide the one that
    // did land.
    const { run } = buildService({
      subscriptions: [
        { id: 'sub-1', status: 'ACTIVE', expiresAt: null, remnawaveId: '1', remnawavePanelId: 1, remnawavePanelUsername: 'a' },
        { id: 'sub-2', status: 'ACTIVE', expiresAt: null, remnawaveId: '2', remnawavePanelId: 2, remnawavePanelUsername: 'b' },
      ],
      panelThrowsOn: 2,
    });
    const result = await run('reset_traffic');

    assert.equal(result.failed, 1);
    assert.match(result.items[0].message ?? '', /1 of 2/);
  });

  it('skips an account with nothing linked instead of claiming success', async () => {
    // "There was nothing to do" is not the same answer as "it is done", and an
    // operator counting a hundred successes over six real profiles is being
    // told the wrong thing.
    const { run, calls } = buildService({ subscriptions: [] });
    const result = await run('reset_traffic');

    assert.deepStrictEqual(calls, []);
    assert.equal(result.skipped, 1);
    assert.match(result.items[0].message ?? '', /No linked/);
  });

  it('says so when the VPN panel is not configured at all', async () => {
    // A different problem from "this user has no profiles", and an operator can
    // act on exactly one of them.
    const { run } = buildService({ withoutPanel: true });
    const result = await run('reset_traffic');

    assert.equal(result.skipped, 1);
    assert.match(result.items[0].message ?? '', /not configured/);
  });
});

describe('re-syncing profiles in bulk', () => {
  it('queues a job rather than calling the panel', async () => {
    // The action exists to repair drift after the panel was unreachable. Doing
    // it with a call that needs the panel reachable now would fail exactly when
    // it is wanted.
    const { run, calls, syncJobs } = buildService();
    await run('resync_profiles');

    assert.deepStrictEqual(calls, []);
    assert.equal(syncJobs.length, 1);
    assert.deepStrictEqual(syncJobs[0]['payload'], {
      source: 'BULK_RESYNC',
      propagateStatus: false,
    });
  });
});

describe('extending subscriptions in bulk', () => {
  it('refuses a nonsense number of days', async () => {
    const { run, updates } = buildService();
    const result = await run('extend_subscription', { days: 0 });
    assert.equal(result.skipped, 1);
    assert.deepStrictEqual(updates, []);
  });

  it('adds days to the existing expiry when it is still ahead', async () => {
    const { run, updates } = buildService();
    await run('extend_subscription', { days: 3 });

    const expiresAt = (updates[0]['data'] as { expiresAt: Date }).expiresAt;
    assert.equal(expiresAt.getTime(), NOW + 8 * 24 * 60 * 60 * 1000);
  });

  it('measures from now when the subscription already lapsed', async () => {
    // Adding to a date in the past hands somebody three days that expired last
    // week — the opposite of what a compensation is for.
    const past = new Date(NOW - 10 * 24 * 60 * 60 * 1000);
    const { run, updates } = buildService({
      subscriptions: [
        {
          id: 'sub-1',
          status: SubscriptionStatus.EXPIRED,
          expiresAt: past,
          remnawaveId: '4711',
          remnawavePanelId: 4711,
          remnawavePanelUsername: 'rz_one',
        },
      ],
    });
    await run('extend_subscription', { days: 3 });

    const data = updates[0]['data'] as { expiresAt: Date; status?: string };
    assert.ok(data.expiresAt.getTime() > NOW, 'the new expiry must be in the future');
    // And the row comes back to life: a longer expiry on a row the product
    // still treats as finished is a customer with no VPN and a later date.
    assert.equal(data.status, SubscriptionStatus.ACTIVE);
  });

  it('pushes the status upstream for a revived row', async () => {
    const { run, syncJobs } = buildService({
      subscriptions: [
        {
          id: 'sub-1',
          status: SubscriptionStatus.EXPIRED,
          expiresAt: new Date(NOW - 1000),
          remnawaveId: '4711',
          remnawavePanelId: 4711,
          remnawavePanelUsername: 'rz_one',
        },
      ],
    });
    await run('extend_subscription', { days: 1 });

    assert.deepStrictEqual(syncJobs[0]['payload'], {
      source: 'BULK_EXTEND',
      propagateStatus: true,
    });
  });
});

describe('the action list', () => {
  it('is the same in the request DTO and the service', () => {
    // `class-validator` needs runtime values, so the accepted list is a literal
    // beside the union. A decorator that drifted would accept an action the
    // service cannot dispatch — answered with a 200 and an error row per user,
    // not with a 400.
    const dto = readFileSync(
      resolve(__dirname, '..', 'src/modules/users/dto/bulk-user-operations.dto.ts'),
      'utf8',
    );
    const service = readFileSync(
      resolve(__dirname, '..', 'src/modules/users/services/bulk-user-operations.service.ts'),
      'utf8',
    );

    const accepted = [...(/@IsIn\(\[([\s\S]*?)\]\)/.exec(dto)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)]
      .map((match) => match[1])
      .sort();
    const declared = [
      ...(
        /export type BulkUserAction =([\s\S]*?);/.exec(service)?.[1] ?? ''
      ).matchAll(/'([a-z_]+)'/g),
    ]
      .map((match) => match[1])
      .sort();

    assert.ok(declared.length > 0, 'could not read the action union');
    assert.deepStrictEqual(accepted, declared);
  });
});

describe('an extension that fell short says so, and says how far it got', () => {
  const TWO_SUBS = [
    {
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date(NOW + 5 * 24 * 60 * 60 * 1000),
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
    },
    {
      id: 'sub-2',
      status: SubscriptionStatus.ACTIVE,
      expiresAt: new Date(NOW + 5 * 24 * 60 * 60 * 1000),
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
    },
  ];

  it('records the subscriptions that DID move before the failure', async () => {
    // THE case. The loop had no per-subscription guard, so a throw on the
    // second row propagated out, the row was reported `error`, and the first
    // subscription was already extended in the database with no audit evidence
    // at all. An operator re-running that id then extends it twice while the
    // trail says once.
    const { run, audit } = buildService({ subscriptions: TWO_SUBS, updateThrowsOn: 2 });

    const result = await run('extend_subscription', { days: 3 });

    assert.equal(result.failed, 1);
    assert.equal(audit.length, 1);
    const metadata = audit[0]['metadata'] as { subscriptions: number; partial?: boolean };
    assert.equal(metadata.subscriptions, 1);
    assert.equal(metadata.partial, true);
  });

  it('tells the operator how many landed, because that decides whether a re-run is safe', async () => {
    const { run } = buildService({ subscriptions: TWO_SUBS, updateThrowsOn: 2 });

    const result = await run('extend_subscription', { days: 3 });

    assert.match(String(result.items[0].message), /Extended 1 of 2/);
  });

  it('writes no audit row when the very first subscription failed', async () => {
    // Nothing moved, so there is nothing to record — and a row claiming an
    // extension that did not happen is worse than no row.
    const { run, audit } = buildService({ subscriptions: TWO_SUBS, updateThrowsOn: 1 });

    const result = await run('extend_subscription', { days: 3 });

    assert.equal(result.failed, 1);
    assert.deepStrictEqual(audit, []);
  });
});
