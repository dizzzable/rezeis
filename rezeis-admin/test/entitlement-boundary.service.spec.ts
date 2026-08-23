import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementBoundaryService } from '../src/modules/add-on-entitlements/services/entitlement-boundary.service';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';

function build(options: {
  due?: Array<{ id: string; type: string; state?: string }>;
  activeTerm?: { id: string } | null;
} = {}) {
  const transitions: Array<{ command: string; commandKey: string; entitlementId: string }> = [];
  const recomputes: string[] = [];
  const tx = {
    addOnEntitlement: {
      findMany: async () =>
        (options.due ?? [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }]).map((row) => ({
          state: 'ACTIVE',
          ...row,
        })),
    },
    subscriptionTerm: {
      findFirst: async () => (options.activeTerm === undefined ? { id: 'term-1' } : options.activeTerm),
    },
    subscription: {
      update: async () => ({ id: 'sub-1', remnawaveId: 'rem-1' }),
    },
    profileSyncJob: {
      create: async () => ({ id: 'job-1' }),
    },
  };
  const prisma = {
    $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  const entitlements = {
    transitionInTransaction: async (_t: unknown, input: { command: string; commandKey: string; entitlementId: string }) => {
      transitions.push({ command: input.command, commandKey: input.commandKey, entitlementId: input.entitlementId });
      return { entitlementId: input.entitlementId, state: 'X', changed: true, eventId: 'e' };
    },
  };
  const projection = {
    recomputeInTransaction: async (_t: unknown, input: { subscriptionId: string }) => {
      recomputes.push(input.subscriptionId);
      return { desiredRevision: 7n, changed: true, desiredTrafficLimitBytes: null, desiredDeviceLimit: 0 };
    },
  };
  const terms = {
    activateInTransaction: async () => ({ id: 'term-1', status: 'ACTIVE', changed: true }),
  };
  const service = new EntitlementBoundaryService(prisma as never, entitlements as never, terms as never, projection as never);
  return { service, transitions, recomputes };
}

