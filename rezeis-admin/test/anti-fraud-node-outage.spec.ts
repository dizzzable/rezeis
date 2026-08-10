import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import {
  OperationalAlert,
  RemnawaveDetectors,
} from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import { RemnawaveNodeInterface } from '../src/modules/remnawave/interfaces/remnawave-node.interface';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { RemnawaveVersionService } from '../src/modules/remnawave/services/remnawave-version.service';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';

/**
 * A node outage must not be able to produce an accusation against a customer.
 *
 * Every test here is the same experiment run twice: the panel is identical, the
 * users are identical, and the ONLY thing that differs is whether the
 * infrastructure was stable. If the verdict differs, the verdict was about the
 * infrastructure. The counterpart assertions — a genuine offender on a stable
 * panel is still named, and a large cohort still runs the share test — are the
 * half that stops "detect less" from passing for "detect correctly".
 */

const GB = 1024 ** 3;
const NOW = new Date('2026-08-05T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

/**
 * The thresholds documented in `traffic-abuse.config.ts`, pinned explicitly.
 *
 * They have to be stated rather than inherited: `resolveTrafficAbuseConfig`
 * cannot currently produce its own documented defaults. Its `parseNumber` does
 * `Number(value ?? '')`, and `Number('')` is `0` — a finite number — so an
 * unset variable never reaches the `fallback` branch and is clamped to the
 * floor instead. With nothing in the environment the live detector runs at
 * minGb=1, medianMultiplier=1.5, sharePercent=5, maxNodesPerRun=1. That defect
 * is in a file this change does not own; these tests pin the intended values so
 * they assert the gate logic rather than the parser accident.
 */
process.env.ANTIFRAUD_NODE_TRAFFIC_MIN_GB = '200';
process.env.ANTIFRAUD_NODE_TRAFFIC_MEDIAN_MULTIPLIER = '4';
process.env.ANTIFRAUD_NODE_TRAFFIC_SHARE_PERCENT = '35';
process.env.ANTIFRAUD_NODE_TRAFFIC_MAX_NODES = '25';

// ── Doubles ──────────────────────────────────────────────────────────────────

function node(overrides: Partial<RemnawaveNodeInterface> & { uuid: string }): RemnawaveNodeInterface {
  return {
    id: null,
    name: overrides.uuid,
    address: '10.0.0.1',
    port: 443,
    isConnected: true,
    isDisabled: false,
    isConnecting: false,
    isTrafficTrackingActive: true,
    trafficResetDay: null,
    trafficLimitBytes: null,
    trafficUsedBytes: null,
    notifyPercent: null,
    viewPosition: 0,
    countryCode: 'DE',
    consumptionMultiplier: 1,
    tags: [],
    lastStatusChange: LONG_AGO,
    lastStatusMessage: null,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    xrayUptime: 1000,
    usersOnline: 0,
    activeConfigProfileUuid: null,
    ...overrides,
  };
}

interface SnapshotNode {
  readonly uuid: string;
  readonly name: string;
  readonly isConnected: boolean;
}

interface Harness {
  readonly detectors: RemnawaveDetectors;
  readonly bandwidthNodeUuids: string[][];
}

function makeDetectors(input: {
  readonly nodes: readonly RemnawaveNodeInterface[];
  readonly topUsers?: readonly { username: string; total: number }[] | null;
  readonly snapshots?: readonly (readonly SnapshotNode[])[];
  readonly hwidStats?: unknown;
}): Harness {
  const bandwidthNodeUuids: string[][] = [];

  const prisma = {
    remnawaveMetricSample: {
      findMany: () =>
        Promise.resolve(
          (input.snapshots ?? []).map((nodesSnapshot) => ({ nodesSnapshot })),
        ),
    },
  } as unknown as PrismaService;

  const api = {
    getAllNodes: () => Promise.resolve([...input.nodes]),
    getNodeUsersBandwidth: (uuids: readonly string[]) => {
      bandwidthNodeUuids.push([...uuids]);
      return Promise.resolve(input.topUsers === undefined ? [] : input.topUsers);
    },
    getHwidStats: () => Promise.resolve(input.hwidStats ?? null),
  } as unknown as RemnawaveApiService;

  const versionService = {
    getCapabilities: () => Promise.resolve({ bandwidthNodesUsers: true }),
  } as unknown as RemnawaveVersionService;

  return { detectors: new RemnawaveDetectors(prisma, api, versionService, tunablesFromEnv()), bandwidthNodeUuids };
}

/**
 * Nine users: one heavy account and a tail of ordinary ones. Large enough that
 * both the median test (4x) and the share test (35%) are legitimately available
 * — this is what a real offender looks like on a panel that is not falling over.
 */
const NINE_USER_COHORT = [
  { username: 'offender', total: 360 * GB },
  ...Array.from({ length: 8 }, (_, i) => ({ username: `ordinary-${i}`, total: 80 * GB })),
];

function captureLogs(): { readonly warns: string[]; readonly logs: string[]; restore(): void } {
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
}

// ── 1. A node outage names nobody ────────────────────────────────────────────

describe('per-user traffic detection during a node outage', () => {
  const captured = captureLogs();
  afterEach(() => {
    captured.warns.length = 0;
    captured.logs.length = 0;
  });
  after(() => captured.restore());

  it('names nobody while the node snapshots show connectivity changing', async () => {
    // Same nine users as the stable-panel test below. The only difference is
    // that nl-1 was connected in the first snapshot and gone by the second, so
    // its users have left the aggregate and everybody still online holds a
    // bigger slice of a smaller pie through no act of their own.
    const { detectors } = makeDetectors({
      nodes: [
        node({ uuid: 'aaaa-de-1', name: 'de-1' }),
        node({ uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: false }),
      ],
      topUsers: NINE_USER_COHORT,
      snapshots: [
        [
          { uuid: 'aaaa-de-1', name: 'de-1', isConnected: true },
          { uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: true },
        ],
        [
          { uuid: 'aaaa-de-1', name: 'de-1', isConnected: true },
          { uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: false },
        ],
      ],
    });

    const candidates = await detectors.detectPerUserNodeTrafficAbuse(NOW);

    assert.deepStrictEqual(
      candidates,
      [],
      'a node dropping out of the aggregate must not produce a fraud signal',
    );
    // A suppressed run that leaves no trace is indistinguishable from a clean
    // panel — the exact confusion this change exists to end.
    assert.ok(
      captured.warns.some((w) => w.includes('skipped') && w.includes('nl-1')),
      `the skip must be logged and must name the node; got ${JSON.stringify(captured.warns)}`,
    );
  });

  it("names nobody when the panel's own status timestamp is recent", async () => {
    // No snapshot history at all (fresh deployment, or the collector has not
    // run yet) — the panel's `lastStatusChange` still says nl-1 moved 5 minutes
    // ago, and that is enough on its own.
    const { detectors } = makeDetectors({
      nodes: [
        node({ uuid: 'aaaa-de-1', name: 'de-1' }),
        node({
          uuid: 'bbbb-nl-1',
          name: 'nl-1',
          lastStatusChange: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        }),
      ],
      topUsers: NINE_USER_COHORT,
      snapshots: [],
    });

    assert.deepStrictEqual(await detectors.detectPerUserNodeTrafficAbuse(NOW), []);
  });

  it('still names a genuine offender when every node has been stable', async () => {
    // Byte-for-byte the same cohort as the first test. Stable panel → the
    // offender is reported. This is the half that keeps the guard honest: a
    // suppression that also swallowed real abuse would pass the test above.
    const { detectors } = makeDetectors({
      nodes: [node({ uuid: 'aaaa-de-1', name: 'de-1' }), node({ uuid: 'bbbb-nl-1', name: 'nl-1' })],
      topUsers: NINE_USER_COHORT,
      snapshots: [
        [
          { uuid: 'aaaa-de-1', name: 'de-1', isConnected: true },
          { uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: true },
        ],
        [
          { uuid: 'aaaa-de-1', name: 'de-1', isConnected: true },
          { uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: true },
        ],
      ],
    });

    const candidates = await detectors.detectPerUserNodeTrafficAbuse(NOW);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].code, 'NODE_TRAFFIC_USER_ABUSE');
    assert.equal(candidates[0].metadata['remnawaveUsername'], 'offender');
    assert.equal(candidates[0].severity, FraudSignalSeverity.MEDIUM);
    assert.equal(candidates[0].metadata['shareTestApplied'], true);
  });
});

