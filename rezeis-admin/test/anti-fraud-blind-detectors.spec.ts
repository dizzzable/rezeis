import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import {
  AntiFraudService,
  AUTO_RESOLVED_NOTE,
} from '../src/modules/anti-fraud/services/anti-fraud.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import type {
  PanelDevicesOutcome,
  PanelHwidDeviceStats,
  PanelHwidTopUsersPage,
} from '../src/modules/remnawave/services/panel-devices.client';
import type {
  PanelNode,
  PanelReadOutcome,
} from '../src/modules/remnawave/services/panel-infra.client';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { makeAntiFraudStore } from './fixtures/anti-fraud-store';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';
import {
  hwidTopUsersPage,
  panelDevicesDouble,
  panelInfraDouble,
  panelNode,
  panelNetworkFailure,
  panelOk,
  panelRejected,
  panelUnreadable,
} from './fixtures/anti-fraud-panel-clients';

/**
 * A DETECTOR THAT CANNOT LOOK MUST NOT REPORT A CLEAN PANEL.
 *
 * `[]` means "we looked and found nobody". Anything else means "we could not
 * look". Those are opposite facts to a module whose whole job is deciding
 * whether to accuse a paying customer, and for three of these paths they used
 * to be the same value:
 *
 *   1. `SharingDetectors.detectHwidOverage` — the device list read swallowed
 *      every transport failure into `[]`, so the detector could only INFER
 *      blindness from a contradiction (a populated user list beside an empty
 *      device list) and could only ever guess.
 *   2. `RemnawaveDetectors.collectHwidAverageAlerts` — two stats paths tried in
 *      a bare `catch { continue }`, so an expired token on the first was
 *      answered by a second request that could only 404, and the pair returned
 *      `null` exactly as an unasked panel would.
 *   3. `SharingDetectors.detectConcurrentIpSharing` — gated on a CAPABILITY
 *      RECORD rather than on any answer. `liveIpControl` was a version fact,
 *      and version detection folds 401 / timeout / DNS / unconfigured token
 *      into one "unknown" — so a panel that was merely having a bad second was
 *      written off, at debug level, as a panel with nothing to report.
 *
 * All three now read the blindness off the ANSWER. Every test here therefore
 * asserts on the OPERATOR-VISIBLE record — the WARN — and on the two properties
 * that make the warning worth having: it is emitted once per episode rather
 * than once per run (288 copies a day is how a real failure gets tuned out),
 * and the detector still returns `[]` so an unobservable run cannot
 * auto-resolve anybody's open signal.
 *
 * The counterpart assertions are the half that stops "warn about everything"
 * passing for "warn about blindness": a panel that answers with no rows is a
 * FACT and must be silent, a partially-read run is incomplete rather than
 * blind, and a detector that recovers has to say so and go back to work.
 */

