import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { FraudSignalSeverity } from '@prisma/client';
import { of } from 'rxjs';

import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import {
  strictOk,
  type RemnawaveStrictOutcome,
} from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import { resolveSharingDetectionConfig } from '../src/modules/anti-fraud/sharing-detection.config';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';
import {
  hwidTopUsersPage,
  panelDevicesDouble,
  panelInfraDouble,
  panelNode,
  panelOk,
  type PanelDevicesDoubleInput,
} from './fixtures/anti-fraud-panel-clients';
import type {
  PanelNode,
  PanelReadOutcome,
} from '../src/modules/remnawave/services/panel-infra.client';
import {
  subscriptionFindManyDouble,
  type SubscriptionQuery,
} from './fixtures/subscription-where';

const NOW = new Date('2026-06-18T12:00:00.000Z');
/** Older than any stability window, so a node carrying it is quiet by default. */
const LONG_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

/** `secondsAgo` before {@link NOW}, as the ISO string the panel sends. */
function ago(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

interface NodeMock {
  uuid: string;
  name: string;
  countryCode: string | null;
  isConnected: boolean;
  isDisabled: boolean;
  lastStatusChange?: string | null;
}

interface SnapshotNode {
  uuid: string;
  name: string;
  isConnected: boolean;
}

interface RemnaMock {
  /**
   * Top-users rows, still declared by the panel UUID they belong to.
   *
   * A 3.x panel does NOT send a uuid on this row — it sends `{ id, username,
   * devicesCount }` and the numeric id is the only identity there is — so the
   * harness resolves `userUuid` to the `panelId` of the matching `panelUsers`
   * entry and hands the detector what the panel would really have sent. Writing
   * the tests in terms of the profile keeps them about behaviour; a uuid with
   * no matching panel user deliberately becomes an id nothing can be joined to,
   * which is how the "we saw a device-heavy row we cannot judge" path is
   * reached.
   */
  hwidTopUsers?: Array<{
    userUuid: string;
    username: string;
    telegramId?: string | null;
    devicesCount: number;
    lastSeenAt?: string | null;
  }>;
  /** Overrides `hwidTopUsers` when the read itself is what a test is about. */
  hwidTopUsersOutcome?: PanelDevicesDoubleInput['topUsers'];
  panelUsers?: Array<{ uuid: string; panelId: number | null; hwidDeviceLimit: number }>;
  /** Overrides `panelUsers` to simulate a bulk read the adapter refused. */
  panelBulkOutcome?: RemnawaveStrictOutcome<unknown>;
  nodes?: NodeMock[];
  /** Overrides `nodes` when the node READ itself is what a test is about. */
  nodesOutcome?: PanelReadOutcome<readonly PanelNode[]>;
  /** `RemnawaveMetricSample.nodesSnapshot` rows inside the stability window. */
  snapshots?: SnapshotNode[][];
  /**
   * Live connections per node uuid.
   *
   * A node listed in `nodes` but absent here was READ AND WAS QUIET (`[]`) —
   * the state most of these tests are about. An explicit `null` is the other
   * fact entirely: the node could not be read. The two must never be spelled
   * the same way, which is why a test that means the second has to say it.
   */
  usersIpsByNode?: Record<
    string,
    Array<{ userId: string | number; ips: Array<{ ip: string; lastSeen: string }> }> | null
  >;
}

interface Harness {
  readonly detectors: SharingDetectors;
  /** Node uuids passed to `fetchNodeConnections`, in call order. */
  readonly scannedNodeUuids: string[];
  /** Every `subscription.findMany`: the `where` sent and the rows it selected. */
  readonly subscriptionQueries: readonly SubscriptionQuery<SubRow>[];
}

/**
 * A `subscriptions` row as the detector selects it. `deviceLimitReducedAt`
 * absent === the column is NULL, i.e. the limit has never been reduced — which
 * is what the overwhelming majority of rows look like and what every test
 * written before the downgrade grace existed assumed.
 *
 * `deviceLimitBeforeReduction` absent === NULL too, which is a THIRD state and
 * not a synonym for "no reduction": a row stamped by the first version of the
 * trigger, which recorded the timestamp and not the limit it reduced from.
 */
interface SubRow {
  remnawaveId: string;
  /**
   * The SECOND angle on the same panel profile, and the one a 3.x panel names
   * users by. Absent === the column is NULL, which is what a row linked on 2.x
   * and never re-read looks like — and what most rows look like, which is why
   * a lookup that ever asks for `remnawavePanelId: null` matches the entire
   * table.
   */
  remnawavePanelId?: number | null;
  userId: string;
  deviceLimitReducedAt?: Date | null;
  deviceLimitBeforeReduction?: number | null;
}

function makeHarness(remna: RemnaMock, subs: SubRow[] = []): Harness {
  const scannedNodeUuids: string[] = [];
  // The `where` is HONOURED, not ignored — see `test/fixtures/subscription-where.ts`.
  const subscriptions = subscriptionFindManyDouble(subs);

  const prismaMock = {
    subscription: {
      findMany: subscriptions.findMany,
    },
    remnawaveMetricSample: {
      findMany: () =>
        Promise.resolve((remna.snapshots ?? []).map((nodesSnapshot) => ({ nodesSnapshot }))),
    },
  } as unknown as PrismaService;

  // The one call the detectors still make through the legacy adapter: the
  // whole-panel user walk that supplies every subscriber's device limit.
  const remnaMock = {
    strictGetAllPanelUsers: () =>
      Promise.resolve(
        remna.panelBulkOutcome ??
          strictOk({ users: remna.panelUsers ?? [], total: (remna.panelUsers ?? []).length }),
      ),
  } as unknown as RemnawaveApiService;

  const panelUsers = remna.panelUsers ?? [];
  const panelIdByUuid = new Map<string, number>();
  for (const user of panelUsers) {
    if (user.panelId !== null) panelIdByUuid.set(user.uuid, user.panelId);
  }
  /** An id no panel user carries, so a uuid nothing matches stays unjoinable. */
  let syntheticId = 900_000;

  const devices = panelDevicesDouble({
    topUsers:
      remna.hwidTopUsersOutcome ??
      panelOk(
        hwidTopUsersPage(
          (remna.hwidTopUsers ?? []).map((row) => ({
            id: panelIdByUuid.get(row.userUuid) ?? (syntheticId += 1),
            username: row.username,
            devicesCount: row.devicesCount,
          })),
        ),
      ),
    nodeConnections: Object.fromEntries([
      // Every listed node defaults to "read, and nobody was on it". Only an
      // explicit `null` below turns one into "could not be read".
      ...(remna.nodes ?? []).map((n) => [n.uuid, [] as unknown[]]),
      ...Object.entries(remna.usersIpsByNode ?? {}).map(([nodeUuid, rows]) => [
        nodeUuid,
        rows === null
          ? null
          : rows.map((row) => ({
              userId: row.userId,
              // The contract transforms `lastSeen` into a `Date`, so that is
              // what a validated response yields. A value the schema would have
              // REJECTED could only arrive on the drift path, where the raw
              // wire string comes through instead — so that is what an
              // unparseable literal is handed over as.
              ips: row.ips.map((sample) => ({
                ip: sample.ip,
                lastSeen: Number.isFinite(Date.parse(sample.lastSeen))
                  ? new Date(sample.lastSeen)
                  : sample.lastSeen,
              })),
            })),
      ]),
    ]) as never,
  });
  // The detector asks node by node, so recording the argument is how a test
  // proves which slice of the panel was actually scanned.
  const fetchNodeConnections = devices.client.fetchNodeConnections.bind(devices.client);
  (devices.client as { fetchNodeConnections: unknown }).fetchNodeConnections = (
    nodeUuid: string,
  ) => {
    scannedNodeUuids.push(nodeUuid);
    return fetchNodeConnections(nodeUuid);
  };

  const infra = panelInfraDouble({
    // Nodes default to "last changed three days ago" so a test that does not
    // care about stability gets a quiet panel rather than an accidental flap.
    nodes:
      remna.nodesOutcome ??
      panelOk(
        (remna.nodes ?? []).map((n) =>
          panelNode({
            uuid: n.uuid,
            name: n.name,
            countryCode: n.countryCode ?? '',
            isConnected: n.isConnected,
            isDisabled: n.isDisabled,
            lastStatusChange:
              n.lastStatusChange === undefined
                ? new Date(LONG_AGO)
                : n.lastStatusChange === null
                  ? null
                  : new Date(n.lastStatusChange),
          }),
        ),
      ),
  });

  return {
    detectors: new SharingDetectors(
      prismaMock,
      remnaMock,
      devices.client,
      infra.client,
      tunablesFromEnv(),
    ),
    scannedNodeUuids,
    subscriptionQueries: subscriptions.queries,
  };
}

function makeDetectors(remna: RemnaMock, subs: SubRow[] = []): SharingDetectors {
  return makeHarness(remna, subs).detectors;
}

/**
 * Capture `Logger` output for the suppression tests. A suppressed accusation
 * that logs nothing is indistinguishable from a clean panel, so the log line IS
 * part of the contract — and WARN vs LOG is how an operator tells a routine
 * excuse from one we could not fully justify.
 */
function captureSharingLogs(): {
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

describe('SharingDetectors — HWID overage', () => {
  it('flags a user whose device count exceeds the limit (MEDIUM) and resolves the rezeis user', async () => {
    const detectors = makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
        ],
        panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 3 }],
      },
      [{ remnawaveId: 'u1', userId: 'user-1' }],
    );
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].code, 'SUBSCRIPTION_SHARING_HWID');
    assert.equal(candidates[0].severity, FraudSignalSeverity.MEDIUM);
    assert.deepEqual(candidates[0].affectedUserIds, ['user-1']);
    assert.equal((candidates[0].metadata as { deviceCount: number }).deviceCount, 5);
  });

  it('escalates to HIGH when devices reach 2x the limit', async () => {
    const detectors = makeDetectors({
      hwidTopUsers: [
        { userUuid: 'u1', username: 'a', telegramId: null, devicesCount: 6, lastSeenAt: null },
      ],
      panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 3 }],
    });
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates[0].severity, FraudSignalSeverity.HIGH);
  });

  it('does not flag at or below the limit (boundary)', async () => {
    const detectors = makeDetectors({
      hwidTopUsers: [
        { userUuid: 'u1', username: 'a', telegramId: null, devicesCount: 3, lastSeenAt: null },
      ],
      panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 3 }],
    });
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
  });

  it('skips users with an unlimited (<=0) device limit', async () => {
    const detectors = makeDetectors({
      hwidTopUsers: [
        { userUuid: 'u1', username: 'a', telegramId: null, devicesCount: 99, lastSeenAt: null },
      ],
      panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 0 }],
    });
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
  });

  // A detector DEGRADES on a bad panel read (unlike an importer, which
  // refuses) — but it must skip the run wholesale rather than judge the
  // survivors. A lossy read used to arrive as a shorter array: the rows that
  // came back were scored and the rows that were lost silently read back as
  // "limit 0" and were exempted, so the run still looked healthy.
  //
  // Driven through the REAL adapter, because that shortening is the thing
  // under test — a hand-made outcome cannot express it.
  it('does not judge the survivors of a lossy panel read', async () => {
    const remna = new RemnawaveApiService(
      {
        request: () =>
          // 3 rows on the wire, one of which carries no uuid → 2 decoded.
          of({
            data: {
              response: {
                users: [
                  { uuid: 'u1', hwidDeviceLimit: 3, id: 1 },
                  { uuid: '', hwidDeviceLimit: 3, id: 2 },
                  { uuid: 'u3', hwidDeviceLimit: 3, id: 3 },
                ],
                total: 3,
              },
            },
          }),
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
      } as never,
    );
    const devices = panelDevicesDouble({
      topUsers: panelOk(hwidTopUsersPage([{ id: 1, username: 'alice', devicesCount: 99 }])),
    });
    const detectors = new SharingDetectors(
      { subscription: { findMany: () => Promise.resolve([]) } } as unknown as PrismaService,
      remna,
      devices.client,
      panelInfraDouble().client,
      tunablesFromEnv(),
    );
    // `u1` survived the read and is 99 devices over a limit of 3 — scoring it
    // would be scoring a fraction of the panel.
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
  });

  it('still scores an offender when the same read is whole', async () => {
    const detectors = makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 99, lastSeenAt: null },
        ],
        panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 3 }],
      },
      [],
    );
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1);
  });
});