describe('EntitlementBoundaryService (T-008)', () => {
  it('BEGIN_EXPIRY + COMPLETE_EXPIRY a due traffic entitlement, then recomputes once', async () => {
    const { service, transitions, recomputes } = build({ due: [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }] });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(result.began, 1);
    assert.equal(result.expired, 1);
    assert.deepEqual(transitions.map((t) => t.command), ['BEGIN_EXPIRY', 'COMPLETE_EXPIRY']);
    assert.deepEqual(recomputes, ['sub-1']);
    assert.equal(result.desiredRevision, 7n);
    assert.deepEqual(result.syncJobIds, ['job-1']);
  });

  it('leaves a due device entitlement in EXPIRING (device saga completes it later)', async () => {
    const { service, transitions } = build({ due: [{ id: 'ent-d', type: 'EXTRA_DEVICES' }] });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(result.began, 1);
    assert.equal(result.expired, 0);
    assert.equal(result.deviceExpiryTriggered, true);
    assert.deepEqual(transitions.map((t) => t.command), ['BEGIN_EXPIRY']);
  });

  it('re-enters planning for a due EXPIRING device entitlement without repeating BEGIN_EXPIRY', async () => {
    const { service, transitions } = build({
      due: [{ id: 'ent-retry', type: 'EXTRA_DEVICES', state: 'EXPIRING' }],
    });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(result.began, 0);
    assert.equal(result.deviceExpiryTriggered, true);
    assert.deepStrictEqual(transitions, []);
  });

  it('uses stable idempotent command keys per entitlement', async () => {
    const { service, transitions } = build({ due: [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }] });
    await service.expireDueForSubscription('sub-1');
    assert.equal(transitions[0]!.commandKey, 'boundary-begin:ent-1');
    assert.equal(transitions[1]!.commandKey, 'boundary-complete:ent-1');
  });

  it('is a no-op with no recompute when nothing is due', async () => {
    const { service, transitions, recomputes } = build({ due: [] });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(result.changed, false);
    assert.deepEqual(transitions, []);
    assert.deepEqual(recomputes, []);
  });

  it('expires entitlements but skips recompute when there is no active term', async () => {
    const { service, transitions, recomputes } = build({
      due: [{ id: 'ent-1', type: 'EXTRA_TRAFFIC' }],
      activeTerm: null,
    });
    const result = await service.expireDueForSubscription('sub-1');
    assert.equal(transitions.length, 2);
    assert.deepEqual(recomputes, [], 'no active term → no projection recompute');
    assert.equal(result.desiredRevision, null);
  });

  it('activates a due scheduled term and its pending entitlements atomically', async () => {
    const commands: string[] = [];
    const tx = {
      subscriptionTerm: { findFirst: async () => ({ id: 'term-2' }) },
      addOnEntitlement: { findMany: async () => [{ id: 'ent-pending' }] },
      subscription: { update: async () => ({ remnawaveId: 'rem-1' }) },
      profileSyncJob: { create: async () => ({ id: 'job-activate' }) },
    };
    const prisma = { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) };
    const entitlements = {
      transitionInTransaction: async (_t: unknown, input: { command: string }) => {
        commands.push(input.command);
        return { changed: true };
      },
    };
    const terms = { activateInTransaction: async () => ({ id: 'term-2', status: 'ACTIVE', changed: true }) };
    const projection = {
      recomputeInTransaction: async () => ({ desiredRevision: 3n, changed: true, desiredTrafficLimitBytes: null, desiredDeviceLimit: 0 }),
    };
    const service = new EntitlementBoundaryService(prisma as never, entitlements as never, terms as never, projection as never);
    const result = await service.activateDueScheduledTerm('sub-1');
    assert.equal(result.activated, true);
    assert.equal(result.termId, 'term-2');
    assert.equal(result.activatedEntitlements, 1);
    assert.deepEqual(commands, ['ACTIVATE']);
    assert.deepEqual(result.syncJobIds, ['job-activate']);
  });

  it('applies deferred plan identity and squads at term activation even when numeric projection is unchanged', async () => {
    const subscriptionUpdates: Array<Record<string, unknown>> = [];
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-future-plan',
          startsAt: new Date('2026-08-01T00:00:00.000Z'),
          trafficResetStrategy: 'NO_RESET',
          resetAnchorAt: null,
          planSnapshot: {
            id: 'plan-future',
            internalSquads: ['future-squad'],
            externalSquad: 'future-external',
          },
        }),
      },
      addOnEntitlement: { findMany: async () => [] },
      subscription: {
        // Squads that still match the stored snapshot: INHERITED, so the
        // deferred term plan's list is the one that lands.
        findUnique: async () => ({
          internalSquads: ['old-squad'],
          externalSquad: null,
          planSnapshot: { internalSquads: ['old-squad'], externalSquad: null },
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          subscriptionUpdates.push(data);
          return { remnawaveId: 'rem-1' };
        },
      },
      profileSyncJob: { create: async () => ({ id: 'job-plan-cutover' }) },
    };
    const service = new EntitlementBoundaryService(
      { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } as never,
      { transitionInTransaction: async () => ({ changed: false }) } as never,
      { activateInTransaction: async () => ({ id: 'term-future-plan', status: 'ACTIVE', changed: true }) } as never,
      {
        recomputeInTransaction: async () => ({
          desiredRevision: 4n,
          changed: false,
          desiredTrafficLimitBytes: 100n * 1024n * 1024n * 1024n,
          desiredDeviceLimit: 3,
        }),
      } as never,
    );

    const result = await service.activateDueScheduledTerm(
      'sub-1',
      new Date('2026-08-01T00:00:00.000Z'),
    );

    assert.equal(subscriptionUpdates.length, 1);
    assert.deepStrictEqual(subscriptionUpdates[0], {
      planSnapshot: {
        id: 'plan-future',
        internalSquads: ['future-squad'],
        externalSquad: 'future-external',
      },
      internalSquads: ['future-squad'],
      externalSquad: 'future-external',
      trafficLimit: 100,
      deviceLimit: 3,
    });
    assert.deepStrictEqual(result.syncJobIds, ['job-plan-cutover']);
  });

  it('refines a pending UNTIL_NEXT_RESET entitlement to the term first epoch before activation', async () => {
    const previous = process.env.ADDON_RESET_EXPIRY_DAY;
    process.env.ADDON_RESET_EXPIRY_DAY = 'true';
    const epochEndsAt = new Date('2026-08-01T00:00:00.000Z');
    const entitlementUpdates: unknown[] = [];
    const epochLookups: unknown[] = [];
    const commands: string[] = [];
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-day',
          startsAt: new Date('2026-07-31T00:00:00.000Z'),
          trafficResetStrategy: 'DAY',
          resetAnchorAt: new Date('2026-07-31T00:00:00.000Z'),
        }),
      },
      subscriptionResetEpoch: {
        findUnique: async (input: unknown) => {
          epochLookups.push(input);
          return {
            id: 'epoch-first',
            startsAt: new Date('2026-07-31T00:00:00.000Z'),
            plannedEndsAt: epochEndsAt,
          };
        },
      },
      addOnEntitlement: {
        findMany: async () => [{ id: 'ent-reset', lifetime: 'UNTIL_NEXT_RESET' }],
        updateMany: async (input: unknown) => {
          entitlementUpdates.push(input);
          return { count: 1 };
        },
      },
      subscription: { update: async () => ({ remnawaveId: 'rem-1' }) },
      profileSyncJob: { create: async () => ({ id: 'job-1' }) },
    };
    const prisma = { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) };
    const service = new EntitlementBoundaryService(
      prisma as never,
      {
        transitionInTransaction: async (_t: unknown, input: { command: string }) => {
          commands.push(input.command);
          return { changed: true };
        },
      } as never,
      { activateInTransaction: async () => ({ id: 'term-day', status: 'ACTIVE', changed: true }) } as never,
      {
        recomputeInTransaction: async () => ({
          desiredRevision: 2n,
          changed: true,
          desiredTrafficLimitBytes: null,
          desiredDeviceLimit: 0,
        }),
      } as never,
    );

    try {
      await service.activateDueScheduledTerm('sub-1', new Date('2026-08-03T12:00:00.000Z'));
      assert.deepStrictEqual(epochLookups[0], {
        where: {
          termId_plannedEndsAt: {
            termId: 'term-day',
            plannedEndsAt: epochEndsAt,
          },
        },
        select: { id: true, startsAt: true, plannedEndsAt: true },
      });
      assert.deepStrictEqual(entitlementUpdates, [{
        where: {
          id: 'ent-reset',
          state: 'PENDING_ACTIVATION',
          lifetime: 'UNTIL_NEXT_RESET',
        },
        data: { expiryEpochId: 'epoch-first', expiresAt: epochEndsAt },
      }]);
      assert.deepStrictEqual(commands, ['ACTIVATE']);
    } finally {
      if (previous === undefined) delete process.env.ADDON_RESET_EXPIRY_DAY;
      else process.env.ADDON_RESET_EXPIRY_DAY = previous;
    }
  });

  it('fails closed instead of activating a paid reset entitlement without an epoch', async () => {
    const previous = process.env.ADDON_RESET_EXPIRY_DAY;
    delete process.env.ADDON_RESET_EXPIRY_DAY;
    const commands: string[] = [];
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-no-epoch',
          startsAt: new Date('2026-07-31T00:00:00.000Z'),
          trafficResetStrategy: 'DAY',
          resetAnchorAt: new Date('2026-07-31T00:00:00.000Z'),
        }),
      },
      addOnEntitlement: {
        findMany: async () => [{ id: 'ent-paid-reset', lifetime: 'UNTIL_NEXT_RESET' }],
      },
      subscription: { update: async () => ({ remnawaveId: 'rem-1' }) },
      profileSyncJob: { create: async () => ({ id: 'job-1' }) },
    };
    const service = new EntitlementBoundaryService(
      { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } as never,
      {
        transitionInTransaction: async (_t: unknown, input: { command: string }) => {
          commands.push(input.command);
          return { changed: true };
        },
      } as never,
      { activateInTransaction: async () => ({ id: 'term-no-epoch', status: 'ACTIVE', changed: true }) } as never,
      {
        recomputeInTransaction: async () => ({
          desiredRevision: 2n,
          changed: false,
          desiredTrafficLimitBytes: null,
          desiredDeviceLimit: 0,
        }),
      } as never,
    );

    try {
      await assert.rejects(
        () => service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T00:00:00.000Z')),
        /reset epoch/i,
      );
      assert.deepStrictEqual(commands, []);
    } finally {
      if (previous === undefined) delete process.env.ADDON_RESET_EXPIRY_DAY;
      else process.env.ADDON_RESET_EXPIRY_DAY = previous;
    }
  });

  it('completes verified due EXPIRING device entitlements with stable command keys', async () => {
    const commands: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1' }],
      addOnEntitlement: {
        findMany: async () => [
          { id: 'ent-device-expiring' },
          { id: 'ent-device-expiring-2' },
        ],
      },
      subscriptionEffectiveProjection: {
        findUnique: async () => ({ desiredRevision: 4n }),
      },
    };
    const service = new EntitlementBoundaryService(
      { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } as never,
      {
        transitionInTransaction: async (_tx: unknown, input: Record<string, unknown>) => {
          commands.push(input);
          return { changed: true };
        },
      } as never,
      {} as never,
      {} as never,
    );
    const complete = (
      service as unknown as {
        completeVerifiedDeviceExpiryForSubscription(
          subscriptionId: string,
          projectionRevision: bigint,
          now?: Date,
        ): Promise<{ status: 'COMPLETED' | 'SUPERSEDED'; completed: number }>;
      }
    ).completeVerifiedDeviceExpiryForSubscription.bind(service);

    const result = await complete('sub-1', 4n, new Date('2026-08-01T00:00:00.000Z'));

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.completed, 2);
    assert.deepStrictEqual(commands.map((entry) => entry.commandKey), [
      'device-expiry-complete:ent-device-expiring',
      'device-expiry-complete:ent-device-expiring-2',
    ]);
  });

  it('does not complete EXPIRING devices when the locked projection revision is newer', async () => {
    const commands: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: async () => [{ id: 'sub-1' }],
      addOnEntitlement: {
        findMany: async () => [{ id: 'ent-newer-device-expiry' }],
      },
      subscriptionEffectiveProjection: {
        findUnique: async () => ({ desiredRevision: 5n }),
      },
    };
    const service = new EntitlementBoundaryService(
      { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } as never,
      {
        transitionInTransaction: async (_tx: unknown, input: Record<string, unknown>) => {
          commands.push(input);
          return { changed: true };
        },
      } as never,
      {} as never,
      {} as never,
    );
    const complete = (
      service as unknown as {
        completeVerifiedDeviceExpiryForSubscription(
          subscriptionId: string,
          projectionRevision: bigint,
          now?: Date,
        ): Promise<{ status: 'COMPLETED' | 'SUPERSEDED'; completed: number }>;
      }
    ).completeVerifiedDeviceExpiryForSubscription.bind(service);

    const result = await complete('sub-1', 4n, new Date('2026-08-01T00:00:00.000Z'));

    assert.deepStrictEqual(result, { status: 'SUPERSEDED', completed: 0 });
    assert.deepStrictEqual(commands, []);
  });

  it('activateDueScheduledTerm is a no-op when no scheduled term is due', async () => {
    const tx = { subscriptionTerm: { findFirst: async () => null } };
    const prisma = { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) };
    const service = new EntitlementBoundaryService(prisma as never, {} as never, {} as never, {} as never);
    const result = await service.activateDueScheduledTerm('sub-1');
    assert.equal(result.activated, false);
    assert.equal(result.termId, null);
    assert.deepEqual(result.syncJobIds, []);
  });

  it('anchors a due MONTH_ROLLING term to panel createdAt before minting its epoch', async () => {
    const previous = process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
    process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = 'true';
    const panelCreatedAt = new Date('2025-01-31T08:00:00.000Z');
    const termUpdates: unknown[] = [];
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-rolling',
          startsAt: new Date('2026-07-31T08:00:00.000Z'),
          trafficResetStrategy: 'MONTH_ROLLING',
          resetAnchorAt: null,
        }),
        update: async (input: unknown) => { termUpdates.push(input); },
      },
      subscriptionResetEpoch: {
        findUnique: async () => ({
          id: 'epoch-existing',
          startsAt: new Date('2026-06-30T08:00:00.000Z'),
          plannedEndsAt: new Date('2026-07-31T08:00:00.000Z'),
        }),
      },
      addOnEntitlement: { findMany: async () => [] },
    };
    const panelRefs: unknown[] = [];
    const prisma = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-rolling',
          // The row carries both supplementary identity columns, as every real
          // one does: 2.x and 3.x alike expose a numeric id and a username on
          // every user, so both are recorded when the profile is linked.
          subscription: {
            remnawaveId: 'panel-user-1',
            remnawavePanelId: 4711,
            remnawavePanelUsername: 'rz_alice_sub',
          },
        }),
      },
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    };
    const terms = { activateInTransaction: async () => ({ id: 'term-rolling', status: 'ACTIVE', changed: true }) };
    const projection = {
      recomputeInTransaction: async () => ({ desiredRevision: 1n, changed: false }),
    };
    const panel = {
      getPanelUser: async (ref: unknown) => {
        panelRefs.push(ref);
        return { createdAt: panelCreatedAt.toISOString() };
      },
    };
    const service = new EntitlementBoundaryService(
      prisma as never,
      { transitionInTransaction: async () => ({ changed: false }) } as never,
      terms as never,
      projection as never,
      panel as never,
    );

    try {
      const result = await service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T08:00:00.000Z'));
      assert.equal(result.activated, true);
      assert.deepEqual(termUpdates, [{
        where: { id: 'term-rolling' },
        data: { resetAnchorAt: panelCreatedAt },
      }]);
      assert.deepStrictEqual(panelRefs, [
        { remnawaveId: 'panel-user-1', panelId: 4711, panelUsername: 'rz_alice_sub' },
      ]);
    } finally {
      if (previous === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
      else process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = previous;
    }
  });

  it('activates fail-closed without an epoch when MONTH_ROLLING panel anchor is unavailable', async () => {
    const previous = process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
    process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = 'true';
    const termUpdates: unknown[] = [];
    let epochReads = 0;
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-rolling',
          startsAt: new Date('2026-07-31T08:00:00.000Z'),
          trafficResetStrategy: 'MONTH_ROLLING',
          resetAnchorAt: new Date('2026-07-31T08:00:00.000Z'),
        }),
        update: async (input: unknown) => { termUpdates.push(input); },
      },
      subscriptionResetEpoch: {
        findUnique: async () => { epochReads += 1; return null; },
      },
      addOnEntitlement: { findMany: async () => [] },
    };
    const prisma = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-rolling',
          subscription: {
            remnawaveId: 'panel-user-1',
            remnawavePanelId: 4711,
            remnawavePanelUsername: 'rz_alice_sub',
          },
        }),
      },
      $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    };
    const service = new EntitlementBoundaryService(
      prisma as never,
      { transitionInTransaction: async () => ({ changed: false }) } as never,
      { activateInTransaction: async () => ({ id: 'term-rolling', status: 'ACTIVE', changed: true }) } as never,
      { recomputeInTransaction: async () => ({ desiredRevision: 1n, changed: false }) } as never,
      { getPanelUser: async () => { throw new Error('panel unavailable'); } } as never,
    );

    try {
      const result = await service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T08:00:00.000Z'));
      assert.equal(result.activated, true);
      assert.deepEqual(termUpdates, [{
        where: { id: 'term-rolling' },
        data: { resetAnchorAt: null },
      }]);
      assert.equal(epochReads, 0);
    } finally {
      if (previous === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
      else process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = previous;
    }
  });

  it('reads the MONTH_ROLLING anchor by the recorded numeric id when the stored id is a stale 2.x uuid', async () => {
    // The upgraded-panel case. It matters more here than it looks: `getPanelUser`
    // returns null for a profile it cannot address, which this service reads as
    // "no createdAt" and turns into a null anchor — the same value a genuinely
    // unreachable panel produces. The term would then anchor its reset window to
    // nothing, silently, for a profile that is alive and answering.
    const previous = process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
    process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = 'true';
    const staleUuid = '330f2b38-1362-46ab-b5c0-dea32167eff9';
    const panelCreatedAt = new Date('2025-01-31T08:00:00.000Z');
    const panelRefs: unknown[] = [];
    const termUpdates: unknown[] = [];
    const tx = {
      subscriptionTerm: {
        findFirst: async () => ({
          id: 'term-upgraded',
          startsAt: new Date('2026-07-31T08:00:00.000Z'),
          trafficResetStrategy: 'MONTH_ROLLING',
          resetAnchorAt: null,
        }),
        update: async (input: unknown) => { termUpdates.push(input); },
      },
      subscriptionResetEpoch: {
        findUnique: async () => ({
          id: 'epoch-existing',
          startsAt: new Date('2026-06-30T08:00:00.000Z'),
          plannedEndsAt: new Date('2026-07-31T08:00:00.000Z'),
        }),
      },
      addOnEntitlement: { findMany: async () => [] },
    };
    const service = new EntitlementBoundaryService(
      {
        subscriptionTerm: {
          findFirst: async () => ({
            id: 'term-upgraded',
            subscription: {
              remnawaveId: staleUuid,
              remnawavePanelId: 8123,
              remnawavePanelUsername: 'rz_alice_sub',
            },
          }),
        },
        $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      } as never,
      { transitionInTransaction: async () => ({ changed: false }) } as never,
      { activateInTransaction: async () => ({ id: 'term-upgraded', status: 'ACTIVE', changed: true }) } as never,
      { recomputeInTransaction: async () => ({ desiredRevision: 1n, changed: false }) } as never,
      {
        getPanelUser: async (ref: unknown) => {
          panelRefs.push(ref);
          return { createdAt: panelCreatedAt.toISOString() };
        },
      } as never,
    );

    try {
      await service.activateDueScheduledTerm('sub-1', new Date('2026-07-31T08:00:00.000Z'));

      assert.deepStrictEqual(panelRefs, [
        { remnawaveId: staleUuid, panelId: 8123, panelUsername: 'rz_alice_sub' },
      ]);
      assert.deepStrictEqual(panelUserAddress(panelRefs[0] as StoredPanelIdentity, 'id'), {
        kind: 'ready',
        segment: '8123',
      });
      assert.deepEqual(termUpdates, [{
        where: { id: 'term-upgraded' },
        data: { resetAnchorAt: panelCreatedAt },
      }]);
    } finally {
      if (previous === undefined) delete process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING;
      else process.env.ADDON_RESET_EXPIRY_MONTH_ROLLING = previous;
    }
  });
});