// ── 2. A collapsed cohort is not a cohort ────────────────────────────────────

describe('per-user traffic detection on a collapsed cohort', () => {
  it('refuses to judge three users against each other', async () => {
    // Three accounts, the largest holding 36%. The even split of three is
    // 33.3%, so "36% of the total" describes somebody 1.05x the average — and
    // three is exactly what is left when a node takes its users with it.
    const { detectors } = makeDetectors({
      nodes: [node({ uuid: 'aaaa-de-1', name: 'de-1' })],
      topUsers: [
        { username: 'barely-above-average', total: 360 * GB },
        { username: 'peer-a', total: 320 * GB },
        { username: 'peer-b', total: 320 * GB },
      ],
      snapshots: [[{ uuid: 'aaaa-de-1', name: 'de-1', isConnected: true }]],
    });

    assert.deepStrictEqual(await detectors.detectPerUserNodeTrafficAbuse(NOW), []);
  });

  it('does not run the share test on a cohort too small for 35% to be an outlier', async () => {
    // Six users. The median test does not fire (360 < 4 x 128), so the only
    // thing that could name this user is the share test — and at six users the
    // even split is 16.7%, so the 35% threshold is only 2.1x the average.
    // 300/35 = 9 users are needed before it is 3x.
    const { detectors } = makeDetectors({
      nodes: [node({ uuid: 'aaaa-de-1', name: 'de-1' })],
      topUsers: [
        { username: 'share-only', total: 360 * GB },
        ...Array.from({ length: 5 }, (_, i) => ({ username: `peer-${i}`, total: 128 * GB })),
      ],
      snapshots: [[{ uuid: 'aaaa-de-1', name: 'de-1', isConnected: true }]],
    });

    assert.deepStrictEqual(await detectors.detectPerUserNodeTrafficAbuse(NOW), []);
  });

  it('runs the share test again once the cohort is large enough', async () => {
    const { detectors } = makeDetectors({
      nodes: [node({ uuid: 'aaaa-de-1', name: 'de-1' })],
      topUsers: NINE_USER_COHORT,
      snapshots: [[{ uuid: 'aaaa-de-1', name: 'de-1', isConnected: true }]],
    });

    const candidates = await detectors.detectPerUserNodeTrafficAbuse(NOW);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].metadata['shareTestApplied'], true);
    assert.equal(candidates[0].metadata['cohortSize'], 9);
  });
});

