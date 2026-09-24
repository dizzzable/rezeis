import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  DeviceReductionExecutionService,
  STALE_PANEL_LINK,
  type DeviceReductionExecutionOutcome,
} from '../src/modules/add-on-entitlements/services/device-reduction-execution.service';
import { SAFE_PRODUCT_CODES } from '../src/common/filters/admin-safe-exception.filter';

/**
 * THE STALE-LINK GUARD ON THE FOURTH VERB: THE DEVICE-REDUCTION SAGA.
 *
 * A SIBLING FILE RATHER THAN MORE OF `device-reduction-execution.service.spec.ts`,
 * for the reason the regenerate spec is separate from the delete spec: that file
 * is about the saga's own state machine — claims, supersedes, read-backs — and
 * this is about ONE refusal standing in front of all of it.
 *
 * WHAT MAKES THIS SITE DIFFERENT FROM THE THREE HTTP SIBLINGS. Those three
 * refuse an operator's or a subscriber's CLICK, in a request, with a 409 whose
 * body a client branches on. This one has no request behind it. Its targets come
 * from a `DeviceReductionPlan` persisted at some earlier moment, so the link can
 * be healthy when the plan is BUILT and stale by the time it EXECUTES.
 *
 * WHY THE REFUSAL IS A BLOCK AND NOT A DEFERRAL. A stale link does not heal by
 * waiting — it clears when the row is linked to its numeric id — so DEFERRED
 * would leave the plan beating forever against a link that cannot come right on
 * its own, and beating quietly, because a deferral raises no incident.
 *
 * THE GUARD READS NO PANEL VERSION. The harness's `getPanelShape` records the
 * call and throws: a guard that asked would show up in the call list.
 *
 * EVERY REFUSAL HERE PINS A POSITIVE SIDE. "No device was deleted" passes just as
 * happily for a run that reached no code at all, so each refusal is paired with
 * an INERTNESS CONTROL driving the SAME harness with a repaired row and
 * asserting the exact arguments that arrive at the panel.
 */

/** A live 2.x uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
/** The same profile as a 3.x panel names it. */
const LIVE_DECIMAL = '5150';

/**
 * The reason token this guard writes, spelled out ONCE here as a literal.
 *
 * Asserting only `outcome.reason === STALE_PANEL_LINK` against the service's own
 * export would pass for any rename, including a rename to something meaningless:
 * the test would be comparing the constant with itself. So the literal is pinned
 * here and the export is checked against it below — the wire spelling and the
 * wiring are two separate claims and both are made.
 */
const EXPECTED_REASON = 'STALE_PANEL_LINK';

const ORIGINAL_FLAG = process.env['ADDON_DEVICE_CLEANUP_AUTO'];
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['ADDON_DEVICE_CLEANUP_AUTO'];
  else process.env['ADDON_DEVICE_CLEANUP_AUTO'] = ORIGINAL_FLAG;
});
function enableAuto(): void {
  process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'true';
}

/**
 * Timestamps are RELATIVE TO NOW, never literals.
 *
 * `findDormantRetentionConflict` — the gate immediately above the delete this
 * guard stands in front of — classifies each row against `Date.now()`. Nothing
 * here carries a `lastSeenAt`, so the activity signal gate reads every row as
 * `unknown` and the dormancy rule is inert; the ages below exist only so the
 * rows are plausible.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function okList(...hwids: string[]) {
  return {
    kind: 'ok' as const,
    value: {
      devices: hwids.map((hwid) => ({ hwid, createdAt: daysAgo(30), lastSeenAt: null })),
      total: hwids.length,
    },
    detectedVersion: '3.2.1',
  };
}

/** Every panel interaction the saga can have, with everything it was handed. */
interface PanelRecord {
  /** Ordered verbs. */
  readonly calls: string[];
  /** Every argument list handed to a strict READ. */
  readonly lists: unknown[][];
  /** Every argument list handed to a strict DELETE. */
  readonly deletes: unknown[][];
}