/**
 * Term activation, end to end, with the REAL {@link EffectiveProjectionService}
 * wired in rather than stubbed.
 *
 * A stubbed projection would assert this file's own fixture back at itself and
 * stay green against the defect, because the defect IS what the projection
 * derives. And stopping at the subscription row would miss the harm entirely:
 * the versioned sync worker reads the desired limits off
 * `SubscriptionEffectiveProjection` by the `desiredRevision` the job carries
 * (`ProfileSyncProcessor.tryVersionedDesiredStateWrite`), so the number the
 * customer actually loses is the one on THAT row, reached through THAT job.
 * Every assertion below follows the job to the row it names.
 *
 * Numbers: plan 3, operator 12, add-on 5. The correct answer is 17; the
 * plan-wins defect reads 8, an unapplied add-on reads 12, and the "plan raised
 * to 4" control reads 9 — four values, no collisions.
 */
describe('EntitlementBoundaryService term activation preserves operator configuration', () => {
  const PLAN_DEVICES = 3;
  const OPERATOR_DEVICES = 12;

  interface ActivationOptions {
    readonly subscription?: Partial<{
      trafficLimit: number | null;
      deviceLimit: number;
      internalSquads: string[];
      externalSquad: string | null;
      planSnapshot: Record<string, unknown>;
    }>;
    readonly scheduledBaseDeviceLimit?: number;
    readonly scheduledPlanSnapshot?: Record<string, unknown>;
    readonly addOnDevices?: bigint | null;
  }

  function createStore(options: ActivationOptions = {}) {
    const subscription: Record<string, unknown> = {
      id: 'sub-1',
      status: 'ACTIVE',
      remnawaveId: 'rw-1',
      trafficLimit: null,
      deviceLimit: OPERATOR_DEVICES,
      internalSquads: ['old-squad'],
      externalSquad: null,
      planSnapshot: {
        id: 'plan-1',
        trafficLimit: null,
        deviceLimit: PLAN_DEVICES,
        internalSquads: ['old-squad'],
        externalSquad: null,
      },
      ...options.subscription,
    };
    const terms = [
      { id: 'term-old', status: 'ACTIVE', baseTrafficLimitBytes: null, baseDeviceLimit: PLAN_DEVICES },
      {
        id: 'term-next',
        status: 'SCHEDULED',
        baseTrafficLimitBytes: null,
        baseDeviceLimit: options.scheduledBaseDeviceLimit ?? PLAN_DEVICES,
        startsAt: new Date('2026-08-01T00:00:00.000Z'),
        trafficResetStrategy: 'NO_RESET',
        resetAnchorAt: null,
        planSnapshot: options.scheduledPlanSnapshot ?? {
          id: 'plan-1',
          trafficLimit: null,
          deviceLimit: PLAN_DEVICES,
          internalSquads: ['plan-squad'],
          externalSquad: 'plan-external',
        },
      },
    ];
    const entitlements =
      options.addOnDevices === null
        ? []
        : [
            {
              id: 'ent-devices',
              termId: 'term-next',
              lifetime: 'UNTIL_SUBSCRIPTION_END',
              type: 'EXTRA_DEVICES',
              state: 'PENDING_ACTIVATION',
              totalValue: options.addOnDevices ?? 5n,
            },
          ];
    const projections: Record<string, Record<string, unknown>> = {};
    const syncJobs: Array<Record<string, unknown>> = [];
    const stats = { subscriptionReads: 0 };

    const tx = {
      $queryRaw: async (query: { readonly sql?: string }) => {
        const sql = String(query?.sql ?? query).replace(/\s+/g, ' ');
        if (sql.includes('base_traffic_limit_bytes')) {
          return terms
            .filter((term) => term.status === 'ACTIVE')
            .map((term) => ({
              id: term.id,
              baseTrafficLimitBytes: term.baseTrafficLimitBytes,
              baseDeviceLimit: term.baseDeviceLimit,
            }));
        }
        assert.match(sql, /FROM "subscriptions"/, 'unexpected raw query');
        assert.match(sql, /\bFOR\s+UPDATE\b/i, 'subscription reads must lock');
        return [{ id: subscription.id, status: subscription.status }];
      },
      subscriptionTerm: {
        findFirst: async (input: { where: Record<string, unknown> }) => {
          const wanted = String(input.where.status ?? 'ACTIVE');
          const found = terms.find((term) => term.status === wanted);
          return found === undefined ? null : { ...found };
        },
        update: async () => ({}),
      },
      subscription: {
        findUnique: async () => {
          stats.subscriptionReads += 1;
          return { ...subscription };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(subscription, data);
          return { remnawaveId: subscription.remnawaveId };
        },
      },
      addOnEntitlement: {
        findMany: async (input: { where: Record<string, unknown> }) => {
          const wanted = String(input.where.state ?? '');
          return entitlements
            .filter((row) => row.state === wanted)
            .map((row) => ({ ...row }));
        },
        updateMany: async () => ({ count: 0 }),
      },
      subscriptionEffectiveProjection: {
        findUnique: async () =>
          projections['sub-1'] === undefined ? null : { ...projections['sub-1'], id: 'proj-1' },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          projections['sub-1'] = { ...data };
          return { ...data };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          projections['sub-1'] = { ...projections['sub-1'], ...data };
          return { ...projections['sub-1'] };
        },
      },
      profileSyncJob: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          syncJobs.push(data);
          return { id: `job-${syncJobs.length}` };
        },
      },
    };

    const service = new EntitlementBoundaryService(
      { $transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } as never,
      {
        transitionInTransaction: async (_t: unknown, input: { entitlementId: string; command: string }) => {
          const row = entitlements.find((entry) => entry.id === input.entitlementId);
          if (row === undefined || input.command !== 'ACTIVATE') return { changed: false };
          row.state = 'ACTIVE';
          return { changed: true };
        },
      } as never,
      {
        activateInTransaction: async (_t: unknown, termId: string) => {
          for (const term of terms) {
            if (term.status === 'ACTIVE') term.status = 'ENDED';
          }
          const claimed = terms.find((term) => term.id === termId)!;
          claimed.status = 'ACTIVE';
          return { id: termId, status: 'ACTIVE', changed: true };
        },
      } as never,
      new EffectiveProjectionService() as never,
    );

    return { service, subscription, projections, syncJobs, stats };
  }

  /** The desired limits the panel push would read, reached through the job. */
  function pushedDesiredState(store: ReturnType<typeof createStore>) {
    assert.equal(store.syncJobs.length, 1, 'activation must enqueue exactly one versioned job');
    const job = store.syncJobs[0]!;
    assert.equal(job.aggregateKey, 'sub-1');
    assert.equal(job.cause, 'TERM_ACTIVATION');
    const row = store.projections['sub-1'];
    assert.notEqual(row, undefined, 'the job names a projection row that must exist');
    assert.equal(
      job.desiredRevision,
      row!.desiredRevision,
      'the job must name the revision the projection row now carries',
    );
    return {
      desiredDeviceLimit: row!.desiredDeviceLimit as number | null,
      desiredTrafficLimitBytes: row!.desiredTrafficLimitBytes as bigint | null,
      baseDeviceLimit: row!.baseDeviceLimit as number | null,
    };
  }

  it('an operator-raised device limit survives activation and is what the sync job pushes (12 + 5 = 17)', async () => {
    const store = createStore();

    const result = await store.service.activateDueScheduledTerm(
      'sub-1',
      new Date('2026-08-01T00:00:00.000Z'),
    );

    assert.equal(result.activated, true);
    assert.equal(result.termId, 'term-next');
    assert.equal(store.stats.subscriptionReads > 0, true, 'the recompute must read the subscription');

    // The compatibility column first, so that the two assertions below are
    // visibly NOT the same claim: a right column with a wrong projection row is
    // a reachable state, and it is the state in which the customer still loses
    // the devices, because the versioned worker never reads this column.
    assert.equal(store.subscription.deviceLimit, 17, 'the mirrored column must keep the operator value');

    const pushed = pushedDesiredState(store);
    assert.equal(pushed.baseDeviceLimit, OPERATOR_DEVICES, 'the row the push reads must carry the operator baseline');
    assert.equal(pushed.desiredDeviceLimit, 17, 'the pushed desired state must keep the operator value');
    assert.notEqual(pushed.desiredDeviceLimit, 8, 'pushing 8 is the plan taking the devices back');
    assert.notEqual(pushed.desiredDeviceLimit, OPERATOR_DEVICES, 'pushing 12 means the paid add-on never landed');
  });

  it('a subscription that was never individually adjusted still takes the plan at activation', async () => {
    const store = createStore({
      subscription: { deviceLimit: PLAN_DEVICES },
      // The plan was raised to 4 and this term was minted from it.
      scheduledBaseDeviceLimit: 4,
    });

    await store.service.activateDueScheduledTerm('sub-1', new Date('2026-08-01T00:00:00.000Z'));

    const pushed = pushedDesiredState(store);
    assert.equal(pushed.baseDeviceLimit, 4, 'an untouched column must not freeze the plan out');
    assert.equal(pushed.desiredDeviceLimit, 9);
    assert.notEqual(pushed.desiredDeviceLimit, 8, 'deriving 8 means the column was mistaken for an override');
  });

  it('the deferred term plan squads land when the subscription still holds the plan list', async () => {
    const store = createStore();

    await store.service.activateDueScheduledTerm('sub-1', new Date('2026-08-01T00:00:00.000Z'));

    assert.deepStrictEqual(store.subscription.internalSquads, ['plan-squad']);
    assert.equal(store.subscription.externalSquad, 'plan-external');
  });

  it('an operator-assigned squad list survives activation whole, and is not merged with the plan list', async () => {
    // Squads are membership, not a quantity: nothing grants a squad the way an
    // add-on grants devices, so there is no second value to add. The two
    // candidate answers are the plan's list and the operator's, and a union
    // would hand out access nobody sold.
    const store = createStore({
      subscription: { internalSquads: ['operator-squad'], externalSquad: 'operator-external' },
    });

    await store.service.activateDueScheduledTerm('sub-1', new Date('2026-08-01T00:00:00.000Z'));

    assert.deepStrictEqual(store.subscription.internalSquads, ['operator-squad']);
    assert.equal(store.subscription.externalSquad, 'operator-external');
    assert.notDeepStrictEqual(
      store.subscription.internalSquads,
      ['plan-squad'],
      'the plan list replacing the operator list is the defect',
    );
    assert.notDeepStrictEqual(
      [...(store.subscription.internalSquads as string[])].sort(),
      ['operator-squad', 'plan-squad'],
      'a union invents squad access nobody bought',
    );
    // The deferred plan identity still lands — only the two membership fields
    // are held back.
    assert.equal((store.subscription.planSnapshot as { id: string }).id, 'plan-1');
  });

  it('an operator squad override does not hold back the numeric baseline, or vice versa', async () => {
    // The two field groups are decided independently, so a subscription can
    // own its squads while inheriting its limits.
    const store = createStore({
      subscription: { deviceLimit: PLAN_DEVICES, internalSquads: ['operator-squad'] },
      scheduledBaseDeviceLimit: 4,
    });

    await store.service.activateDueScheduledTerm('sub-1', new Date('2026-08-01T00:00:00.000Z'));

    assert.deepStrictEqual(store.subscription.internalSquads, ['operator-squad']);
    assert.equal(pushedDesiredState(store).desiredDeviceLimit, 9);
  });
});