// ── 3. The cohort must not depend on the panel's list order ──────────────────

describe('the aggregated node slice', () => {
  const original = process.env.ANTIFRAUD_NODE_TRAFFIC_MAX_NODES;
  afterEach(() => {
    process.env.ANTIFRAUD_NODE_TRAFFIC_MAX_NODES = original;
  });

  it('picks the same nodes however the panel orders them', async () => {
    // Both the median and the share denominator come out of whichever nodes
    // this slice keeps, so an unsorted slice makes the cohort — and therefore
    // the verdict — depend on the panel's list order.
    process.env.ANTIFRAUD_NODE_TRAFFIC_MAX_NODES = '2';
    const nodes = [
      node({ uuid: 'aaaa-de-1', name: 'de-1' }),
      node({ uuid: 'bbbb-nl-1', name: 'nl-1' }),
      node({ uuid: 'cccc-fi-1', name: 'fi-1' }),
    ];
    const snapshots = [nodes.map((n) => ({ uuid: n.uuid, name: n.name, isConnected: true }))];

    const forward = makeDetectors({ nodes, topUsers: [], snapshots });
    await forward.detectors.detectPerUserNodeTrafficAbuse(NOW);

    const reversed = makeDetectors({ nodes: [...nodes].reverse(), topUsers: [], snapshots });
    await reversed.detectors.detectPerUserNodeTrafficAbuse(NOW);

    assert.deepStrictEqual(forward.bandwidthNodeUuids, [['aaaa-de-1', 'bbbb-nl-1']]);
    assert.deepStrictEqual(reversed.bandwidthNodeUuids, forward.bandwidthNodeUuids);
  });
});

