import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';

import { SystemEventsService } from '../src/common/services/system-events.service';
import {
  makeAntiFraudStore,
  type AntiFraudStore,
  type ExemptionRow,
  type SignalRow,
  type StreakRow,
} from './fixtures/anti-fraud-store';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import { FraudSignalCandidate } from '../src/modules/anti-fraud/interfaces/fraud-signal.interface';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  AntiFraudService,
  AUTO_RESOLVED_NOTE,
  AUTO_SUPERSEDED_NOTE,
} from '../src/modules/anti-fraud/services/anti-fraud.service';

/**
 * The two gates in front of "a fraud signal opens".
 *
 *   1. HYSTERESIS — a condition read off the live panel has to survive three
 *      consecutive observing runs before it becomes an accusation, so a
 *      momentary panel state cannot file a row against a paying customer.
 *   2. EXEMPTIONS — an operator can clear a specific user of specific detector
 *      codes until a date, and the exemption leaves a visible trace rather than
 *      quietly switching a detector off.
 *
 * Every test here is paired. A gate that simply refused to open anything would
 * satisfy "a one-shot candidate opens nothing" and fail "a sustained one opens
 * on the third run"; an exemption implemented as a blanket mute would satisfy
 * "HWID is suppressed" and fail "IP still opens". Nothing is asserted through an
 * internal flag — only the rows written, the events emitted, and what the
 * operator-facing read methods return.
 */

// ── Time buckets, as the detectors build them ────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const dayKey = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const TODAY = dayKey(0);
const YESTERDAY = dayKey(-1);

/** Mirrors `REQUIRED_OBSERVATIONS` in the service. */
const REQUIRED = 3;

/** A panel-backed code: reads a live snapshot, therefore gated. */
const GATED_CODE = 'SUBSCRIPTION_SHARING_HWID';
/** The other panel-backed code, used to prove exemptions are per-code. */
const OTHER_GATED_CODE = 'SUBSCRIPTION_SHARING_IP';
/** Counts immutable local rows, therefore NOT gated. */
const UNGATED_CODE = 'PROMO_ABUSE';

// ── Harness ──────────────────────────────────────────────────────────────────

type DetectorName =
  | 'excessiveFailedPayments'
  | 'rapidReferralVelocity'
  | 'promoAbuse'
  | 'rapidChurn'
  | 'perUserNodeTrafficAbuse'
  | 'hwidOverage'
  | 'concurrentIpSharing'
  | 'subscriptionUaTunnel';

type DetectorOutput = readonly FraudSignalCandidate[] | Error;

interface EmittedEvent {
  readonly type: string;
  readonly severity: 'INFO' | 'WARNING';
  readonly metadata: Record<string, unknown>;
  readonly message: string;
}

interface Harness {
  readonly service: AntiFraudService;
  readonly store: AntiFraudStore;
  readonly events: EmittedEvent[];
  readonly warns: string[];
  readonly logs: string[];
  /** Swaps what the detectors return for the next run. */
  setDetectors(next: Partial<Record<DetectorName, DetectorOutput>>): void;
}

function build(input: {
  readonly signals?: readonly Partial<SignalRow>[];
  readonly streaks?: readonly Partial<StreakRow>[];
  readonly exemptions?: readonly Partial<ExemptionRow>[];
  readonly users?: readonly string[];
  readonly detectors?: Partial<Record<DetectorName, DetectorOutput>>;
}): Harness {
  const store = makeAntiFraudStore({
    signals: input.signals,
    streaks: input.streaks,
    exemptions: input.exemptions,
    users: input.users ?? ['u1', 'u2'],
    today: TODAY,
  });
  const events: EmittedEvent[] = [];
  let current: Partial<Record<DetectorName, DetectorOutput>> = input.detectors ?? {};

  const out = (name: DetectorName) => () => {
    const configured = current[name] ?? [];
    return configured instanceof Error
      ? Promise.reject(configured)
      : Promise.resolve([...configured]);
  };

  const fraudDetectors = {
    detectExcessiveFailedPayments: out('excessiveFailedPayments'),
    detectRapidReferralVelocity: out('rapidReferralVelocity'),
    detectPromoAbuse: out('promoAbuse'),
    detectRapidChurn: out('rapidChurn'),
  } as unknown as FraudDetectors;

  const remnawaveDetectors = {
    detectPerUserNodeTrafficAbuse: out('perUserNodeTrafficAbuse'),
    collectHwidAverageAlerts: () => Promise.resolve([]),
    collectNodeTrafficAlerts: () => Promise.resolve([]),
    collectGeoConcentrationAlerts: () => Promise.resolve([]),
    collectOfflineNodeAlerts: () => Promise.resolve([]),
  } as unknown as RemnawaveDetectors;

  const sharingDetectors = {
    detectHwidOverage: out('hwidOverage'),
    detectConcurrentIpSharing: out('concurrentIpSharing'),
  } as unknown as SharingDetectors;

  const subscriptionUaDetectors = {
    detectSubscriptionUaTunnel: out('subscriptionUaTunnel'),
  } as unknown as SubscriptionUaDetectors;

  const record =
    (severity: 'INFO' | 'WARNING') =>
    (type: string, _category: string, message: string, metadata?: Record<string, unknown>) => {
      events.push({ type, severity, message, metadata: metadata ?? {} });
    };
  const systemEvents = {
    info: record('INFO'),
    warn: record('WARNING'),
    emit: () => undefined,
  } as unknown as SystemEventsService;

  const service = new AntiFraudService(
    store.prisma,
    fraudDetectors,
    remnawaveDetectors,
    sharingDetectors,
    subscriptionUaDetectors,
    {} as unknown as RemnawaveApiService,
    systemEvents,
  );

  return {
    service,
    store,
    events,
    warns: captured.warns,
    logs: captured.logs,
    setDetectors: (next) => {
      current = next;
    },
  };
}

