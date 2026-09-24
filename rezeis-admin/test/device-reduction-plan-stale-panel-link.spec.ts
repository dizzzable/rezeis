import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STALE_PANEL_LINK } from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';

/**
 * THE STALE-LINK GUARD ON THE OTHER HALF OF THE SAGA: THE PLANNER.
 *
 * `device-reduction-stale-panel-link.spec.ts` covers the EXECUTION guard, which
 * refuses to delete against a link that cannot be trusted to name the right
 * customer. This file covers the half that runs FIRST.
 *
 * -- WHAT THE EXECUTION GUARD DOES NOT COVER ---------------------------------
 *
 * `DeviceReductionPlanService.planForSubscription` reads `strictListUserDevices`
 * on the stored identity. `panelUserAddress` falls back -- numeric fast path ->
 * `remnawavePanelId` -> the short uuid recovered from `config_url` ->
 * `remnawavePanelUsername` -- so a dead 2.x uuid still resolves to whatever
 * profile is LIVE at that address. Unguarded, the planner reads A DIFFERENT
 * CUSTOMER'S DEVICE LIST and writes THEIR hwids into `selectedDevices` as this
 * subscription's targets.
 *
 * -- WHY THE ANSWER IS "PERSIST NOTHING", NOT "PERSIST A BLOCKED PLAN" -------
 *
 * The upsert is keyed `(subscriptionId, projectionRevision)` with an EMPTY
 * `update`, so the first row written at a revision is the row FOREVER. A
 * placeholder written while the link was stale would still be sitting there
 * after the link was repaired -- and the re-plan that should have produced the
 * real targets would silently return the placeholder instead.
 *
 * THE GUARD READS NO PANEL VERSION ("not a decimal" is the whole test). The
 * harness's `getPanelShape` records the call and throws.
 *
 * EVERY REFUSAL HERE PINS A POSITIVE SIDE. "No plan was written" passes just as
 * happily for a service that crashed before reaching any of it, so each zero is
 * paired with an INERTNESS CONTROL driving the SAME harness with a repaired row
 * and asserting the ROW that was written and the ARGUMENTS that reached the
 * panel.
 */

/** A live 2.x uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
/** The same profile as a 3.x panel names it. */
const LIVE_DECIMAL = '5150';

/**
 * The reason token, pinned here as a LITERAL.
 *
 * Comparing `outcome.reason` against the service's own export would be the
 * constant compared with itself and would pass for any rename. The literal pins
 * the wire spelling; the case at the bottom pins the wiring.
 */
const EXPECTED_REASON = 'STALE_PANEL_LINK';

/**
 * Timestamps are RELATIVE TO NOW, never literals: `selectDeviceReductionTargets`
 * classifies every row against `Date.now()` for the dormancy rule.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A strict-list answer. */
function okList(...rows: Array<[string, number]>) {
  return {
    kind: 'ok' as const,
    value: {
      devices: rows.map(([hwid, age]) => ({ hwid, createdAt: daysAgo(age), lastSeenAt: null })),
      total: rows.length,
    },
    detectedVersion: '3.2.1',
  };
}

/**
 * THE OTHER CUSTOMER'S DEVICES -- what the fallback actually returns when a
 * dead uuid resolves through `remnawavePanelId` to a live profile. Named so the
 * assertion below reads as what it is: these hwids must never be written under
 * `sub-1`.
 */
const FOREIGN_DEVICES = okList(['victim-laptop', 200], ['victim-phone', 3]);
/** This subscriber's own devices, on a repaired link. */
const OWN_DEVICES = okList(['own-desktop', 200], ['own-phone', 3]);

interface PanelRecord {
  /** Ordered verbs. */
  readonly calls: string[];
  /** Every argument list handed to a strict READ, by value. */
  readonly lists: unknown[][];
}

interface Opts {
  readonly remnawaveId?: string | null;
  readonly subscription?: Record<string, unknown> | null;
  readonly projection?: {
    id: string;
    desiredRevision: bigint;
    desiredDeviceLimit: number | null;
  } | null;
  readonly strictList?: unknown;
}

function subscriptionRow(remnawaveId: string | null) {
  return {
    remnawaveId,
    remnawavePanelId: 8123,
    remnawavePanelUsername: 'rz_alice_sub',
    configUrl: null,
    status: 'ACTIVE',
  };
}

/** The identity the adapter must receive -- asserted BY VALUE, never by count. */
const HEALTHY_IDENTITY = { remnawaveId: LIVE_DECIMAL, panelId: 8123, panelUsername: 'rz_alice_sub' };