interface PanelOpts {
  readonly listQueue?: unknown[];
  readonly deleteResults?: unknown[];
}

function panelHarness(opts: PanelOpts) {
  const record: PanelRecord = { calls: [], lists: [], deletes: [] };
  const listQueue = [...(opts.listQueue ?? [])];
  const deleteResults = [...(opts.deleteResults ?? [])];
  const remnawave = {
    getPanelShape: async () => {
      record.calls.push('getPanelShape');
      throw new Error('the panel version must not be read by the device saga');
    },
    strictListUserDevices: async (...args: unknown[]) => {
      record.calls.push('strictListUserDevices');
      record.lists.push(args);
      return listQueue.length > 0 ? listQueue.shift() : okList('old');
    },
    strictDeleteUserDevice: async (...args: unknown[]) => {
      record.calls.push('strictDeleteUserDevice');
      record.deletes.push(args);
      return deleteResults.length > 0
        ? deleteResults.shift()
        : { kind: 'ok', value: { total: 1 }, detectedVersion: '3.2.1' };
    },
  };
  return { record, remnawave };
}

function subscriptionRow(remnawaveId: string) {
  return {
    remnawaveId,
    remnawavePanelId: 8123,
    remnawavePanelUsername: 'rz_alice_sub',
    status: 'ACTIVE',
  };
}

/** The identity the adapter must receive — asserted by VALUE, never by count. */
const HEALTHY_IDENTITY = {
  remnawaveId: LIVE_DECIMAL,
  panelId: 8123,
  panelUsername: 'rz_alice_sub',
};

interface Opts extends PanelOpts {
  readonly remnawaveId?: string;
  readonly planState?: string;
  readonly targets?: string[];
}

function build(opts: Opts = {}) {
  const planUpdates: Array<Record<string, unknown>> = [];
  const incidents: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  const { record, remnawave } = panelHarness(opts);

  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    deviceReductionPlan: {
      findUnique: async () => ({
        id: 'plan-1',
        subscriptionId: 'sub-1',
        projectionId: 'proj-1',
        projectionRevision: 4n,
        desiredLimit: 1,
        state: opts.planState ?? 'PENDING',
        startedAt: null,
        selectedDevices: (opts.targets ?? ['new']).map((hwid) => ({
          hwid,
          createdAt: daysAgo(2),
        })),
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        planUpdates.push(args.data);
        return {};
      },
      updateMany: async (args: { data: Record<string, unknown> }) => {
        claims.push(args.data);
        return { count: 1 };
      },
    },
    subscriptionEffectiveProjection: {
      findUnique: async () => ({ desiredRevision: 4n, desiredDeviceLimit: 1 }),
    },
    subscription: {
      findUnique: async () => subscriptionRow(opts.remnawaveId ?? DEAD_UUID),
      findFirst: async () => null,
    },
    entitlementIncident: {
      upsert: async (args: { create: Record<string, unknown> }) => {
        incidents.push(args.create);
        return { id: 'inc-1' };
      },
    },
  };

  const completion = {
    completeVerifiedDeviceExpiryInTransaction: async () => ({
      status: 'COMPLETED' as const,
      completed: 1,
    }),
  };

  const service = new DeviceReductionExecutionService(
    prisma as never,
    remnawave as never,
    completion as never,
  );
  return { service, planUpdates, incidents, claims, panel: record };
}

function reasonOf(outcome: DeviceReductionExecutionOutcome): string | undefined {
  return 'reason' in outcome ? outcome.reason : undefined;
}

// -- THE REFUSAL -------------------------------------------------------------

