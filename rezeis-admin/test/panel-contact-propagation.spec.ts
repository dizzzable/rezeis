import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { AdminUserWebController } from '../src/modules/users/controllers/admin-user-web.controller';
import { ProfileSyncQueueService } from '../src/modules/profile-sync/profile-sync-queue.service';
import { RemnawaveProfileNamingService } from '../src/modules/profile-sync/remnawave-profile-naming.service';

/**
 * What the VPN profile is told about the customer, and when.
 *
 * ── Two ways the same fact went stale ────────────────────────────────────
 *
 * The sync payload has always carried the Telegram id and the e-mail, and the
 * processor has always sent them. Neither ever reached the panel reliably:
 *
 *   • nothing enqueued a job when the CONTACT changed, so binding a Telegram id
 *     wrote the local column and left the profile showing the old one until an
 *     unrelated edit happened to push — on an account nobody edits again, that
 *     is forever;
 *   • the e-mail was read from `User.email` alone, a column social sign-up
 *     deliberately leaves unset, so every Google / Yandex / Mail.ru customer
 *     pushed a NULL address while the panel screen beside it showed one.
 */

describe('what the panel is told the e-mail is', () => {
  function buildNaming(user: Record<string, unknown> | null) {
    return new RemnawaveProfileNamingService({ user: { findUnique: async () => user } } as never);
  }

  it('prefers the canonical column when it is set', async () => {
    const naming = buildNaming({
      telegramId: 42n,
      email: 'canonical@example.com',
      webAccount: { email: 'other@example.com', emailNormalized: 'other@example.com' },
    });
    assert.equal((await naming.getContactInfo('user-1')).email, 'canonical@example.com');
  });

  it('falls back to the account the customer signs in with', async () => {
    // The case that was broken for every social sign-up: `User.email` is a
    // unique column that OAuth registration deliberately leaves unset, because
    // the identity lives on the `WebAccount` and setting both would collide
    // with an imported row carrying the same address.
    const naming = buildNaming({
      telegramId: null,
      email: null,
      webAccount: { email: 'Web@Example.com', emailNormalized: 'web@example.com' },
    });
    assert.equal((await naming.getContactInfo('user-1')).email, 'Web@Example.com');
  });

  it('uses the normalised form when the typed one is missing', async () => {
    const naming = buildNaming({
      telegramId: null,
      email: null,
      webAccount: { email: null, emailNormalized: 'web@example.com' },
    });
    assert.equal((await naming.getContactInfo('user-1')).email, 'web@example.com');
  });

  it('reports no e-mail when there genuinely is none', async () => {
    // A bot-only customer. `null` is the honest answer and the panel field is
    // left empty rather than filled with something invented.
    const naming = buildNaming({ telegramId: 42n, email: null, webAccount: null });
    assert.equal((await naming.getContactInfo('user-1')).email, null);
  });
});

describe('pushing a contact change to the panel', () => {
  function buildQueue(subscriptions: ReadonlyArray<Record<string, unknown>>) {
    const jobs: Array<Record<string, unknown>> = [];
    const queries: Array<Record<string, unknown>> = [];
    const service = new ProfileSyncQueueService(
      {
        subscription: {
          findMany: async (args: { where: Record<string, unknown> }) => {
            queries.push(args.where);
            return subscriptions;
          },
        },
        profileSyncJob: {
          create: async (args: { data: Record<string, unknown> }) => {
            jobs.push(args.data);
            return { id: `job-${jobs.length}` };
          },
          findUnique: async () => null,
        },
      } as never,
      { add: async () => undefined, remove: async () => undefined } as never,
    );
    return { service, jobs, queries };
  }

  it('queues one job per linked profile', async () => {
    const { service, jobs } = buildQueue([{ id: 'sub-1' }, { id: 'sub-2' }]);
    const queued = await service.enqueueContactRefresh('user-1');

    assert.equal(queued, 2);
    assert.deepStrictEqual(jobs[0]['payload'], {
      source: 'CONTACT_REFRESH',
      propagateStatus: false,
    });
  });

  it('never asserts a status', async () => {
    // A contact change says nothing about whether the subscription should be
    // enabled. Pushing the local column as a side effect of correcting an
    // e-mail would send a value `AutoRenewService` may have moved a minute ago.
    const { service, jobs } = buildQueue([{ id: 'sub-1' }]);
    await service.enqueueContactRefresh('user-1');
    assert.equal((jobs[0]['payload'] as { propagateStatus: boolean }).propagateStatus, false);
  });

  it('skips rows with no upstream profile', async () => {
    // A job for an unlinked row is delegated to CREATE by the processor, which
    // would provision a profile as a side effect of an e-mail edit.
    const { service, queries } = buildQueue([]);
    await service.enqueueContactRefresh('user-1');

    assert.deepStrictEqual(queries[0]['remnawaveId'], { not: null });
    assert.deepStrictEqual(queries[0]['status'], { not: SubscriptionStatus.DELETED });
  });
});

describe('binding a Telegram id', () => {
  // `withoutQueue` and not `queue: undefined`: the absent-dependency case is
  // exactly `undefined`, so an options bag that spells it that way cannot
  // tell 'not supplied' from 'supplied as absent' — and the test would
  // silently exercise the happy path instead.
  function buildController(options: { readonly withoutQueue?: boolean } = {}) {
    const refreshed: string[] = [];
    const controller = new AdminUserWebController(
      {
        user: {
          // `findUnique` serves two different questions here — the route param
          // lookup (by id) and the conflict check (by telegram id) — so the
          // fake has to answer on the shape of the `where`, not on the method.
          findUnique: async (args: { where: Record<string, unknown> }) =>
            'id' in args.where ? { id: 'user-1', telegramId: null } : null,
          findFirst: async () => null,
          update: async () => ({}),
        },
        adminAuditLog: { create: async () => ({}) },
      } as never,
      {} as never,
      {} as never,
      options.withoutQueue === true
        ? (undefined as never)
        : ({
            enqueueContactRefresh: async (userId: string) => {
              refreshed.push(userId)
              return 2
            },
          } as never),
    );
    return { controller, refreshed };
  }

  it('pushes the new id to the VPN profiles', async () => {
    const { controller, refreshed } = buildController();
    const result = await controller.bindTelegramId(
      'user-1',
      { telegramId: '123456789' } as never,
      { id: 'admin-1' } as never,
      { headers: {}, socket: {} } as never,
    );

    assert.deepStrictEqual(refreshed, ['user-1']);
    assert.equal((result as { syncedProfiles?: number }).syncedProfiles, 2);
  });

  it('still binds when the queue is unavailable', async () => {
    // The edit is done and audited by then. A queue hiccup must not turn a
    // completed binding into an error the operator has to interpret.
    const { controller } = buildController({ withoutQueue: true });
    const result = await controller.bindTelegramId(
      'user-1',
      { telegramId: '123456789' } as never,
      { id: 'admin-1' } as never,
      { headers: {}, socket: {} } as never,
    );
    assert.equal((result as { changed: boolean }).changed, true);
  });
});