const NOW = new Date('2026-08-10T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);

// ── Log capture ──────────────────────────────────────────────────────────────

interface Captured {
  readonly warns: string[];
  readonly logs: string[];
  restore(): void;
}

function captureLogs(): Captured {
  const warns: string[] = [];
  const logs: string[] = [];
  const originalWarn = Logger.prototype.warn;
  const originalLog = Logger.prototype.log;
  const originalDebug = Logger.prototype.debug;
  Logger.prototype.warn = function patched(message: unknown): void {
    warns.push(String(message));
  } as typeof Logger.prototype.warn;
  Logger.prototype.log = function patched(message: unknown): void {
    logs.push(String(message));
  } as typeof Logger.prototype.log;
  // Silenced, not recorded: the "still blind" runs are deliberately debug, and
  // asserting on them would pin a level that is free to change.
  Logger.prototype.debug = function patched(): void {} as typeof Logger.prototype.debug;
  return {
    warns,
    logs,
    restore(): void {
      Logger.prototype.warn = originalWarn;
      Logger.prototype.log = originalLog;
      Logger.prototype.debug = originalDebug;
    },
  };
}

const blindWarns = (captured: Captured, needle: string): string[] =>
  captured.warns.filter((w) => w.includes('BLIND') && w.includes(needle));

// ── SharingDetectors harness ─────────────────────────────────────────────────

interface PanelUser {
  readonly uuid: string;
  readonly panelId: number | null;
  readonly hwidDeviceLimit: number;
}

interface SharingHarness {
  readonly detectors: SharingDetectors;
  /** Every panel read the detector actually made, in call order. */
  readonly panelCalls: string[];
}

/**
 * `SharingDetectors` over doubles that can express all three answers.
 *
 * `topUsers` / `nodes` take a whole OUTCOME rather than rows, because the
 * distinction under test is between an outcome that carries no rows and an
 * outcome that is not a read at all — and a harness that only accepts rows
 * cannot say the second thing.
 */
function makeSharingHarness(input: {
  readonly panelUsers?: readonly PanelUser[];
  readonly topUsers?: PanelDevicesOutcome<PanelHwidTopUsersPage>;
  readonly nodes?: PanelReadOutcome<readonly PanelNode[]>;
  readonly nodeUuids?: readonly string[];
  /**
   * Per node uuid. A listed node ABSENT here answers `null`: "we could not read
   * this node", which is the state the whole file exists to keep separate from
   * "this node was read and was quiet" (`[]`).
   */
  readonly connectionsByNode?: Readonly<
    Record<string, ReadonlyArray<{ userId: number; ips: ReadonlyArray<{ ip: string; lastSeen: Date }> }> | null>
  >;
}): SharingHarness {
  const panelCalls: string[] = [];
  const panelUsers = input.panelUsers ?? [];

  const prisma = {
    subscription: { findMany: () => Promise.resolve([]) },
    remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const api = {
    strictGetAllPanelUsers: () => {
      panelCalls.push('strictGetAllPanelUsers');
      return Promise.resolve(strictOk({ users: [...panelUsers], total: panelUsers.length }));
    },
  } as unknown as RemnawaveApiService;

  const nodeUuids = input.nodeUuids ?? [];
  const devices = panelDevicesDouble({
    topUsers: input.topUsers ?? panelOk(hwidTopUsersPage([])),
    nodeConnections: input.connectionsByNode as never,
  });
  const infra = panelInfraDouble({
    nodes:
      input.nodes ??
      panelOk(nodeUuids.map((uuid) => panelNode({ uuid, name: uuid, lastStatusChange: LONG_AGO }))),
  });

  // Both doubles record into their own arrays; this merges them into the single
  // call log the tests read, in real call order.
  const record = <T extends object>(client: T, method: keyof T, label: (arg: unknown) => string) => {
    const original = (client[method] as unknown as (arg: unknown) => unknown).bind(client);
    (client as Record<string, unknown>)[method as string] = (arg: unknown) => {
      panelCalls.push(label(arg));
      return original(arg);
    };
  };
  record(devices.client, 'listTopUsersByDeviceCount', () => 'listTopUsersByDeviceCount');
  record(devices.client, 'fetchNodeConnections', (uuid) => `fetchNodeConnections:${String(uuid)}`);
  record(infra.client, 'getNodes', () => 'getNodes');

  return {
    detectors: new SharingDetectors(
      prisma,
      api,
      devices.client,
      infra.client,
      tunablesFromEnv(),
    ),
    panelCalls,
  };
}

/** Three IPs on three networks, all seen a moment ago — an offender. */
function offenderIps(at: Date): ReadonlyArray<{ ip: string; lastSeen: Date }> {
  return [
    { ip: '1.1.1.1', lastSeen: at },
    { ip: '2.2.2.2', lastSeen: at },
    { ip: '3.3.3.3', lastSeen: at },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. HWID overage: a failed device read is not an empty one
// ─────────────────────────────────────────────────────────────────────────────

describe('detectHwidOverage — a device read that failed is not a clean panel', () => {
  let captured: Captured;
  beforeEach(() => {
    captured = captureLogs();
  });
  afterEach(() => captured.restore());

  it('says so, once, when the panel refuses the device list', async () => {
    const { detectors } = makeSharingHarness({
      panelUsers: [
        { uuid: '1', panelId: 1, hwidDeviceLimit: 3 },
        { uuid: '2', panelId: 2, hwidDeviceLimit: 3 },
      ],
      topUsers: panelRejected(404),
    });

    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);

    const blind = blindWarns(captured, 'HWID overage');
    assert.equal(
      blind.length,
      1,
      `three runs of a five-minute cron must warn once, not three times; saw ${JSON.stringify(captured.warns)}`,
    );
    assert.match(blind[0], /HTTP 404/);
    assert.match(blind[0], /zero offenders/);
  });

  it('names the failure it actually had, so the two need different fixes', async () => {
    // `unreadable` is the panel answering 2xx with a body the data is not in —
    // a contract problem somebody has to look at. Reporting it as a refusal
    // sends an operator to check a token that is fine.
    const { detectors } = makeSharingHarness({
      panelUsers: [{ uuid: '1', panelId: 1, hwidDeviceLimit: 3 }],
      topUsers: panelUnreadable('`response.users` is not an array'),
    });

    await detectors.detectHwidOverage(NOW);

    assert.match(blindWarns(captured, 'HWID overage')[0] ?? '', /could not read/);
  });

  it('stays silent when the panel answers that nobody has a device', async () => {
    // THE ASSERTION THAT FLIPPED, and the reason the migration was worth doing.
    // This used to be the blind case: the old reader collapsed a 404 into `[]`,
    // so the detector had to treat "a populated panel with no device rows" as
    // evidence of a failed read and warn about it. The read now reports its own
    // failure, so an `ok` with no rows is a FACT about the panel — and warning
    // about a fact is how an operator learns to ignore the line that matters.
    const { detectors } = makeSharingHarness({
      panelUsers: [
        { uuid: '1', panelId: 1, hwidDeviceLimit: 3 },
        { uuid: '2', panelId: 2, hwidDeviceLimit: 3 },
        { uuid: '3', panelId: 3, hwidDeviceLimit: 3 },
      ],
      topUsers: panelOk(hwidTopUsersPage([])),
    });

    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
    assert.deepEqual(blindWarns(captured, 'HWID overage'), []);
  });

  it('announces the recovery and re-arms for the next blindness', async () => {
    let answer: PanelDevicesOutcome<PanelHwidTopUsersPage> = panelRejected(404);
    const panelUsers = [{ uuid: '1', panelId: 1, hwidDeviceLimit: 3 }];
    const api = {
      strictGetAllPanelUsers: () =>
        Promise.resolve(strictOk({ users: panelUsers, total: panelUsers.length })),
    } as unknown as RemnawaveApiService;
    const devices = {
      listTopUsersByDeviceCount: () => Promise.resolve(answer),
    } as unknown as import('../src/modules/remnawave/services/panel-devices.client').PanelDevicesClient;
    const detectors = new SharingDetectors(
      { subscription: { findMany: () => Promise.resolve([]) } } as unknown as PrismaService,
      api,
      devices,
      panelInfraDouble().client,
      tunablesFromEnv(),
    );

    await detectors.detectHwidOverage(NOW); // blind
    answer = panelOk(hwidTopUsersPage([{ id: 1, username: 'alice', devicesCount: 5 }]));
    const named = await detectors.detectHwidOverage(NOW); // sees again
    answer = panelRejected(500);
    await detectors.detectHwidOverage(NOW); // blind again

    assert.equal(named.length, 1, 'a recovered detector has to go back to naming offenders');
    assert.equal(
      blindWarns(captured, 'HWID overage').length,
      2,
      'a detector that went blind, recovered, and went blind again is two episodes',
    );
    assert.equal(
      captured.logs.filter((l) => l.includes('HWID overage detection recovered')).length,
      1,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Panel-wide HWID average: a failed read is "we could not look"
// ─────────────────────────────────────────────────────────────────────────────

describe('collectHwidAverageAlerts — a failed stats read is not a healthy average', () => {
  let captured: Captured;
  beforeEach(() => {
    captured = captureLogs();
  });
  afterEach(() => captured.restore());

  function makeCollector(read: () => PanelDevicesOutcome<PanelHwidDeviceStats>): RemnawaveDetectors {
    return new RemnawaveDetectors(
      {} as unknown as PrismaService,
      {
        getDeviceStats: () => Promise.resolve(read()),
      } as unknown as import('../src/modules/remnawave/services/panel-devices.client').PanelDevicesClient,
      panelInfraDouble().client,
      tunablesFromEnv(),
    );
  }

  const healthy = (): PanelDevicesOutcome<PanelHwidDeviceStats> =>
    panelOk({
      stats: { averageHwidDevicesPerUser: 3.4, totalHwidDevices: 900, totalUniqueDevices: 800 },
      byPlatform: [],
    } as unknown as PanelHwidDeviceStats);

  it('says so, once, when the stats read does not come back', async () => {
    const collector = makeCollector(() => panelNetworkFailure('socket hang up'));

    assert.deepEqual(await collector.collectHwidAverageAlerts(NOW), []);
    assert.deepEqual(await collector.collectHwidAverageAlerts(NOW), []);
    assert.deepEqual(await collector.collectHwidAverageAlerts(NOW), []);

    const blind = blindWarns(captured, 'HWID average');
    assert.equal(
      blind.length,
      1,
      `a broken endpoint stays broken; one WARN per episode, not per run; saw ${JSON.stringify(captured.warns)}`,
    );
    assert.match(blind[0], /socket hang up/);
  });

  it('recovers loudly, and a blind run does not re-arm the band it never left', async () => {
    // The counterpart, and the reason the blind branch must not reset
    // `lastHwidBand`: an average that was already reported at band 3 and then
    // became unobservable must not re-announce band 3 when it comes back.
    let answer = healthy();
    const collector = makeCollector(() => answer);

    const first = await collector.collectHwidAverageAlerts(NOW);
    answer = panelRejected(404);
    const blindRun = await collector.collectHwidAverageAlerts(NOW);
    answer = healthy();
    const afterRecovery = await collector.collectHwidAverageAlerts(NOW);

    assert.equal(first.length, 1);
    assert.equal(first[0].dedupeKey, 'hwid|3');
    assert.deepEqual(blindRun, []);
    assert.deepEqual(
      afterRecovery,
      [],
      'a band that was never observed to change is not a new finding',
    );
    assert.equal(blindWarns(captured, 'HWID average').length, 1);
    assert.equal(
      captured.logs.filter((l) => l.includes('HWID average recovered')).length,
      1,
      'the operator who was told the collector went blind has to be told it came back',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Concurrent-IP: blindness is read off the answers, not off a version
// ─────────────────────────────────────────────────────────────────────────────

describe('detectConcurrentIpSharing — a blind run is not a quiet panel', () => {
  let captured: Captured;
  let previousEnabled: string | undefined;

  beforeEach(() => {
    captured = captureLogs();
    // The IP detector is OFF by default and everything under test sits behind
    // that switch, so it has to be on for any of this to be reached.
    previousEnabled = process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    process.env.ANTIFRAUD_SHARING_IP_ENABLED = 'true';
  });
  afterEach(() => {
    captured.restore();
    if (previousEnabled === undefined) delete process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    else process.env.ANTIFRAUD_SHARING_IP_ENABLED = previousEnabled;
  });

  it('warns once when the node list cannot be read, and scans nothing', async () => {
    // `?? []` used to stand here. A node list we could not read produced zero
    // connected nodes, the run returned `[]`, and an unreachable panel was
    // indistinguishable from one where nobody is sharing.
    const { detectors, panelCalls } = makeSharingHarness({
      panelUsers: [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: panelRejected(503),
    });

    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);

    const blind = blindWarns(captured, 'Concurrent-IP');
    assert.equal(blind.length, 1, `saw ${JSON.stringify(captured.warns)}`);
    assert.match(blind[0], /node list/);
    assert.match(blind[0], /not the same fact as a panel/);
    assert.deepEqual(
      panelCalls.filter((call) => call.startsWith('fetchNodeConnections')),
      [],
      'there is nothing to scan and nothing must be scanned',
    );
  });

  it('warns once when not one connected node could be read', async () => {
    // Every node answered `null`. The run examined nobody, so its silence is
    // not evidence — and a big node is both the slowest to answer and the one
    // sharers live on, so this is the failure that lands where it matters most.
    const { detectors, panelCalls } = makeSharingHarness({
      panelUsers: [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }],
      nodeUuids: ['n1', 'n2'],
      connectionsByNode: { n1: null, n2: null },
    });

    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);

    const blind = blindWarns(captured, 'Concurrent-IP');
    assert.equal(blind.length, 1, `saw ${JSON.stringify(captured.warns)}`);
    assert.match(blind[0], /not one of the 2 connected node\(s\)/);
    // The nodes WERE attempted, on both runs — that is what separates this from
    // the case above, where nothing was scanned at all, and an operator reading
    // the two lines has two different problems.
    assert.deepEqual(
      panelCalls.filter((call) => call.startsWith('fetchNodeConnections')),
      [
        'fetchNodeConnections:n1',
        'fetchNodeConnections:n2',
        'fetchNodeConnections:n1',
        'fetchNodeConnections:n2',
      ],
    );
  });

  it('re-announces when the run goes blind for a different reason', async () => {
    // Latched on the REASON, not on a boolean: a node list that stopped
    // answering after the user list had already been failing is a new fact and
    // a different fix.
    const { detectors: unreadableNodes } = makeSharingHarness({
      panelUsers: [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }],
      nodeUuids: ['n1'],
      connectionsByNode: { n1: null },
    });
    await unreadableNodes.detectConcurrentIpSharing(NOW);

    const { detectors: unreadableList } = makeSharingHarness({
      panelUsers: [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: panelUnreadable('`response` is not an array'),
    });
    await unreadableList.detectConcurrentIpSharing(NOW);

    const blind = blindWarns(captured, 'Concurrent-IP');
    assert.equal(blind.length, 2);
    assert.match(blind[0], /not one of the 1 connected node\(s\)/);
    assert.match(blind[1], /node list/);
  });

  it('treats a partly-read panel as incomplete, not as blind', async () => {
    // The counterpart that stops "warn about everything" passing for the fix. A
    // run that read SOME nodes has real evidence about those nodes; it is
    // simply not evidence about the rest, and that is a different (and more
    // proportionate) sentence than "this run proves nothing".
    const { detectors } = makeSharingHarness({
      panelUsers: [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }],
      nodeUuids: ['n1', 'n2'],
      connectionsByNode: { n1: [{ userId: 10, ips: offenderIps(NOW) }], n2: null },
    });

    const found = await detectors.detectConcurrentIpSharing(NOW);

    assert.equal(found.length, 1, 'the nodes that answered still produce their detections');
    assert.deepEqual(blindWarns(captured, 'Concurrent-IP'), []);
    assert.ok(
      captured.warns.some((w) => w.includes('could not read 1 of 2 connected node(s)')),
      `the unread node has to be visible anyway; saw ${JSON.stringify(captured.warns)}`,
    );
  });

  it('reads a panel that answers, and names the offender', async () => {
    const { detectors } = makeSharingHarness({
      panelUsers: [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }],
      nodeUuids: ['n1'],
      connectionsByNode: { n1: [{ userId: 10, ips: offenderIps(NOW) }] },
    });

    const found = await detectors.detectConcurrentIpSharing(NOW);

    assert.equal(found.length, 1, 'a readable panel must produce detections, not silence');
    assert.equal(found[0].code, 'SUBSCRIPTION_SHARING_IP');
    assert.deepEqual(blindWarns(captured, 'Concurrent-IP'), []);
  });

  it('recovers loudly on a panel it can read, and still names the offender', async () => {
    let connections: ReadonlyArray<{ userId: number; ips: ReadonlyArray<{ ip: string; lastSeen: Date }> }> | null =
      null;
    const panelUsers = [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }];
    const api = {
      strictGetAllPanelUsers: () =>
        Promise.resolve(strictOk({ users: panelUsers, total: panelUsers.length })),
    } as unknown as RemnawaveApiService;
    const devices = {
      fetchNodeConnections: () => Promise.resolve(connections),
    } as unknown as import('../src/modules/remnawave/services/panel-devices.client').PanelDevicesClient;
    const detectors = new SharingDetectors(
      {
        subscription: { findMany: () => Promise.resolve([]) },
        remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
      } as unknown as PrismaService,
      api,
      devices,
      panelInfraDouble({
        nodes: panelOk([panelNode({ uuid: 'n1', name: 'N1', lastStatusChange: LONG_AGO })]),
      }).client,
      tunablesFromEnv(),
    );

    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
    connections = [{ userId: 10, ips: offenderIps(NOW) }];
    const named = await detectors.detectConcurrentIpSharing(NOW);

    assert.equal(named.length, 1, 'the fix must not cost a real detection');
    assert.equal(named[0].code, 'SUBSCRIPTION_SHARING_IP');
    assert.equal(blindWarns(captured, 'Concurrent-IP').length, 1);
    assert.equal(
      captured.logs.filter((l) => l.includes('Concurrent-IP detection recovered')).length,
      1,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The run plan still treats a blind run as no information at all
// ─────────────────────────────────────────────────────────────────────────────

describe('runDetectors — a blind detector must not auto-resolve anybody', () => {
  let captured: Captured;
  let previousEnabled: string | undefined;

  beforeEach(() => {
    captured = captureLogs();
    previousEnabled = process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    process.env.ANTIFRAUD_SHARING_IP_ENABLED = 'true';
  });
  afterEach(() => {
    captured.restore();
    if (previousEnabled === undefined) delete process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    else process.env.ANTIFRAUD_SHARING_IP_ENABLED = previousEnabled;
  });

  // `runDetectors` stamps its own `new Date()`, so the day bucket a fingerprint
  // has to match — and the recency an IP sample has to clear — are both the real
  // clock's, not this suite's fixed NOW.
  const TODAY = new Date().toISOString().slice(0, 10);

  /**
   * `AntiFraudService` over the REAL `SharingDetectors`, so the blind path is
   * the thing driving the run rather than a stub of it.
   */
  function build(readable: boolean) {
    const store = makeAntiFraudStore({
      today: TODAY,
      signals: [
        {
          code: 'SUBSCRIPTION_SHARING_IP',
          fingerprint: `${TODAY}|someone-else`,
          status: FraudSignalStatus.OPEN,
        },
      ],
    });
    const now = new Date();
    const panelUsers = [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }];
    const api = {
      strictGetAllPanelUsers: () =>
        Promise.resolve(strictOk({ users: panelUsers, total: panelUsers.length })),
    } as unknown as RemnawaveApiService;

    const devices = panelDevicesDouble({
      // A device row for a user who is not over their limit: the HWID detector
      // has looked, found nothing, and — crucially for this suite — is NOT
      // blind, so the only blindness in the run is the one under test.
      topUsers: panelOk(hwidTopUsersPage([{ id: 10, username: 'offender', devicesCount: 1 }])),
      // Readable: the node answered and the offender is on it. Blind: the node
      // could not be read at all, which is the `null` the whole file is about.
      nodeConnections: {
        n1: readable ? [{ userId: 10, ips: offenderIps(now) }] : null,
      } as never,
    });
    const infra = panelInfraDouble({
      nodes: panelOk([
        panelNode({
          uuid: 'n1',
          name: 'N1',
          lastStatusChange: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
        }),
      ]),
    });

    const prisma = {
      ...(store.prisma as unknown as Record<string, unknown>),
      subscription: { findMany: () => Promise.resolve([]) },
      remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
    } as unknown as PrismaService;

    const sharing = new SharingDetectors(
      prisma,
      api,
      devices.client,
      infra.client,
      tunablesFromEnv(),
    );
    const empty = () => Promise.resolve([]);
    const service = new AntiFraudService(
      prisma,
      {
        detectExcessiveFailedPayments: empty,
        detectRapidReferralVelocity: empty,
        detectPromoAbuse: empty,
        detectRapidChurn: empty,
      } as unknown as FraudDetectors,
      {
        detectPerUserNodeTrafficAbuse: empty,
        collectHwidAverageAlerts: empty,
        collectNodeTrafficAlerts: empty,
        collectGeoConcentrationAlerts: empty,
        collectOfflineNodeAlerts: empty,
      } as unknown as RemnawaveDetectors,
      sharing,
      { detectSubscriptionUaTunnel: empty } as unknown as SubscriptionUaDetectors,
      panelDevicesDouble().client,
      {
        info: () => undefined,
        warn: () => undefined,
        emit: () => undefined,
      } as unknown as SystemEventsService,
    );
    return { service, store };
  }

  it('leaves an open sharing signal alone when the panel could not be read', async () => {
    const { service, store } = build(false);

    await service.runDetectors();

    const row = store.rows[0];
    assert.equal(
      row.status,
      FraudSignalStatus.OPEN,
      'a run that could not look must not stamp "no longer detected" on a live accusation',
    );
    assert.equal(row.resolutionNote, null);
    assert.equal(blindWarns(captured, 'Concurrent-IP').length, 1);
  });

  it('still auto-resolves once a run that COULD look reports the condition gone', async () => {
    // The counterpart that stops "never resolve anything" passing for the fix.
    // The detector has to produce SOMETHING for its code to become reconcilable
    // at all — that is the `observational` rule — so this run names a different
    // user, and the stale row for `someone-else` closes as it always did.
    const { service, store } = build(true);

    await service.runDetectors();

    const stale = store.rows.find((r) => r.fingerprint === `${TODAY}|someone-else`);
    assert.equal(stale?.status, FraudSignalStatus.RESOLVED);
    assert.equal(stale?.resolutionNote, AUTO_RESOLVED_NOTE);
    assert.deepEqual(blindWarns(captured, 'Concurrent-IP'), []);
  });
});