/**
 * A downgrade is not sharing — but it only explains as much as it explains.
 *
 * `devicesCount` counts registered HWID records and nothing on the limit-change
 * path deletes them, so lowering a customer's plan from five devices to two
 * leaves five registered against a limit of two — an overage we manufactured.
 * The old detector named exactly that customer at HIGH/80.
 *
 * The first fix excused ANY overage from a recently reduced subscription, on the
 * premise that Remnawave refuses a registration at or over the limit so no new
 * device can have appeared. That premise is false — the HWID limit is
 * bypassable, which is the only reason this detector has anything to find — and
 * the blanket excuse was therefore a purchasable immunity. What a reduction
 * genuinely explains is bounded by `Subscription.deviceLimitBeforeReduction`:
 * the devices the customer already held, and not one more.
 */
/**
 * The panel upgraded; the subscription row did not.
 *
 * On a 3.x panel every identity the detectors receive is a decimal `id` — the
 * `uuid` column is gone from the user model. A subscription linked during the
 * 2.x era still stores its uuid in `remnawaveId` and always will, because the
 * panel's own migration drops the uuid and we never had anywhere else to put
 * it. So `remnawaveId IN (<decimals>)` matches NOTHING for that population, and
 * on this operator's 3.3.2 panel that is most of the paying base.
 *
 * The consequence is not a blank field. `rezeisUserId` comes back null AND the
 * device-limit-reduction stamp never reaches the grace, so a customer who
 * legitimately downgraded their plan is accused of sharing. It fails silently,
 * in the accusing direction, against people who did nothing.
 *
 * `remnawavePanelId` is the second recorded angle on the same profile and is
 * what closes it — under the two bounds the last two cases here pin, because
 * the careless version of this fix (`remnawavePanelId: null`, or an `in` list
 * carrying a null) matches every row that has no panel id, which in an
 * anti-fraud detector means every customer at once.
 */
describe('SharingDetectors — a 3.x panel identity against a 2.x-era row', () => {
  const UUID_2X = '330f2b38-1362-46ab-b5c0-dea32167eff9';
  /** The identity a 3.x panel sends: the numeric id, rendered decimal. */
  const PANEL_ID = 4471;
  const IDENTITY_3X = String(PANEL_ID);

  /** Rows that belong to other customers and have no panel id recorded. */
  const STRANGERS: SubRow[] = [
    { remnawaveId: '9e7c1a54-0000-4000-8000-000000000001', userId: 'stranger-1' },
    { remnawaveId: '9e7c1a54-0000-4000-8000-000000000002', userId: 'stranger-2' },
    { remnawaveId: 'not-a-panel-identity', userId: 'stranger-3' },
  ];

  function harnessFor(subs: SubRow[]) {
    return makeHarness(
      {
        hwidTopUsers: [
          {
            userUuid: IDENTITY_3X,
            username: 'alice',
            telegramId: null,
            devicesCount: 5,
            lastSeenAt: null,
          },
        ],
        panelUsers: [{ uuid: IDENTITY_3X, panelId: PANEL_ID, hwidDeviceLimit: 2 }],
      },
      subs,
    );
  }

  /** The 2.x-era row: uuid in `remnawaveId`, numeric id in the second column. */
  function upgradedRow(over: Partial<SubRow> = {}): SubRow {
    return { remnawaveId: UUID_2X, remnawavePanelId: PANEL_ID, userId: 'user-42', ...over };
  }

  it('deep-links the signal through the numeric angle', async () => {
    const { detectors } = harnessFor([...STRANGERS, upgradedRow()]);

    const candidates = await detectors.detectHwidOverage(NOW);

    assert.equal(candidates.length, 1);
    // The whole point: without the numeric arm this is `[]` and the operator
    // gets a signal that opens onto nobody.
    assert.deepEqual(candidates[0].affectedUserIds, ['user-42']);
  });

  it('lets the downgrade grace reach that row, so the customer is not accused', async () => {
    const { detectors } = harnessFor([
      ...STRANGERS,
      upgradedRow({
        deviceLimitReducedAt: new Date(NOW.getTime() - 60_000),
        deviceLimitBeforeReduction: 5,
      }),
    ]);

    assert.deepEqual(
      await detectors.detectHwidOverage(NOW),
      [],
      'a customer who downgraded moments ago was accused because their row was never found',
    );
  });

  it('accuses the same customer when nothing records the second angle — the control', async () => {
    // Same downgrade, same instant, but the row carries no `remnawavePanelId`,
    // so there is genuinely no way back to it from a 3.x identity. This is what
    // makes the case above evidence: the excuse travelled through the numeric
    // angle and not through some accident of the harness.
    const { detectors } = harnessFor([
      ...STRANGERS,
      upgradedRow({
        remnawavePanelId: null,
        deviceLimitReducedAt: new Date(NOW.getTime() - 60_000),
        deviceLimitBeforeReduction: 5,
      }),
    ]);

    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].affectedUserIds, []);
  });

  it('selects that one row and no other — a null panel id must never be asked for', async () => {
    // THE MUTATION THIS EXISTS FOR. `remnawave_panel_id` has no unique
    // constraint and is null on most rows (migration `20260810160000`), so
    // asking `remnawavePanelId: null` — or putting a null in the `in` list —
    // turns "which subscriptions are these" into "all of them" inside an
    // anti-fraud detector. The stranger rows above all have no panel id, so
    // they are exactly what such a query would sweep up.
    const { detectors, subscriptionQueries } = harnessFor([...STRANGERS, upgradedRow()]);

    await detectors.detectHwidOverage(NOW);

    assert.equal(subscriptionQueries.length, 1, 'the detector did not query subscriptions at all');
    assert.deepEqual(
      subscriptionQueries[0].matched.map((row) => row.userId),
      ['user-42'],
    );
  });

  it('asks one column only when the batch holds no numeric identity', async () => {
    // A 2.x panel, or any batch of uuids: there is no numeric angle to ask
    // about, and the arm is OMITTED rather than emitted empty or null.
    const { detectors, subscriptionQueries } = makeHarness(
      {
        hwidTopUsers: [
          { userUuid: UUID_2X, username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
        ],
        panelUsers: [{ uuid: UUID_2X, panelId: PANEL_ID, hwidDeviceLimit: 2 }],
      },
      [...STRANGERS, { remnawaveId: UUID_2X, userId: 'user-42' }],
    );

    await detectors.detectHwidOverage(NOW);

    assert.equal(subscriptionQueries.length, 1);
    assert.deepEqual(subscriptionQueries[0].where, { remnawaveId: { in: [UUID_2X] } });
    assert.deepEqual(
      subscriptionQueries[0].matched.map((row) => row.userId),
      ['user-42'],
    );
  });
});