// ── 4. Infrastructure facts are operator alerts, not accusations ─────────────

describe('panel-wide observations', () => {
  it('no longer expose a fraud-signal entry point', () => {
    const detectors = makeDetectors({ nodes: [] }).detectors as unknown as Record<string, unknown>;
    for (const gone of [
      'detectOfflineNodes',
      'detectGeoAnomalies',
      'detectNodeTrafficAbuse',
      'detectHwidAnomalies',
    ]) {
      assert.equal(
        typeof detectors[gone],
        'undefined',
        `${gone} must not be able to file a fraud signal any more`,
      );
    }
  });

  it('reports an outage on the node event channel', async () => {
    const { detectors } = makeDetectors({
      nodes: [
        node({ uuid: 'aaaa-de-1', name: 'de-1' }),
        node({ uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: false }),
      ],
    });

    const alerts = await detectors.collectOfflineNodeAlerts(NOW);

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'node.connection_lost');
    assert.equal(alerts[0].category, 'NODE');
    assert.equal(alerts[0].metadata['offlineCount'], 1);
  });

  it('does not re-announce the same outage listed in a different order', async () => {
    // `getAllNodes` does not sort, and the old fingerprint was built from the
    // unsorted list — so the identical outage arriving in a different order
    // minted a second HIGH-severity signal.
    const offline = [
      node({ uuid: 'cccc-fi-1', name: 'fi-1', isConnected: false }),
      node({ uuid: 'aaaa-de-1', name: 'de-1', isConnected: false }),
      node({ uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: false }),
    ];
    const prisma = {} as unknown as PrismaService;
    const versionService = {} as unknown as RemnawaveVersionService;
    let order: readonly RemnawaveNodeInterface[] = offline;
    const api = {
      getAllNodes: () => Promise.resolve([...order]),
    } as unknown as RemnawaveApiService;
    const detectors = new RemnawaveDetectors(prisma, api, versionService, tunablesFromEnv());

    const first = await detectors.collectOfflineNodeAlerts(NOW);
    order = [...offline].reverse();
    const second = await detectors.collectOfflineNodeAlerts(NOW);

    assert.equal(first.length, 1);
    assert.equal(
      first[0].dedupeKey,
      'nodes_offline|aaaa-de-1,bbbb-nl-1,cccc-fi-1',
      'the key must be the sorted, fully-qualified uuid list',
    );
    assert.deepStrictEqual(second, [], 'the same outage reordered is the same outage');
  });

  it('re-announces node traffic only when it crosses a new band', async () => {
    let usedBytes = 91;
    const api = {
      getAllNodes: () =>
        Promise.resolve([
          node({
            uuid: 'aaaa-de-1',
            name: 'de-1',
            trafficLimitBytes: 100,
            trafficUsedBytes: usedBytes,
          }),
        ]),
    } as unknown as RemnawaveApiService;
    const detectors = new RemnawaveDetectors(
      {} as unknown as PrismaService,
      api,
      {} as unknown as RemnawaveVersionService,
      tunablesFromEnv(),
    );

    const at91 = await detectors.collectNodeTrafficAlerts(NOW);
    usedBytes = 92;
    const at92 = await detectors.collectNodeTrafficAlerts(NOW);
    usedBytes = 96;
    const at96 = await detectors.collectNodeTrafficAlerts(NOW);

    assert.equal(at91.length, 1);
    assert.equal(at91[0].type, 'node.traffic_notify');
    assert.deepStrictEqual(at92, [], '92% is the same fact as 91%, not a new one');
    assert.equal(at96.length, 1, 'crossing 95% is a new fact');
    assert.equal(at96[0].dedupeKey, 'node_traffic|aaaa-de-1|95');
  });

  it('does not report geo concentration measured across a moving panel', async () => {
    // 100% of online users behind DE because the NL node just dropped is the
    // outage restated, not a distribution to load-balance.
    const { detectors } = makeDetectors({
      nodes: [
        node({ uuid: 'aaaa-de-1', name: 'de-1', countryCode: 'DE', usersOnline: 40 }),
        node({
          uuid: 'bbbb-nl-1',
          name: 'nl-1',
          countryCode: 'NL',
          isConnected: false,
          usersOnline: 0,
        }),
      ],
      snapshots: [
        [
          { uuid: 'aaaa-de-1', name: 'de-1', isConnected: true },
          { uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: true },
        ],
        [
          { uuid: 'aaaa-de-1', name: 'de-1', isConnected: true },
          { uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: false },
        ],
      ],
    });

    assert.deepStrictEqual(await detectors.collectGeoConcentrationAlerts(NOW), []);
  });

  it('reports geo concentration on a stable panel, banded not per-percent', async () => {
    let deOnline = 41;
    const nodes = () => [
      node({ uuid: 'aaaa-de-1', name: 'de-1', countryCode: 'DE', usersOnline: deOnline }),
      node({ uuid: 'bbbb-nl-1', name: 'nl-1', countryCode: 'NL', usersOnline: 5 }),
    ];
    const prisma = {
      remnawaveMetricSample: {
        findMany: () =>
          Promise.resolve([
            {
              nodesSnapshot: [
                { uuid: 'aaaa-de-1', name: 'de-1', isConnected: true },
                { uuid: 'bbbb-nl-1', name: 'nl-1', isConnected: true },
              ],
            },
          ]),
      },
    } as unknown as PrismaService;
    const api = { getAllNodes: () => Promise.resolve(nodes()) } as unknown as RemnawaveApiService;
    const detectors = new RemnawaveDetectors(
      prisma,
      api,
      {} as unknown as RemnawaveVersionService,
      tunablesFromEnv(),
    );

    const first = await detectors.collectGeoConcentrationAlerts(NOW); // 89.1%
    deOnline = 42; // 89.4% — the same band
    const second = await detectors.collectGeoConcentrationAlerts(NOW);

    assert.equal(first.length, 1);
    assert.equal(first[0].type, 'node.geo_concentration');
    assert.equal(first[0].dedupeKey, 'geo|DE|80');
    assert.deepStrictEqual(second, [], 'a percentage drifting inside its band is not a new fact');
  });

  it('bands the panel-wide device average instead of keying on it', async () => {
    let average = 3.4;
    const api = {
      getHwidStats: () =>
        Promise.resolve({
          stats: {
            averageHwidDevicesPerUser: average,
            totalHwidDevices: 900,
            totalUniqueDevices: 800,
          },
          byPlatform: {},
        }),
    } as unknown as RemnawaveApiService;
    const detectors = new RemnawaveDetectors(
      {} as unknown as PrismaService,
      api,
      {} as unknown as RemnawaveVersionService,
      tunablesFromEnv(),
    );

    const first = await detectors.collectHwidAverageAlerts(NOW);
    average = 3.5; // one tenth higher — used to be a brand-new fraud signal
    const second = await detectors.collectHwidAverageAlerts(NOW);

    assert.equal(first.length, 1);
    assert.equal(first[0].dedupeKey, 'hwid|3');
    assert.deepStrictEqual(second, [], '0.1 of drift is not a new finding');
  });
});