function candidate(over: Partial<FraudSignalCandidate>): FraudSignalCandidate {
  return {
    code: GATED_CODE,
    fingerprint: `${TODAY}|uuid-1`,
    severity: FraudSignalSeverity.MEDIUM,
    title: 'Subscription sharing — device limit exceeded',
    description: 'description',
    score: 60,
    confidence: 80,
    affectedUserIds: ['u1'],
    metadata: {},
    ...over,
  };
}

const REQUEST_METADATA = {
  remoteAddress: '10.0.0.1',
  userAgent: 'test',
  requestId: 'req-1',
} as unknown as Parameters<AntiFraudService['createExemption']>[0]['requestMetadata'];

// ── Log capture ──────────────────────────────────────────────────────────────

const captured = (() => {
  const warns: string[] = [];
  const logs: string[] = [];
  const originalWarn = Logger.prototype.warn;
  const originalLog = Logger.prototype.log;
  Logger.prototype.warn = function patched(message: unknown): void {
    warns.push(String(message));
  } as typeof Logger.prototype.warn;
  Logger.prototype.log = function patched(message: unknown): void {
    logs.push(String(message));
  } as typeof Logger.prototype.log;
  return {
    warns,
    logs,
    restore(): void {
      Logger.prototype.warn = originalWarn;
      Logger.prototype.log = originalLog;
    },
  };
})();

afterEach(() => {
  captured.warns.length = 0;
  captured.logs.length = 0;
});
after(() => captured.restore());

/**
 * A gate that "worked" by throwing inside a swallowed catch would leave exactly
 * the same observable state as a gate that correctly held the candidate. Every
 * test asserts this.
 */
function assertNoInfrastructureFailure(warns: readonly string[]): void {
  const bad = warns.filter(
    (w) =>
      w.includes('reconciliation failed') ||
      w.includes('Failed to upsert') ||
      w.includes('Failed to clear') ||
      w.includes('cooldown probe failed'),
  );
  assert.deepStrictEqual(bad, [], 'the run must reach its verdict without swallowing an error');
}

const openSignals = (h: Harness): SignalRow[] =>
  h.store.rows.filter((r) => r.status === FraudSignalStatus.OPEN);

// ── Gate 1: sustained evidence ───────────────────────────────────────────────