describe('SharingDetectors — a downgrade is not sharing', () => {
  const GRACE_DAYS = 14;
  const days = (n: number): number => n * 24 * 60 * 60 * 1000;

  /**
   * The 5-devices-against-a-limit-of-2 downgrade from the bug report: five
   * registered devices, a plan that now allows two, reduced from five.
   */
  function downgradeHarness(reducedAt: Date | null, previousLimit: number | null = 5) {
    return makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
        ],
        panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 2 }],
      },
      [
        {
          remnawaveId: 'u1',
          userId: 'user-1',
          deviceLimitReducedAt: reducedAt,
          deviceLimitBeforeReduction: previousLimit,
        },
      ],
    );
  }


  it('does not name a customer whose limit was reduced moments ago', async () => {
    const detectors = downgradeHarness(new Date(NOW.getTime() - 60_000));
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
  });

  // The precise shape of the reported defect: 5 devices against a limit of 2 is
  // `devices >= limit * 2`, which is the HIGH branch.
  it('does not name a fresh downgrade even at the HIGH threshold', async () => {
    const detectors = downgradeHarness(new Date(NOW.getTime() - days(1)));
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.deepEqual(
      candidates.map((c) => c.severity),
      [],
      'a one-day-old downgrade was still escalated to HIGH',
    );
  });

  it('names the same overage once the window has passed', async () => {
    const detectors = downgradeHarness(new Date(NOW.getTime() - days(GRACE_DAYS + 1)));
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].code, 'SUBSCRIPTION_SHARING_HWID');
    // Unchanged thresholds: 5 >= 2*2 is still HIGH.
    assert.equal(candidates[0].severity, FraudSignalSeverity.HIGH);
    // Confidence is no longer the flat 80 this used to assert — 5 devices
    // against a limit of 2 is a real overage but not a conclusive one, and it
    // now says so: ratio 2.5 of the 3 that saturates, surplus 3 of the 5 that
    // does. 80 × (0.4 + 0.6 × 0.625) = 62. What the window decides is which
    // baseline the overage is measured from, and that is unchanged.
    assert.equal(candidates[0].confidence, 62);
    assert.deepEqual(candidates[0].affectedUserIds, ['user-1']);
  });

  // The window is a bound, not a fudge factor: one second either side of it has
  // to decide differently, or the constant is not the thing being tested.
  it('flips at the window edge and not before', async () => {
    const inside = downgradeHarness(new Date(NOW.getTime() - days(GRACE_DAYS) + 1_000));
    assert.deepEqual(await inside.detectHwidOverage(NOW), []);
    const outside = downgradeHarness(new Date(NOW.getTime() - days(GRACE_DAYS) - 1_000));
    assert.equal((await outside.detectHwidOverage(NOW)).length, 1);
  });

  // The whole point of the fix is that it is NARROW. A limit that has not moved
  // is the genuine-sharing case and must be judged exactly as it was before.
  it('still names a customer over a limit that never moved', async () => {
    const detectors = makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
        ],
        panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 2 }],
      },
      [{ remnawaveId: 'u1', userId: 'user-1', deviceLimitReducedAt: null }],
    );
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].severity, FraudSignalSeverity.HIGH);
  });

  // No local row means no evidence of a downgrade — not evidence of one. A panel
  // profile we cannot map must keep being judged, or an unlinked profile would
  // become permanently exempt.
  it('still names a panel profile with no local subscription row', async () => {
    const detectors = makeDetectors({
      hwidTopUsers: [
        { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
      ],
      panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 2 }],
    });
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].affectedUserIds, []);
  });

  // The grace is per subscription, not per run: excusing one downgrade must not
  // excuse the sharer sitting next to it in the same panel response.
  it('excuses only the downgraded user in a mixed batch', async () => {
    const detectors = makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
          { userUuid: 'u2', username: 'bob', telegramId: null, devicesCount: 5, lastSeenAt: null },
        ],
        panelUsers: [
          { uuid: 'u1', panelId: 1, hwidDeviceLimit: 2 },
          { uuid: 'u2', panelId: 2, hwidDeviceLimit: 2 },
        ],
      },
      [
        {
          remnawaveId: 'u1',
          userId: 'user-1',
          deviceLimitReducedAt: new Date(NOW.getTime() - days(2)),
          deviceLimitBeforeReduction: 5,
        },
        { remnawaveId: 'u2', userId: 'user-2', deviceLimitReducedAt: null },
      ],
    );
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.deepEqual(
      candidates.map((c) => c.affectedUserIds),
      [['user-2']],
    );
  });

  // `remnawaveId` carries no unique constraint, so two rows can answer to one
  // panel uuid. Between rows that disagree the suppressing one wins — the grace
  // exists to prevent a false accusation, so ambiguity resolves towards silence.
  it('takes the latest reduction when two rows share a panel uuid', async () => {
    const detectors = makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
        ],
        panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 2 }],
      },
      [
        {
          remnawaveId: 'u1',
          userId: 'user-old',
          deviceLimitReducedAt: new Date(NOW.getTime() - days(400)),
          deviceLimitBeforeReduction: 3,
        },
        {
          remnawaveId: 'u1',
          userId: 'user-new',
          deviceLimitReducedAt: new Date(NOW.getTime() - days(1)),
          deviceLimitBeforeReduction: 5,
        },
      ],
    );
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
  });

  // The timestamp and the ceiling describe ONE event, so they have to come off
  // ONE row. Read field-by-field, the fresh row's timestamp would pair with the
  // stale row's ceiling of 3 and name a customer whose five devices the winning
  // reduction accounts for exactly.
  it('pairs the winning row’s ceiling with its own timestamp', async () => {
    const detectors = makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 5, lastSeenAt: null },
        ],
        panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: 2 }],
      },
      [
        // Deliberately ordered stale-last, so a "keep whichever came through the
        // loop most recently" bug is caught as well as a field-by-field one.
        {
          remnawaveId: 'u1',
          userId: 'user-new',
          deviceLimitReducedAt: new Date(NOW.getTime() - days(1)),
          deviceLimitBeforeReduction: 5,
        },
        {
          remnawaveId: 'u1',
          userId: 'user-old',
          deviceLimitReducedAt: new Date(NOW.getTime() - days(400)),
          deviceLimitBeforeReduction: 3,
        },
      ],
    );
    assert.deepEqual(await detectors.detectHwidOverage(NOW), []);
  });
});

