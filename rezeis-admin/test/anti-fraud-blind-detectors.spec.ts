import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import {
  SharingDetectors,
  classifyLiveConnectionBlindness,
} from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import {
  AntiFraudService,
  AUTO_RESOLVED_NOTE,
} from '../src/modules/anti-fraud/services/anti-fraud.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  RemnawaveVersionService,
  type RemnawaveCapabilities,
} from '../src/modules/remnawave/services/remnawave-version.service';
import { makeAntiFraudStore } from './fixtures/anti-fraud-store';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';

/**
 * A DETECTOR THAT CANNOT LOOK MUST NOT REPORT A CLEAN PANEL.
 *
 * Three paths in this module returned an empty list in total silence when the
 * thing they read was unavailable, and on a Remnawave 3.x panel all three are
 * unavailable at once:
 *
 *   1. `SharingDetectors.detectHwidOverage` — `getHwidTopUsers()` swallows every
 *      transport failure and answers `[]`, which the detector could not tell
 *      from "nobody is over their limit".
 *   2. `RemnawaveDetectors.collectHwidAverageAlerts` — `getHwidStats()` answers
 *      `null` only when BOTH stats paths failed, and the collector returned as
 *      if the average were unremarkable.
 *   3. `SharingDetectors.detectConcurrentIpSharing` — gated on `liveIpControl`,
 *      which is `major === 2 && minor >= 8`, so a 3.2.1 panel that serves live
 *      connections perfectly well under `/api/connections/*` was written off, at
 *      debug, as "lacks mature ip-control (need 2.8+)".
 *
 * Every test here therefore asserts on the OPERATOR-VISIBLE record — the WARN —
 * and on the two properties that make the warning worth having: it is emitted
 * once per episode rather than once per run (288 copies a day is how a real
 * failure gets tuned out), and the detector still returns `[]` so an
 * unobservable run cannot auto-resolve anybody's open signal.
 *
 * The counterpart assertions are the half that stops "warn about everything"
 * passing for "warn about blindness": an empty panel legitimately holds no
 * devices, and a detector that recovers has to say so and go back to work.
 */

