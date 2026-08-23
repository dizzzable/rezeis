import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STALE_PANEL_LINK } from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';
import { DeviceReductionPlanService } from '../src/modules/add-on-entitlements/services/device-reduction-plan.service';

/**
 * THE STALE-LINK GUARD ON THE OTHER HALF OF THE SAGA: THE PLANNER.
 *
 * `device-reduction-stale-panel-link.spec.ts` covers the EXECUTION guard, which
 * refuses to delete against a link that cannot be trusted to name the right
 * customer. This file covers the half that runs FIRST, and the defect that
 * survived that fix.
 *
 * -- WHAT THE EXECUTION GUARD DOES NOT COVER ---------------------------------
 *
 * `DeviceReductionPlanService.planForSubscription` reads
 * `strictListUserDevices` on the stored identity and asks NO era question at
 * all. `panelUserAddress` falls back -- numeric fast path -> `remnawavePanelId`
 * -> the short uuid recovered from `config_url` -> `remnawavePanelUsername` --
 * so on a 3.x panel a dead 2.x uuid still resolves to whatever profile is LIVE
 * at that address. The planner therefore reads A DIFFERENT CUSTOMER'S DEVICE
 * LIST and writes THEIR hwids into `selectedDevices` as this subscription's
 * targets.
 *
 * The execution guard then refuses to run that plan -- nothing is deleted --
 * but the row is still there, and an operator inspecting it sees a
 * coherent-looking plan about device identifiers that were never this
 * subscriber's. Persisting somebody else's hwids under a customer's
 * subscription is the defect on its own, independent of whether anything is
 * ever deleted.
 *
 * -- WHY THE ANSWER IS "PERSIST NOTHING", NOT "PERSIST A BLOCKED PLAN" -------
 *
 * The planner has no `block()`: every BLOCKED outcome it already returns
 * (`STRICT_LIST_*`, `INVALID_SOURCE_DATA`, `DORMANT_RETENTION_CONFLICT`)
 * persists no plan, and its own docstring says so -- "that refusal blocks here,
 * so no plan is ever persisted for an operator to approve". A blocked plan here
 * would be worse than useless, and one line explains why: the upsert is keyed
 * `(subscriptionId, projectionRevision)` with an EMPTY `update`, so the first
 * row written at a revision is the row FOREVER. A placeholder written while the
 * link was stale would still be sitting there, empty, after the reconciliation
 * repaired the link -- and the re-plan that should have produced the real
 * targets would silently return the placeholder instead. Persisting nothing
 * keeps the revision usable, and the case below proves exactly that.
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
 * Timestamps are RELATIVE TO NOW, never literals.
 *
 * `selectDeviceReductionTargets` classifies every row against `Date.now()` for
 * the dormancy rule, so a fixture dated `2026-01-01` is a fixture whose meaning
 * changes every day it is not looked at. Nothing here carries a `lastSeenAt`,
 * so the activity gate reads every row as `unknown` and the dormancy rule is
 * inert; the ages exist only so the rows are plausible and so newest-first has
 * a deterministic answer.
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
  /** Ordered verbs, so "the era is read once, first" is a claim about ORDER. */
  readonly calls: string[];
  /** The identity handed to each strict READ, by value. */
  readonly lists: unknown[];
}