/**
 * A downgrade explains the devices they already had, and NOT ONE MORE.
 *
 * This is the narrowing. The blanket excuse was exploitable in an obvious way:
 * the panel's HWID limit is bypassable — that bypass is the only reason
 * `devices > limit` is reachable at all — so a genuine sharer could downgrade
 * their own plan, lose nothing they were actually using, and buy fourteen days
 * of silence. `Subscription.deviceLimitBeforeReduction` bounds the excuse to
 * what the reduction can actually account for.
 */
describe('SharingDetectors — a downgrade explains only what it explains', () => {
  const GRACE_DAYS = 14;
  const days = (n: number): number => n * 24 * 60 * 60 * 1000;
  const YESTERDAY = new Date(NOW.getTime() - days(1));

  function harness(input: {
    devices: number;
    limit: number;
    reducedAt?: Date | null;
    previousLimit?: number | null;
  }) {
    return makeDetectors(
      {
        hwidTopUsers: [
          {
            userUuid: 'u1',
            username: 'alice',
            telegramId: null,
            devicesCount: input.devices,
            lastSeenAt: null,
          },
        ],
        panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: input.limit }],
      },
      [
        {
          remnawaveId: 'u1',
          userId: 'user-1',
          deviceLimitReducedAt: input.reducedAt ?? null,
          deviceLimitBeforeReduction: input.previousLimit ?? null,
        },
      ],
    );
  }

  // ── The gap that had to close ──────────────────────────────────────────────

  // The attack in one test: nine devices behind a bypassed limit of two, then a
  // downgrade to one. Under the blanket excuse this user disappeared from the
  // report for a fortnight at the cost of a plan they were not using anyway.
  it('gives a sharer nothing for downgrading', async () => {
    const detectors = harness({
      devices: 9,
      limit: 1,
      reducedAt: new Date(NOW.getTime() - 60_000),
      previousLimit: 2,
    });
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1, 'a fresh downgrade still bought immunity');
    assert.equal(candidates[0].code, 'SUBSCRIPTION_SHARING_HWID');
    assert.equal(candidates[0].severity, FraudSignalSeverity.HIGH);
  });

  // The brief's own example: the same customer at 5 is explained, at 9 is not.
  it('excuses 5-of-5 but not 9-of-5 after the same 5 → 2 downgrade', async () => {
    const excused = harness({ devices: 5, limit: 2, reducedAt: YESTERDAY, previousLimit: 5 });
    assert.deepEqual(await excused.detectHwidOverage(NOW), []);

    const named = harness({ devices: 9, limit: 2, reducedAt: YESTERDAY, previousLimit: 5 });
    assert.equal((await named.detectHwidOverage(NOW)).length, 1);
  });

  // The ceiling is a bound, not a fudge factor: one device either side of it has
  // to decide differently, or it is not the thing being tested.
  it('flips one device above the previous limit', async () => {
    const at = harness({ devices: 5, limit: 2, reducedAt: YESTERDAY, previousLimit: 5 });
    assert.deepEqual(await at.detectHwidOverage(NOW), []);
    const over = harness({ devices: 6, limit: 2, reducedAt: YESTERDAY, previousLimit: 5 });
    assert.equal((await over.detectHwidOverage(NOW)).length, 1);
  });

  // ── What must NOT have changed ─────────────────────────────────────────────

  // A limit that never moved is the genuine-sharing case. Same severity, same
  // score, same description, and the same metadata plus the confidence
  // derivation — which at nine devices against a limit of two saturates both
  // factors and lands on the 80 this detector has always reported for it.
  it('judges an unchanged limit exactly as it always did', async () => {
    const detectors = harness({ devices: 9, limit: 2 });
    const [candidate] = await detectors.detectHwidOverage(NOW);
    assert.equal(candidate.severity, FraudSignalSeverity.HIGH);
    assert.equal(candidate.confidence, 80);
    assert.equal(candidate.score, 100);
    assert.equal(
      candidate.description,
      'User alice has 9 registered devices but the plan allows 2.',
    );
    assert.deepEqual(candidate.metadata, {
      kind: 'hwid_overage',
      deviceCount: 9,
      deviceLimit: 2,
      remnawaveUuid: 'u1',
      remnawaveUsername: 'alice',
      confidenceBaseline: 2,
      confidenceCeiling: 80,
      confidenceAgreement: 1,
      confidenceDataQuality: 1,
      confidenceFactors: {
        overageRatio: { observed: 4.5, strength: 1 },
        overageSurplus: { observed: 7, strength: 1 },
      },
    });
  });

  // The window still expires. Once it has, the reduction explains nothing at
  // all and the partly-explained treatment goes with it.
  it('drops the explanation entirely once the window closes', async () => {
    const detectors = harness({
      devices: 9,
      limit: 2,
      reducedAt: new Date(NOW.getTime() - days(GRACE_DAYS + 1)),
      previousLimit: 5,
    });
    const [candidate] = await detectors.detectHwidOverage(NOW);
    assert.equal(candidate.severity, FraudSignalSeverity.HIGH);
    assert.equal(candidate.confidence, 80);
    assert.equal(candidate.metadata.partlyExplainedByLimitReduction, undefined);
  });

  // ── "Previously unlimited" is not an excuse ────────────────────────────────
  //
  // `Subscription.deviceLimit` is `@default(0)`, so `0` is the column's default
  // and its "never synced" value as much as it is "unlimited". The transition
  // that produces `before = 0` at scale is not a downgrade at all:
  // `RemnawaveImporterService.syncSubscription` writes `deviceLimit` on every
  // import pass, so the first import after HWID limits are switched on moves
  // every row `0 → N` and stamps the whole customer base.
  //
  // Unlike the finite case there is no ceiling to bound the excuse with, so the
  // only shapes on offer are blanket immunity or none — and blanket immunity
  // muted the detector for 14 days starting the moment a new limit existed.

  it('does not excuse an overage merely because the previous limit was 0', async () => {
    const detectors = harness({ devices: 99, limit: 2, reducedAt: YESTERDAY, previousLimit: 0 });
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 1, '99 devices against a limit of 2 is not explained by a 0');
    assert.equal(candidates[0].code, 'SUBSCRIPTION_SHARING_HWID');
    assert.equal(candidates[0].severity, FraudSignalSeverity.HIGH);
  });

  // The specific production shape: an operator turns HWID limits on, the next
  // import writes `0 → 5` for EVERY subscription, and the trigger stamps every
  // one of them. If that stamp were an excuse, the detector would be silent for
  // a fortnight across the entire user base — at exactly the moment the new
  // limit is most likely to be breached.
  it('still names every user after a fleet-wide 0 → N import stamps them all', async () => {
    const detectors = makeDetectors(
      {
        hwidTopUsers: [
          { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 8, lastSeenAt: null },
          { userUuid: 'u2', username: 'bob', telegramId: null, devicesCount: 12, lastSeenAt: null },
        ],
        panelUsers: [
          { uuid: 'u1', panelId: 1, hwidDeviceLimit: 5 },
          { uuid: 'u2', panelId: 2, hwidDeviceLimit: 5 },
        ],
      },
      [
        {
          remnawaveId: 'u1',
          userId: 'user-1',
          deviceLimitReducedAt: new Date(NOW.getTime() - 60_000),
          deviceLimitBeforeReduction: 0,
        },
        {
          remnawaveId: 'u2',
          userId: 'user-2',
          deviceLimitReducedAt: new Date(NOW.getTime() - 60_000),
          deviceLimitBeforeReduction: 0,
        },
      ],
    );
    const candidates = await detectors.detectHwidOverage(NOW);
    assert.equal(candidates.length, 2, 'one import pass must not mute the detector fleet-wide');
  });

  // Judged means judged EXACTLY as it always was — the unsizeable stamp is not
  // a half-excuse either. Stated as a comparison against the identical panel
  // state with no stamp at all, so this cannot drift into asserting a literal.
  it('judges a 0-stamped overage identically to an unstamped one', async () => {
    const stamped = harness({ devices: 8, limit: 2, reducedAt: YESTERDAY, previousLimit: 0 });
    const unstamped = harness({ devices: 8, limit: 2 });
    const [judged] = await stamped.detectHwidOverage(NOW);
    const [reference] = await unstamped.detectHwidOverage(NOW);
    assert.equal(judged.severity, reference.severity);
    assert.equal(judged.score, reference.score);
    assert.equal(judged.confidence, reference.confidence);
    assert.equal(judged.metadata.confidenceBaseline, reference.metadata.confidenceBaseline);
    assert.equal(judged.metadata.confidenceCeiling, 80);
    assert.equal(
      judged.metadata.partlyExplainedByLimitReduction,
      undefined,
      'a 0 explains no part of the overage, so nothing is reported as partly explained',
    );
    assert.equal(judged.description, reference.description);
  });

  // A negative limit is nonsense the trigger canonicalises to 0, and a stray one
  // reaching the detector must not read as a finite ceiling of -1 either.
  it('treats a negative previous limit the same way, not as a finite ceiling', async () => {
    const detectors = harness({ devices: 4, limit: 2, reducedAt: YESTERDAY, previousLimit: -1 });
    assert.equal((await detectors.detectHwidOverage(NOW)).length, 1);
  });

  // A genuine unlimited → finite downgrade IS named now, and that is the cost of
  // the decision. The log is what carries the mitigating fact to the operator,
  // so a silent version of this branch would be the same defect wearing a
  // different hat.
  it('says out loud that it declined to honour the stamp', async () => {
    const logs: string[] = [];
    const detectors = harness({ devices: 8, limit: 5, reducedAt: YESTERDAY, previousLimit: 0 });
    (detectors as unknown as { logger: { log: (m: string) => void } }).logger.log = (m: string) =>
      logs.push(m);
    await detectors.detectHwidOverage(NOW);
    const notice = logs.find((l) => l.includes('reduction FROM'));
    assert.ok(notice, `the operator must be told; got ${JSON.stringify(logs)}`);
    assert.ok(notice.includes('alice'), 'and told which user it was');
    assert.ok(notice.includes('JUDGED'), 'and that the stamp was not honoured');
  });

  // A raise after the reduction can leave the current limit at or above the old
  // one. Then the reduction explains nothing this user is not already over, and
  // weakening the signal for it would be a discount for free.
  it('does not weaken a signal when the reduction is below the current limit', async () => {
    const detectors = harness({ devices: 10, limit: 9, reducedAt: YESTERDAY, previousLimit: 5 });
    const [candidate] = await detectors.detectHwidOverage(NOW);
    // Stated as the comparison rather than as a literal: the identical panel
    // state with no reduction stamp at all must produce the identical number.
    // Asserting a bare `80` here would have been asserting that a 10-against-9
    // overage is conclusive, which it is not — it is the weakest overage the
    // detector can report, and both cases now say so equally.
    const unstamped = harness({ devices: 10, limit: 9 });
    const [reference] = await unstamped.detectHwidOverage(NOW);
    assert.equal(candidate.confidence, reference.confidence);
    assert.equal(candidate.metadata.confidenceCeiling, 80);
    assert.equal(candidate.metadata.confidenceBaseline, 9);
    assert.equal(candidate.metadata.partlyExplainedByLimitReduction, undefined);
  });

  // ── How a partly-explained overage is reported ─────────────────────────────

  // Same code and same fingerprint — this is the same accusation, made with
  // weaker evidence, not a new kind of signal.
  it('reports a partial explanation under the same code and fingerprint', async () => {
    const partial = harness({ devices: 9, limit: 2, reducedAt: YESTERDAY, previousLimit: 5 });
    const full = harness({ devices: 9, limit: 2 });
    const [a] = await partial.detectHwidOverage(NOW);
    const [b] = await full.detectHwidOverage(NOW);
    assert.equal(a.code, b.code);
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.title, b.title);
  });

  // The weakening, stated as the comparison that motivates it: the SAME nine
  // devices are a milder signal when five of them are ours to explain.
  it('reports weaker evidence than an unexplained overage of the same size', async () => {
    const partial = harness({ devices: 9, limit: 2, reducedAt: YESTERDAY, previousLimit: 5 });
    const full = harness({ devices: 9, limit: 2 });
    const [a] = await partial.detectHwidOverage(NOW);
    const [b] = await full.detectHwidOverage(NOW);

    // Severity falls out of the UNCHANGED threshold read against the higher
    // pre-reduction baseline: 9 >= 2*2 is HIGH, 9 >= 5*2 is not.
    assert.equal(b.severity, FraudSignalSeverity.HIGH);
    assert.equal(a.severity, FraudSignalSeverity.MEDIUM);
    // Score measures the unexplained excess: 50 + (9-5)*10, not 50 + (9-2)*10.
    assert.equal(a.score, 90);
    assert.equal(b.score, 100);
    // Confidence says out loud that part of the count is our own bookkeeping —
    // twice over now. The ceiling drops from 80 to 65 because a mitigating fact
    // exists at all, and the factors then drop it further because they are
    // measured from the higher pre-reduction baseline: ratio 9/5 = 1.8 against
    // 9/2 = 4.5, surplus 4 against 7. 65 × (0.4 + 0.6 × 0.575) = 48.
    assert.equal(a.confidence, 48);
    assert.equal(b.confidence, 80);
    assert.ok(a.confidence < b.confidence);
    assert.equal(a.metadata.confidenceCeiling, 65);
    assert.equal(b.metadata.confidenceCeiling, 80);
  });

  // The operator has to be able to see WHY it is weaker without opening the
  // database: how many devices the reduction accounts for, and how many it does
  // not. `deviceLimit` stays the PLAN limit — `getTopOffenders` and the Telegram
  // block render it as "count / limit", and that is the true entitlement.
  it('carries the reduction context in the description and metadata', async () => {
    const detectors = harness({ devices: 9, limit: 2, reducedAt: YESTERDAY, previousLimit: 5 });
    const [candidate] = await detectors.detectHwidOverage(NOW);
    assert.match(candidate.description, /reduced 1d ago from 5/);
    assert.match(candidate.description, /accounts for 5 of those devices/);
    assert.match(candidate.description, /remaining 4 are not explained/);
    // Under a day reads as prose, not as a baffling "0d ago". The exact instant
    // is in `deviceLimitReducedAt` for anyone who needs it.
    const fresh = harness({
      devices: 9,
      limit: 2,
      reducedAt: new Date(NOW.getTime() - 60_000),
      previousLimit: 5,
    });
    const [freshCandidate] = await fresh.detectHwidOverage(NOW);
    assert.match(freshCandidate.description, /reduced less than a day ago from 5/);
    assert.deepEqual(candidate.metadata, {
      kind: 'hwid_overage',
      deviceCount: 9,
      deviceLimit: 2,
      remnawaveUuid: 'u1',
      remnawaveUsername: 'alice',
      partlyExplainedByLimitReduction: true,
      deviceLimitBeforeReduction: 5,
      deviceLimitReducedAt: YESTERDAY.toISOString(),
      unexplainedDeviceCount: 4,
      // …and why the confidence is what it is. `deviceLimit` is the PLAN limit
      // and is not the number the factors were measured from, which is exactly
      // why `confidenceBaseline` has to be spelled out separately.
      confidenceBaseline: 5,
      confidenceCeiling: 65,
      confidenceAgreement: 0.75,
      confidenceDataQuality: 1,
      confidenceFactors: {
        overageRatio: { observed: 1.8, strength: 0.4 },
        overageSurplus: { observed: 4, strength: 0.75 },
      },
    });
  });

  // ── A stamp with no ceiling: unreachable, and not an excuse ────────────────

  // The trigger writes the timestamp and the ceiling in one assignment block, so
  // this state cannot arise from the schema. If it ever does, something wrote
  // the timestamp outside the trigger and we cannot say what it means — and
  // granting immunity on provenance we cannot explain is the exploitable
  // direction, since it IS the blanket excuse a sharer buys with a downgrade.
  // Judging is the recoverable direction: an operator can review and dismiss an
  // accusation, and dismissal now genuinely suppresses.
  it('judges a stamp with no recorded ceiling instead of excusing it', async () => {
    const detectors = harness({ devices: 99, limit: 2, reducedAt: YESTERDAY, previousLimit: null });
    const signals = await detectors.detectHwidOverage(NOW);

    assert.equal(signals.length, 1, 'an unexplained stamp must not buy immunity');
    assert.equal(signals[0]?.code, 'SUBSCRIPTION_SHARING_HWID');
    // Judged as if there were no reduction at all — not weakened, because
    // nothing about this row explains any part of the overage.
    assert.equal(signals[0]?.severity, 'HIGH');
    assert.equal(signals[0]?.metadata?.partlyExplainedByLimitReduction, undefined);
  });

  // ...and says so at ERROR, because an unreachable state that occurred is a
  // defect in whatever wrote it, not a routine suppression.
  it('reports an unrecorded ceiling as an anomaly rather than passing over it', async () => {
    const captured = captureSharingLogs();
    try {
      await harness({
        devices: 99,
        limit: 2,
        reducedAt: YESTERDAY,
        previousLimit: null,
      }).detectHwidOverage(NOW);
      assert.equal(
        captured.errors.some((line) => /NO previous limit recorded/.test(line)),
        true,
        `no error names the anomalous stamp; saw ${JSON.stringify(captured.errors)}`,
      );

      captured.warns.length = 0;
      captured.logs.length = 0;
      // A fully explained overage is a normal, expected excuse — LOG, not WARN.
      await harness({
        devices: 5,
        limit: 2,
        reducedAt: YESTERDAY,
        previousLimit: 5,
      }).detectHwidOverage(NOW);
      assert.equal(captured.warns.length, 0);
      assert.equal(
        captured.logs.some((line) => /fully accounted for by a device-limit reduction/.test(line)),
        true,
        `no log records the excused user; saw ${JSON.stringify(captured.logs)}`,
      );
    } finally {
      captured.restore();
    }
  });
});

