import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';

import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  strictOk,
  strictUnavailable,
  type RemnawaveStrictOutcome,
} from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import type { PanelDevicesOutcome, PanelHwidDeviceInventory } from '../src/modules/remnawave/services/panel-devices.client';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';
import {
  hwidDeviceInventory,
  panelDevicesDouble,
  panelInfraDouble,
  panelNetworkFailure,
  panelOk,
} from './fixtures/anti-fraud-panel-clients';
import { subscriptionFindManyDouble } from './fixtures/subscription-where';
import type { StoredAntiFraudSettings } from '../src/modules/settings/utils/anti-fraud-settings.util';

/**
 * One device, several customers
 * ═════════════════════════════
 *
 * `detectHwidOverage` asks whether ONE user holds more devices than THAT user's
 * plan allows. It is a per-account question and it cannot see across accounts at
 * all: two people on one machine, each holding one device against a limit of
 * three, are two clean rows to it and always were. The other seven detectors in
 * the module group by user, transaction or referral, so none of them could see it
 * either — before this detector, one machine registered under three paying
 * identities produced no signal anywhere in the system.
 *
 * These tests are mostly about the ways it must NOT fire, because the failure
 * that matters here is not a missed sharer. It is naming a customer for holding
 * two subscriptions, or naming the entire customer base because one client build
 * sends a constant identifier.
 */

const NOW = new Date('2026-08-28T12:00:00.000Z');
const TODAY = '2026-08-28';

interface PanelUser {
  readonly uuid: string;
  readonly panelId: number | null;
  readonly hwidDeviceLimit?: number;
}

interface SubRow {
  readonly remnawaveId: string;
  readonly remnawavePanelId?: number | null;
  readonly userId: string;
}

interface DeviceRow {
  readonly hwid: string;
  readonly userId: number;
  readonly platform?: string | null;
  readonly deviceModel?: string | null;
}

interface Setup {
  readonly devices?: readonly DeviceRow[];
  /** Overrides `devices` when the READ itself is what a test is about. */
  readonly inventory?: PanelDevicesOutcome<PanelHwidDeviceInventory>;
  readonly panelUsers?: readonly PanelUser[];
  /** Overrides `panelUsers` to simulate a bulk read the adapter refused. */
  readonly panelBulkOutcome?: RemnawaveStrictOutcome<unknown>;
  readonly subscriptions?: readonly SubRow[];
  /** Stored panel tunables, laid over the environment the way production does. */
  readonly stored?: StoredAntiFraudSettings;
  readonly incompleteWalk?: boolean;
}

interface Harness {
  readonly detectors: SharingDetectors;
  /** Every call made on the devices client, in order. */
  readonly panelCalls: readonly string[];
}