const NOW = new Date('2026-08-10T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

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

// ── Capability doubles ───────────────────────────────────────────────────────

/**
 * A full `RemnawaveCapabilities` record. Spelled out in full rather than cast
 * from a partial so a test cannot accidentally assert against a field the
 * version service does not actually produce.
 */
function capabilities(over: Partial<RemnawaveCapabilities>): RemnawaveCapabilities {
  return {
    version: null,
    major: null,
    minor: null,
    patch: null,
    supported: false,
    reachable: false,
    liveIpControl: false,
    bandwidthNodesUsers: false,
    userAddressing: 'unknown',
    connectionsApi: 'unknown',
    userLookups: { byTelegramId: false, byEmail: false },
    ...over,
  };
}

/** The three panels this suite cares about, as the version service reports them. */
const PANEL_2_7_4 = capabilities({
  version: '2.7.4',
  major: 2,
  minor: 7,
  patch: 4,
  supported: true,
  reachable: true,
  connectionsApi: 'ip-control',
  userAddressing: 'uuid',
  userLookups: { byTelegramId: true, byEmail: true },
});
const PANEL_2_8_0 = capabilities({
  version: '2.8.0',
  major: 2,
  minor: 8,
  patch: 0,
  supported: true,
  reachable: true,
  liveIpControl: true,
  bandwidthNodesUsers: true,
  connectionsApi: 'ip-control',
  userAddressing: 'uuid',
  userLookups: { byTelegramId: true, byEmail: true },
});
const PANEL_3_2_1 = capabilities({
  version: '3.2.1',
  major: 3,
  minor: 2,
  patch: 1,
  supported: true,
  reachable: true,
  // True since the adapter learned `/api/connections/*`. It was false while the
  // reader did not exist — a 3.x panel then had live-connection data rezeis
  // could not fetch — and the two had to change together, or the detector would
  // have walked every node for guaranteed 404s and called the panel clean.
  liveIpControl: true,
  bandwidthNodesUsers: true,
  connectionsApi: 'connections',
  userAddressing: 'id',
});
/** Every version-detection failure collapses into this one shape. */
const PANEL_UNREACHABLE = capabilities({});

/**
 * A version service that answers with `caps`, or walks a sequence of capability
 * records one per call and then sticks on the last — which is how a panel that
 * is upgraded (or goes unreachable) between two detector runs is expressed.
 *
 * The cursor is per-service, in a closure: a shared counter would make two
 * detectors built in the same test consume each other's answers.
 */
function versionService(
  caps: RemnawaveCapabilities | readonly RemnawaveCapabilities[],
): RemnawaveVersionService {
  const queue: readonly RemnawaveCapabilities[] = Array.isArray(caps)
    ? caps
    : [caps as RemnawaveCapabilities];
  let cursor = 0;
  return {
    getCapabilities: () =>
      Promise.resolve(queue[Math.min(cursor++, queue.length - 1)]),
  } as unknown as RemnawaveVersionService;
}

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

function makeSharingHarness(input: {
  readonly caps: RemnawaveCapabilities | readonly RemnawaveCapabilities[];
  readonly panelUsers?: readonly PanelUser[];
  readonly hwidTopUsers?: readonly {
    userUuid: string;
    username: string;
    telegramId: string | null;
    devicesCount: number;
    lastSeenAt: string | null;
  }[];
  readonly nodes?: readonly { uuid: string; name: string }[];
  readonly usersIpsByNode?: Record<
    string,
    readonly { userId: string; ips: readonly { ip: string; lastSeen: string }[] }[]
  >;
}): SharingHarness {
  const panelCalls: string[] = [];
  const panelUsers = input.panelUsers ?? [];

  const prisma = {
    subscription: { findMany: () => Promise.resolve([]) },
    remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const api = {
    getHwidTopUsers: () => {
      panelCalls.push('getHwidTopUsers');
      return Promise.resolve([...(input.hwidTopUsers ?? [])]);
    },
    strictGetAllPanelUsers: () => {
      panelCalls.push('strictGetAllPanelUsers');
      return Promise.resolve(strictOk({ users: [...panelUsers], total: panelUsers.length }));
    },
    getAllNodes: () => {
      panelCalls.push('getAllNodes');
      return Promise.resolve(
        (input.nodes ?? []).map((n) => ({
          ...n,
          countryCode: 'DE',
          isConnected: true,
          isDisabled: false,
          lastStatusChange: LONG_AGO,
        })),
      );
    },
    fetchUsersIpsForNode: (nodeUuid: string) => {
      panelCalls.push(`fetchUsersIpsForNode:${nodeUuid}`);
      return Promise.resolve([...(input.usersIpsByNode?.[nodeUuid] ?? [])]);
    },
  } as unknown as RemnawaveApiService;

  return {
    detectors: new SharingDetectors(
      prisma,
      api,
      versionService(input.caps as never),
      tunablesFromEnv(),
    ),
    panelCalls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. HWID overage: an empty device list on a populated panel
// ─────────────────────────────────────────────────────────────────────────────

describe('detectHwidOverage — an unreadable device list is not a clean panel', () => {
  let captured: Captured;
  beforeEach(() => {
    captured = captureLogs();
  });
  afterEach(() => captured.restore());

  it('says so, once, when a populated panel reports nobody with a device', async () => {
    const { detectors } = makeSharingHarness({
      caps: PANEL_3_2_1,
      // The strict read vouched for three users; the HWID endpoint claims not
      // one of them has ever registered a device. On 3.x that is the `/api/hwid`
      // family having moved, and the adapter turning the 404 into `[]`.
      panelUsers: [
        { uuid: 'u1', panelId: 1, hwidDeviceLimit: 3 },
        { uuid: 'u2', panelId: 2, hwidDeviceLimit: 3 },
        { uuid: 'u3', panelId: 3, hwidDeviceLimit: 3 },
      ],
      hwidTopUsers: [],
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
    assert.match(blind[0], /3 user\(s\)/);
    assert.match(blind[0], /panel version 3\.2\.1/);
    assert.match(blind[0], /zero offenders/);
  });

  it('stays silent about a panel that genuinely holds no users', async () => {
    // The counterpart. No users means no devices, consistently — this is the
    // one empty answer that IS information, and warning about it would train an
    // operator to ignore the warning that matters.
    const { detectors } = makeSharingHarness({
      caps: PANEL_2_8_0,
      panelUsers: [],
      hwidTopUsers: [],
    });

    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
    assert.deepEqual(blindWarns(captured, 'HWID overage'), []);
  });

  it('announces the recovery and re-arms for the next blindness', async () => {
    let devices: readonly {
      userUuid: string;
      username: string;
      telegramId: string | null;
      devicesCount: number;
      lastSeenAt: string | null;
    }[] = [];
    const panelUsers = [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 3 }];
    const api = {
      getHwidTopUsers: () => Promise.resolve([...devices]),
      strictGetAllPanelUsers: () =>
        Promise.resolve(strictOk({ users: panelUsers, total: panelUsers.length })),
    } as unknown as RemnawaveApiService;
    const detectors = new SharingDetectors(
      { subscription: { findMany: () => Promise.resolve([]) } } as unknown as PrismaService,
      api,
      versionService(PANEL_3_2_1),
      tunablesFromEnv(),
    );

    await detectors.detectHwidOverage(NOW); // blind
    devices = [
      { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
    ];
    const named = await detectors.detectHwidOverage(NOW); // sees again
    devices = [];
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
// 2. Panel-wide HWID average: `null` is "we could not look"
// ─────────────────────────────────────────────────────────────────────────────

describe('collectHwidAverageAlerts — a failed stats read is not a healthy average', () => {
  let captured: Captured;
  beforeEach(() => {
    captured = captureLogs();
  });
  afterEach(() => captured.restore());

  function makeCollector(read: () => unknown): RemnawaveDetectors {
    return new RemnawaveDetectors(
      {} as unknown as PrismaService,
      { getHwidStats: () => Promise.resolve(read()) } as unknown as RemnawaveApiService,
      {} as unknown as RemnawaveVersionService,
      tunablesFromEnv(),
    );
  }

  it('says so, once, when every HWID stats path has failed', async () => {
    const collector = makeCollector(() => null);

    assert.deepEqual(await collector.collectHwidAverageAlerts(NOW), []);
    assert.deepEqual(await collector.collectHwidAverageAlerts(NOW), []);
    assert.deepEqual(await collector.collectHwidAverageAlerts(NOW), []);

    const blind = blindWarns(captured, 'HWID average');
    assert.equal(
      blind.length,
      1,
      `a broken endpoint stays broken; one WARN per episode, not per run; saw ${JSON.stringify(captured.warns)}`,
    );
    assert.match(blind[0], /hwid/);
  });

  it('recovers loudly, and a blind run does not re-arm the band it never left', async () => {
    // The counterpart, and the reason the blind branch must not reset
    // `lastHwidBand`: an average that was already reported at band 3 and then
    // became unobservable must not re-announce band 3 when it comes back.
    let stats: unknown = {
      stats: { averageHwidDevicesPerUser: 3.4, totalHwidDevices: 900, totalUniqueDevices: 800 },
      byPlatform: {},
    };
    const collector = makeCollector(() => stats);

    const first = await collector.collectHwidAverageAlerts(NOW);
    stats = null;
    const blindRun = await collector.collectHwidAverageAlerts(NOW);
    stats = {
      stats: { averageHwidDevicesPerUser: 3.4, totalHwidDevices: 900, totalUniqueDevices: 800 },
      byPlatform: {},
    };
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
// 3. Concurrent-IP: `liveIpControl` had one answer for three different states
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyLiveConnectionBlindness', () => {
  it('lets a 2.8 panel through', () => {
    assert.equal(classifyLiveConnectionBlindness(PANEL_2_8_0), null);
  });

  it('lets a 3.x panel through — the adapter reads its connections family', () => {
    // This assertion used to be the opposite, and pinning it that way was right
    // at the time: the reader did not exist, so a 3.x panel was blind and had to
    // SAY which of the three blindnesses it was. Now that `fetchUsersIpsForNode`
    // / `fetchUserIps` / `dropConnections` branch on `connectionsApi`, "3.x is
    // blind" stopped being true, and a test still guarding it would be guarding
    // the wrong fact while staying green.
    assert.equal(classifyLiveConnectionBlindness(PANEL_3_2_1), null);
  });

  it('separates an immature 2.x panel from an unknown one', () => {
    const older = classifyLiveConnectionBlindness(PANEL_2_7_4);
    const unknown = classifyLiveConnectionBlindness(PANEL_UNREACHABLE);
    assert.equal(older?.reason, 'immature_ip_control');
    assert.equal(unknown?.reason, 'panel_shape_unknown');
    // Different operator actions: upgrade the panel vs fix the connection.
    assert.notEqual(older?.message, unknown?.message);
  });
});

describe('detectConcurrentIpSharing — a blind run is not a quiet panel', () => {
  let captured: Captured;
  let previousEnabled: string | undefined;

  beforeEach(() => {
    captured = captureLogs();
    // The IP detector is OFF by default; the capability gate under test sits
    // behind that switch, so it has to be on for any of this to be reached.
    previousEnabled = process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    process.env.ANTIFRAUD_SHARING_IP_ENABLED = 'true';
  });
  afterEach(() => {
    captured.restore();
    if (previousEnabled === undefined) delete process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    else process.env.ANTIFRAUD_SHARING_IP_ENABLED = previousEnabled;
  });

  it('warns once on a pre-2.8 panel, and does not touch the panel to find out', async () => {
    // The blind case used to be 3.x. It is 2.7.4 now: 3.x serves its live data
    // under `/api/connections/*` and the adapter reads it, while 2.7.4's
    // `ip-control` exists but is not trustworthy enough to accuse anybody with.
    const { detectors, panelCalls } = makeSharingHarness({ caps: PANEL_2_7_4 });

    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);

    const blind = blindWarns(captured, 'Concurrent-IP');
    assert.equal(blind.length, 1, `saw ${JSON.stringify(captured.warns)}`);
    assert.match(blind[0], /did not mature/);
    assert.match(blind[0], /not the same fact as a panel/);
    // Walking the node list for data we have already decided not to trust would
    // be load with no information at the end of it.
    assert.deepEqual(panelCalls, [], 'a detector that knows it cannot read must not read');
  });

  it('reads a 3.x panel instead of standing down', async () => {
    // The counterpart to the test above, and the reason it had to change: a 3.x
    // panel is no longer a blindness at all. Without this, "3.x works" would be
    // asserted only by the absence of a warning.
    const recent = NOW.toISOString();
    const { detectors } = makeSharingHarness({
      caps: PANEL_3_2_1,
      panelUsers: [{ uuid: '10', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: [{ uuid: 'n1', name: 'N1' }],
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            ips: [
              { ip: '1.1.1.1', lastSeen: recent },
              { ip: '2.2.2.2', lastSeen: recent },
              { ip: '3.3.3.3', lastSeen: recent },
            ],
          },
        ],
      },
    });

    const found = await detectors.detectConcurrentIpSharing(NOW);

    assert.equal(found.length, 1, 'a 3.x panel must produce detections, not silence');
    assert.deepEqual(blindWarns(captured, 'Concurrent-IP'), []);
  });

  it('re-announces when the panel moves to a different kind of blindness', async () => {
    const { detectors } = makeSharingHarness({
      caps: [PANEL_2_7_4, PANEL_2_7_4, PANEL_UNREACHABLE],
    });

    await detectors.detectConcurrentIpSharing(NOW);
    await detectors.detectConcurrentIpSharing(NOW);
    await detectors.detectConcurrentIpSharing(NOW);

    const blind = blindWarns(captured, 'Concurrent-IP');
    assert.equal(blind.length, 2, 'a panel we cannot reach is a different fact from an old one');
    assert.match(blind[0], /did not mature/);
    assert.match(blind[1], /could not read/);
  });

  it('recovers loudly on a panel it can read, and still names the offender', async () => {
    const recent = NOW.toISOString();
    const { detectors } = makeSharingHarness({
      caps: [PANEL_2_7_4, PANEL_2_8_0],
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: [{ uuid: 'n1', name: 'N1' }],
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            ips: [
              { ip: '1.1.1.1', lastSeen: recent },
              { ip: '2.2.2.2', lastSeen: recent },
              { ip: '3.3.3.3', lastSeen: recent },
            ],
          },
        ],
      },
    });

    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
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
   * `AntiFraudService` over the REAL `SharingDetectors`, so the blind path this
   * change added is the thing driving the run rather than a stub of it.
   */
  function build(caps: RemnawaveCapabilities, offenderIps: boolean) {
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
    const recent = new Date().toISOString();
    const panelUsers = [{ uuid: 'offender', panelId: 10, hwidDeviceLimit: 1 }];
    const api = {
      // A device row for a user who is not over their limit: the HWID detector
      // has looked, found nothing, and — crucially for this suite — is NOT
      // blind, so the only blindness in the run is the one under test.
      getHwidTopUsers: () =>
        Promise.resolve([
          {
            userUuid: 'offender',
            username: 'offender',
            telegramId: null,
            devicesCount: 1,
            lastSeenAt: null,
          },
        ]),
      strictGetAllPanelUsers: () =>
        Promise.resolve(strictOk({ users: panelUsers, total: panelUsers.length })),
      getAllNodes: () =>
        Promise.resolve([
          {
            uuid: 'n1',
            name: 'N1',
            countryCode: 'DE',
            isConnected: true,
            isDisabled: false,
            lastStatusChange: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ]),
      fetchUsersIpsForNode: () =>
        Promise.resolve(
          offenderIps
            ? [
                {
                  userId: '10',
                  ips: [
                    { ip: '1.1.1.1', lastSeen: recent },
                    { ip: '2.2.2.2', lastSeen: recent },
                    { ip: '3.3.3.3', lastSeen: recent },
                  ],
                },
              ]
            : [],
        ),
    } as unknown as RemnawaveApiService;

    const prisma = {
      ...(store.prisma as unknown as Record<string, unknown>),
      subscription: { findMany: () => Promise.resolve([]) },
      remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
    } as unknown as PrismaService;

    const sharing = new SharingDetectors(prisma, api, versionService(caps), tunablesFromEnv());
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
      {} as unknown as RemnawaveApiService,
      {
        info: () => undefined,
        warn: () => undefined,
        emit: () => undefined,
      } as unknown as SystemEventsService,
    );
    return { service, store };
  }

  it('leaves an open sharing signal alone when the panel could not be read', async () => {
    // 2.7.4, not 3.2.1: a 3.x panel is readable now, so it no longer stands in
    // for "could not look".
    const { service, store } = build(PANEL_2_7_4, false);

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
    const { service, store } = build(PANEL_2_8_0, true);

    await service.runDetectors();

    const stale = store.rows.find((r) => r.fingerprint === `${TODAY}|someone-else`);
    assert.equal(stale?.status, FraudSignalStatus.RESOLVED);
    assert.equal(stale?.resolutionNote, AUTO_RESOLVED_NOTE);
    assert.deepEqual(blindWarns(captured, 'Concurrent-IP'), []);
  });
});