describe('SharingDetectors — concurrent IP (network-grouped)', () => {
  // The IP detector is OFF by default (HWID overage is the authoritative
  // signal). Enable it for this block and restore the env afterwards.
  let prevEnabled: string | undefined;
  beforeEach(() => {
    prevEnabled = process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    process.env.ANTIFRAUD_SHARING_IP_ENABLED = 'true';
  });
  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    else process.env.ANTIFRAUD_SHARING_IP_ENABLED = prevEnabled;
  });

  it('is disabled by default (no env) — returns nothing even with many IPs', async () => {
    delete process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    const recent = NOW.toISOString();
    const detectors = makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: [{ uuid: 'n1', name: 'N1', countryCode: 'DE', isConnected: true, isDisabled: false }],
      usersIpsByNode: {
        n1: [{ userId: '10', ips: [
          { ip: '1.1.1.1', lastSeen: recent },
          { ip: '2.2.2.2', lastSeen: recent },
          { ip: '3.3.3.3', lastSeen: recent },
        ] }],
      },
    });
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });

  it('flags when distinct networks exceed the limit + margin (LOW severity)', async () => {
    const recent = NOW.toISOString();
    const detectors = makeDetectors(
      {
        panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 2 }],
        nodes: [{ uuid: 'n1', name: 'N1', countryCode: 'DE', isConnected: true, isDisabled: false }],
        usersIpsByNode: {
          n1: [
            {
              userId: '10',
              ips: [
                // 4 distinct /24 networks; limit 2 + margin 1 → tolerated 3 → flagged.
                { ip: '1.1.1.1', lastSeen: recent },
                { ip: '2.2.2.2', lastSeen: recent },
                { ip: '3.3.3.3', lastSeen: recent },
                { ip: '4.4.4.4', lastSeen: recent },
              ],
            },
          ],
        },
      },
      [{ remnawaveId: 'u1', userId: 'user-1' }],
    );
    const candidates = await detectors.detectConcurrentIpSharing(NOW);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].code, 'SUBSCRIPTION_SHARING_IP');
    assert.equal(candidates[0].severity, FraudSignalSeverity.LOW);
    assert.equal((candidates[0].metadata as { distinctNetworkCount: number }).distinctNetworkCount, 4);
    assert.equal((candidates[0].metadata as { distinctIpCount: number }).distinctIpCount, 4);
    assert.deepEqual(candidates[0].affectedUserIds, ['user-1']);
  });

  it('does NOT flag a single user roaming within one /24 (false-positive fix)', async () => {
    const recent = NOW.toISOString();
    const detectors = makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: [{ uuid: 'n1', name: 'N1', countryCode: 'DE', isConnected: true, isDisabled: false }],
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            ips: [
              // 4 raw IPs but all in one carrier /24 → 1 network → not flagged.
              { ip: '100.64.10.1', lastSeen: recent },
              { ip: '100.64.10.55', lastSeen: recent },
              { ip: '100.64.10.120', lastSeen: recent },
              { ip: '100.64.10.200', lastSeen: recent },
            ],
          },
        ],
      },
    });
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });

  it('does NOT flag at limit + margin (tolerance boundary: home Wi-Fi + mobile)', async () => {
    const recent = NOW.toISOString();
    const detectors = makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: [{ uuid: 'n1', name: 'N1', countryCode: 'DE', isConnected: true, isDisabled: false }],
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            // 2 networks; limit 1 + margin 1 → tolerated 2 → 2 is NOT > 2.
            ips: [
              { ip: '85.10.20.5', lastSeen: recent },
              { ip: '100.64.10.1', lastSeen: recent },
            ],
          },
        ],
      },
    });
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });

  it('ignores IPs outside the time window', async () => {
    const recent = NOW.toISOString();
    const old = new Date(NOW.getTime() - 60 * 60_000).toISOString(); // 60m ago, window 10m
    const detectors = makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: [{ uuid: 'n1', name: 'N1', countryCode: 'DE', isConnected: true, isDisabled: false }],
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            ips: [
              { ip: '1.1.1.1', lastSeen: recent },
              { ip: '9.9.9.9', lastSeen: old }, // stale → excluded
            ],
          },
        ],
      },
    });
    // 1 in-window network <= tolerated 2 → no candidate
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });

  it('returns nothing when there are no connected nodes', async () => {
    const detectors = makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
      nodes: [{ uuid: 'n1', name: 'N1', countryCode: 'DE', isConnected: false, isDisabled: false }],
    });
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rest of this file is one question asked five ways: does the detector
// accuse a customer for something the customer did, or for something the
// infrastructure — or the passage of time — did? Every block pairs the
// false-positive case with the counterpart that must still fire, because
// "detects nothing" passes the first half of every one of these on its own.
// ─────────────────────────────────────────────────────────────────────────────