describe('a panel-backed condition must be sustained before it accuses anyone', () => {
  it('files nothing at all on a single detection', async () => {
    // The behaviour this replaces: one reading — a stale HWID, an ip-control
    // response caught mid-handoff — was enough to open a row against a paying
    // customer.
    const h = build({ detectors: { hwidOverage: [candidate({})] } });

    await h.service.runDetectors();

    assert.deepStrictEqual(h.store.rows, [], 'one sighting is a reading, not an accusation');
    const streak = h.store.streakFor(GATED_CODE, 'uuid-1');
    assert.ok(streak, 'but the sighting is remembered');
    assert.equal(streak.observations, 1);
    assert.equal(streak.heldBy, 'streak');
    assertNoInfrastructureFailure(h.warns);
  });

  it('opens on exactly the third consecutive run, not the second and not the fourth', async () => {
    // The counterpart. A gate implemented as "never open" passes the test above
    // and fails this one.
    const h = build({ detectors: { hwidOverage: [candidate({})] } });

    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 0, 'run 1 files nothing');
    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 0, 'run 2 files nothing');
    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, `run ${REQUIRED} files exactly one signal`);
    assert.equal(h.store.rows[0].status, FraudSignalStatus.OPEN);
    assert.equal(h.store.rows[0].fingerprint, `${TODAY}|uuid-1`);

    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 1, 'and the fourth run refreshes it rather than duplicating');
    assert.equal(
      h.store.streakFor(GATED_CODE, 'uuid-1'),
      undefined,
      'the streak is dropped once it has done its job',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('reaches the subscription-UA detector, gates it, and never auto-resolves it', async () => {
    // `SubscriptionUaDetectors` existed, was tested, and was provided by the
    // module for a full round without being in the run plan — so it never ran.
    // Everything asserted here is downstream of that one registration:
    //
    //   in the plan          → a candidate it produces becomes a row at all;
    //   `observational`      → it waits for sustained evidence like its panel-
    //                          backed neighbours, rather than accusing on one
    //                          reading of a UA heuristic;
    //   `observational`      → and an empty run (panel down, log unreadable, the
    //                          operator switching it off) is NOT evidence the
    //                          condition cleared, so the row survives.
    const ua = candidate({
      code: 'SUBSCRIPTION_UA_TUNNEL',
      fingerprint: `${TODAY}|uuid-ua`,
      severity: FraudSignalSeverity.LOW,
      title: 'Subscription fetched by a client carrying a proxy config',
    });
    const h = build({ detectors: { subscriptionUaTunnel: [ua] } });

    await h.service.runDetectors();
    await h.service.runDetectors();
    assert.deepStrictEqual(h.store.rows, [], 'a UA heuristic does not accuse on one reading');
    assert.equal(h.store.streakFor('SUBSCRIPTION_UA_TUNNEL', 'uuid-ua')?.observations, 2);

    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 1, 'sustained, it opens — which it cannot do unregistered');
    assert.equal(h.store.rows[0].code, 'SUBSCRIPTION_UA_TUNNEL');
    assert.equal(h.store.rows[0].status, FraudSignalStatus.OPEN);

    // Switched off in the panel, or a panel that could not be read: both come
    // back as `[]`, and neither may close the row.
    h.setDetectors({ subscriptionUaTunnel: [] });
    await h.service.runDetectors();
    assert.equal(h.store.rows[0].status, FraudSignalStatus.OPEN, 'silence is not "it cleared"');
    assert.equal(h.store.rows[0].resolutionNote, null);
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not make a point-in-time finding wait', async () => {
    // PROMO_ABUSE counts promocode activations already committed to Postgres.
    // The third activation happened; looking again in five minutes cannot make
    // it un-happen, so a second observation adds nothing and the wait would be
    // fifteen minutes of pure delay.
    const h = build({
      detectors: {
        promoAbuse: [candidate({ code: UNGATED_CODE, fingerprint: `${TODAY}|abc` })],
      },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, 'immutable history is not a reading');
    assert.equal(h.store.rows[0].code, UNGATED_CODE);
    assert.deepStrictEqual(h.store.streaks, [], 'and it keeps no streak at all');
    assertNoInfrastructureFailure(h.warns);
  });

  it('survives a run the panel could not answer', async () => {
    // A sharing detector that returns [] may have seen a clean panel or may
    // have seen nothing at all — the run plan already refuses to treat the two
    // alike, and the streak must not either.
    const h = build({ detectors: { hwidOverage: [candidate({})] } });

    await h.service.runDetectors();
    h.setDetectors({ hwidOverage: [] }); // panel unreachable / node-flap / capability off
    await h.service.runDetectors();

    const afterSkip = h.store.streakFor(GATED_CODE, 'uuid-1');
    assert.ok(afterSkip, 'a run that could not observe must not erase the evidence');
    assert.equal(afterSkip.observations, 1, 'nor count as an observation');

    h.setDetectors({ hwidOverage: [candidate({})] });
    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 0, 'that is the second real observation');
    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 1, 'and the third opens it');
    assertNoInfrastructureFailure(h.warns);
  });

  it('survives a detector that threw', async () => {
    const h = build({ detectors: { hwidOverage: [candidate({})] } });

    await h.service.runDetectors();
    h.setDetectors({ hwidOverage: new Error('panel unreachable') });
    await h.service.runDetectors();

    const streak = h.store.streakFor(GATED_CODE, 'uuid-1');
    assert.ok(streak, 'a failure is not evidence of absence');
    assert.equal(streak.observations, 1);
    assert.ok(h.warns.some((w) => w.includes('detectHwidOverage') && w.includes('failed')));
  });

  it('restarts when a run that DID observe declined to name the condition', async () => {
    // The counterpart to the two above: with the panel demonstrably answering
    // (it named somebody else), the condition it no longer names really did
    // stop, and its half-built streak must not be banked for later.
    const h = build({ detectors: { hwidOverage: [candidate({})] } });

    await h.service.runDetectors();
    await h.service.runDetectors();
    assert.equal(h.store.streakFor(GATED_CODE, 'uuid-1')?.observations, 2);

    h.setDetectors({ hwidOverage: [candidate({ fingerprint: `${TODAY}|uuid-9` })] });
    await h.service.runDetectors();

    assert.equal(
      h.store.streakFor(GATED_CODE, 'uuid-1'),
      undefined,
      'the broken streak is gone, not paused',
    );

    h.setDetectors({ hwidOverage: [candidate({})] });
    await h.service.runDetectors();
    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 0, 'so the condition starts its count over');
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not count a sighting from another era as consecutive', async () => {
    // Two observations are "consecutive" only inside the gap bound. Without it,
    // a condition seen twice in the spring would open a signal in the summer.
    const h = build({
      streaks: [
        {
          code: GATED_CODE,
          conditionKey: 'uuid-1',
          observations: 2,
          lastSeenAt: new Date(Date.now() - 3 * HOUR_MS),
          firstSeenAt: new Date(Date.now() - 4 * HOUR_MS),
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 0, 'stale evidence does not complete a streak');
    assert.equal(h.store.streakFor(GATED_CODE, 'uuid-1')?.observations, 1, 'the count restarts');
    assertNoInfrastructureFailure(h.warns);
  });

  it('counts a sighting from inside the gap bound', async () => {
    // The counterpart: 12 runs of slack is what lets a panel outage pass
    // through without costing the streak.
    const h = build({
      streaks: [
        {
          code: GATED_CODE,
          conditionKey: 'uuid-1',
          observations: 2,
          lastSeenAt: new Date(Date.now() - 30 * 60_000),
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, 'half an hour of silence is still the same episode');
    assertNoInfrastructureFailure(h.warns);
  });
});

describe('the wait never delays a genuinely urgent case', () => {
  it('opens immediately when the evidence gets dramatically worse', async () => {
    const h = build({
      detectors: { hwidOverage: [candidate({ severity: FraudSignalSeverity.MEDIUM })] },
    });

    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 0);

    h.setDetectors({
      hwidOverage: [candidate({ severity: FraudSignalSeverity.HIGH, score: 98 })],
    });
    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, 'an escalation does not wait its turn');
    assert.equal(h.store.rows[0].severity, FraudSignalSeverity.HIGH);
    assert.ok(
      h.events.some((e) => e.type === 'fraud.signal_opened'),
      'and the operator is paged for it',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not treat a condition merely staying HIGH as an escalation', async () => {
    // The counterpart. If any HIGH bypassed the gate, the gate would do nothing
    // for the very detector whose readings are most transient.
    const h = build({
      detectors: { hwidOverage: [candidate({ severity: FraudSignalSeverity.HIGH })] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 0, 'a HIGH first reading is still a first reading');
    assert.equal(h.store.streakFor(GATED_CODE, 'uuid-1')?.observations, 2);
    assertNoInfrastructureFailure(h.warns);
  });

  it('leaves an already-open signal free to escalate on the very next run', async () => {
    // The gates sit in front of OPENING a signal, never in front of refreshing
    // one. A gate that also intercepted the refresh path would freeze a live
    // signal's severity and swallow the page it is supposed to trigger.
    const h = build({
      signals: [
        {
          id: 'live',
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          severity: FraudSignalSeverity.LOW,
          affectedUserIds: ['u1'],
        },
      ],
      detectors: {
        hwidOverage: [candidate({ severity: FraudSignalSeverity.HIGH, score: 99 })],
      },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows[0].severity, FraudSignalSeverity.HIGH);
    assert.ok(h.events.some((e) => e.type === 'fraud.signal_escalated'));
    assertNoInfrastructureFailure(h.warns);
  });
});

describe('a held candidate is not mistaken for a cleared one', () => {
  it('does not auto-resolve the open signal of a condition this run held', async () => {
    // `AUTO_SUPERSEDED_NOTE` says the condition was not re-detected. For a held
    // candidate that is the opposite of what happened: it WAS detected and we
    // chose not to act on it. Stamping that note would be the run lying in its
    // own audit trail.
    const h = build({
      signals: [
        {
          id: 'yesterday',
          code: GATED_CODE,
          fingerprint: `${YESTERDAY}|uuid-1`,
          updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();

    const row = h.store.rows.find((r) => r.id === 'yesterday');
    assert.equal(row?.status, FraudSignalStatus.OPEN, 'held is not cleared');
    assert.equal(row?.resolutionNote, null);
    assertNoInfrastructureFailure(h.warns);
  });

  it('still auto-resolves once the condition really does stop', async () => {
    // The counterpart, so the guard above cannot be implemented as "never
    // auto-resolve a gated code".
    const h = build({
      signals: [
        {
          id: 'gone',
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
        },
      ],
      detectors: { hwidOverage: [candidate({ fingerprint: `${TODAY}|uuid-9` })] },
    });

    await h.service.runDetectors();

    const row = h.store.rows.find((r) => r.id === 'gone');
    assert.equal(row?.status, FraudSignalStatus.RESOLVED);
    assert.equal(row?.resolutionNote, AUTO_RESOLVED_NOTE);
    assertNoInfrastructureFailure(h.warns);
  });
});

// ── Gate 2: exemptions ───────────────────────────────────────────────────────

describe('an exemption clears a user of the codes it names, and only those', () => {
  const bothDetectors = {
    hwidOverage: [candidate({ code: GATED_CODE, fingerprint: `${TODAY}|uuid-1` })],
    concurrentIpSharing: [
      candidate({
        code: OTHER_GATED_CODE,
        fingerprint: `${TODAY}|uuid-1`,
        severity: FraudSignalSeverity.LOW,
      }),
    ],
  };

  it('suppresses the exempted code and lets the other one through', async () => {
    const h = build({
      exemptions: [{ id: 'ex-1', userId: 'u1', codes: [GATED_CODE] }],
      detectors: bothDetectors,
    });

    // Three runs: enough for BOTH conditions to clear the hysteresis gate, so
    // the only thing separating them is the exemption.
    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();

    const codes = openSignals(h).map((r) => r.code);
    assert.deepStrictEqual(codes, [OTHER_GATED_CODE], 'a partial exemption is partial');
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not reach a different user', async () => {
    const h = build({
      exemptions: [{ id: 'ex-1', userId: 'u2', codes: [GATED_CODE] }],
      detectors: { hwidOverage: [candidate({ affectedUserIds: ['u1'] })] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();

    assert.equal(openSignals(h).length, 1, "u2's exemption says nothing about u1");
    assertNoInfrastructureFailure(h.warns);
  });

  it('stops suppressing the moment it expires', async () => {
    const h = build({
      exemptions: [
        {
          id: 'ex-1',
          userId: 'u1',
          codes: [GATED_CODE],
          expiresAt: new Date(Date.now() - 60_000),
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();

    assert.equal(openSignals(h).length, 1, 'an expired exemption is not an exemption');
    assertNoInfrastructureFailure(h.warns);
  });

  it('stops suppressing once revoked', async () => {
    const h = build({
      exemptions: [
        {
          id: 'ex-1',
          userId: 'u1',
          codes: [GATED_CODE],
          revokedAt: new Date(Date.now() - 60_000),
          revokedBy: 'admin-1',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();

    assert.equal(openSignals(h).length, 1);
    assertNoInfrastructureFailure(h.warns);
  });

  it('opens on the first run after a lapse, because the evidence never stopped', async () => {
    // The exemption parks the accusation, not the observation. A condition that
    // has been true for a month does not owe another fifteen minutes.
    const expiresAt = new Date(Date.now() + 50);
    const h = build({
      exemptions: [{ id: 'ex-1', userId: 'u1', codes: [GATED_CODE], expiresAt }],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();
    assert.equal(h.store.rows.length, 0, 'nothing filed while it was covered');
    assert.equal(h.store.streakFor(GATED_CODE, 'uuid-1')?.observations, 3, 'but evidence banked');

    await new Promise((resolve) => setTimeout(resolve, 80));
    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, 'and it opens immediately once the cover lapses');
    assertNoInfrastructureFailure(h.warns);
  });
});

describe('an exemption leaves a trace', () => {
  it('records the hold, names the exemption, and lists it as pending', async () => {
    const h = build({
      exemptions: [{ id: 'ex-1', userId: 'u1', codes: [GATED_CODE], reason: 'verified reseller' }],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();

    const streak = h.store.streakFor(GATED_CODE, 'uuid-1');
    assert.ok(streak, 'a suppression with no row is a detector nobody knows stopped');
    assert.equal(streak.heldBy, 'exemption');
    assert.equal(streak.exemptionId, 'ex-1');

    const pending = await h.service.listPendingCandidates(50);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].heldBy, 'exemption');
    assert.equal(pending[0].exemptionId, 'ex-1');
    assert.equal(pending[0].code, GATED_CODE);
    assert.equal(pending[0].requiredObservations, REQUIRED);

    const announced = h.events.filter((e) => e.type === 'fraud.candidate_exempted');
    assert.equal(announced.length, 1, 'the operator channel is told');
    assert.equal(announced[0].metadata.exemptionId, 'ex-1');
    assert.equal(announced[0].metadata.reason, 'verified reseller');

    assert.ok(
      h.logs.some((l) => l.includes('held by exemption') && l.includes(GATED_CODE)),
      `the hold is logged; got ${JSON.stringify(h.logs)}`,
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('announces the hold once, not every five minutes', async () => {
    const h = build({
      exemptions: [{ id: 'ex-1', userId: 'u1', codes: [GATED_CODE] }],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();

    assert.equal(
      h.events.filter((e) => e.type === 'fraud.candidate_exempted').length,
      1,
      'the hold is an edge, not a heartbeat',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('lists a still-gathering candidate as pending too', async () => {
    const h = build({ detectors: { hwidOverage: [candidate({})] } });

    await h.service.runDetectors();
    await h.service.runDetectors();

    const pending = await h.service.listPendingCandidates(50);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].heldBy, 'streak');
    assert.equal(pending[0].observations, 2);
    assert.equal(pending[0].requiredObservations, REQUIRED);
    assert.equal(pending[0].exemptionId, null);
    assert.deepStrictEqual(pending[0].affectedUserIds, ['u1']);
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not keep a held candidate around after the condition stops', async () => {
    // The counterpart to "it must be visible": the pending list must also be
    // honest about what is NOT being watched any more.
    const h = build({ detectors: { hwidOverage: [candidate({})] } });

    await h.service.runDetectors();
    h.setDetectors({ hwidOverage: [candidate({ fingerprint: `${TODAY}|uuid-9` })] });
    await h.service.runDetectors();

    const pending = await h.service.listPendingCandidates(50);
    assert.deepStrictEqual(
      pending.map((p) => p.conditionKey),
      ['uuid-9'],
    );
    assertNoInfrastructureFailure(h.warns);
  });
});

// ── The exemption write path ─────────────────────────────────────────────────

describe('granting an exemption is an audit-relevant act', () => {
  const grant = (service: AntiFraudService, over: Record<string, unknown> = {}) =>
    service.createExemption({
      userId: 'u1',
      codes: [GATED_CODE],
      reason: 'verified reseller, confirmed by support ticket 4412',
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      adminId: 'admin-1',
      requestMetadata: REQUEST_METADATA,
      ...over,
    } as Parameters<AntiFraudService['createExemption']>[0]);

  it('records who granted it, why, and until when', async () => {
    const h = build({});

    const created = await grant(h.service);

    assert.equal(created.userId, 'u1');
    assert.deepStrictEqual(created.codes, [GATED_CODE]);
    assert.equal(created.createdBy, 'admin-1');
    assert.equal(created.active, true);

    const audit = h.store.audits.find((a) => a.action === 'fraud.exemption_granted');
    assert.ok(audit, 'the admin audit log carries it');
    assert.equal(audit.adminId, 'admin-1');
    assert.equal(audit.metadata.userId, 'u1');
    assert.equal(audit.metadata.reason, 'verified reseller, confirmed by support ticket 4412');
    assert.ok(h.events.some((e) => e.type === 'fraud.exemption_granted'));
  });

  it('refuses an expiry in the past', async () => {
    const h = build({});
    await assert.rejects(
      () => grant(h.service, { expiresAt: new Date(Date.now() - 1000) }),
      /future/i,
      'a permanent exemption is a permanent blind spot; a past one is a no-op',
    );
    assert.deepStrictEqual(h.store.exemptions, []);
  });

  it('refuses a blanket exemption', async () => {
    const h = build({});
    await assert.rejects(() => grant(h.service, { codes: [] }), /at least one detector code/i);
    assert.deepStrictEqual(h.store.exemptions, []);
  });

  it('refuses a user that does not exist', async () => {
    const h = build({ users: [] });
    await assert.rejects(() => grant(h.service), /User not found/i);
  });

  it('revokes without deleting, and drops the streaks it was holding', async () => {
    const h = build({
      exemptions: [{ id: 'ex-1', userId: 'u1', codes: [GATED_CODE] }],
      streaks: [{ code: GATED_CODE, conditionKey: 'uuid-1', heldBy: 'exemption', exemptionId: 'ex-1' }],
    });

    const revoked = await h.service.revokeExemption({
      id: 'ex-1',
      adminId: 'admin-2',
      requestMetadata: REQUEST_METADATA,
    });

    assert.equal(revoked.active, false);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revokedBy, 'admin-2');
    assert.equal(h.store.exemptions.length, 1, 'the row is history, not litter');
    assert.equal(
      h.store.streakFor(GATED_CODE, 'uuid-1'),
      undefined,
      'the banked evidence goes with it — the condition re-earns its case',
    );
    assert.ok(h.store.audits.some((a) => a.action === 'fraud.exemption_revoked'));
    assert.ok(h.events.some((e) => e.type === 'fraud.exemption_revoked'));
  });

  it('refuses to revoke twice', async () => {
    const h = build({
      exemptions: [{ id: 'ex-1', userId: 'u1', revokedAt: new Date(), revokedBy: 'admin-1' }],
    });
    await assert.rejects(
      () =>
        h.service.revokeExemption({
          id: 'ex-1',
          adminId: 'admin-2',
          requestMetadata: REQUEST_METADATA,
        }),
      /already revoked/i,
    );
  });

  it('keeps expired and revoked exemptions readable, and can hide them on request', async () => {
    const h = build({
      exemptions: [
        { id: 'live', userId: 'u1', codes: [GATED_CODE] },
        { id: 'lapsed', userId: 'u1', codes: [GATED_CODE], expiresAt: new Date(Date.now() - DAY_MS) },
      ],
    });

    const all = await h.service.listExemptions({ activeOnly: false, limit: 50 });
    assert.equal(all.length, 2, 'history answers "why did we stop seeing signals for this user"');
    assert.equal(all.find((e) => e.id === 'lapsed')?.active, false);

    const live = await h.service.listExemptions({ activeOnly: true, limit: 50 });
    assert.deepStrictEqual(
      live.map((e) => e.id),
      ['live'],
    );
  });
});

// ── The two gates together ───────────────────────────────────────────────────

describe('the gates compose with the lifecycle that was already there', () => {
  it('lets a dismissal still suppress a condition that cleared the streak', async () => {
    const h = build({
      signals: [
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.DISMISSED,
          severity: FraudSignalSeverity.MEDIUM,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, 'the dismissal still holds after the streak completes');
    assert.equal(h.store.rows[0].status, FraudSignalStatus.DISMISSED);
    assertNoInfrastructureFailure(h.warns);
  });

  it('ages out a signal whose condition genuinely stopped, gate or no gate', async () => {
    const h = build({
      signals: [
        {
          id: 'stale',
          code: GATED_CODE,
          fingerprint: `${YESTERDAY}|uuid-1`,
          updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        },
      ],
      detectors: { hwidOverage: [candidate({ fingerprint: `${TODAY}|uuid-9` })] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.find((r) => r.id === 'stale')?.status, FraudSignalStatus.RESOLVED);
    assert.equal(h.store.rows.find((r) => r.id === 'stale')?.resolutionNote, AUTO_SUPERSEDED_NOTE);
    assertNoInfrastructureFailure(h.warns);
  });
});

// ── Gate 3: an OPERATOR verdict, and only an operator's ──────────────────────

/**
 * The system's own auto-resolve is not a verdict, and reading it as one turned
 * the detector off.
 *
 * `reconcileOpenSignals` closes a signal with `status: RESOLVED, resolvedBy:
 * null` the moment a run that *could* see the condition stops producing it, and
 * the suppression gate accepted any RESOLVED row inside the six-hour window
 * without ever looking at who closed it. So one run where the panel momentarily
 * reported a user under their limit bought that user six hours of immunity from
 * the system's own hand — and the log said "operator RESOLVED this condition".
 *
 * Every test below is paired against its counterpart: a fix implemented as
 * "stop suppressing" would satisfy the re-open cases and fail every operator
 * one.
 */
describe('a system auto-resolve is not an operator verdict', () => {
  /** Runs the detector `times` times with whatever is currently configured. */
  const runs = async (h: Harness, times: number): Promise<void> => {
    for (let i = 0; i < times; i += 1) await h.service.runDetectors();
  };

  const liveFor = (h: Harness, condition: string): SignalRow[] =>
    h.store.rows.filter(
      (r) =>
        r.fingerprint.startsWith(`${TODAY}|${condition}`) &&
        (r.status === FraudSignalStatus.OPEN || r.status === FraudSignalStatus.ACKNOWLEDGED),
    );

  it('re-opens a condition the system closed a moment earlier', async () => {
    // The defect end to end. Three runs open the signal; ONE run where the
    // panel reports uuid-1 under the limit auto-resolves it (uuid-9 is still
    // over, so the detector returns a non-empty list and the code stays
    // reconcilable); then the condition comes back and never stops.
    const h = build({ detectors: { hwidOverage: [candidate({})] } });
    await runs(h, REQUIRED);
    assert.equal(liveFor(h, 'uuid-1').length, 1, 'the streak opened it');

    h.setDetectors({
      hwidOverage: [candidate({ fingerprint: `${TODAY}|uuid-9`, affectedUserIds: ['u2'] })],
    });
    await h.service.runDetectors();
    const closed = h.store.rows.find((r) => r.fingerprint === `${TODAY}|uuid-1`);
    assert.equal(closed?.status, FraudSignalStatus.RESOLVED, 'the blink auto-resolved it');
    assert.equal(closed?.resolvedBy, null, 'and nobody signed it — the system did');

    h.setDetectors({ hwidOverage: [candidate({})] });
    await runs(h, REQUIRED);

    assert.equal(
      liveFor(h, 'uuid-1').length,
      1,
      'a condition the SYSTEM closed must re-open once the evidence is sustained again',
    );
    assert.equal(
      h.store.rows.find((r) => r.fingerprint === `${TODAY}|uuid-1`)?.status,
      FraudSignalStatus.RESOLVED,
      'and it is filed beside the auto-resolve, not over it',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not claim an operator ruled when nobody did', async () => {
    // The log line was the only trace this gate left, and it named an operator
    // who had never touched the row. An engineer reading it had no way to tell
    // the detector had switched itself off.
    const h = build({
      signals: [
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.RESOLVED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: null,
          resolutionNote: AUTO_RESOLVED_NOTE,
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();

    assert.deepStrictEqual(
      h.logs.filter((l) => l.includes('suppressed: operator')),
      [],
      'nothing may report an operator verdict that does not exist',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('ignores a system-authored DISMISSED too, not only a RESOLVED one', async () => {
    // `transitionStatus` types its `adminId` `string | null`, so a system
    // dismissal is one caller away — and it would buy SEVEN days, not six hours.
    const h = build({
      signals: [
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.DISMISSED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: null,
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await runs(h, REQUIRED);

    assert.equal(liveFor(h, 'uuid-1').length, 1, 'an unsigned dismissal is not a verdict either');
    assertNoInfrastructureFailure(h.warns);
  });

  // ── The counterparts: a human's verdict still means what it meant ──────────

  it('still lets an operator RESOLVED silence the condition for its window', async () => {
    const h = build({
      signals: [
        {
          id: 'ruled',
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.RESOLVED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: 'admin-1',
          resolutionNote: 'dropped their connections and warned the customer',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await runs(h, REQUIRED + 1);

    assert.equal(h.store.rows.length, 1, 'the operator acted; give the action time to land');
    assert.equal(h.store.rows[0].id, 'ruled');
    assert.ok(
      h.logs.some((l) => l.includes('suppressed: operator admin-1')),
      `the suppression names who ruled; got ${JSON.stringify(h.logs)}`,
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('lets the condition back once the operator resolution ages past its window', async () => {
    // The counterpart to the counterpart: a mute, not a blind spot.
    const h = build({
      signals: [
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.RESOLVED,
          resolvedAt: new Date(Date.now() - 7 * HOUR_MS),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await runs(h, REQUIRED);

    assert.equal(liveFor(h, 'uuid-1').length, 1, 'six hours is a window, not a verdict forever');
    assertNoInfrastructureFailure(h.warns);
  });

  // ── Where the gate now sits, and why it matters ───────────────────────────

  it('leaves a pending row while an operator verdict is muting the condition', async () => {
    // The gate used to sit in front of the streak gate, so a muted condition
    // wrote NO streak row and `GET /admin/fraud/pending` — the surface built to
    // answer "which detector quietly stopped detecting" — showed nothing at all
    // while a detector's entire output was being swallowed.
    const h = build({
      signals: [
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.DISMISSED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await runs(h, REQUIRED + 2);

    const streak = h.store.streakFor(GATED_CODE, 'uuid-1');
    assert.ok(streak, 'a suppression with no row is a detector nobody knows stopped');
    assert.equal(streak.heldBy, 'verdict', 'and it says which hold is actually winning');

    const pending = await h.service.listPendingCandidates(50);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].conditionKey, 'uuid-1');
    assert.equal(pending[0].heldBy, 'verdict');
    assert.equal(
      pending[0].observations,
      REQUIRED,
      'progress towards the bar cannot exceed the bar, however long the mute runs',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('opens on the first run after the mute lapses, without re-earning the streak', async () => {
    // What recording underneath the mute buys: the evidence banked while the
    // condition was muted is not thrown away, exactly as it is not under an
    // exemption. Seeded one millisecond from expiry so the same run sequence
    // covers both sides of the boundary.
    const h = build({
      signals: [
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.RESOLVED,
          resolvedAt: new Date(Date.now() - (6 * HOUR_MS - 60)),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await runs(h, REQUIRED);
    assert.equal(liveFor(h, 'uuid-1').length, 0, 'still muted, but the evidence is banking');
    assert.equal(h.store.streakFor(GATED_CODE, 'uuid-1')?.observations, REQUIRED);

    await new Promise((resolve) => setTimeout(resolve, 80));
    await h.service.runDetectors();

    assert.equal(liveFor(h, 'uuid-1').length, 1, 'and it opens on the very next run');
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not let the verdict gate skip the streak for a condition that just started', async () => {
    // The other ordering hazard: recording before the verdict must not let a
    // one-shot reading through once the verdict expires. Two observations is
    // still two observations.
    const h = build({
      signals: [
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.RESOLVED,
          resolvedAt: new Date(Date.now() - 7 * HOUR_MS),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await runs(h, REQUIRED - 1);

    assert.equal(liveFor(h, 'uuid-1').length, 0, 'an expired verdict does not waive the evidence bar');
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not stamp "no longer detected" on a condition it is merely muting', async () => {
    // A verdict-suppressed condition was seen. Left out of `heldConditions`,
    // the reconcile pass closes a still-open row for the same condition under an
    // older bucket and stamps it "not re-detected" — which says the opposite of
    // what happened, and (before the fix above) that unsigned auto-close then
    // suppressed the condition on the strength of its own lie.
    //
    // `updatedAt` is put past `STALE_BUCKET_GRACE_MS` deliberately: inside the
    // grace the reconcile declines for an unrelated reason and the test would
    // pass without the guard it is here to check.
    const h = build({
      signals: [
        {
          id: 'older',
          code: GATED_CODE,
          fingerprint: `${YESTERDAY}|uuid-1`,
          status: FraudSignalStatus.OPEN,
          updatedAt: new Date(Date.now() - 25 * HOUR_MS),
        },
        {
          code: GATED_CODE,
          fingerprint: `${TODAY}|uuid-1`,
          status: FraudSignalStatus.DISMISSED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { hwidOverage: [candidate({})] },
    });

    await h.service.runDetectors();

    const older = h.store.rows.find((r) => r.id === 'older');
    assert.equal(older?.status, FraudSignalStatus.OPEN, 'we chose not to act; it did not clear');
    assert.equal(older?.resolutionNote, null);
    assertNoInfrastructureFailure(h.warns);
  });
});