function harness(setup: Setup = {}): Harness {
  const subscriptions = subscriptionFindManyDouble([...(setup.subscriptions ?? [])]);
  const prisma = {
    subscription: { findMany: subscriptions.findMany },
    remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const panelUsers = (setup.panelUsers ?? []).map((user) => ({
    uuid: user.uuid,
    panelId: user.panelId,
    hwidDeviceLimit: user.hwidDeviceLimit ?? 5,
  }));
  const remnawave = {
    strictGetAllPanelUsers: () =>
      Promise.resolve(
        setup.panelBulkOutcome ?? strictOk({ users: panelUsers, total: panelUsers.length }),
      ),
  } as unknown as RemnawaveApiService;

  const rows = [...(setup.devices ?? [])];
  const devices = panelDevicesDouble({
    allDevices:
      setup.inventory ??
      panelOk(
        hwidDeviceInventory(
          rows,
          setup.incompleteWalk === true ? { total: rows.length + 400, complete: false } : {},
        ),
      ),
  });

  return {
    detectors: new SharingDetectors(
      prisma,
      remnawave,
      devices.client,
      panelInfraDouble().client,
      tunablesFromEnv(setup.stored ?? {}),
    ),
    panelCalls: devices.calls,
  };
}

/**
 * Captures `Logger` output.
 *
 * Every branch that declines to file a group logs why, and that is part of the
 * contract rather than decoration: a suppressed accusation which logs nothing is
 * indistinguishable from a clean panel, and an operator asking "why is this
 * obvious duplicate not listed?" has to be able to find the answer.
 */
function captureLogs(): {
  readonly warns: string[];
  readonly logs: string[];
  readonly errors: string[];
  restore(): void;
} {
  const warns: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const originalWarn = Logger.prototype.warn;
  const originalLog = Logger.prototype.log;
  const originalError = Logger.prototype.error;
  Logger.prototype.warn = function patched(message: unknown): void {
    warns.push(String(message));
  } as typeof Logger.prototype.warn;
  Logger.prototype.log = function patched(message: unknown): void {
    logs.push(String(message));
  } as typeof Logger.prototype.log;
  Logger.prototype.error = function patched(message: unknown): void {
    errors.push(String(message));
  } as typeof Logger.prototype.error;
  return {
    warns,
    logs,
    errors,
    restore(): void {
      Logger.prototype.warn = originalWarn;
      Logger.prototype.log = originalLog;
      Logger.prototype.error = originalError;
    },
  };
}

/** Two customers, one panel profile each, both holding device `dev-a`. */
function twoCustomersOneDevice(over: Partial<Setup> = {}): Setup {
  return {
    devices: [
      { hwid: 'dev-a', userId: 1, platform: 'ios', deviceModel: 'iPhone15,2' },
      { hwid: 'dev-a', userId: 2, platform: 'ios', deviceModel: 'iPhone15,2' },
    ],
    panelUsers: [
      { uuid: '1', panelId: 1 },
      { uuid: '2', panelId: 2 },
    ],
    subscriptions: [
      { remnawaveId: '1', remnawavePanelId: 1, userId: 'user-1' },
      { remnawaveId: '2', remnawavePanelId: 2, userId: 'user-2' },
    ],
    ...over,
  };
}

describe('one device under two customers is named', () => {
  it('files one signal for the device, naming both owners', async () => {
    const candidates = await harness(twoCustomersOneDevice()).detectors.detectSharedHwidAcrossAccounts(
      NOW,
    );

    assert.equal(candidates.length, 1);
    const [signal] = candidates;
    assert.equal(signal.code, 'SHARED_DEVICE_MULTI_ACCOUNT');
    assert.equal(signal.severity, FraudSignalSeverity.MEDIUM);
    // The finding is a RELATION, so both sides are on it. Naming one of them
    // would be picking an offender the evidence does not identify.
    assert.deepStrictEqual(signal.affectedUserIds, ['user-1', 'user-2']);
    const metadata = signal.metadata as { kind: string; hwid: string; accountCount: number };
    assert.equal(metadata.kind, 'shared_hwid');
    assert.equal(metadata.hwid, 'dev-a');
    assert.equal(metadata.accountCount, 2);
  });

  it('keys the fingerprint on the device and the day, not on either customer', async () => {
    // One device is one condition however many accounts it lands on: a
    // fingerprint carrying a user would file the same finding twice and let one
    // of the two be resolved while its other half stayed open.
    const candidates = await harness(twoCustomersOneDevice()).detectors.detectSharedHwidAcrossAccounts(
      NOW,
    );
    assert.equal(candidates[0].fingerprint, `${TODAY}|dev-a`);
  });

  it('escalates to HIGH at three customers', async () => {
    const candidates = await harness({
      devices: [
        { hwid: 'dev-a', userId: 1 },
        { hwid: 'dev-a', userId: 2 },
        { hwid: 'dev-a', userId: 3 },
      ],
      panelUsers: [
        { uuid: '1', panelId: 1 },
        { uuid: '2', panelId: 2 },
        { uuid: '3', panelId: 3 },
      ],
      subscriptions: [
        { remnawaveId: '1', remnawavePanelId: 1, userId: 'user-1' },
        { remnawaveId: '2', remnawavePanelId: 2, userId: 'user-2' },
        { remnawaveId: '3', remnawavePanelId: 3, userId: 'user-3' },
      ],
    }).detectors.detectSharedHwidAcrossAccounts(NOW);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].severity, FraudSignalSeverity.HIGH);
    assert.equal(candidates[0].score, 65);
  });
});