function withIpDetectorEnabled(): void {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    process.env.ANTIFRAUD_SHARING_IP_ENABLED = 'true';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ANTIFRAUD_SHARING_IP_ENABLED;
    else process.env.ANTIFRAUD_SHARING_IP_ENABLED = prev;
  });
}

const ONE_NODE: NodeMock[] = [
  { uuid: 'n1', name: 'N1', countryCode: 'DE', isConnected: true, isDisabled: false },
];

describe('SharingDetectors — a lookback is not simultaneity', () => {
  withIpDetectorEnabled();

  // Same user, same four networks, same 10-minute lookback. The ONLY thing that
  // differs between these two tests is WHEN the connections were last used.
  const FOUR_NETWORKS = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'];

  function userWith(ips: Array<{ ip: string; lastSeen: string }>): SharingDetectors {
    return makeDetectors(
      {
        panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
        nodes: ONE_NODE,
        usersIpsByNode: { n1: [{ userId: '10', ips }] },
      },
      [{ remnawaveId: 'u1', userId: 'user-1' }],
    );
  }

  it('does NOT flag one person whose networks are spread across the lookback', async () => {
    // A phone that left the house: Wi-Fi, then a train, then LTE, then now.
    // Each connection died when the next began, so each `lastSeen` froze where
    // it was. Under the old rule all four were "within 10 minutes" and the
    // customer was reported for owning four networks.
    const detectors = userWith([
      { ip: FOUR_NETWORKS[0], lastSeen: ago(540) },
      { ip: FOUR_NETWORKS[1], lastSeen: ago(420) },
      { ip: FOUR_NETWORKS[2], lastSeen: ago(300) },
      { ip: FOUR_NETWORKS[3], lastSeen: ago(5) },
    ]);
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });

  it('DOES flag the same four networks when they were all in use at once', async () => {
    // Four people streaming simultaneously. Every connection is live, so every
    // `lastSeen` is current. This is the half that stops "detect less" from
    // passing for "detect correctly".
    const detectors = userWith([
      { ip: FOUR_NETWORKS[0], lastSeen: ago(2) },
      { ip: FOUR_NETWORKS[1], lastSeen: ago(9) },
      { ip: FOUR_NETWORKS[2], lastSeen: ago(15) },
      { ip: FOUR_NETWORKS[3], lastSeen: ago(31) },
    ]);
    const candidates = await detectors.detectConcurrentIpSharing(NOW);
    assert.equal(candidates.length, 1);
    assert.equal((candidates[0].metadata as { distinctNetworkCount: number }).distinctNetworkCount, 4);
    assert.deepEqual(candidates[0].affectedUserIds, ['user-1']);
  });

  it('judges a session that has already ended by its own clock, not by ours', async () => {
    // Everyone went offline six minutes ago, but while they were on they were
    // on together. Anchoring the cluster on `now` instead of on the user's own
    // most recent sighting would silently exonerate this.
    const detectors = userWith([
      { ip: FOUR_NETWORKS[0], lastSeen: ago(360) },
      { ip: FOUR_NETWORKS[1], lastSeen: ago(370) },
      { ip: FOUR_NETWORKS[2], lastSeen: ago(380) },
      { ip: FOUR_NETWORKS[3], lastSeen: ago(390) },
    ]);
    assert.equal((await detectors.detectConcurrentIpSharing(NOW)).length, 1);
  });

  it('reports the concurrency window it actually applied', async () => {
    const detectors = userWith([
      { ip: FOUR_NETWORKS[0], lastSeen: ago(2) },
      { ip: FOUR_NETWORKS[1], lastSeen: ago(9) },
      { ip: FOUR_NETWORKS[2], lastSeen: ago(15) },
      // Stale: inside the 10m lookback, outside the 180s cluster.
      { ip: FOUR_NETWORKS[3], lastSeen: ago(540) },
    ]);
    const [candidate] = await detectors.detectConcurrentIpSharing(NOW);
    const metadata = candidate.metadata as {
      distinctIpCount: number;
      observedIpCount: number;
      concurrencyWindowSeconds: number;
    };
    assert.equal(metadata.distinctIpCount, 3, 'only the clustered IPs are evidence');
    assert.equal(metadata.observedIpCount, 4, 'but the operator still sees what was observed');
    assert.equal(metadata.concurrencyWindowSeconds, 180);
  });

  it('drops an IP sample whose lastSeen cannot be read rather than counting it as current', async () => {
    // Unreadable timestamps used to pass the window check and count as
    // concurrent with everything. An event we cannot place in time is not
    // evidence that two things happened at the same time.
    const detectors = userWith([
      { ip: FOUR_NETWORKS[0], lastSeen: ago(2) },
      { ip: FOUR_NETWORKS[1], lastSeen: 'not-a-timestamp' },
      { ip: FOUR_NETWORKS[2], lastSeen: '' },
      { ip: FOUR_NETWORKS[3], lastSeen: 'yesterday-ish' },
    ]);
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });
});

