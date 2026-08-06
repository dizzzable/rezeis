import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { AntiFraudTunablesUnavailableError } from '../src/modules/anti-fraud/services/anti-fraud-tunables.service';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { RemnawaveVersionService } from '../src/modules/remnawave/services/remnawave-version.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import type { StoredAntiFraudSettings } from '../src/modules/settings/utils/anti-fraud-settings.util';
import { tunablesFromEnv, tunablesThatFail } from './fixtures/anti-fraud-tunables';

/**
 * The end of the wire: a value an operator saved in the panel has to change what
 * the detectors DO, in the same process, without a restart — and an unreadable
 * settings row has to stop them rather than quietly retune them.
 *
 * Every case here sets `process.env` to the OPPOSITE of the stored value, so a
 * passing assertion can only mean the stored value was the one consulted.
 */

const NOW = new Date('2026-06-18T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

// ── Sharing detectors ─────────────────────────────────────────────────────

function sharingDetectors(stored: StoredAntiFraudSettings, scanned: string[] = []) {
  const prisma = {
    subscription: { findMany: () => Promise.resolve([]) },
    remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const api = {
    getHwidTopUsers: () =>
      Promise.resolve([
        { userUuid: 'uuid-1', username: 'sharer', telegramId: null, devicesCount: 9, lastSeenAt: null },
      ]),
    strictGetAllPanelUsers: () =>
      Promise.resolve(
        strictOk({ users: [{ uuid: 'uuid-1', panelId: 1, hwidDeviceLimit: 2 }], total: 1 }),
      ),
    getAllNodes: () =>
      Promise.resolve(
        ['n1', 'n2', 'n3'].map((uuid) => ({
          uuid,
          name: uuid,
          countryCode: 'DE',
          isConnected: true,
          isDisabled: false,
          lastStatusChange: LONG_AGO,
        })),
      ),
    fetchUsersIpsForNode: (nodeUuid: string) => {
      scanned.push(nodeUuid);
      return Promise.resolve([]);
    },
  } as unknown as RemnawaveApiService;

  const version = {
    getCapabilities: () => Promise.resolve({ liveIpControl: true, bandwidthNodesUsers: true }),
  } as unknown as RemnawaveVersionService;

  return new SharingDetectors(prisma, api, version, tunablesFromEnv(stored));
}

describe('the sharing detectors run on the panel value, not the environment', () => {
  const touched = [
    'ANTIFRAUD_SHARING_HWID_ENABLED',
    'ANTIFRAUD_SHARING_IP_ENABLED',
    'ANTIFRAUD_SHARING_MAX_NODES_PER_RUN',
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  });
  afterEach(() => {
    for (const key of touched) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('a stored OFF switch silences a detector the environment switched on', async () => {
    process.env.ANTIFRAUD_SHARING_HWID_ENABLED = 'true';
    assert.equal(
      (await sharingDetectors({}).detectHwidOverage(NOW)).length,
      1,
      'precondition: the env-only config names this sharer',
    );
    assert.deepEqual(
      await sharingDetectors({ sharing: { enableHwidOverage: false } }).detectHwidOverage(NOW),
      [],
      'the panel switch has to win over the env variable',
    );
  });

  it('a stored ON switch enables a detector the environment left off', async () => {
    delete process.env.ANTIFRAUD_SHARING_IP_ENABLED; // default is OFF
    const scanned: string[] = [];
    await sharingDetectors({}, scanned).detectConcurrentIpSharing(NOW);
    assert.deepEqual(scanned, [], 'precondition: off by default, so no node is probed');

    const enabled: string[] = [];
    await sharingDetectors({ sharing: { enableIpSharing: true } }, enabled)
      .detectConcurrentIpSharing(NOW);
    assert.ok(enabled.length > 0, 'the stored switch turned the detector on');
  });

  it('a stored node cap bounds the run below the environment cap', async () => {
    process.env.ANTIFRAUD_SHARING_IP_ENABLED = 'true';
    process.env.ANTIFRAUD_SHARING_MAX_NODES_PER_RUN = '3';

    const envScanned: string[] = [];
    await sharingDetectors({}, envScanned).detectConcurrentIpSharing(NOW);
    assert.equal(envScanned.length, 3, 'precondition: the env cap allows all three nodes');

    const panelScanned: string[] = [];
    await sharingDetectors({ sharing: { maxNodesPerRun: 1 } }, panelScanned)
      .detectConcurrentIpSharing(NOW);
    assert.equal(panelScanned.length, 1, 'the panel cap is the one that bound the run');
  });

  it('refuses to run at all when the tunables cannot be read', async () => {
    process.env.ANTIFRAUD_SHARING_HWID_ENABLED = 'true';
    const prisma = {
      subscription: { findMany: () => Promise.resolve([]) },
    } as unknown as PrismaService;
    const api = {
      getHwidTopUsers: () => Promise.resolve([]),
    } as unknown as RemnawaveApiService;
    const detectors = new SharingDetectors(
      prisma,
      api,
      {} as unknown as RemnawaveVersionService,
      tunablesThatFail(),
    );

    // Rejecting (rather than returning []) is what puts the detector in the
    // `Promise.allSettled` rejected branch of `AntiFraudService.runDetectors`,
    // which keeps its codes out of the reconcile set — so an unreadable settings
    // row cannot auto-resolve a live signal either.
    await assert.rejects(
      () => detectors.detectHwidOverage(NOW),
      AntiFraudTunablesUnavailableError,
    );
    await assert.rejects(
      () => detectors.detectConcurrentIpSharing(NOW),
      AntiFraudTunablesUnavailableError,
    );
  });
});

// ── Traffic-abuse detector ────────────────────────────────────────────────

/** Nine users: one heavy account and an ordinary tail, so both tests are live. */
const COHORT = [
  { username: 'heavy', total: 900 * 1024 ** 3 },
  ...Array.from({ length: 8 }, (_, i) => ({
    username: `ordinary-${i}`,
    total: 20 * 1024 ** 3,
  })),
];

function trafficDetectors(stored: StoredAntiFraudSettings, probed: string[][] = []) {
  const prisma = {
    remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const api = {
    getAllNodes: () =>
      Promise.resolve(
        ['a1', 'b2', 'c3'].map((uuid) => ({
          uuid,
          name: uuid,
          countryCode: 'DE',
          isConnected: true,
          isDisabled: false,
          lastStatusChange: LONG_AGO,
          usersOnline: 10,
          trafficLimitBytes: null,
          trafficUsedBytes: null,
        })),
      ),
    getNodeUsersBandwidth: (uuids: readonly string[]) => {
      probed.push([...uuids]);
      return Promise.resolve(COHORT);
    },
  } as unknown as RemnawaveApiService;

  const version = {
    getCapabilities: () => Promise.resolve({ bandwidthNodesUsers: true }),
  } as unknown as RemnawaveVersionService;

  return new RemnawaveDetectors(prisma, api, version, tunablesFromEnv(stored));
}

describe('the traffic-abuse detector runs on the panel value, not the environment', () => {
  const touched = [
    'ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED',
    'ANTIFRAUD_NODE_TRAFFIC_MIN_GB',
    'ANTIFRAUD_NODE_TRAFFIC_MAX_NODES',
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  });
  afterEach(() => {
    for (const key of touched) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('a stored GB floor above the offender clears the run the environment flagged', async () => {
    process.env.ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED = 'true';
    process.env.ANTIFRAUD_NODE_TRAFFIC_MIN_GB = '200';

    const flagged = await trafficDetectors({}).detectPerUserNodeTrafficAbuse(NOW);
    assert.equal(flagged.length, 1, 'precondition: 900 GB is over the 200 GB env floor');
    assert.equal(flagged[0].code, 'NODE_TRAFFIC_USER_ABUSE');

    const raised = await trafficDetectors({
      trafficAbuse: { minGb: 5000 },
    }).detectPerUserNodeTrafficAbuse(NOW);
    assert.deepEqual(raised, [], 'the panel floor is the one that decided');
  });

  it('a stored OFF switch silences the detector the environment switched on', async () => {
    process.env.ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED = 'true';
    assert.deepEqual(
      await trafficDetectors({ trafficAbuse: { enabled: false } }).detectPerUserNodeTrafficAbuse(NOW),
      [],
    );
  });

  it('a stored node cap bounds the panel call below the environment cap', async () => {
    process.env.ANTIFRAUD_NODE_TRAFFIC_MAX_NODES = '3';
    const envProbed: string[][] = [];
    await trafficDetectors({}, envProbed).detectPerUserNodeTrafficAbuse(NOW);
    assert.deepEqual(envProbed, [['a1', 'b2', 'c3']], 'precondition: env allows all three');

    const panelProbed: string[][] = [];
    await trafficDetectors({ trafficAbuse: { maxNodesPerRun: 1 } }, panelProbed)
      .detectPerUserNodeTrafficAbuse(NOW);
    assert.deepEqual(panelProbed, [['a1']], 'the panel cap bound the panel call');
  });

  it('refuses to run at all when the tunables cannot be read', async () => {
    process.env.ANTIFRAUD_NODE_TRAFFIC_USER_ENABLED = 'true';
    const detectors = new RemnawaveDetectors(
      {} as unknown as PrismaService,
      { getAllNodes: () => Promise.resolve([]) } as unknown as RemnawaveApiService,
      {} as unknown as RemnawaveVersionService,
      tunablesThatFail(),
    );
    await assert.rejects(
      () => detectors.detectPerUserNodeTrafficAbuse(NOW),
      AntiFraudTunablesUnavailableError,
    );
  });

  it('a failed read never resolves to the range floor', async () => {
    // The floor for `minGb` is 1 GB — at that setting every ordinary 20 GB user
    // in the cohort is a candidate. If a read failure ever degraded to floors,
    // this run would produce offenders instead of rejecting.
    const detectors = new RemnawaveDetectors(
      { remnawaveMetricSample: { findMany: () => Promise.resolve([]) } } as unknown as PrismaService,
      {
        getAllNodes: () => Promise.resolve([]),
        getNodeUsersBandwidth: () => Promise.resolve(COHORT),
      } as unknown as RemnawaveApiService,
      { getCapabilities: () => Promise.resolve({ bandwidthNodesUsers: true }) } as unknown as
        RemnawaveVersionService,
      tunablesThatFail(),
    );
    await assert.rejects(
      () => detectors.detectPerUserNodeTrafficAbuse(NOW),
      (error: unknown) => {
        assert.ok(error instanceof AntiFraudTunablesUnavailableError);
        assert.match((error as Error).message, /skipped rather than guessed at/);
        return true;
      },
    );
  });
});