interface Opts {
  readonly addressing?: 'id' | 'uuid' | 'unknown';
  /** An unreachable panel: the shape read throws rather than answering. */
  readonly throws?: boolean;
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
const STALE_IDENTITY = { remnawaveId: DEAD_UUID, panelId: 8123, panelUsername: 'rz_alice_sub' };
const HEALTHY_IDENTITY = { ...STALE_IDENTITY, remnawaveId: LIVE_DECIMAL };

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
      if (opts.throws === true) throw new Error('panel unreachable');
      return { addressing: opts.addressing ?? 'id' };
    },
    strictListUserDevices: async (ref: unknown) => {
      record.calls.push('strictListUserDevices');
      record.lists.push(ref);
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
    const { service, plans, panel } = build({ addressing: 'id' });

    const outcome = await service.planForSubscription('sub-1');

    assert.deepEqual(outcome, { status: 'BLOCKED', reason: EXPECTED_REASON });
    assert.deepEqual(planRows(plans), [], 'not one plan row may be written');
    assert.deepEqual(
      panel.lists,
      [],
      'and the wrong customer device list is not even READ -- the hwids never ' +
        'enter this process, so they cannot be persisted by any later edit',
    );
    assert.deepEqual(
      panel.calls,
      ['getPanelShape'],
      'the era read is the ONLY panel traffic a refused planning pass produces',
    );
  });

  it('INERTNESS CONTROL: the same harness DOES persist a plan when the link is repaired', async () => {
    // Without this case the empty array above would pass for a service that
    // threw before reaching the upsert. Same harness, same stubs, one repaired
    // row -- and the assertion is on the ROW and on the ARGUMENTS, not a count.
    const { service, plans, panel } = build({
      addressing: 'id',
      remnawaveId: LIVE_DECIMAL,
      strictList: OWN_DEVICES,
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.deepEqual(panel.lists, [HEALTHY_IDENTITY], 'the read is addressed from the repaired row');
    const [row] = planRows(plans);
    assert.deepEqual(hwidsOf(row), ['own-phone'], 'newest-first, and it is HIS device');
    assert.equal(row?.['desiredLimit'], 1);
    assert.equal(row?.['projectionRevision'], 4n);
    assert.equal(row?.['state'], 'PENDING');
  });

  it('the refused revision stays USABLE: no placeholder row poisons the later repair', async () => {
    // Why the answer is "persist nothing" rather than "persist a blocked plan".
    // The upsert is keyed `(subscriptionId, projectionRevision)` with an EMPTY
    // `update`, so whatever is written first at a revision is what an operator
    // sees forever. A placeholder written during the stale window would survive
    // the reconciliation and the re-plan would return IT instead of the real
    // targets.
    const stale = build({ addressing: 'id' });
    await stale.service.planForSubscription('sub-1');
    assert.deepEqual(planRows(stale.plans), [], 'the stale pass left nothing behind');

    // The operator runs the panel link reconciliation; `remnawaveId` is
    // rewritten to the decimal. Same revision, same subscription, same table.
    const repaired = build({
      addressing: 'id',
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
    // outcome, and a stale link is not terminal by itself -- only the
    // reconciliation clears it. Without an incident the subscription would
    // stall forever in silence; with one incident per tick the operator would
    // be buried. So the refusal is keyed by `(subscription, revision)`, exactly
    // as the existing dormancy refusal is, and for the same reason: NO PLAN
    // EXISTS to hang it off.
    const { service, incidents } = build({ addressing: 'id' });

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

  it('ONE OBSERVATION: the era is read once per planning pass, and BEFORE the device read', async () => {
    // The defect the observation shape exists to close, restated on this flow.
    // `getPanelShape()` caches a FAILURE for fifteen seconds, so two readings
    // taken microseconds apart can legitimately disagree -- and the
    // disagreement that hurts runs "the guard saw 'unknown', so proceed" into
    // "the address builder saw 'id', so fall back through panelId to whatever
    // is live at that address". One reading per pass is the property; a second
    // one anywhere in this method is the defect being re-introduced.
    const { service, panel } = build({
      addressing: 'id',
      remnawaveId: LIVE_DECIMAL,
      strictList: OWN_DEVICES,
    });

    await service.planForSubscription('sub-1');

    assert.deepEqual(
      panel.calls,
      ['getPanelShape', 'strictListUserDevices'],
      'exactly one era read, and it precedes the device list rather than following it',
    );
  });

  it('a subscription with no panel profile still asks the panel NOTHING', async () => {
    // The guard must not move in front of the cheap local disqualifications.
    // Most swept subscriptions never reach the panel at all, and an era read
    // per swept subscription would be a new round trip on a path that used to
    // be pure database work.
    const { service, panel } = build({ remnawaveId: null });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'NOT_APPLICABLE');
    assert.deepEqual(panel.calls, [], 'no profile means neither era nor devices are asked for');
  });

  it('an unlimited desired limit short-circuits before the era is read', async () => {
    const { service, panel } = build({
      projection: { id: 'proj-1', desiredRevision: 1n, desiredDeviceLimit: null },
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'NOT_APPLICABLE');
    assert.deepEqual(panel.calls, []);
  });
});

// -- THE THREE STATES THAT MUST NOT NOTICE THE GUARD -------------------------

describe('device reduction PLANNING on a link that is NOT stale is untouched', () => {
  it('3.x panel, current decimal identity: the ordinary plan is unchanged', async () => {
    // The inverted-shape-test catcher: a guard that refused a decimal would
    // stop every correctly-linked reduction on a 3.x panel.
    const { service, plans, panel } = build({
      addressing: 'id',
      remnawaveId: LIVE_DECIMAL,
      strictList: OWN_DEVICES,
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.deepEqual(panel.lists, [HEALTHY_IDENTITY]);
    assert.deepEqual(hwidsOf(planRows(plans)[0]), ['own-phone']);
  });

  it('2.x panel: a uuid identity is what that panel issued, so planning runs', async () => {
    // Installations still on 2.x must not notice this guard at all -- there the
    // stored uuid is CORRECT and this population is empty.
    const { service, plans, panel } = build({ addressing: 'uuid', strictList: OWN_DEVICES });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.deepEqual(panel.lists, [STALE_IDENTITY], 'addressed from the uuid, which 2.x answers to');
    assert.deepEqual(hwidsOf(planRows(plans)[0]), ['own-phone']);
  });

  it('THE FAIL-OPEN: an unreachable panel must NOT become a new way for PLANNING to fail', async () => {
    // THIS STANCE IS DELIBERATE AND IS ASSERTED FOR ALL FOUR SIBLING GUARDS.
    // Version detection fails for the same reasons requests fail -- an
    // unreachable panel, an expired token, a panel mid-restart -- so a refusal
    // keyed on it would fire exactly when the panel is already answering with
    // terminal errors. `observePanelEra` turns a throw into 'unknown', and
    // 'unknown' is trusted. What an unreachable panel produces here is the
    // answer it always produced: the strict list says `unavailable` and the
    // pass DEFERS, durably retryable and raising nothing.
    const { service, plans, incidents, panel } = build({
      throws: true,
      strictList: { kind: 'unavailable', retryAfterMs: null },
    });

    const outcome = await service.planForSubscription('sub-1');

    assert.deepEqual(outcome, { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' });
    assert.deepEqual(
      panel.lists,
      [STALE_IDENTITY],
      'the stale-shaped identity is still USED when the era cannot be read -- ' +
        'the guard did not turn an outage into a refusal',
    );
    assert.deepEqual(planRows(plans), [], 'an unavailable list plans nothing, as before');
    assert.deepEqual([...incidents.values()], [], 'an unreadable era raises no incident');
  });

  it('an unreadable era with a healthy device read still plans normally', async () => {
    // The half of the fail-open that the DEFERRED case above cannot show: when
    // the era read fails but the device read succeeds, a plan is still built.
    // Otherwise "fail-open" could be satisfied by a service that always defers.
    const { service, plans } = build({ throws: true, strictList: OWN_DEVICES });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.deepEqual(hwidsOf(planRows(plans)[0]), ['own-phone']);
  });

  it('an era the panel REPORTED as unknown behaves the same as an unreachable one', async () => {
    // The other half of 'unknown': the shape read succeeded and could not
    // classify the version. Asserted separately because a guard could easily
    // catch one and not the other.
    const { service, plans } = build({ addressing: 'unknown', strictList: OWN_DEVICES });

    const outcome = await service.planForSubscription('sub-1');

    assert.equal(outcome.status, 'PLANNED');
    assert.deepEqual(hwidsOf(planRows(plans)[0]), ['own-phone']);
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