describe('SharingDetectors — an unreadable panel id names nobody, out loud', () => {
  withIpDetectorEnabled();

  // `ip-control` keys its rows by the panel's own `userId`, and on a panel that
  // was upgraded from 2.x that string can still be a UUID. `Number.parseInt`
  // turns `'3f2a-1111-2222'` into `3` — a perfectly valid-looking panel id
  // belonging to a DIFFERENT customer — so the detector refuses anything that
  // is not wholly an integer.
  //
  // The refusal itself is guarded by the first assertion below. The COUNT and
  // the warning were guarded by nothing at all: deleting `unreadablePanelIds`
  // and the block that reports it left every test in this file green, and the
  // detector would then have gone back to what it did before it was silent —
  // covering only part of the panel while reporting a clean result, which is
  // the shape of every "the sweep saw nothing, so nothing is wrong" bug this
  // module has already paid for.
  const RECENT_FOUR = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'];

  function ipsAt(now: Date): Array<{ ip: string; lastSeen: string }> {
    return RECENT_FOUR.map((ip) => ({ ip, lastSeen: now.toISOString() }));
  }

  it('attributes nothing to the misparsed id and reports how much it skipped', async () => {
    const captured = captureSharingLogs();
    try {
      const detectors = makeDetectors(
        {
          panelUsers: [
            // The customer `parseInt('3f2a-…')` would have accused: id 3, and a
            // limit of 1 so four networks would certainly have flagged them.
            { uuid: 'u3', panelId: 3, hwidDeviceLimit: 1 },
            // The genuine offender, addressed by a real integer.
            { uuid: 'u10', panelId: 10, hwidDeviceLimit: 2 },
          ],
          nodes: ONE_NODE,
          usersIpsByNode: {
            n1: [
              { userId: '3f2a-1111-2222', ips: ipsAt(NOW) },
              { userId: '10', ips: ipsAt(NOW) },
            ],
          },
        },
        [
          { remnawaveId: 'u3', userId: 'user-3' },
          { remnawaveId: 'u10', userId: 'user-10' },
        ],
      );

      const candidates = await detectors.detectConcurrentIpSharing(NOW);

      // Attribution: exactly one accusation, and it is not the misparse's
      // victim. Asserted as the affected user, not as a count — a count of one
      // would also pass if the detector had accused `user-3` and dropped the
      // real offender.
      assert.deepEqual(
        candidates.map((candidate) => candidate.affectedUserIds),
        [['user-10']],
      );

      // Visibility: the skipped row is counted and named. Without this the run
      // above is indistinguishable from one where the panel sent nothing odd,
      // and an operator reading "one offender" would not know that a second
      // row's connections were never examined at all.
      const line = captured.warns.find((warn) => /is not an integer panel id/.test(warn));
      assert.notEqual(
        line,
        undefined,
        `no warning reports the skipped live-connection row; saw ${JSON.stringify(captured.warns)}`,
      );
      assert.match(line ?? '', /skipped 1 live-connection row\(s\)/);
    } finally {
      captured.restore();
    }
  });

  it('says nothing when every ip-control row carries a readable id', async () => {
    // The other half of the contract: a warning that also fires on a clean run
    // is a warning operators filter out, and then the real one is invisible too.
    const captured = captureSharingLogs();
    try {
      const detectors = makeDetectors(
        {
          panelUsers: [{ uuid: 'u10', panelId: 10, hwidDeviceLimit: 2 }],
          nodes: ONE_NODE,
          usersIpsByNode: { n1: [{ userId: '10', ips: ipsAt(NOW) }] },
        },
        [{ remnawaveId: 'u10', userId: 'user-10' }],
      );

      await detectors.detectConcurrentIpSharing(NOW);

      assert.deepEqual(
        captured.warns.filter((warn) => /is not an integer panel id/.test(warn)),
        [],
      );
    } finally {
      captured.restore();
    }
  });
});

describe('SharingDetectors — a dual-stack device is one device', () => {
  withIpDetectorEnabled();

  it('does NOT flag a legitimate two-device customer whose ISP has IPv6', async () => {
    // limit 2 + margin 1 → tolerated 3. Two devices, each presenting a v4 and a
    // v6 address for the same connection, used to count as 4 networks.
    const detectors = makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 2 }],
      nodes: ONE_NODE,
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            ips: [
              { ip: '203.0.113.10', lastSeen: ago(3) },
              { ip: '2001:db8:1:2::5', lastSeen: ago(3) },
              { ip: '198.51.100.7', lastSeen: ago(6) },
              { ip: '2001:db8:9:9::a', lastSeen: ago(6) },
            ],
          },
        ],
      },
    });
    assert.deepEqual(await detectors.detectConcurrentIpSharing(NOW), []);
  });

  it('still flags four dual-stack devices on a two-device plan', async () => {
    const detectors = makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 2 }],
      nodes: ONE_NODE,
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            ips: [
              { ip: '203.0.113.10', lastSeen: ago(3) },
              { ip: '2001:db8:1::5', lastSeen: ago(3) },
              { ip: '198.51.100.7', lastSeen: ago(4) },
              { ip: '2001:db8:2::a', lastSeen: ago(4) },
              { ip: '192.0.2.9', lastSeen: ago(5) },
              { ip: '2001:db8:3::b', lastSeen: ago(5) },
              { ip: '203.0.113.200', lastSeen: ago(6) },
              { ip: '2001:db8:4::c', lastSeen: ago(6) },
            ],
          },
        ],
      },
    });
    const candidates = await detectors.detectConcurrentIpSharing(NOW);
    assert.equal(candidates.length, 1);
    assert.equal(
      (candidates[0].metadata as { distinctNetworkCount: number }).distinctNetworkCount,
      4,
      'four devices, not eight addresses',
    );
  });
});