describe('device reduction on a stale panel link', () => {
  it('THE PROOF: the plan is BLOCKED and NOT ONE panel call is issued', async () => {
    // The whole hazard in one case. `strictDeleteUserDevice` names its owner
    // through the SAME `panelUserAddress` fallback every other verb uses --
    // numeric fast path -> `remnawavePanelId` -> the short uuid recovered from
    // `config_url` -> `remnawavePanelUsername` -- so this dead uuid resolves,
    // via the recorded panel id, to whatever profile is LIVE at that address. On
    // an unrepaired duplicate pair that is a paying customer, and the saga
    // unbinds a device they are using.
    enableAuto();
    const { service, planUpdates, incidents, panel } = build();

    const outcome = await service.executePlan('plan-1');

    assert.deepEqual(outcome, { status: 'BLOCKED', reason: EXPECTED_REASON });
    assert.deepEqual(panel.deletes, [], 'not one device may be unbound from any profile');
    assert.deepEqual(
      panel.lists,
      [],
      'the READS are covered too: a list against the wrong profile makes the ' +
        'post-condition assert about somebody else’s device list',
    );
    assert.deepEqual(panel.calls, [], 'a refused plan produces no panel traffic at all');
    // The refusal has to survive the run, not just be returned by it.
    const blocked = planUpdates.find((data) => data.state === 'BLOCKED');
    assert.notEqual(blocked, undefined, 'the plan row is moved to BLOCKED');
    assert.equal(blocked?.lastErrorCode, EXPECTED_REASON);
    assert.equal(incidents.length, 1, 'an operator is told, once');
    assert.deepEqual(
      {
        subscriptionId: incidents[0]?.subscriptionId,
        kind: incidents[0]?.kind,
        severity: incidents[0]?.severity,
        summaryCode: incidents[0]?.summaryCode,
        supportRef: incidents[0]?.supportRef,
      },
      {
        subscriptionId: 'sub-1',
        kind: 'DEVICE_REDUCTION_BLOCKED',
        severity: 'CRITICAL',
        summaryCode: EXPECTED_REASON,
        // The support ref names the CAUSE as well as the plan. Keying it on the
        // plan alone made `update: {}` keep the FIRST reason forever, so a plan
        // blocked for something else and later for this one still told the
        // operator about the first thing. See
        // `device-reduction-blocked-reason-visibility.spec.ts`.
        supportRef: 'device-reduction:plan-1:STALE_PANEL_LINK',
      },
    );
  });

  it('an empty stored id is refused the same way — it names nobody either', async () => {
    enableAuto();
    const { service, panel } = build({ remnawaveId: '' });

    const outcome = await service.executePlan('plan-1');

    // `storedIdentityOf` still answers for an empty string (only NULL means "no
    // profile"), so the plan reaches the guard, and the guard refuses it.
    assert.deepEqual(outcome, { status: 'BLOCKED', reason: EXPECTED_REASON });
    assert.deepEqual(panel.calls, []);
  });

  it('INERTNESS CONTROL: the same harness DOES delete when the link is repaired', async () => {
    // Without this case, every "nothing was deleted" above would pass for a
    // service that crashed before reaching any of it. Same harness, same stubs,
    // one repaired row -- and the assertion is on the ARGUMENTS, not on a count.
    enableAuto();
    const { service, planUpdates, incidents, panel } = build({
      remnawaveId: LIVE_DECIMAL,
      listQueue: [okList('old', 'new'), okList('old')],
    });

    const outcome = await service.executePlan('plan-1');

    assert.deepEqual(outcome, { status: 'APPLIED', deleted: 1 });
    // The identity (and the hwid) and nothing else: no era rides along any more,
    // and the panel's version is never asked.
    assert.deepEqual(panel.deletes, [[HEALTHY_IDENTITY, 'new']]);
    assert.deepEqual(panel.lists, [[HEALTHY_IDENTITY], [HEALTHY_IDENTITY]]);
    assert.equal(panel.calls.includes('getPanelShape'), false);
    assert.equal(planUpdates.some((data) => data.state === 'APPLIED'), true);
    assert.deepEqual(incidents, [], 'a healthy run raises nothing');
  });

  it('the refusal is TERMINAL, not a deferral that beats forever', async () => {
    // `PANEL_UNAVAILABLE` is the service's word for "come back later", and a
    // stale link is the opposite kind of failure: waiting does nothing. A
    // deferral would also raise NO incident, so the plan would keep retrying
    // against a wrong profile in silence.
    enableAuto();
    const { service, planUpdates, incidents } = build();

    const outcome = await service.executePlan('plan-1');

    assert.notEqual(outcome.status, 'DEFERRED', 'a stale link does not heal by retrying');
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(reasonOf(outcome), EXPECTED_REASON);
    assert.equal(
      planUpdates.some((data) => data.state === 'IN_PROGRESS'),
      true,
      'the run started, so an operator sees an attempt rather than a silent skip',
    );
    assert.equal(
      incidents[0]?.severity,
      'CRITICAL',
      'a deferral raises nothing; this outcome has to reach a person',
    );
  });

  it('a re-run does not silently retry the deletion -- the automatic sweep will not touch it', async () => {
    // BLOCKED is not in `AUTO_STARTABLE_STATES`, which is what makes the
    // refusal stick: the unattended sweep that would otherwise re-drive this
    // plan every cycle stops at the state and never reaches the panel.
    enableAuto();
    const { service, panel } = build({ planState: 'BLOCKED' });

    const outcome = await service.executePlan('plan-1');

    assert.deepEqual(outcome, { status: 'SKIPPED', reason: 'PLAN_STATE_BLOCKED' });
    assert.deepEqual(panel.deletes, []);
    assert.deepEqual(panel.calls, [], 'a skipped plan asks the panel nothing at all');
  });

  it('an operator re-driving the blocked plan is refused again, not obeyed', async () => {
    // `force: true` DOES widen the startable states to include BLOCKED -- that
    // is the whole point of the override, and it is how a plan is re-driven
    // once the cause is fixed. So the override reaches the guard, and the guard
    // has to answer the same way a second time: the link is still stale until
    // the row is linked to its numeric id.
    enableAuto();
    const { service, panel, incidents } = build({ planState: 'BLOCKED' });

    const outcome = await service.executePlan('plan-1', { force: true });

    assert.deepEqual(outcome, { status: 'BLOCKED', reason: EXPECTED_REASON });
    assert.deepEqual(panel.deletes, [], 'a second click is not a second licence to delete');
    assert.deepEqual(panel.lists, []);
    assert.equal(incidents[0]?.summaryCode, EXPECTED_REASON);
  });

  it('the guard stands in front of the READS as well, not only the deletes', async () => {
    // Stated as its own case because "no delete happened" is the obvious half
    // and the reads are the half that gets left out. A read against the wrong
    // profile destroys nothing, but every decision in the loop is made FROM it:
    // whether the target is still present, whether the overage is already gone,
    // and whether the dormancy gate fires. The FINAL read-back is worse — it is
    // the proof written into `postconditionMetadata` before the plan marks
    // itself APPLIED, so a read off the wrong profile would let a plan certify
    // a limit it never applied to anybody.
    enableAuto();
    const { service, planUpdates, panel } = build();

    await service.executePlan('plan-1');

    assert.deepEqual(
      panel.calls.filter((call) => call === 'strictListUserDevices'),
      [],
      'neither the per-pass list nor the final read-back may be issued',
    );
    assert.equal(
      planUpdates.some((data) => data.state === 'APPLIED'),
      false,
      'and no post-condition is certified off a list that was never read',
    );
  });
});

