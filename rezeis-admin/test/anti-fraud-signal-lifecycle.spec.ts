import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';

import { SystemEventsService } from '../src/common/services/system-events.service';
import { makeAntiFraudStore, type AntiFraudStore, type SignalRow } from './fixtures/anti-fraud-store';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import { FraudSignalCandidate } from '../src/modules/anti-fraud/interfaces/fraud-signal.interface';
import { panelDevicesDouble } from './fixtures/anti-fraud-panel-clients';
import {
  AntiFraudService,
  AUTO_RESOLVED_NOTE,
  AUTO_SUPERSEDED_NOTE,
} from '../src/modules/anti-fraud/services/anti-fraud.service';

/**
 * The lifecycle of a fraud signal, end to end: raised, refreshed, escalated,
 * dismissed, auto-resolved.
 *
 * Every test here is written against the *observable* record — the rows the
 * service writes and the events it emits — never against an internal flag, and
 * each one has a counterpart that fails if the fix is implemented as "do less".
 * A suppression that also swallowed a genuine recurrence, or an auto-resolve
 * that never resolved anything, would pass half of these and fail the other.
 *
 * The Prisma double is deliberately strict: any filter operator the service
 * starts using that the double does not model throws instead of quietly
 * matching everything, and every test asserts that no infrastructure warning
 * was logged. A reconcile pass that blew up would otherwise be indistinguishable
 * from a reconcile pass that correctly decided to leave a signal alone.
 */

// ── Time buckets, as the detectors build them ────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const TODAY = dayKey(0);
const YESTERDAY = dayKey(-1);

// ── The in-memory database ───────────────────────────────────────────────────
//
// Lives in `fixtures/anti-fraud-store.ts` so this suite and the gate suite
// cannot drift into disagreeing about what Postgres does. It is deliberately
// strict: an unknown column or an unmodelled filter operator throws.

type Row = SignalRow;
type Store = AntiFraudStore;

const makeStore = (seed: readonly Partial<Row>[] = []): Store =>
  makeAntiFraudStore({ signals: seed, today: TODAY });

// ── Detector doubles ─────────────────────────────────────────────────────────

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
  /**
   * Captured, not discarded, because `category` is not decoration: it is what
   * `resolveTelegramDeliveryTarget` reads to pick the forum topic an operator's
   * card lands in. A recorder that dropped it let `fraud.signal_transitioned`
   * ship for months announcing itself in the backups topic.
   */
  readonly category: string;
  readonly severity: 'INFO' | 'WARNING';
  readonly metadata: Record<string, unknown>;
  readonly message: string;
}

interface Harness {
  readonly service: AntiFraudService;
  readonly store: Store;
  readonly events: EmittedEvent[];
  readonly warns: string[];
  readonly logs: string[];
}