describe('the ordinary states it must never name', () => {
  it('says nothing about a device held by one profile', async () => {
    const candidates = await harness({
      devices: [
        { hwid: 'dev-a', userId: 1 },
        { hwid: 'dev-b', userId: 1 },
        { hwid: 'dev-c', userId: 2 },
      ],
      panelUsers: [
        { uuid: '1', panelId: 1 },
        { uuid: '2', panelId: 2 },
      ],
      subscriptions: [
        { remnawaveId: '1', remnawavePanelId: 1, userId: 'user-1' },
        { remnawaveId: '2', remnawavePanelId: 2, userId: 'user-2' },
      ],
    }).detectors.detectSharedHwidAcrossAccounts(NOW);

    assert.deepStrictEqual(candidates, []);
  });

  it('does not name one customer whose two subscriptions share their own laptop', async () => {
    // THE test. This is the single largest false positive available here: two
    // panel profiles, legitimately, and one machine legitimately on both. It is
    // two profiles and ONE customer, and the detector counts customers.
    const capture = captureLogs();
    try {
      const candidates = await harness({
        devices: [
          { hwid: 'dev-a', userId: 1 },
          { hwid: 'dev-a', userId: 2 },
        ],
        panelUsers: [
          { uuid: '1', panelId: 1 },
          { uuid: '2', panelId: 2 },
        ],
        subscriptions: [
          { remnawaveId: '1', remnawavePanelId: 1, userId: 'user-1' },
          { remnawaveId: '2', remnawavePanelId: 2, userId: 'user-1' },
        ],
      }).detectors.detectSharedHwidAcrossAccounts(NOW);

      assert.deepStrictEqual(candidates, []);
      // Counted and announced, not silently dropped.
      assert.ok(
        capture.logs.some((line) => line.includes('single customer holding more than one')),
        `expected the collapse to be logged, got ${JSON.stringify(capture.logs)}`,
      );
    } finally {
      capture.restore();
    }
  });

  it('honours a raised floor, so a deployment that considers pairs ordinary hears nothing', async () => {
    const candidates = await harness(
      twoCustomersOneDevice({ stored: { sharing: { sharedHwidMinAccounts: 3 } } }),
    ).detectors.detectSharedHwidAcrossAccounts(NOW);

    assert.deepStrictEqual(candidates, []);
  });

  it('is silent, and never touches the panel, when it is switched off', async () => {
    const built = harness(twoCustomersOneDevice({ stored: { sharing: { enableSharedHwid: false } } }));
    assert.deepStrictEqual(await built.detectors.detectSharedHwidAcrossAccounts(NOW), []);
    // A detector an operator switched off must not keep paging the panel's
    // whole device inventory every five minutes.
    assert.deepStrictEqual([...built.panelCalls], []);
  });
});

describe('a client that reports one identifier for every install', () => {
  it('names nobody above the account ceiling, and says which hwid it was', async () => {
    // The panel's hwid is a header the client chooses. A build sending a
    // constant string puts the whole customer base into one group, and filing
    // that would accuse everybody at once — a page of identical signals gets
    // dismissed wholesale and takes the genuine pairs beside it down too.
    const owners = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const capture = captureLogs();
    try {
      const candidates = await harness({
        devices: owners.map((userId) => ({ hwid: 'constant-hwid', userId })),
        panelUsers: owners.map((id) => ({ uuid: String(id), panelId: id })),
        subscriptions: owners.map((id) => ({
          remnawaveId: String(id),
          remnawavePanelId: id,
          userId: `user-${id}`,
        })),
      }).detectors.detectSharedHwidAcrossAccounts(NOW);

      assert.deepStrictEqual(candidates, []);
      assert.ok(
        capture.errors.some(
          (line) => line.includes('constant-hwid') && line.includes('client build'),
        ),
        `expected the placeholder hwid to be reported, got ${JSON.stringify(capture.errors)}`,
      );
    } finally {
      capture.restore();
    }
  });

  it('still files the groups that sit below the ceiling in the same run', async () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const candidates = await harness({
      devices: [
        ...many.map((userId) => ({ hwid: 'constant-hwid', userId })),
        { hwid: 'dev-real', userId: 1 },
        { hwid: 'dev-real', userId: 2 },
      ],
      panelUsers: many.map((id) => ({ uuid: String(id), panelId: id })),
      subscriptions: many.map((id) => ({
        remnawaveId: String(id),
        remnawavePanelId: id,
        userId: `user-${id}`,
      })),
    }).detectors.detectSharedHwidAcrossAccounts(NOW);

    // The broken build suppresses ITS group, not the run.
    assert.equal(candidates.length, 1);
    assert.equal((candidates[0].metadata as { hwid: string }).hwid, 'dev-real');
  });

  it('raises a ceiling set below the floor instead of obeying it into silence', async () => {
    // A ceiling under the floor files nothing at all — the "detector that can
    // never fire" shape this module keeps rediscovering. It is raised, and the
    // operator is told.
    const capture = captureLogs();
    try {
      const candidates = await harness(
        twoCustomersOneDevice({
          stored: { sharing: { sharedHwidMinAccounts: 4, sharedHwidMaxAccounts: 2 } },
        }),
      ).detectors.detectSharedHwidAcrossAccounts(NOW);

      // Nothing is filed here because the FLOOR is 4 and this group is 2 —
      // which is the floor doing its job, not the clamp.
      assert.deepStrictEqual(candidates, []);
      assert.ok(
        capture.warns.some((line) => line.includes('below the floor')),
        `expected the clamp to be announced, got ${JSON.stringify(capture.warns)}`,
      );
    } finally {
      capture.restore();
    }
  });
});