// ── 5. The orchestrator routes them apart ────────────────────────────────────

describe('AntiFraudService.runDetectors', () => {
  it('emits the panel-wide observations as events and files no fraud row for them', async () => {
    const created: unknown[] = [];
    const emitted: { type: string; category: string }[] = [];

    const prisma = {
      fraudSignal: {
        findUnique: () => Promise.resolve(null),
        // The run reconciles its open signals against the candidate set it
        // produced; an empty table is the honest answer here, and without it
        // this test would reach its verdict through the reconcile pass's
        // error handler instead of through the reconcile pass.
        findMany: () => Promise.resolve([]),
        create: (args: unknown) => {
          created.push(args);
          return Promise.resolve({
            id: 'sig-1',
            code: 'X',
            fingerprint: 'f',
            severity: FraudSignalSeverity.LOW,
            status: 'OPEN',
            title: 't',
            description: 'd',
            score: 0,
            confidence: 0,
            affectedUserIds: [],
            metadata: {},
            lastAction: 'none',
            detectedAt: NOW,
            resolvedAt: null,
            resolvedBy: null,
            resolutionNote: null,
            createdAt: NOW,
            updatedAt: NOW,
          });
        },
      },
      // The two gates in front of `upsertSignal` read their own tables on every
      // run. Modelled here as empty rather than omitted for the same reason as
      // `fraudSignal.findMany` above: an absent table would make the run reach
      // its verdict through a thrown `undefined.findMany` — and this test's
      // whole claim is "no accusation was made", which an exception satisfies
      // for entirely the wrong reason.
      fraudExemption: {
        findMany: () => Promise.resolve([]),
      },
      fraudCandidateStreak: {
        findUnique: () => Promise.resolve(null),
        findMany: () => Promise.resolve([]),
        upsert: () => Promise.resolve({}),
        deleteMany: () => Promise.resolve({ count: 0 }),
      },
    } as unknown as PrismaService;

    const noFraud = () => Promise.resolve([]);
    const fraudDetectors = {
      detectExcessiveFailedPayments: noFraud,
      detectRapidReferralVelocity: noFraud,
      detectPromoAbuse: noFraud,
      detectRapidChurn: noFraud,
    } as unknown as FraudDetectors;

    const alert = (type: string): OperationalAlert => ({
      type,
      category: 'NODE',
      severity: 'WARNING',
      message: `alert ${type}`,
      dedupeKey: `k|${type}`,
      metadata: { kind: type },
    });
    const remnawaveDetectors = {
      detectPerUserNodeTrafficAbuse: noFraud,
      collectHwidAverageAlerts: () => Promise.resolve([alert('remnawave.hwid_average_high')]),
      collectNodeTrafficAlerts: () => Promise.resolve([alert('node.traffic_notify')]),
      collectGeoConcentrationAlerts: () => Promise.resolve([alert('node.geo_concentration')]),
      collectOfflineNodeAlerts: () => Promise.resolve([alert('node.connection_lost')]),
    } as unknown as RemnawaveDetectors;

    const sharingDetectors = {
      detectHwidOverage: noFraud,
      detectConcurrentIpSharing: noFraud,
    } as unknown as SharingDetectors;

    const subscriptionUaDetectors = {
      detectSubscriptionUaTunnel: noFraud,
    } as unknown as SubscriptionUaDetectors;

    const systemEvents = {
      emit: (event: { type: string; category: string }) => {
        emitted.push({ type: event.type, category: event.category });
      },
      warn: () => undefined,
    } as unknown as SystemEventsService;

    const service = new AntiFraudService(
      prisma,
      fraudDetectors,
      remnawaveDetectors,
      sharingDetectors,
      subscriptionUaDetectors,
      {} as unknown as RemnawaveApiService,
      systemEvents,
    );

    const results = await service.runDetectors();

    assert.deepStrictEqual(results, [], 'no accusation was made');
    assert.deepStrictEqual(created, [], 'no infrastructure fact reached the fraud table');
    assert.deepStrictEqual(
      emitted.map((e) => e.type).sort(),
      [
        'node.connection_lost',
        'node.geo_concentration',
        'node.traffic_notify',
        'remnawave.hwid_average_high',
      ],
      'all four panel-wide observations reached the operator event channel',
    );
  });
});