// -- THE STATE THAT MUST NOT NOTICE THE GUARD --------------------------------

describe('device reduction on a link that is NOT stale is untouched', () => {
  it('a current decimal identity: the ordinary reduction is unchanged, over every target', async () => {
    // The inverted-test catcher. A guard that refused a decimal would stop every
    // correctly-linked reduction.
    enableAuto();
    const { service, panel } = build({
      remnawaveId: LIVE_DECIMAL,
      targets: ['new', 'newer'],
      listQueue: [okList('old', 'new', 'newer'), okList('old', 'newer'), okList('old')],
    });

    const outcome = await service.executePlan('plan-1');

    assert.equal(outcome.status, 'APPLIED');
    assert.deepEqual(panel.deletes, [
      [HEALTHY_IDENTITY, 'new'],
      [HEALTHY_IDENTITY, 'newer'],
    ]);
    assert.equal(panel.calls.includes('getPanelShape'), false, 'no version is read at all');
  });
});

// -- WHAT THE REASON IS, AND WHAT IT IS NOT ----------------------------------

describe('the STALE_PANEL_LINK reason token', () => {
  it('is the spelling the service actually exports, not a literal the test invented', () => {
    // The other half of the claim EXPECTED_REASON makes. Every assertion above
    // compares a persisted row against the local literal, which pins the WIRE
    // SPELLING; this one pins the WIRING, so a rename of the export shows up as
    // a failure here rather than as a silently renamed incident code that no
    // runbook and no operator recognises.
    assert.equal(STALE_PANEL_LINK, EXPECTED_REASON);
  });

  it('is NOT an HTTP product code, and must not be allowlisted as one', () => {
    // The decision, pinned so it is not quietly reversed. This is not a request
    // path: `AdminAddOnEntitlementsController.approveDevicePlan` returns
    // `BLOCKED` as a 200 BODY and throws only on `REFUSED`, and
    // `AdminSafeExceptionFilter` shapes EXCEPTIONS only -- a 200 never passes
    // through it. An entry in `SAFE_PRODUCT_CODES` would therefore be dead
    // configuration that reads like a wire contract.
    assert.equal(
      SAFE_PRODUCT_CODES.has(EXPECTED_REASON),
      false,
      'a 409 body is the wrong instrument for an outcome that travels as a 200',
    );
  });

  it('would survive the filter anyway, if some future path ever wrapped it in an exception', () => {
    // Belt and braces. Today this token never meets `SENSITIVE_HTTP_TEXT_PATTERNS`
    // — it travels in a 200 body — but `approveDevicePlan` DOES throw a
    // `ConflictException` interpolating `result.reason` on the `REFUSED` branch,
    // so a future edit routing this outcome through that throw is one line away.
    // A token that tripped the scrub would reach the operator as the four words
    // "Request failed", which is the failure mode the three sibling refusals are
    // worded around.
    //
    // WHAT SAVES IT IS THE UNDERSCORES, and that is worth pinning because it is
    // easy to get backwards: the scrub's word list is anchored with `\b`, and
    // `_` is a WORD character, so `profile` inside `PANEL_PROFILE_SHARED` has no
    // boundary in front of it and does not match. Every SCREAMING_SNAKE reason
    // in this service is protected by that accident; a reason ever spelled as
    // prose would not be. Both halves are asserted so neither can be assumed.
    const sensitive =
      /\b(?:auth|authorization|bearer|cookie|credential|password|profile|secret|token)\b/iu;
    assert.equal(sensitive.test(EXPECTED_REASON), false);
    assert.equal(
      sensitive.test('PANEL_PROFILE_SHARED'),
      false,
      'the SCREAMING_SNAKE spelling is what keeps the neighbours out of the scrub',
    );
    assert.equal(
      sensitive.test('the stored profile is stale'),
      true,
      'and prose would NOT be — the protection is the underscore, not the word list',
    );
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/iu.test(EXPECTED_REASON), false, 'no uuid');
    assert.equal(EXPECTED_REASON.includes('://'), false, 'no URL');
    assert.equal(/\b[0-9a-f]{24,}\b/iu.test(EXPECTED_REASON), false, 'no long hex run');
  });
});