function build(opts: Opts = {}) {
  const record: PanelRecord = { calls: [], lists: [] };
  /** Every persisted plan, keyed exactly as the unique constraint keys it. */
  const plans = new Map<string, Record<string, unknown>>();
  const incidents = new Map<string, Record<string, unknown>>();

  const prisma = {
    subscriptionEffectiveProjection: {
      findUnique: async () =>
        opts.projection === undefined
          ? { id: 'proj-1', desiredRevision: 4n, desiredDeviceLimit: 1 }
          : opts.projection,
    },
    subscription: {
      findUnique: async () =>
        opts.subscription === undefined
          ? subscriptionRow(opts.remnawaveId === undefined ? DEAD_UUID : opts.remnawaveId)
          : opts.subscription,
    },
    deviceReductionPlan: {
      // A REAL upsert, because the empty `update` is the whole reason a
      // placeholder row would be permanent. A fake that always inserted would
      // hide exactly the behaviour the "revision stays usable" case proves.
      upsert: async (args: {
        where: {
          subscriptionId_projectionRevision: {
            subscriptionId: string;
            projectionRevision: bigint;
          };
        };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        const { subscriptionId, projectionRevision } = args.where.subscriptionId_projectionRevision;
        const key = `${subscriptionId}:${projectionRevision.toString()}`;
        const existing = plans.get(key);
        if (existing !== undefined) {
          Object.assign(existing, args.update);
          return existing;
        }
        const row = { id: `plan-${plans.size + 1}`, ...args.create };
        plans.set(key, row);
        return row;
      },
    },
    entitlementIncident: {
      upsert: async (args: {
        where: { supportRef: string };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        const existing = incidents.get(args.where.supportRef);
        if (existing !== undefined) {
          Object.assign(existing, args.update);
          return existing;
        }
        const row = { id: `inc-${incidents.size + 1}`, state: 'OPEN', ...args.create };
        incidents.set(args.where.supportRef, row);
        return row;
      },
    },
  };

  const remnawave = {
    getPanelShape: async () => {
      record.calls.push('getPanelShape');
      throw new Error('the panel version must not be read by the planner');
    },
    strictListUserDevices: async (...args: unknown[]) => {
      record.calls.push('strictListUserDevices');
      record.lists.push(args);
      return opts.strictList ?? FOREIGN_DEVICES;
    },
  };

  const service = new DeviceReductionPlanService(prisma as never, remnawave as never);
  return { service, plans, incidents, panel: record };
}

function planRows(plans: Map<string, Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...plans.values()];
}

function hwidsOf(row: Record<string, unknown> | undefined): string[] {
  const selected = (row?.['selectedDevices'] ?? []) as Array<{ hwid: string }>;
  return selected.map((d) => d.hwid);
}

// -- THE REFUSAL -------------------------------------------------------------

describe('device reduction PLANNING on a stale panel link', () => {
  it('THE PROOF: no plan is persisted, and the foreign device list is never even read', async () => {
    // The whole defect in one case. Without the guard the planner reads
    // `victim-laptop`/`victim-phone` off a profile that belongs to somebody
    // else and writes `victim-phone` into sub-1's plan as its target.
    const { service, plans, panel } = build();

    const outcome = await service.planForSubscription('sub-1');

    assert.deepEqual(outcome, { status: 'BLOCKED', reason: EXPECTED_REASON });
    assert.deepEqual(planRows(plans), [], 'not one plan row may be written');
    assert.deepEqual(
      panel.lists,
      [],
      'and the wrong customer device list is not even READ -- the hwids never ' +
        'enter this process, so they cannot be persisted by any later edit',
    );
    assert.deepEqual(panel.calls, [], 'a refused planning pass produces no panel traffic at all');
  });

  it('an empty stored id is refused the same way', async () => {
    const { service, plans, panel } = build({ remnawaveId: '' });

    const outcome = await service.planForSubscription('sub-1');

    assert.deepEqual(outcome, { status: 'BLOCKED', reason: EXPECTED_REASON });
    assert.deepEqual(planRows(plans), []);
    assert.deepEqual(panel.calls, []);
  });

  it('INERTNESS CONTROL: the same harness DOES persist a plan when the link is repaired', async () => {
    // Without this case the empty array above would pass for a service that
    // threw before reaching the upsert. Same harness, same stubs, one repaired
    // row -- and the assertion is on the ROW and on the ARGUMENTS, not a count.
    const { service, plans, panel } = build({
      remnawaveId: LIVE_DECIMAL,
      strictList: OWN_DEVICES,
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    // The identity alone -- no era rides along -- and the device read is the
    // only panel call: the version is never asked.
    assert.deepEqual(panel.lists, [[HEALTHY_IDENTITY]], 'the read is addressed from the repaired row');
    assert.deepEqual(panel.calls, ['strictListUserDevices']);
    const [row] = planRows(plans);
    assert.deepEqual(hwidsOf(row), ['own-phone'], 'newest-first, and it is HIS device');
    assert.equal(row?.['desiredLimit'], 1);
    assert.equal(row?.['projectionRevision'], 4n);
    assert.equal(row?.['state'], 'PENDING');
  });

  it('the refused revision stays USABLE: no placeholder row poisons the later repair', async () => {
    // Why the answer is "persist nothing" rather than "persist a blocked plan".
    const stale = build();
    await stale.service.planForSubscription('sub-1');
    assert.deepEqual(planRows(stale.plans), [], 'the stale pass left nothing behind');

    // The row is relinked -- by the automatic link check, or by «Привязать
    // профиль» -- and `remnawaveId` is rewritten to the decimal. Same revision,
    // same subscription, same table.
    const repaired = build({
      remnawaveId: LIVE_DECIMAL,
      strictList: OWN_DEVICES,
    });
    for (const [key, row] of stale.plans) repaired.plans.set(key, row);

    const outcome = await repaired.service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.deepEqual(
      hwidsOf(planRows(repaired.plans)[0]),
      ['own-phone'],
      'the real targets are what the revision ends up holding',
    );
  });

  it('the operator is TOLD, once, and re-planning does not become an incident storm', async () => {
    // The boundary sweep re-enters planning every five minutes until a terminal
    // outcome, and a stale link is not terminal by itself. Without an incident
    // the subscription would stall forever in silence; with one incident per
    // tick the operator would be buried. So the refusal is keyed by
    // `(subscription, revision)`, exactly as the existing dormancy refusal is.
    const { service, incidents } = build();

    await service.planForSubscription('sub-1');
    await service.planForSubscription('sub-1');
    await service.planForSubscription('sub-1');

    const rows = [...incidents.values()];
    assert.equal(rows.length, 1, 'three sweeps, one row');
    assert.deepEqual(
      {
        subscriptionId: rows[0]?.['subscriptionId'],
        kind: rows[0]?.['kind'],
        summaryCode: rows[0]?.['summaryCode'],
        supportRef: rows[0]?.['supportRef'],
      },
      {
        subscriptionId: 'sub-1',
        kind: 'DEVICE_REDUCTION_BLOCKED',
        summaryCode: EXPECTED_REASON,
        supportRef: 'device-reduction-stale-link:sub-1:4',
      },
    );
    assert.equal(
      rows[0]?.['severity'],
      'WARNING',
      'WARNING and not CRITICAL: this refusal stops before anything exists, ' +
        'which is the line this subsystem already draws between the two halves',
    );
  });

  it('a subscription with no panel profile still asks the panel NOTHING', async () => {
    // The guard must not move in front of the cheap local disqualifications.
    const { service, panel } = build({ remnawaveId: null });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'NOT_APPLICABLE');
    assert.deepEqual(panel.calls, [], 'no profile means no device read');
  });

  it('an unlimited desired limit short-circuits before the guard', async () => {
    const { service, panel } = build({
      projection: { id: 'proj-1', desiredRevision: 1n, desiredDeviceLimit: null },
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'NOT_APPLICABLE');
    assert.deepEqual(panel.calls, []);
  });
});

// -- THE STATES THAT MUST NOT NOTICE THE GUARD -------------------------------

describe('device reduction PLANNING on a link that is NOT stale is untouched', () => {
  it('a current decimal identity: the ordinary plan is unchanged', async () => {
    // The inverted-test catcher: a guard that refused a decimal would stop every
    // correctly-linked reduction.
    const { service, plans, panel } = build({
      remnawaveId: LIVE_DECIMAL,
      strictList: OWN_DEVICES,
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.deepEqual(panel.lists, [[HEALTHY_IDENTITY]]);
    assert.deepEqual(hwidsOf(planRows(plans)[0]), ['own-phone']);
  });

  it('an outage still DEFERS, as it always has -- the guard did not turn it into a refusal', async () => {
    // What an unreachable panel produces here is the answer it always produced:
    // the strict list says `unavailable` and the pass DEFERS, durably retryable
    // and raising nothing. The guard reads no version, so an outage cannot
    // reach it at all.
    const { service, plans, incidents, panel } = build({
      remnawaveId: LIVE_DECIMAL,
      strictList: { kind: 'unavailable', retryAfterMs: null },
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.deepEqual(outcome, { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' });
    assert.deepEqual(panel.lists, [[HEALTHY_IDENTITY]]);
    assert.deepEqual(planRows(plans), [], 'an unavailable list plans nothing, as before');
    assert.deepEqual([...incidents.values()], [], 'an outage raises no incident');
  });
});

// -- THE TOKEN ---------------------------------------------------------------

describe('the planner stale-link reason token', () => {
  it('is the SAME spelling the execution half exports, not a second dialect', () => {
    // One code across both halves, so one runbook covers both and an operator
    // reading `STALE_PANEL_LINK` on a plan and on a refusal is reading about
    // the same fault with the same remedy. A second spelling here would be a
    // second thing to recognise for no additional information.
    assert.equal(STALE_PANEL_LINK, EXPECTED_REASON);
  });
});