describe('SharingDetectors — a node flap is not a customer', () => {
  withIpDetectorEnabled();

  /**
   * Four networks in use right now on a one-device plan: a genuine offender, so
   * the ONLY variable between these tests is whether the panel was stable.
   */
  function sharingPanel(nodes: NodeMock[], snapshots?: SnapshotNode[][]): SharingDetectors {
    return makeDetectors({
      panelUsers: [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }],
      nodes,
      snapshots,
      usersIpsByNode: {
        n1: [
          {
            userId: '10',
            ips: [
              { ip: '1.1.1.1', lastSeen: ago(2) },
              { ip: '2.2.2.2', lastSeen: ago(4) },
              { ip: '3.3.3.3', lastSeen: ago(6) },
              { ip: '4.4.4.4', lastSeen: ago(8) },
            ],
          },
        ],
      },
    });
  }

  it('names the offender on a stable panel', async () => {
    const candidates = await sharingPanel(ONE_NODE).detectConcurrentIpSharing(NOW);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].code, 'SUBSCRIPTION_SHARING_IP');
  });

  it('names nobody when the panel reports a node status change in the window', async () => {
    // Everyone that node was carrying reconnects from a new source IP within
    // seconds. The extra networks this run would count are the outage.
    const candidates = await sharingPanel([
      ...ONE_NODE,
      {
        uuid: 'n2',
        name: 'N2',
        countryCode: 'NL',
        isConnected: true,
        isDisabled: false,
        lastStatusChange: ago(5 * 60),
      },
    ]).detectConcurrentIpSharing(NOW);
    assert.deepEqual(candidates, []);
  });

  it('names nobody when the node snapshots disagree inside the window', async () => {
    // The panel's own timestamp can be stale or absent; the collector's 5-minute
    // `isConnected` history is the second, independent source.
    const candidates = await sharingPanel(ONE_NODE, [
      [{ uuid: 'n1', name: 'N1', isConnected: false }],
      [{ uuid: 'n1', name: 'N1', isConnected: true }],
    ]).detectConcurrentIpSharing(NOW);
    assert.deepEqual(candidates, []);
  });

  it('still names the offender when the snapshots agree the panel was steady', async () => {
    const candidates = await sharingPanel(ONE_NODE, [
      [{ uuid: 'n1', name: 'N1', isConnected: true }],
      [{ uuid: 'n1', name: 'N1', isConnected: true }],
    ]).detectConcurrentIpSharing(NOW);
    assert.equal(candidates.length, 1);
  });

  it('ignores a status change older than the stability window', async () => {
    const candidates = await sharingPanel([
      ...ONE_NODE,
      {
        uuid: 'n2',
        name: 'N2',
        countryCode: 'NL',
        isConnected: true,
        isDisabled: false,
        lastStatusChange: ago(45 * 60),
      },
    ]).detectConcurrentIpSharing(NOW);
    assert.equal(candidates.length, 1);
  });
});

describe('SharingDetectors — the scanned node set is deterministic', () => {
  withIpDetectorEnabled();

  let prevMaxNodes: string | undefined;
  beforeEach(() => {
    prevMaxNodes = process.env.ANTIFRAUD_SHARING_MAX_NODES_PER_RUN;
    process.env.ANTIFRAUD_SHARING_MAX_NODES_PER_RUN = '2';
  });
  afterEach(() => {
    if (prevMaxNodes === undefined) delete process.env.ANTIFRAUD_SHARING_MAX_NODES_PER_RUN;
    else process.env.ANTIFRAUD_SHARING_MAX_NODES_PER_RUN = prevMaxNodes;
  });

  const NODES: NodeMock[] = ['aaa', 'bbb', 'ccc', 'ddd'].map((uuid) => ({
    uuid,
    name: uuid.toUpperCase(),
    countryCode: 'DE',
    isConnected: true,
    isDisabled: false,
  }));

  it('scans the same nodes whatever order the panel lists them in', async () => {
    // `getAllNodes` returns the panel's order, which is not stable — and the
    // distinct-IP count that the accusation rests on is taken over exactly the
    // nodes that get scanned. Two runs, two panel orderings, one node set.
    const panelUsers = [{ uuid: 'u1', panelId: 10, hwidDeviceLimit: 1 }];
    const first = makeHarness({ panelUsers, nodes: [...NODES] });
    const second = makeHarness({ panelUsers, nodes: [...NODES].reverse() });

    await first.detectors.detectConcurrentIpSharing(NOW);
    await second.detectors.detectConcurrentIpSharing(NOW);

    assert.deepEqual(first.scannedNodeUuids, ['aaa', 'bbb']);
    assert.deepEqual(second.scannedNodeUuids, ['aaa', 'bbb']);
  });
});

describe('SharingDetectors — an unreadable panel id is skipped, never guessed', () => {
  withIpDetectorEnabled();

  /**
   * Panel user #3 is an ordinary customer on a one-device plan. The ip-control
   * row carries a `userId` the vendored contract types as a plain string, and
   * `Number.parseInt('3f2a-…', 10)` is 3 — so somebody else's four networks
   * were filed under #3's name.
   */
  function panelWith(userId: string): SharingDetectors {
    return makeDetectors(
      {
        panelUsers: [{ uuid: 'u3', panelId: 3, hwidDeviceLimit: 1 }],
        nodes: ONE_NODE,
        usersIpsByNode: {
          n1: [
            {
              userId,
              ips: [
                { ip: '1.1.1.1', lastSeen: ago(2) },
                { ip: '2.2.2.2', lastSeen: ago(4) },
                { ip: '3.3.3.3', lastSeen: ago(6) },
                { ip: '4.4.4.4', lastSeen: ago(8) },
              ],
            },
          ],
        },
      },
      [{ remnawaveId: 'u3', userId: 'user-3' }],
    );
  }

  it('does not attribute a uuid-shaped userId to the panel user its digits happen to match', async () => {
    assert.deepEqual(await panelWith('3f2a-9c11-4d8e').detectConcurrentIpSharing(NOW), []);
  });

  it('still attributes a genuine integer userId', async () => {
    const candidates = await panelWith('3').detectConcurrentIpSharing(NOW);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].affectedUserIds, ['user-3']);
  });
});

describe('resolveSharingDetectionConfig', () => {
  it('returns the documented defaults on an empty environment', () => {
    // `parseInteger` uses `Number.parseInt`, and `Number.parseInt('', 10)` is
    // NaN, so an unset variable reaches its fallback. The sibling
    // `traffic-abuse.config.ts` used `Number(value ?? '')` — `Number('')` is 0,
    // which is finite, so every default there collapsed to its range floor.
    // This asserts that this file does not have that bug rather than assuming it.
    assert.deepEqual(resolveSharingDetectionConfig({}), {
      enableHwidOverage: true,
      enableIpSharing: false,
      ipWindowMinutes: 10,
      ipConcurrencyWindowSeconds: 180,
      maxNodesPerRun: 25,
      maxIpsInMetadata: 20,
      ipNetworkGrouping: true,
      ipV4PrefixLength: 24,
      ipV6PrefixLength: 48,
      ipOverageMargin: 1,
    });
  });

  it('treats a blank variable as unset, not as the range floor', () => {
    const blank = resolveSharingDetectionConfig({
      ANTIFRAUD_SHARING_IP_WINDOW_MINUTES: '',
      ANTIFRAUD_SHARING_MAX_NODES_PER_RUN: '   ',
    });
    assert.equal(blank.ipWindowMinutes, 10);
    assert.equal(blank.maxNodesPerRun, 25);
  });

  it('reads NO environment variable for the new concurrency window', () => {
    // `ipConcurrencyWindowSeconds` is the one knob here with no env layer, and
    // that is deliberate: it is new, so no deployment can already be setting
    // `ANTIFRAUD_SHARING_IP_CONCURRENCY_WINDOW_SECONDS`, so an env layer buys
    // no backward compatibility and only adds a second place a value can come
    // from. It is panel-editable like the rest. Same call this file's sibling
    // `subscription-ua-detection.config.ts` makes for its three new knobs.
    //
    // Both assertions matter. A value INSIDE the range would be returned
    // verbatim by an env layer; one outside it would come back clamped to the
    // range bound. Neither may happen — the built-in default is the only answer
    // this function has for this knob.
    assert.equal(
      resolveSharingDetectionConfig({ ANTIFRAUD_SHARING_IP_CONCURRENCY_WINDOW_SECONDS: '90' })
        .ipConcurrencyWindowSeconds,
      180,
      'an in-range variable must be ignored, not honoured',
    );
    assert.equal(
      resolveSharingDetectionConfig({ ANTIFRAUD_SHARING_IP_CONCURRENCY_WINDOW_SECONDS: '99999' })
        .ipConcurrencyWindowSeconds,
      180,
      'an out-of-range variable must be ignored, not clamped',
    );
  });

  it('no longer resolves the poll knobs nothing ever read', () => {
    // `jobPollAttempts` / `jobPollIntervalMs` were resolved here and consumed
    // by nobody — `pollIpControlJob` defaults its own attempts/interval and
    // `fetchUsersIpsForNode` passes neither.
    const keys = Object.keys(
      resolveSharingDetectionConfig({
        ANTIFRAUD_SHARING_JOB_POLL_ATTEMPTS: '60',
        ANTIFRAUD_SHARING_JOB_POLL_INTERVAL_MS: '9000',
      }),
    );
    assert.equal(keys.includes('jobPollAttempts'), false);
    assert.equal(keys.includes('jobPollIntervalMs'), false);
  });
});