describe('what the confidence is measured from', () => {
  it('reads agreement between the rows describing the device', async () => {
    const agreeing = await harness(twoCustomersOneDevice()).detectors.detectSharedHwidAcrossAccounts(
      NOW,
    );
    const disagreeing = await harness(
      twoCustomersOneDevice({
        devices: [
          { hwid: 'dev-a', userId: 1, platform: 'ios', deviceModel: 'iPhone15,2' },
          { hwid: 'dev-a', userId: 2, platform: 'android', deviceModel: 'Pixel 8' },
        ],
      }),
    ).detectors.detectSharedHwidAcrossAccounts(NOW);

    // One identifier reported by devices that are demonstrably not the same
    // device is the placeholder story arriving below the account ceiling, where
    // nothing else would catch it.
    assert.ok(
      disagreeing[0].confidence < agreeing[0].confidence,
      `${disagreeing[0].confidence} should be below ${agreeing[0].confidence}`,
    );
    assert.equal((agreeing[0].metadata as { descriptorAgreement: number }).descriptorAgreement, 1);
    assert.equal(
      (disagreeing[0].metadata as { descriptorAgreement: number }).descriptorAgreement,
      0.5,
    );
    assert.ok(disagreeing[0].description.includes('disagree about the platform'));
  });

  it('omits the agreement factor entirely when no row described itself', async () => {
    // An unmeasured factor scored as perfect agreement would raise an
    // accusation's confidence on evidence that was never collected.
    const candidates = await harness(
      twoCustomersOneDevice({
        devices: [
          { hwid: 'dev-a', userId: 1 },
          { hwid: 'dev-a', userId: 2 },
        ],
      }),
    ).detectors.detectSharedHwidAcrossAccounts(NOW);

    const metadata = candidates[0].metadata as {
      descriptorAgreement?: number;
      confidenceFactors: Record<string, unknown>;
    };
    assert.equal(metadata.descriptorAgreement, undefined);
    assert.deepStrictEqual(Object.keys(metadata.confidenceFactors), ['sharedAccountCount']);
  });

  it('lowers confidence when the inventory walk was a prefix of the fleet', async () => {
    const whole = await harness(twoCustomersOneDevice()).detectors.detectSharedHwidAcrossAccounts(
      NOW,
    );
    const partial = await harness(
      twoCustomersOneDevice({ incompleteWalk: true }),
    ).detectors.detectSharedHwidAcrossAccounts(NOW);

    assert.ok(
      partial[0].confidence < whole[0].confidence,
      `${partial[0].confidence} should be below ${whole[0].confidence}`,
    );
  });
});

describe('a read it could not make is never reported as a clean panel', () => {
  it('files nothing and warns once when the inventory is unreadable', async () => {
    const capture = captureLogs();
    try {
      const built = harness({ inventory: panelNetworkFailure('ECONNRESET') });
      assert.deepStrictEqual(await built.detectors.detectSharedHwidAcrossAccounts(NOW), []);
      assert.deepStrictEqual(await built.detectors.detectSharedHwidAcrossAccounts(NOW), []);
      assert.deepStrictEqual(await built.detectors.detectSharedHwidAcrossAccounts(NOW), []);

      // Latched: once per transition, never once per run. A line on every tick
      // is noise an operator filters out, and the filter would hide the failure
      // it exists to surface.
      const blind = capture.warns.filter((line) => line.includes('is BLIND'));
      assert.equal(blind.length, 1);
      assert.ok(blind[0].includes('not the same fact as a panel on which no device is shared'));
    } finally {
      capture.restore();
    }
  });

  it('skips the run when the panel user list cannot be vouched for', async () => {
    // A partial user map does not under-report, it MIS-attributes: a profile
    // whose row we lost is dropped from its group, which can take a genuine
    // pair down to one account and clear it — while the run looks healthy.
    const candidates = await harness(
      twoCustomersOneDevice({
        panelBulkOutcome: strictUnavailable(null),
      }),
    ).detectors.detectSharedHwidAcrossAccounts(NOW);

    assert.deepStrictEqual(candidates, []);
  });

  it('announces a truncated walk as incomplete rather than clean', async () => {
    const capture = captureLogs();
    try {
      await harness(twoCustomersOneDevice({ incompleteWalk: true })).detectors.detectSharedHwidAcrossAccounts(
        NOW,
      );
      assert.ok(
        capture.warns.some((line) => line.includes('INCOMPLETE for the rest of the fleet')),
        `expected the truncation to be announced, got ${JSON.stringify(capture.warns)}`,
      );
    } finally {
      capture.restore();
    }
  });
});

