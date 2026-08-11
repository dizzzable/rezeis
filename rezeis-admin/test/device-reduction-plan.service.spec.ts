import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';
import {
  panelUserAddress,
  type StoredPanelIdentity,
} from '../src/modules/remnawave/services/panel-user-address';

function devices(...rows: Array<[string, string]>) {
  return { kind: 'ok' as const, value: { devices: rows.map(([hwid, createdAt]) => ({ hwid, createdAt })), total: rows.length }, detectedVersion: '2.8.0' };
}

/**
 * A subscription row as Prisma actually returns it once the select asks for the
 * panel identity.
 *
 * The two supplementary columns are populated by DEFAULT, because that is the
 * production shape: every supported panel version puts a numeric `id` and a
 * `username` on every user row, so both are recorded the moment a profile is
 * linked. A fake that left them out would let a service which never reads them
 * pass every test here and then be unable to name a profile on an upgraded
 * panel.
 */
function subscriptionRow(patch: Record<string, unknown> = {}) {
  return {
    remnawaveId: 'rem-1',
    remnawavePanelId: 4711,
    remnawavePanelUsername: 'rz_alice_sub',
    status: 'ACTIVE',
    ...patch,
  };
}

function build(options: {
  projection?: { id: string; desiredRevision: bigint; desiredDeviceLimit: number | null } | null;
  subscription?: Record<string, unknown> | null;
  strictList?: unknown;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const selects: unknown[] = [];
  const listRefs: unknown[] = [];
  const prisma = {
    subscriptionEffectiveProjection: {
      findUnique: async () =>
        options.projection === undefined
          ? { id: 'proj-1', desiredRevision: 4n, desiredDeviceLimit: 1 }
          : options.projection,
    },
    subscription: {
      findUnique: async (args: { select: unknown }) => {
        selects.push(args.select);
        return options.subscription === undefined ? subscriptionRow() : options.subscription;
      },
    },
    deviceReductionPlan: {
      upsert: async (args: { create: Record<string, unknown> }) => {
        created.push(args.create);
        return { id: 'plan-1', ...args.create };
      },
    },
  };
  const remnawave = {
    strictListUserDevices: async (ref: unknown) => {
      listRefs.push(ref);
      return options.strictList ?? devices(['old', '2026-01-01T00:00:00Z'], ['new', '2026-06-01T00:00:00Z']);
    },
  };
  const service = new DeviceReductionPlanService(prisma as never, remnawave as never);
  return { service, created, selects, listRefs };
}

describe('DeviceReductionPlanService (T-011b)', () => {
  it('persists an immutable plan targeting the newest devices when over the limit', async () => {
    const { service, created } = build();
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'PLANNED');
    if (outcome.status !== 'PLANNED') return;
    assert.equal(outcome.targetCount, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.desiredLimit, 1);
    assert.equal(created[0]!.projectionRevision, 4n);
    const selected = created[0]!.selectedDevices as Array<{ hwid: string }>;
    assert.deepEqual(selected.map((d) => d.hwid), ['new']);
  });

  it('returns VERIFIED (no plan) when devices are within the limit', async () => {
    const { service, created } = build({ strictList: devices(['only', '2026-01-01T00:00:00Z']) });
    const outcome = await service.planForSubscription('sub-1');
    assert.deepStrictEqual(outcome, { status: 'VERIFIED', projectionRevision: 4n });
    assert.equal(created.length, 0);
  });

  it('is NOT_APPLICABLE for an unlimited desired device limit', async () => {
    const { service } = build({ projection: { id: 'p', desiredRevision: 1n, desiredDeviceLimit: null } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'NOT_APPLICABLE');
  });

  it('is NOT_APPLICABLE when the subscription has no panel profile', async () => {
    const { service, listRefs } = build({
      subscription: subscriptionRow({
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
      }),
    });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'NOT_APPLICABLE');
    assert.deepStrictEqual(listRefs, [], 'no profile ⇒ the panel is never asked');
  });

  it('addresses the panel with the recorded numeric id when the stored id is a stale 2.x uuid', async () => {
    // The upgraded-panel case: the profile was created on 2.x, the operator has
    // since moved to 3.x, and the panel's own migration dropped the uuid column
    // — so `remnawaveId` names nobody. Only the recorded numeric id can find it.
    const staleUuid = '330f2b38-1362-46ab-b5c0-dea32167eff9';
    const { service, listRefs } = build({
      subscription: subscriptionRow({ remnawaveId: staleUuid, remnawavePanelId: 8123 }),
    });

    await service.planForSubscription('sub-1');

    assert.deepStrictEqual(listRefs, [
      { remnawaveId: staleUuid, panelId: 8123, panelUsername: 'rz_alice_sub' },
    ]);
    // What the adapter does with it on a 3.x panel: the numeric id, never the
    // dead uuid and never a resolve-by-name round trip.
    assert.deepStrictEqual(panelUserAddress(listRefs[0] as StoredPanelIdentity, 'id'), {
      kind: 'ready',
      segment: '8123',
    });
  });

  it('selects the supplementary identity columns alongside remnawaveId', async () => {
    // Without them `storedIdentityOf` hands over `undefined` for both, which is
    // indistinguishable from a profile that never recorded either — the very
    // state that makes an upgraded panel unreachable.
    const { service, selects } = build();
    await service.planForSubscription('sub-1');
    assert.deepStrictEqual(selects, [
      {
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        configUrl: true,
        status: true,
      },
    ]);
  });

  it('DEFERS when the strict device list is unavailable (retry later)', async () => {
    const { service, created } = build({ strictList: { kind: 'unavailable', retryAfterMs: null } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'DEFERRED');
    assert.equal(created.length, 0);
  });

  it('BLOCKS on an invalid-contract device list (no plan, incident territory)', async () => {
    const { service, created } = build({ strictList: { kind: 'invalidContract', details: 'total mismatch' } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(created.length, 0);
  });

  it('is NOT_APPLICABLE when the panel profile is already gone (notFound)', async () => {
    const { service } = build({ strictList: { kind: 'notFound' } });
    const outcome = await service.planForSubscription('sub-1');
    assert.equal(outcome.status, 'NOT_APPLICABLE');
  });
});
