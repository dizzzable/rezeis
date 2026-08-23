import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';

import { BadRequestException, ConflictException, HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AdminWebPushSubscription, WebPushSubscription } from '@prisma/client';
import * as webpush from 'web-push';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalPushController } from '../src/modules/push/internal-push.controller';
import { WebPushService } from '../src/modules/push/services/web-push.service';

const requireWebPush = createRequire(__filename);
const mutableWebPush = requireWebPush('web-push') as typeof webpush;
const originalSendNotification = mutableWebPush.sendNotification;

afterEach(() => {
  setWebPushSendNotification(originalSendNotification);
  clearVapidEnv();
});

describe('InternalPushController', () => {
  it('exposes current internal push route contracts and guard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalPushController), 'internal/push');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalPushController), [
      InternalAdminAuthGuard,
    ]);
    assert.deepStrictEqual(route('getPublicKey'), {
      path: 'public-key',
      method: RequestMethod.GET,
      httpCode: undefined,
    });
    assert.deepStrictEqual(route('subscribe'), {
      path: 'subscribe',
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
    assert.deepStrictEqual(route('unsubscribe'), {
      path: 'unsubscribe',
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
  });

  it('delegates public key, subscribe, and unsubscribe to WebPushService', async () => {
    const calls: unknown[] = [];
    const webPushService = {
      getPublicKey: async () => 'public-key-1',
      subscribe: async (input: unknown) => {
        calls.push(['subscribe', input]);
        return { id: 'subscription-1' };
      },
      unsubscribe: async (input: unknown) => {
        calls.push(['unsubscribe', input]);
      },
    } as unknown as WebPushService;
    const controller = new InternalPushController(webPushService);

    assert.deepStrictEqual(await controller.getPublicKey(), { publicKey: 'public-key-1' });
    assert.deepStrictEqual(
      await controller.subscribe({
        userId: 'user-1',
        userAgent: 'Mozilla/5.0',
        subscription: {
          endpoint: 'https://push.example.test/subscription-1',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        },
      }),
      { success: true },
    );
    assert.deepStrictEqual(
      await controller.unsubscribe({
        userId: 'user-1',
        endpoint: 'https://push.example.test/subscription-1',
      }),
      { success: true },
    );

    assert.deepStrictEqual(calls, [
      [
        'subscribe',
        {
          userId: 'user-1',
          endpoint: 'https://push.example.test/subscription-1',
          p256dhKey: 'p256dh-key',
          authKey: 'auth-key',
          userAgent: 'Mozilla/5.0',
        },
      ],
      ['unsubscribe', { userId: 'user-1', endpoint: 'https://push.example.test/subscription-1' }],
    ]);
  });

  it('rejects invalid subscribe and unsubscribe payloads before service calls', async () => {
    const calls: unknown[] = [];
    const controller = new InternalPushController({
      getPublicKey: async () => '',
      subscribe: async (input: unknown) => {
        calls.push(['subscribe', input]);
      },
      unsubscribe: async (input: unknown) => {
        calls.push(['unsubscribe', input]);
      },
    } as unknown as WebPushService);

    await assert.rejects(
      controller.subscribe({
        userId: 'user-1',
        subscription: { endpoint: 'https://push.example.test/subscription-1', keys: {} },
      }),
      (error: unknown) => {
        assert.equal(error instanceof BadRequestException, true);
        assert.equal((error as Error).message, 'Invalid subscribe payload');
        return true;
      },
    );
    await assert.rejects(
      controller.unsubscribe({ userId: 'user-1' }),
      (error: unknown) => {
        assert.equal(error instanceof BadRequestException, true);
        assert.equal((error as Error).message, 'Invalid unsubscribe payload');
        return true;
      },
    );

    assert.deepStrictEqual(calls, []);
  });
});

describe('WebPushService', () => {
  it('returns the configured public key exactly as the SPA expects it', async () => {
    const { service } = createService({ webPushConfig: TEST_VAPID });

    assert.equal(await service.getPublicKey(), 'public-key-1');
  });

  it('upserts browser subscriptions by endpoint and resets failure state on refresh', async () => {
    const { service, state } = createService({ upsertResult: { id: 'subscription-1' } });

    const result = await service.subscribe({
      userId: 'user-1',
      endpoint: 'https://push.example.test/subscription-1',
      p256dhKey: 'p256dh-key',
      authKey: 'auth-key',
      userAgent: 'Mozilla/5.0',
    });

    assert.deepStrictEqual(result, { id: 'subscription-1' });
    assert.equal(state.upsertCalls.length, 1);
    assert.deepStrictEqual(state.upsertCalls[0], {
      where: { endpoint: 'https://push.example.test/subscription-1' },
      create: {
        userId: 'user-1',
        endpoint: 'https://push.example.test/subscription-1',
        p256dhKey: 'p256dh-key',
        authKey: 'auth-key',
        userAgent: 'Mozilla/5.0',
      },
      update: {
        userId: 'user-1',
        p256dhKey: 'p256dh-key',
        authKey: 'auth-key',
        userAgent: 'Mozilla/5.0',
        failureCount: 0,
        lastSeenAt: state.upsertCalls[0]?.update.lastSeenAt,
      },
      select: { id: true },
    });
    assert.equal(state.upsertCalls[0]?.update.lastSeenAt instanceof Date, true);
  });

  it('hands a shared browser to whoever signed in last, unlike the admin path', async () => {
    // This is the decision, not an accident of the query shape. The same
    // `upsert({ where: { endpoint } })` on the admin side let one admin take
    // another's row and had to be split into an ownership-scoped `updateMany`
    // plus a `create` that 409s (see the ownership suite below). Here it stays,
    // for reasons that live in the doc comment on `subscribe()`:
    //
    //   - `internal/push/subscribe` is behind `InternalAdminAuthGuard` and the
    //     cabinet's BFF fills `userId` from a session it already verified, so
    //     no subscriber can name another subscriber;
    //   - an endpoint reaches logs that admins read, and subscribers do not,
    //     so there is no channel to learn one;
    //   - a shared browser is the only remaining case, and there the newest
    //     sign-in SHOULD own it. The cabinet re-registers once per session, so
    //     the row follows the account that is actually signed in.
    //
    // Refusing here instead would leave the second person on a shared computer
    // with no push until the first one's row is deleted.
    const { service, state } = createService({ upsertResult: { id: 'subscription-1' } });
    const endpoint = 'https://push.example.test/shared-browser';

    await service.subscribe({
      userId: 'user-a',
      endpoint,
      p256dhKey: 'p256dh-a',
      authKey: 'auth-a',
      userAgent: 'Mozilla/5.0',
    });
    await service.subscribe({
      userId: 'user-b',
      endpoint,
      p256dhKey: 'p256dh-b',
      authKey: 'auth-b',
      userAgent: 'Mozilla/5.0',
    });

    assert.equal(state.upsertCalls.length, 2, 'both sign-ins reach the database');
    assert.equal(
      state.upsertCalls[1]?.where.endpoint,
      endpoint,
      'the second sign-in addresses the same row rather than creating a second one',
    );
    assert.equal(
      state.upsertCalls[1]?.update.userId,
      'user-b',
      'the browser follows the account signed in now — removing this line is the change that needs a decision, not a fix',
    );
    assert.equal(
      state.upsertCalls[1]?.update.failureCount,
      0,
      'a live re-subscribe clears failure state so a pruned-looking row comes back',
    );
  });

  it('deletes only the current user subscription endpoint on unsubscribe', async () => {
    const { service, state } = createService();

    await service.unsubscribe({
      userId: 'user-1',
      endpoint: 'https://push.example.test/subscription-1',
    });

    assert.deepStrictEqual(state.deleteManyCalls, [
      { where: { userId: 'user-1', endpoint: 'https://push.example.test/subscription-1' } },
    ]);
  });

  it('does not query subscriptions or call providers when VAPID is disabled', async () => {
    const { service, state } = createService({
      subscriptions: [createSubscription({ id: 'subscription-1' })],
    });
    const providerCalls: unknown[] = [];
    setWebPushSendNotification(async (...args) => {
      providerCalls.push(args);
      return {} as webpush.SendResult;
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World' });

    assert.deepStrictEqual(state.findManyCalls, []);
    assert.deepStrictEqual(providerCalls, []);
  });

  it('sends current notification payloads and refreshes subscription health on success', async () => {
    const providerCalls: unknown[] = [];
    const { service, state } = createService({
      subscriptions: [createSubscription({ id: 'subscription-1' })],
      webPushConfig: TEST_VAPID,
    });
    setWebPushSendNotification(async (...args) => {
      providerCalls.push(args);
      return {} as webpush.SendResult;
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World', url: '/notifications' });

    assert.deepStrictEqual(state.findManyCalls, [{ where: { userId: 'user-1' } }]);
    assert.equal(providerCalls.length, 1);
    assert.deepStrictEqual(providerCalls[0], [
      {
        endpoint: 'https://push.example.test/subscription-1',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
      JSON.stringify({ title: 'Hello', body: 'World', url: '/notifications' }),
      { TTL: 60, vapidDetails: TEST_VAPID_DETAILS },
    ]);
    assert.equal(state.updateCalls.length, 1);
    assert.deepStrictEqual(state.updateCalls[0], {
      where: { id: 'subscription-1' },
      data: { failureCount: 0, lastSeenAt: state.updateCalls[0]?.data.lastSeenAt },
    });
    assert.equal(state.updateCalls[0]?.data.lastSeenAt instanceof Date, true);
  });

  it('deletes permanently gone subscriptions after provider 404 or 410 responses', async () => {
    const { service, state } = createService({
      subscriptions: [createSubscription({ id: 'subscription-dead' })],
      webPushConfig: TEST_VAPID,
    });
    setWebPushSendNotification(async () => {
      throw { statusCode: 410 };
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World' });

    assert.deepStrictEqual(state.deleteCalls, [{ where: { id: 'subscription-dead' } }]);
    assert.deepStrictEqual(state.updateCalls, []);
  });

  it('increments transient failure counts and evicts after the current threshold', async () => {
    const { service, state } = createService({
      subscriptions: [
        createSubscription({ id: 'subscription-retry', failureCount: 1 }),
        createSubscription({ id: 'subscription-evict', failureCount: 2 }),
      ],
      webPushConfig: TEST_VAPID,
    });
    setWebPushSendNotification(async () => {
      throw { statusCode: 503 };
    });

    await service.sendToUser({ userId: 'user-1', title: 'Hello', body: 'World' });

    assert.deepStrictEqual(state.updateCalls, [
      { where: { id: 'subscription-retry' }, data: { failureCount: 2 } },
    ]);
    assert.deepStrictEqual(state.deleteCalls, [{ where: { id: 'subscription-evict' } }]);
  });
});

/**
 * `subscribeAdmin` is self-service — the admin's own browser registering
 * itself — so permissions cannot arbitrate it: the caller is entitled to
 * subscribe SOME browser, and the only question is WHICH row that write lands
 * on. `endpoint` is globally `@unique` on `AdminWebPushSubscription` in
 * `prisma/schema.prisma` (the ADMIN table; the subscriber `WebPushSubscription`
 * has its own separate `endpoint @unique`), so the
 * `upsert({ where: { endpoint } })` this replaced had one row to update no
 * matter who owned it, and its update branch wrote `adminId`. An endpoint is a
 * long random URL, but it is not a secret: it is stored in plaintext beside
 * `userAgent` and reaches any log that records request bodies.
 *
 * The stub below is an in-memory `admin_web_push_subscriptions` that enforces
 * the real unique constraint, so the cross-admin case is exercised against the
 * same rule Postgres applies rather than against a mock's opinion of it.
 */
describe('WebPushService admin subscription ownership', () => {
  it('refuses to bind an endpoint that another admin already owns', async () => {
    const { service } = createService({
      adminSubscriptions: [
        createAdminSubscription({
          id: 'admin-b-row',
          adminId: 'admin-b',
          endpoint: ADMIN_ENDPOINT,
        }),
      ],
    });

    await assert.rejects(
      service.subscribeAdmin({
        adminId: 'admin-a',
        endpoint: ADMIN_ENDPOINT,
        p256dhKey: 'admin-a-p256dh',
        authKey: 'admin-a-auth',
        userAgent: 'Admin A browser',
      }),
      (error: unknown) => {
        assert.equal(error instanceof ConflictException, true);
        assert.equal(
          error instanceof ConflictException ? error.getStatus() : null,
          HttpStatus.CONFLICT,
        );
        // Says nothing about who holds the row — that belongs in the server
        // log, not in a response any admin can trigger at will.
        assert.equal(
          error instanceof Error ? error.message : null,
          'This browser subscription is already registered to another administrator',
        );
        return true;
      },
    );
  });

  it('leaves the other admin\'s row exactly as it was when the claim is refused', async () => {
    const adminBRow = createAdminSubscription({
      id: 'admin-b-row',
      adminId: 'admin-b',
      endpoint: ADMIN_ENDPOINT,
      p256dhKey: 'admin-b-p256dh',
      authKey: 'admin-b-auth',
      userAgent: 'Admin B browser',
      // Non-zero on purpose: the update branch reset it to 0, which revived
      // rows the fanout was two failures into evicting.
      failureCount: 2,
    });
    const { service, state } = createService({ adminSubscriptions: [adminBRow] });

    // The refusal itself is pinned by the test above; swallowed here so that
    // what this one reports on failure is the state of B's row.
    await service
      .subscribeAdmin({
        adminId: 'admin-a',
        endpoint: ADMIN_ENDPOINT,
        p256dhKey: 'admin-a-p256dh',
        authKey: 'admin-a-auth',
        userAgent: 'Admin A browser',
      })
      .catch(() => undefined);

    // Every field: `adminId` is the takeover, the keys and `userAgent` are B's
    // browser being described as A's, `failureCount` is the resurrection, and
    // `lastSeenAt` is the row looking healthier than it is.
    assert.deepStrictEqual(state.adminRows, [adminBRow]);
  });

  it('refreshes the caller\'s own row through a write scoped to that admin', async () => {
    const { service, state } = createService({
      adminSubscriptions: [
        createAdminSubscription({
          id: 'admin-a-row',
          adminId: 'admin-a',
          endpoint: ADMIN_ENDPOINT,
          p256dhKey: 'stale-p256dh',
          authKey: 'stale-auth',
          userAgent: 'Admin A browser (old build)',
          failureCount: 2,
        }),
      ],
    });

    const result = await service.subscribeAdmin({
      adminId: 'admin-a',
      endpoint: ADMIN_ENDPOINT,
      p256dhKey: 'rotated-p256dh',
      authKey: 'rotated-auth',
      userAgent: 'Admin A browser',
    });

    // Re-subscribing the same browser keeps the same row and adopts the keys
    // the service worker rotated — the behaviour the scoping must not cost.
    assert.deepStrictEqual(result, { id: 'admin-a-row' });
    assert.equal(state.adminRows.length, 1);
    const [row] = state.adminRows;
    assert.equal(row?.adminId, 'admin-a');
    assert.equal(row?.p256dhKey, 'rotated-p256dh');
    assert.equal(row?.authKey, 'rotated-auth');
    assert.equal(row?.userAgent, 'Admin A browser');
    assert.equal(row?.failureCount, 0);
    assert.equal((row?.lastSeenAt.getTime() ?? 0) > ADMIN_SEED_TIMESTAMP.getTime(), true);

    // The invariant, not the call sequence. Everything above is equally true
    // of `upsert({ where: { endpoint } })`, which is the defect: the same call
    // carrying another admin's endpoint rewrites their row. What separates the
    // two is that no write here addresses a row without naming its owner.
    assert.deepStrictEqual(
      state.adminCalls.filter((call) => call.mutates && !call.adminScoped),
      [],
    );
  });

  it('treats an insert race lost to the same admin as a re-subscribe, not a conflict', async () => {
    const { service, state } = createService({
      // Two tabs of the same admin subscribing at once: this row appears in the
      // window between the caller's scoped update finding nothing and its
      // INSERT. A unique violation therefore does not imply a foreign owner.
      adminInsertRaceWinner: createAdminSubscription({
        id: 'admin-a-second-tab',
        adminId: 'admin-a',
        endpoint: ADMIN_ENDPOINT,
        p256dhKey: 'second-tab-p256dh',
        authKey: 'second-tab-auth',
      }),
    });

    const result = await service.subscribeAdmin({
      adminId: 'admin-a',
      endpoint: ADMIN_ENDPOINT,
      p256dhKey: 'first-tab-p256dh',
      authKey: 'first-tab-auth',
      userAgent: 'Admin A browser',
    });

    assert.deepStrictEqual(result, { id: 'admin-a-second-tab' });
    assert.equal(state.adminRows.length, 1);
    assert.equal(state.adminRows[0]?.p256dhKey, 'first-tab-p256dh');
  });
});

function route(methodName: keyof InternalPushController): {
  readonly path: string | undefined;
  readonly method: RequestMethod | undefined;
  readonly httpCode: number | undefined;
} {
  const method = InternalPushController.prototype[methodName] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, method) as string | undefined,
    method: Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod | undefined,
    httpCode: Reflect.getMetadata(HTTP_CODE_METADATA, method) as number | undefined,
  };
}

function createService(input: {
  readonly upsertResult?: { readonly id: string };
  readonly subscriptions?: readonly WebPushSubscription[];
  readonly adminSubscriptions?: readonly AdminWebPushSubscription[];
  readonly adminInsertRaceWinner?: AdminWebPushSubscription;
  readonly webPushConfig?: typeof TEST_VAPID | null;
} = {}): {
  readonly service: WebPushService;
  readonly state: {
    readonly upsertCalls: UpsertCall[];
    readonly deleteManyCalls: unknown[];
    readonly findManyCalls: unknown[];
    readonly updateCalls: UpdateCall[];
    readonly deleteCalls: unknown[];
    /** Live contents of the in-memory `admin_web_push_subscriptions` table. */
    readonly adminRows: AdminWebPushSubscription[];
    readonly adminCalls: AdminTableCall[];
  };
} {
  const adminRows: AdminWebPushSubscription[] = (input.adminSubscriptions ?? []).map((row) => ({
    ...row,
  }));
  const adminCalls: AdminTableCall[] = [];
  const state = {
    upsertCalls: [] as UpsertCall[],
    deleteManyCalls: [] as unknown[],
    findManyCalls: [] as unknown[],
    updateCalls: [] as UpdateCall[],
    deleteCalls: [] as unknown[],
    adminRows,
    adminCalls,
  };
  let generatedAdminRows = 0;
  let raceWinnerInserted = false;
  const adminRowByEndpoint = (endpoint: string): AdminWebPushSubscription | undefined =>
    adminRows.find((row) => row.endpoint === endpoint);
  const insertAdminRow = (data: AdminInsertData): AdminWebPushSubscription => {
    generatedAdminRows += 1;
    const now = new Date();
    const created: AdminWebPushSubscription = {
      id: `generated-admin-row-${generatedAdminRows}`,
      adminId: data.adminId,
      endpoint: data.endpoint,
      p256dhKey: data.p256dhKey,
      authKey: data.authKey,
      userAgent: data.userAgent,
      failureCount: 0,
      createdAt: now,
      lastSeenAt: now,
    };
    adminRows.push(created);
    return created;
  };
  const prisma = {
    // In-memory `admin_web_push_subscriptions`. `endpoint` is UNIQUE, so at
    // most one row can hold one, and an INSERT that collides raises P2002
    // instead of adding a second row aimed at the same browser.
    adminWebPushSubscription: {
      upsert: async (args: AdminUpsertCall): Promise<{ id: string }> => {
        // Only the replaced implementation reaches this, and it is stubbed
        // faithfully so that code fails these tests on an assertion about rows
        // rather than on a missing method.
        adminCalls.push({ op: 'upsert', adminScoped: false, mutates: true });
        const existing = adminRowByEndpoint(args.where.endpoint);
        if (existing === undefined) {
          return { id: insertAdminRow(args.create).id };
        }
        existing.adminId = args.update.adminId;
        existing.p256dhKey = args.update.p256dhKey;
        existing.authKey = args.update.authKey;
        existing.userAgent = args.update.userAgent;
        existing.failureCount = args.update.failureCount;
        existing.lastSeenAt = args.update.lastSeenAt;
        return { id: existing.id };
      },
      updateMany: async (args: AdminUpdateManyCall): Promise<{ count: number }> => {
        adminCalls.push({ op: 'updateMany', adminScoped: true, mutates: true });
        const matched = adminRows.filter(
          (row) => row.adminId === args.where.adminId && row.endpoint === args.where.endpoint,
        );
        for (const row of matched) {
          row.p256dhKey = args.data.p256dhKey;
          row.authKey = args.data.authKey;
          row.userAgent = args.data.userAgent;
          row.failureCount = args.data.failureCount;
          row.lastSeenAt = args.data.lastSeenAt;
        }
        return { count: matched.length };
      },
      create: async (args: AdminCreateCall): Promise<{ id: string }> => {
        adminCalls.push({ op: 'create', adminScoped: true, mutates: true });
        // The concurrent winner lands here rather than in the seed because the
        // window it models — between a scoped update finding nothing and the
        // INSERT that follows — exists only for a two-step write.
        if (input.adminInsertRaceWinner !== undefined && !raceWinnerInserted) {
          raceWinnerInserted = true;
          adminRows.push({ ...input.adminInsertRaceWinner });
        }
        if (adminRowByEndpoint(args.data.endpoint) !== undefined) {
          throw new FakeUniqueConstraintError('endpoint');
        }
        return { id: insertAdminRow(args.data).id };
      },
      findUnique: async (
        args: AdminFindUniqueCall,
      ): Promise<{ id: string; adminId: string } | null> => {
        adminCalls.push({ op: 'findUnique', adminScoped: false, mutates: false });
        const row = adminRowByEndpoint(args.where.endpoint);
        return row === undefined ? null : { id: row.id, adminId: row.adminId };
      },
      findFirst: async (args: AdminFindFirstCall): Promise<{ id: string } | null> => {
        adminCalls.push({ op: 'findFirst', adminScoped: true, mutates: false });
        const row = adminRows.find(
          (candidate) =>
            candidate.adminId === args.where.adminId && candidate.endpoint === args.where.endpoint,
        );
        return row === undefined ? null : { id: row.id };
      },
    },
    webPushSubscription: {
      upsert: async (args: UpsertCall) => {
        state.upsertCalls.push(args);
        return input.upsertResult ?? { id: 'subscription-1' };
      },
      deleteMany: async (args: unknown) => {
        state.deleteManyCalls.push(args);
        return { count: 1 };
      },
      findMany: async (args: unknown) => {
        state.findManyCalls.push(args);
        return [...(input.subscriptions ?? [])];
      },
      update: async (args: UpdateCall) => {
        state.updateCalls.push(args);
        return createSubscription({ id: args.where.id, failureCount: args.data.failureCount ?? 0 });
      },
      delete: async (args: unknown) => {
        state.deleteCalls.push(args);
        return createSubscription({ id: 'deleted-subscription' });
      },
    },
  };
  // Mock SettingsService: returns the panel-managed VAPID config (or null when
  // push is disabled), mirroring `getDecryptedWebPushConfig`.
  const settingsService = {
    getDecryptedWebPushConfig: async () => input.webPushConfig ?? null,
  };
  return { service: new WebPushService(prisma as never, settingsService as never), state };
}

/** Test VAPID config returned by the mocked SettingsService. */
const TEST_VAPID = {
  publicKey: 'public-key-1',
  privateKey: 'private-key-1',
  subject: 'mailto:admin@example.com',
};

/** The `vapidDetails` the service forwards to `web-push` (subset of TEST_VAPID). */
const TEST_VAPID_DETAILS = {
  subject: TEST_VAPID.subject,
  publicKey: TEST_VAPID.publicKey,
  privateKey: TEST_VAPID.privateKey,
};

interface UpsertCall {
  readonly where: { readonly endpoint: string };
  readonly create: {
    readonly userId: string;
    readonly endpoint: string;
    readonly p256dhKey: string;
    readonly authKey: string;
    readonly userAgent: string | null;
  };
  readonly update: {
    readonly userId: string;
    readonly p256dhKey: string;
    readonly authKey: string;
    readonly userAgent: string | null;
    readonly failureCount: number;
    readonly lastSeenAt: Date;
  };
  readonly select: { readonly id: true };
}

interface UpdateCall {
  readonly where: { readonly id: string };
  readonly data: { readonly failureCount: number; readonly lastSeenAt?: Date };
}

/** Endpoint every admin-ownership case is played out on. */
const ADMIN_ENDPOINT = 'https://push.example.test/admin-endpoint-1';

/** `createdAt` / `lastSeenAt` every seeded admin row starts from. */
const ADMIN_SEED_TIMESTAMP = new Date('2026-04-20T10:00:00.000Z');

interface AdminInsertData {
  readonly adminId: string;
  readonly endpoint: string;
  readonly p256dhKey: string;
  readonly authKey: string;
  readonly userAgent: string | null;
}

interface AdminUpsertCall {
  readonly where: { readonly endpoint: string };
  readonly create: AdminInsertData;
  readonly update: {
    readonly adminId: string;
    readonly p256dhKey: string;
    readonly authKey: string;
    readonly userAgent: string | null;
    readonly failureCount: number;
    readonly lastSeenAt: Date;
  };
}

interface AdminUpdateManyCall {
  readonly where: { readonly adminId: string; readonly endpoint: string };
  readonly data: {
    readonly p256dhKey: string;
    readonly authKey: string;
    readonly userAgent: string | null;
    readonly failureCount: number;
    readonly lastSeenAt: Date;
  };
}

interface AdminCreateCall {
  readonly data: AdminInsertData;
}

interface AdminFindUniqueCall {
  readonly where: { readonly endpoint: string };
}

interface AdminFindFirstCall {
  readonly where: { readonly adminId: string; readonly endpoint: string };
}

/**
 * One operation against the in-memory admin table.
 *
 * `adminScoped` records whether the operation named an admin at all — in its
 * `where`, or in the row it wrote. A mutation for which this is false reaches
 * whichever row holds the endpoint, which is the whole defect; recording it
 * lets a test assert the property instead of a call sequence.
 */
interface AdminTableCall {
  readonly op: 'upsert' | 'updateMany' | 'create' | 'findUnique' | 'findFirst';
  readonly adminScoped: boolean;
  readonly mutates: boolean;
}

/**
 * Stands in for `PrismaClientKnownRequestError` with code P2002. The service
 * matches on the code rather than the class, which is what lets the unique
 * constraint be modelled here at all.
 */
class FakeUniqueConstraintError extends Error {
  public readonly code = 'P2002';

  public constructor(field: string) {
    super(`Unique constraint failed on the fields: (\`${field}\`)`);
  }
}

function createAdminSubscription(input: {
  readonly id: string;
  readonly adminId: string;
  readonly endpoint?: string;
  readonly p256dhKey?: string;
  readonly authKey?: string;
  readonly userAgent?: string | null;
  readonly failureCount?: number;
}): AdminWebPushSubscription {
  return {
    id: input.id,
    adminId: input.adminId,
    endpoint: input.endpoint ?? ADMIN_ENDPOINT,
    p256dhKey: input.p256dhKey ?? 'p256dh-key',
    authKey: input.authKey ?? 'auth-key',
    userAgent: input.userAgent ?? null,
    failureCount: input.failureCount ?? 0,
    createdAt: ADMIN_SEED_TIMESTAMP,
    lastSeenAt: ADMIN_SEED_TIMESTAMP,
  };
}

function createSubscription(input: {
  readonly id: string;
  readonly userId?: string;
  readonly endpoint?: string;
  readonly p256dhKey?: string;
  readonly authKey?: string;
  readonly userAgent?: string | null;
  readonly failureCount?: number;
}): WebPushSubscription {
  return {
    id: input.id,
    userId: input.userId ?? 'user-1',
    endpoint: input.endpoint ?? `https://push.example.test/${input.id}`,
    p256dhKey: input.p256dhKey ?? 'p256dh-key',
    authKey: input.authKey ?? 'auth-key',
    userAgent: input.userAgent ?? null,
    failureCount: input.failureCount ?? 0,
    createdAt: new Date('2026-04-20T10:00:00.000Z'),
    lastSeenAt: new Date('2026-04-20T10:00:00.000Z'),
  };
}

function setWebPushSendNotification(next: typeof webpush.sendNotification): void {
  mutableWebPush.sendNotification = next;
}

function clearVapidEnv(): void {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_CONTACT_EMAIL;
}