describe('rows it refuses to read', () => {
  it('refuses an hwid too long to be a device identifier, rather than truncating it', async () => {
    // It reaches a `FraudSignal.fingerprint` under a UNIQUE index, and
    // PostgreSQL's btree refuses a key past ~2700 bytes — so a hostile client's
    // registration would turn into a failing upsert on every run. Truncating
    // instead would collide two different devices into one signal.
    const huge = 'x'.repeat(300);
    const capture = captureLogs();
    try {
      const candidates = await harness(
        twoCustomersOneDevice({
          devices: [
            { hwid: huge, userId: 1 },
            { hwid: huge, userId: 2 },
          ],
        }),
      ).detectors.detectSharedHwidAcrossAccounts(NOW);

      assert.deepStrictEqual(candidates, []);
      assert.ok(
        capture.warns.some((line) => line.includes('no usable hwid/owner pair')),
        `expected the skipped rows to be reported, got ${JSON.stringify(capture.warns)}`,
      );
    } finally {
      capture.restore();
    }
  });

  it('drops a profile with no subscription row here, and says the pair went unreported', async () => {
    // Under-reporting is the safe direction — we cannot name a customer we have
    // no row for — but it must be visible, because a pair that loses one member
    // this way produces no signal at all.
    const capture = captureLogs();
    try {
      const candidates = await harness(
        twoCustomersOneDevice({
          subscriptions: [{ remnawaveId: '1', remnawavePanelId: 1, userId: 'user-1' }],
        }),
      ).detectors.detectSharedHwidAcrossAccounts(NOW);

      assert.deepStrictEqual(candidates, []);
      assert.ok(
        capture.logs.some((line) => line.includes('no subscription row here')),
        `expected the unattributed profile to be reported, got ${JSON.stringify(capture.logs)}`,
      );
    } finally {
      capture.restore();
    }
  });

  it('drops a profile the panel user list holds no row for, and says so', async () => {
    const capture = captureLogs();
    try {
      const candidates = await harness(
        twoCustomersOneDevice({ panelUsers: [{ uuid: '1', panelId: 1 }] }),
      ).detectors.detectSharedHwidAcrossAccounts(NOW);

      assert.deepStrictEqual(candidates, []);
      assert.ok(
        capture.warns.some((line) => line.includes('could not attribute')),
        `expected the unjoinable profile to be reported, got ${JSON.stringify(capture.warns)}`,
      );
    } finally {
      capture.restore();
    }
  });
});

describe('the query it puts to Postgres', () => {
  it('resolves every group in one round-trip, not one per device', async () => {
    const subscriptions = subscriptionFindManyDouble<SubRow>([
      { remnawaveId: '1', remnawavePanelId: 1, userId: 'user-1' },
      { remnawaveId: '2', remnawavePanelId: 2, userId: 'user-2' },
      { remnawaveId: '3', remnawavePanelId: 3, userId: 'user-3' },
      { remnawaveId: '4', remnawavePanelId: 4, userId: 'user-4' },
    ]);
    const prisma = {
      subscription: { findMany: subscriptions.findMany },
      remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
    } as unknown as PrismaService;
    const panelUsers = [1, 2, 3, 4].map((id) => ({
      uuid: String(id),
      panelId: id,
      hwidDeviceLimit: 5,
    }));
    const detectors = new SharingDetectors(
      prisma,
      {
        strictGetAllPanelUsers: () =>
          Promise.resolve(strictOk({ users: panelUsers, total: panelUsers.length })),
      } as unknown as RemnawaveApiService,
      panelDevicesDouble({
        allDevices: panelOk(
          hwidDeviceInventory([
            { hwid: 'dev-a', userId: 1 },
            { hwid: 'dev-a', userId: 2 },
            { hwid: 'dev-b', userId: 3 },
            { hwid: 'dev-b', userId: 4 },
          ]),
        ),
      }).client,
      panelInfraDouble().client,
      tunablesFromEnv(),
    );

    const candidates = await detectors.detectSharedHwidAcrossAccounts(NOW);

    assert.equal(candidates.length, 2);
    // A panel with a hundred shared devices must not cost a hundred queries.
    assert.equal(subscriptions.queries.length, 1);
  });
});