function build(input: {
  readonly seed?: readonly Partial<Row>[];
  readonly detectors?: Partial<Record<DetectorName, DetectorOutput>>;
}): Harness {
  const store = makeStore(input.seed);
  const events: EmittedEvent[] = [];
  const out = (name: DetectorName) => () => {
    const configured = input.detectors?.[name] ?? [];
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
    (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
      events.push({ type, category, severity, message, metadata: metadata ?? {} });
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
    panelDevicesDouble().client,
    systemEvents,
  );

  return { service, store, events, warns: captured.warns, logs: captured.logs };
}

function candidate(over: Partial<FraudSignalCandidate>): FraudSignalCandidate {
  return {
    code: 'PROMO_ABUSE',
    fingerprint: `${TODAY}|x`,
    severity: FraudSignalSeverity.MEDIUM,
    title: 'Potential promocode abuse detected',
    description: 'description',
    score: 55,
    confidence: 70,
    affectedUserIds: [],
    metadata: {},
    ...over,
  };
}

// ── Log capture (also the guard against a silently-broken reconcile) ─────────

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
 * Nothing in this suite is allowed to reach its verdict via a swallowed
 * exception. `reconcileOpenSignals` logs and continues on failure so a broken
 * reconcile cannot discard a run's real work — which means "the signal was left
 * OPEN" and "the reconcile threw" look identical from the outside unless this
 * is asserted.
 */
function assertNoInfrastructureFailure(warns: readonly string[]): void {
  const bad = warns.filter(
    (w) =>
      w.includes('reconciliation failed') ||
      w.includes('Failed to upsert') ||
      w.includes('cooldown probe failed'),
  );
  assert.deepStrictEqual(bad, [], 'the run must reach its verdict without swallowing an error');
}

// ── 1. Dismissing a false positive actually suppresses it ────────────────────

describe('an operator verdict suppresses re-creation', () => {
  it('stops re-minting the condition a dismissal closed', async () => {
    // The exact shape of the bug: the base row is DISMISSED, so the base key
    // lookup finds a closed row and the old code filed `${fingerprint}#${ms}`
    // — every five minutes, forever.
    const h = build({
      seed: [
        {
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          status: FraudSignalStatus.DISMISSED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: 'admin-1',
          resolutionNote: 'false positive',
        },
      ],
      detectors: { promoAbuse: [candidate({ fingerprint: `${TODAY}|abc` })] },
    });

    await h.service.runDetectors();
    await h.service.runDetectors();
    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, 'three runs after a dismissal must file nothing');
    assert.equal(h.store.rows[0].status, FraudSignalStatus.DISMISSED);
    assert.equal(h.store.rows[0].resolutionNote, 'false positive', 'the verdict is untouched');
    assert.ok(
      h.logs.some((l) => l.includes('suppressed') && l.includes('PROMO_ABUSE')),
      `the suppression must be visible; got ${JSON.stringify(h.logs)}`,
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('keeps suppressing once the fingerprint rolls into a new day', async () => {
    // Dismissal is a verdict on the rule, not on the key. A window that only
    // covered today's fingerprint would hand the operator the identical false
    // positive again tomorrow morning under `${tomorrow}|abc`.
    const h = build({
      seed: [
        {
          code: 'PROMO_ABUSE',
          fingerprint: `${YESTERDAY}|abc`,
          status: FraudSignalStatus.DISMISSED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { promoAbuse: [candidate({ fingerprint: `${TODAY}|abc` })] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1, "yesterday's dismissal still covers today's key");
    assertNoInfrastructureFailure(h.warns);
  });

  it('lets the condition come back once the window expires', async () => {
    // The counterpart that keeps the suppression from being a blind spot.
    const h = build({
      seed: [
        {
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          status: FraudSignalStatus.DISMISSED,
          resolvedAt: new Date(Date.now() - 8 * DAY_MS),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: { promoAbuse: [candidate({ fingerprint: `${TODAY}|abc` })] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 2, 'an expired dismissal must not mute the rule forever');
    const fresh = h.store.rows.find((r) => r.status === FraudSignalStatus.OPEN);
    assert.ok(fresh, 'the re-occurrence is a new OPEN row');
    assert.ok(
      fresh.fingerprint.startsWith(`${TODAY}|abc#`),
      'and it is filed beside the verdict, not over it',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('lets a worse condition break through the window', async () => {
    // A verdict on a LOW does not buy silence on a HIGH.
    const h = build({
      seed: [
        {
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          severity: FraudSignalSeverity.LOW,
          status: FraudSignalStatus.DISMISSED,
          resolvedAt: new Date(Date.now() - 60_000),
          resolvedBy: 'admin-1',
        },
      ],
      detectors: {
        promoAbuse: [
          candidate({ fingerprint: `${TODAY}|abc`, severity: FraudSignalSeverity.HIGH, score: 95 }),
        ],
      },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 2, 'an escalating condition is not silenced by a dismissal');
    assertNoInfrastructureFailure(h.warns);
  });

  it('refreshes the row a previous re-occurrence already opened', async () => {
    // The other half of the loop: once one suffixed row exists and is live, the
    // base key still resolves to the closed verdict, so the next run has to be
    // able to find `${base}#${ms}` and refresh *that* instead of minting again.
    const h = build({
      seed: [
        {
          id: 'closed',
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          status: FraudSignalStatus.RESOLVED,
          resolvedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
          resolvedBy: 'admin-1',
        },
        {
          id: 'live',
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc#1700000000000`,
          status: FraudSignalStatus.OPEN,
          score: 55,
        },
      ],
      detectors: { promoAbuse: [candidate({ fingerprint: `${TODAY}|abc`, score: 71 })] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 2, 'the live re-occurrence is refreshed, not duplicated');
    assert.equal(h.store.rows.find((r) => r.id === 'live')?.score, 71);
    assertNoInfrastructureFailure(h.warns);
  });

  it('never re-opens an acknowledged signal as a second row', async () => {
    // ACKNOWLEDGED is somebody's live ticket. Treating it as "closed" put it on
    // the same duplicate-minting path as a dismissal.
    const h = build({
      seed: [
        {
          id: 'ack',
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          status: FraudSignalStatus.ACKNOWLEDGED,
          score: 55,
        },
      ],
      detectors: { promoAbuse: [candidate({ fingerprint: `${TODAY}|abc`, score: 80 })] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.length, 1);
    assert.equal(h.store.rows[0].status, FraudSignalStatus.ACKNOWLEDGED, 'ownership is preserved');
    assert.equal(h.store.rows[0].score, 80);
    assertNoInfrastructureFailure(h.warns);
  });
});

// ── 2. Auto-resolve, and the two things that must not trigger it ─────────────

describe('a condition that cleared is closed by the run that saw it clear', () => {
  it('resolves the signal with a system-authored note', async () => {
    const h = build({
      seed: [{ id: 'gone', code: 'PROMO_ABUSE', fingerprint: `${TODAY}|abc` }],
      detectors: { promoAbuse: [] },
    });

    await h.service.runDetectors();

    const row = h.store.rows[0];
    assert.equal(row.status, FraudSignalStatus.RESOLVED);
    assert.equal(row.resolutionNote, AUTO_RESOLVED_NOTE);
    assert.equal(row.resolvedBy, null, 'a null author is what separates this from an operator');
    assert.ok(row.resolvedAt instanceof Date);
    assert.ok(
      h.events.some((e) => e.type === 'fraud.signals_auto_resolved'),
      'the operator channel is told',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('leaves the signals the same run is still raising alone', async () => {
    const h = build({
      seed: [
        { id: 'still-bad', code: 'PROMO_ABUSE', fingerprint: `${TODAY}|abc` },
        { id: 'cleared', code: 'PROMO_ABUSE', fingerprint: `${TODAY}|def` },
      ],
      detectors: { promoAbuse: [candidate({ fingerprint: `${TODAY}|abc` })] },
    });

    await h.service.runDetectors();

    assert.equal(
      h.store.rows.find((r) => r.id === 'still-bad')?.status,
      FraudSignalStatus.OPEN,
      'a re-detected condition must survive its own reconcile pass',
    );
    assert.equal(h.store.rows.find((r) => r.id === 'cleared')?.status, FraudSignalStatus.RESOLVED);
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not auto-resolve when a panel-backed detector skipped its run', async () => {
    // A skipped sharing run and a clean sharing run are the same empty array.
    // Resolving on it would wipe the queue during a panel outage.
    const h = build({
      seed: [
        { id: 'live-sharing', code: 'SUBSCRIPTION_SHARING_IP', fingerprint: `${TODAY}|uuid-1` },
      ],
      detectors: { concurrentIpSharing: [] },
    });

    await h.service.runDetectors();

    assert.equal(
      h.store.rows[0].status,
      FraudSignalStatus.OPEN,
      'an empty panel-backed run is no information, not an all-clear',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('does auto-resolve a panel-backed signal once the panel answers', async () => {
    // The counterpart: with the panel demonstrably answering (it named somebody
    // else), the signal it no longer names is genuinely gone.
    const h = build({
      seed: [
        { id: 'cleared', code: 'SUBSCRIPTION_SHARING_IP', fingerprint: `${TODAY}|uuid-1` },
        { id: 'still-bad', code: 'SUBSCRIPTION_SHARING_IP', fingerprint: `${TODAY}|uuid-2` },
      ],
      detectors: {
        concurrentIpSharing: [
          candidate({ code: 'SUBSCRIPTION_SHARING_IP', fingerprint: `${TODAY}|uuid-2` }),
        ],
      },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows.find((r) => r.id === 'cleared')?.status, FraudSignalStatus.RESOLVED);
    assert.equal(h.store.rows.find((r) => r.id === 'still-bad')?.status, FraudSignalStatus.OPEN);
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not auto-resolve for a detector that threw', async () => {
    const h = build({
      seed: [{ id: 'live', code: 'PROMO_ABUSE', fingerprint: `${TODAY}|abc` }],
      detectors: { promoAbuse: new Error('database unavailable') },
    });

    const results = await h.service.runDetectors();

    assert.deepStrictEqual(results, [], 'the run survives a failing detector');
    assert.equal(h.store.rows[0].status, FraudSignalStatus.OPEN, 'a failure is not an all-clear');
    assert.ok(h.warns.some((w) => w.includes('detectPromoAbuse') && w.includes('failed')));
    assert.deepStrictEqual(
      h.warns.filter((w) => w.includes('reconciliation failed')),
      [],
    );
  });

  it('never touches a code no detector in the run owns', async () => {
    // Rows left behind by a retired detector are nobody's to close.
    const h = build({
      seed: [{ id: 'orphan', code: 'NODE_OFFLINE', fingerprint: `${TODAY}|de-1` }],
      detectors: { promoAbuse: [] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows[0].status, FraudSignalStatus.OPEN);
    assertNoInfrastructureFailure(h.warns);
  });

  it('leaves an acknowledged signal for the human who took it', async () => {
    const h = build({
      seed: [
        {
          id: 'mine',
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          status: FraudSignalStatus.ACKNOWLEDGED,
        },
      ],
      detectors: { promoAbuse: [] },
    });

    await h.service.runDetectors();

    assert.equal(h.store.rows[0].status, FraudSignalStatus.ACKNOWLEDGED);
    assertNoInfrastructureFailure(h.warns);
  });
});

describe("yesterday's signal and today's key", () => {
  it('is not resolved merely because the day rolled over', async () => {
    const h = build({
      seed: [
        {
          id: 'yesterday',
          code: 'PROMO_ABUSE',
          fingerprint: `${YESTERDAY}|abc`,
          updatedAt: new Date(Date.now() - 60_000),
        },
      ],
      detectors: { promoAbuse: [candidate({ fingerprint: `${TODAY}|abc` })] },
    });

    await h.service.runDetectors();

    assert.equal(
      h.store.rows.find((r) => r.id === 'yesterday')?.status,
      FraudSignalStatus.OPEN,
      'a different bucket is not evidence about the condition',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('ages out only after a full day without any re-detection', async () => {
    const h = build({
      seed: [
        {
          id: 'stale',
          code: 'PROMO_ABUSE',
          fingerprint: `${YESTERDAY}|abc`,
          updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        },
      ],
      detectors: { promoAbuse: [] },
    });

    await h.service.runDetectors();

    const row = h.store.rows[0];
    assert.equal(row.status, FraudSignalStatus.RESOLVED);
    assert.equal(row.resolutionNote, AUTO_SUPERSEDED_NOTE);
    assert.equal(row.resolvedBy, null);
    assertNoInfrastructureFailure(h.warns);
  });
});

// ── 3. Escalation ────────────────────────────────────────────────────────────

describe('an open signal can get worse', () => {
  it('escalates severity and notifies', async () => {
    const h = build({
      seed: [
        {
          id: 'creeping',
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          severity: FraudSignalSeverity.LOW,
          score: 20,
          affectedUserIds: ['u1'],
        },
      ],
      detectors: {
        promoAbuse: [
          candidate({
            fingerprint: `${TODAY}|abc`,
            severity: FraudSignalSeverity.HIGH,
            score: 96,
            affectedUserIds: ['u1'],
          }),
        ],
      },
    });

    await h.service.runDetectors();

    const row = h.store.rows[0];
    assert.equal(h.store.rows.length, 1, 'escalation happens in place, not as a second row');
    assert.equal(row.severity, FraudSignalSeverity.HIGH);
    assert.equal(row.score, 96);
    assert.equal(row.lastAction, 'notify');
    const escalation = h.events.find((e) => e.type === 'fraud.signal_escalated');
    assert.ok(escalation, `expected an escalation record; got ${JSON.stringify(h.events)}`);
    assert.equal(escalation.metadata.previousSeverity, FraudSignalSeverity.LOW);
    assert.equal(escalation.metadata.newSeverity, FraudSignalSeverity.HIGH);
    assert.ok(
      h.events.some((e) => e.type === 'fraud.signal_opened' && e.severity === 'WARNING'),
      'the operator is actually paged for the HIGH it became',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not de-escalate silently', async () => {
    const h = build({
      seed: [
        {
          id: 'was-high',
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          severity: FraudSignalSeverity.HIGH,
          affectedUserIds: ['u1'],
        },
      ],
      detectors: {
        promoAbuse: [
          candidate({
            fingerprint: `${TODAY}|abc`,
            severity: FraudSignalSeverity.MEDIUM,
            affectedUserIds: ['u1'],
          }),
        ],
      },
    });

    await h.service.runDetectors();

    const row = h.store.rows[0];
    assert.equal(row.severity, FraudSignalSeverity.HIGH, 'urgency is a high-water mark');
    assert.equal(row.metadata.observedSeverity, FraudSignalSeverity.MEDIUM);
    assert.equal(row.metadata.severityPeak, FraudSignalSeverity.HIGH);
    assert.ok(
      h.events.some((e) => e.type === 'fraud.signal_severity_receded'),
      'and the recession is on the record',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not re-announce a severity that is merely staying low', async () => {
    const h = build({
      seed: [
        {
          id: 'was-high',
          code: 'PROMO_ABUSE',
          fingerprint: `${TODAY}|abc`,
          severity: FraudSignalSeverity.HIGH,
        },
      ],
      detectors: {
        promoAbuse: [candidate({ fingerprint: `${TODAY}|abc`, severity: FraudSignalSeverity.LOW })],
      },
    });

    await h.service.runDetectors();
    const afterFirst = h.events.filter((e) => e.type === 'fraud.signal_severity_receded').length;
    await h.service.runDetectors();
    const afterSecond = h.events.filter((e) => e.type === 'fraud.signal_severity_receded').length;

    assert.equal(afterFirst, 1);
    assert.equal(afterSecond, 1, 'the recession is an edge, not a heartbeat');
    assertNoInfrastructureFailure(h.warns);
  });
});

// ── 4. The HIGH-severity notification cooldown ───────────────────────────────

describe('HIGH-severity notifications are throttled per affected user', () => {
  const high = (fingerprint: string, users: string[]) =>
    candidate({
      code: 'SUBSCRIPTION_SHARING_HWID',
      fingerprint,
      severity: FraudSignalSeverity.HIGH,
      affectedUserIds: users,
    });

  /**
   * `SUBSCRIPTION_SHARING_HWID` is panel-backed, so the sustained-evidence gate
   * holds it until the condition has survived three consecutive runs. That is
   * what production now does before any of these rows exist at all; driving one
   * run here would test the gate, not the cooldown. See `anti-fraud-gates.spec.ts`
   * for the gate's own coverage.
   */
  const runUntilFiled = async (service: { runDetectors(): Promise<unknown> }): Promise<void> => {
    await service.runDetectors();
    await service.runDetectors();
    await service.runDetectors();
  };

  it('files the signal but sends no second page inside the window', async () => {
    const h = build({
      seed: [
        {
          id: 'already-paged',
          code: 'SUBSCRIPTION_SHARING_HWID',
          fingerprint: `${TODAY}|uuid-0`,
          severity: FraudSignalSeverity.HIGH,
          affectedUserIds: ['u1'],
          lastAction: 'notify',
          detectedAt: new Date(Date.now() - 10 * 60_000),
        },
      ],
      detectors: { hwidOverage: [high(`${TODAY}|uuid-1`, ['u1'])] },
    });

    await runUntilFiled(h.service);

    const fresh = h.store.rows.find((r) => r.id !== 'already-paged');
    assert.ok(fresh, 'the signal itself is still filed — only the page is throttled');
    assert.equal(fresh.status, FraudSignalStatus.OPEN);
    assert.equal(fresh.lastAction, 'none', 'a throttled row must not claim it notified');
    assert.equal(fresh.metadata.notificationThrottled, true);
    assert.deepStrictEqual(
      h.events.filter((e) => e.type === 'fraud.signal_opened'),
      [],
      'no page went out',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('pages again once the window has passed', async () => {
    const h = build({
      seed: [
        {
          id: 'paged-long-ago',
          code: 'SUBSCRIPTION_SHARING_HWID',
          fingerprint: `${TODAY}|uuid-0`,
          severity: FraudSignalSeverity.HIGH,
          affectedUserIds: ['u1'],
          lastAction: 'notify',
          detectedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      ],
      detectors: { hwidOverage: [high(`${TODAY}|uuid-1`, ['u1'])] },
    });

    await runUntilFiled(h.service);

    const fresh = h.store.rows.find((r) => r.id !== 'paged-long-ago');
    assert.equal(fresh?.lastAction, 'notify');
    assert.equal(h.events.filter((e) => e.type === 'fraud.signal_opened').length, 1);
    assertNoInfrastructureFailure(h.warns);
  });

  it('does not let one user starve another of their page', async () => {
    const h = build({
      seed: [
        {
          id: 'paged-u1',
          code: 'SUBSCRIPTION_SHARING_HWID',
          fingerprint: `${TODAY}|uuid-0`,
          severity: FraudSignalSeverity.HIGH,
          affectedUserIds: ['u1'],
          lastAction: 'notify',
          detectedAt: new Date(Date.now() - 60_000),
        },
      ],
      detectors: { hwidOverage: [high(`${TODAY}|uuid-9`, ['u2'])] },
    });

    await runUntilFiled(h.service);

    assert.equal(
      h.events.filter((e) => e.type === 'fraud.signal_opened').length,
      1,
      'the cooldown is per affected user, not global',
    );
    assertNoInfrastructureFailure(h.warns);
  });

  it('survives a process restart, because it is read out of the rows', async () => {
    // A fresh AntiFraudService over the same table — the state an in-memory
    // cooldown map would have lost.
    const seed: Partial<Row>[] = [];
    const first = build({ seed, detectors: { hwidOverage: [high(`${TODAY}|uuid-1`, ['u1'])] } });
    await runUntilFiled(first.service);
    assert.equal(first.events.filter((e) => e.type === 'fraud.signal_opened').length, 1);

    const restarted = new AntiFraudService(
      first.store.prisma,
      {
        detectExcessiveFailedPayments: () => Promise.resolve([]),
        detectRapidReferralVelocity: () => Promise.resolve([]),
        detectPromoAbuse: () => Promise.resolve([]),
        detectRapidChurn: () => Promise.resolve([]),
      } as unknown as FraudDetectors,
      {
        detectPerUserNodeTrafficAbuse: () => Promise.resolve([]),
        collectHwidAverageAlerts: () => Promise.resolve([]),
        collectNodeTrafficAlerts: () => Promise.resolve([]),
        collectGeoConcentrationAlerts: () => Promise.resolve([]),
        collectOfflineNodeAlerts: () => Promise.resolve([]),
      } as unknown as RemnawaveDetectors,
      {
        detectHwidOverage: () => Promise.resolve([high(`${TODAY}|uuid-2`, ['u1'])]),
        detectConcurrentIpSharing: () => Promise.resolve([]),
      } as unknown as SharingDetectors,
      {
        detectSubscriptionUaTunnel: () => Promise.resolve([]),
      } as unknown as SubscriptionUaDetectors,
      panelDevicesDouble().client,
      {
        info: () => undefined,
        warn: (type: string) => {
          if (type === 'fraud.signal_opened') throw new Error('paged after a restart');
        },
        emit: () => undefined,
      } as unknown as SystemEventsService,
    );

    await runUntilFiled(restarted);

    const second = first.store.byFingerprint('SUBSCRIPTION_SHARING_HWID', `${TODAY}|uuid-2`);
    assert.ok(second, 'the second signal is still filed');
    assert.equal(second.lastAction, 'none', 'but the restart did not hand out a fresh allowance');
    assertNoInfrastructureFailure(first.warns);
  });
});

// ── 8. A hand-made status change is an anti-fraud card, not a system one ─────

/**
 * `transitionStatus` is the one write in this service an operator performs by
 * hand, and it is the one that shipped with the wrong `category`.
 *
 * That word is load-bearing twice over, which is why these assertions are about
 * the emit and not about a rendered string:
 *
 *   * `resolveTelegramDeliveryTarget` reads `event.category` to choose the
 *     forum topic, so `SYSTEM` sent the card wherever SYSTEM is mapped — the
 *     backups topic on a real install — away from every sibling `fraud.*`;
 *   * the card renderer declines its promocode block for FRAUD so a detector
 *     code is not captioned as a coupon, and `SYSTEM` walked around that guard.
 *
 * Both defects are one word, so one assertion on that word retires both — and
 * it fails loudly if somebody "simplifies" the emit back.
 */
describe('an operator moving a signal between statuses', () => {
  it('emits with category FRAUD, so the card lands in the anti-fraud topic', async () => {
    const h = build({
      seed: [
        {
          id: 'sig-1',
          code: 'NODES_OFFLINE',
          fingerprint: `${TODAY}|nodes`,
          status: FraudSignalStatus.OPEN,
          severity: FraudSignalSeverity.HIGH,
        },
      ],
    });

    await h.service.transitionStatus({
      id: 'sig-1',
      status: FraudSignalStatus.DISMISSED,
      note: 'infrastructure, not a customer',
      adminId: 'admin-7',
    });

    const emitted = h.events.find((e) => e.type === 'fraud.signal_transitioned');
    assert.ok(emitted, `expected a transition event; got ${JSON.stringify(h.events)}`);
    assert.equal(
      emitted.category,
      'FRAUD',
      'category picks the Telegram topic — SYSTEM files anti-fraud cards under backups',
    );
  });

  it('carries the code and both statuses, which are all the card has to show', async () => {
    const h = build({
      seed: [
        {
          id: 'sig-2',
          code: 'SUBSCRIPTION_SHARING_HWID',
          fingerprint: `${TODAY}|hwid`,
          status: FraudSignalStatus.OPEN,
        },
      ],
    });

    await h.service.transitionStatus({
      id: 'sig-2',
      status: FraudSignalStatus.RESOLVED,
      note: null,
      adminId: 'admin-7',
    });

    const emitted = h.events.find((e) => e.type === 'fraud.signal_transitioned');
    assert.ok(emitted);
    // The rendered block is keyed on the status PAIR and prints `code`; drop any
    // of the three and the operator gets a card that says a signal changed and
    // never says which one, or to what.
    assert.equal(emitted.metadata['code'], 'SUBSCRIPTION_SHARING_HWID');
    assert.equal(emitted.metadata['previousStatus'], FraudSignalStatus.OPEN);
    assert.equal(emitted.metadata['newStatus'], FraudSignalStatus.RESOLVED);
    assert.equal(emitted.metadata['signalId'], 'sig-2');
  });

  it('agrees with every other fraud.* emit in this service', async () => {
    const h = build({
      seed: [{ id: 'sig-3', code: 'PROMO_ABUSE', fingerprint: `${TODAY}|promo` }],
      detectors: {
        promoAbuse: [candidate({ fingerprint: `${TODAY}|fresh` })],
      },
    });

    await h.service.runDetectors();
    await h.service.transitionStatus({
      id: 'sig-3',
      status: FraudSignalStatus.ACKNOWLEDGED,
      note: null,
      adminId: 'admin-7',
    });

    // Whole-set assertion rather than one type: a future `fraud.*` emit that
    // picks the wrong category is the same defect and fails here on arrival.
    const strays = h.events
      .filter((e) => e.type.startsWith('fraud.') && e.category !== 'FRAUD')
      .map((e) => `${e.type}=${e.category}`);
    assert.deepStrictEqual(strays, [], `fraud events emitted outside the FRAUD category: ${strays}`);
  });
});
