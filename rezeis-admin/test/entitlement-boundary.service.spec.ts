import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
