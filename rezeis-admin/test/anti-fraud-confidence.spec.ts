import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FraudSignalSeverity } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  computeConfidence,
  ratioStrength,
} from '../src/modules/anti-fraud/confidence.util';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import {
  NODE_USERS_BANDWIDTH_TOP_LIMIT,
  RemnawaveApiService,
} from '../src/modules/remnawave/services/remnawave-api.service';
import { RemnawaveVersionService } from '../src/modules/remnawave/services/remnawave-version.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';
import type { StoredAntiFraudSettings } from '../src/modules/settings/utils/anti-fraud-settings.util';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';

/**
 * `confidence` has to be a reading of the evidence, not a per-detector label.
 *
 * Every detector in this module used to report a literal — 90, 80, 75, 70, 65,
 * 60, 55 — about every signal it ever raised, so a user one device over a limit
 * of ten and a user thirty devices over a limit of two were equally "80%
 * confident", and a four-network count assembled from four lone IP sightings
 * read the same as one assembled from two hundred.
 *
 * Two obligations are tested here and they are equally load-bearing:
 *
 *   1. the number MOVES with each input the detector claims it responds to —
 *      margin over the threshold, sample size, cohort size, completeness of the
 *      read;
 *   2. the number does NOT move with anything else, in particular not with the
 *      things that would make it drift on their own (unrelated offenders on the
 *      same panel, the panel's population, nodes that were never eligible to be
 *      scanned, the calendar day).
 *
 * And the invariant that governs the whole change: THRESHOLDS AND SEVERITIES
 * ARE UNTOUCHED. Several cases below assert the severity alongside the
 * confidence for exactly that reason.
 */

const NOW = new Date('2026-06-18T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
const GB = 1024 ** 3;

// ─────────────────────────────────────────────────────────────────────────────
//  The arithmetic itself
// ─────────────────────────────────────────────────────────────────────────────

describe('confidence arithmetic', () => {
  it('is the ceiling when everything agrees and the read was complete', () => {
    const { confidence } = computeConfidence({
      ceiling: 80,
      dataQuality: 1,
      factors: [
        { name: 'a', observed: 9, strength: 1 },
        { name: 'b', observed: 9, strength: 1 },
      ],
    });
    assert.equal(confidence, 80);
  });

  // The reference model's floor: a detector that fired but whose every factor
  // is at its weakest is still worth 0.4 of its ceiling, because the threshold
  // was crossed to get here at all.
  it('falls to 0.4 of the ceiling when no factor agrees', () => {
    const { confidence } = computeConfidence({
      ceiling: 80,
      dataQuality: 1,
      factors: [{ name: 'a', observed: 0, strength: 0 }],
    });
    assert.equal(confidence, 32);
  });

  it('halves on a worthless read and scales linearly between', () => {
    const full = computeConfidence({
      ceiling: 80,
      dataQuality: 1,
      factors: [{ name: 'a', observed: 1, strength: 1 }],
    });
    const half = computeConfidence({
      ceiling: 80,
      dataQuality: 0.5,
      factors: [{ name: 'a', observed: 1, strength: 1 }],
    });
    const none = computeConfidence({
      ceiling: 80,
      dataQuality: 0,
      factors: [{ name: 'a', observed: 1, strength: 1 }],
    });
    assert.equal(full.confidence, 80);
    assert.equal(half.confidence, 60);
    assert.equal(none.confidence, 40);
  });

  // A detector with nothing to weigh must get its ceiling, not a penalty
  // invented by an empty average.
  it('treats no factors as full agreement rather than none', () => {
    assert.equal(computeConfidence({ ceiling: 70, dataQuality: 1, factors: [] }).confidence, 70);
  });

  it('never exceeds the ceiling and never rounds into zero', () => {
    const over = computeConfidence({
      ceiling: 55,
      dataQuality: 5,
      factors: [{ name: 'a', observed: 1, strength: 9 }],
    });
    assert.equal(over.confidence, 55);
    // 6 × 0.4 × 0.5 = 1.2, which would render to an operator as "1%".
    const under = computeConfidence({
      ceiling: 6,
      dataQuality: 0,
      factors: [{ name: 'a', observed: 0, strength: 0 }],
    });
    assert.equal(under.confidence, 5);
  });

  it('records every input it used', () => {
    const { explanation } = computeConfidence({
      ceiling: 80,
      dataQuality: 0.5,
      factors: [{ name: 'margin', observed: 2.5, strength: 0.75 }],
    });
    assert.deepEqual(explanation, {
      confidenceCeiling: 80,
      confidenceAgreement: 0.85,
      confidenceDataQuality: 0.5,
      confidenceFactors: { margin: { observed: 2.5, strength: 0.75 } },
    });
  });

  describe('ratioStrength', () => {
    it('is 0 at or below the floor and 1 at or above the full mark', () => {
      assert.equal(ratioStrength(1, 1, 3), 0);
      assert.equal(ratioStrength(0.5, 1, 3), 0);
      assert.equal(ratioStrength(3, 1, 3), 1);
      assert.equal(ratioStrength(30, 1, 3), 1);
    });

    it('is linear in between', () => {
      assert.equal(ratioStrength(2, 1, 3), 0.5);
      assert.equal(ratioStrength(1.5, 1, 3), 0.25);
    });

    // A ratio we could not compute (a zero denominator, a missing count) is the
    // weakest reading available. Fail-open here would let an unmeasurable input
    // raise an accusation's confidence.
    it('treats an unmeasurable input as the weakest, never the strongest', () => {
      assert.equal(ratioStrength(Number.NaN, 1, 3), 0);
      // Infinity is a division that ran away, not a conclusive measurement.
      assert.equal(ratioStrength(Number.POSITIVE_INFINITY, 1, 3), 0);
      assert.equal(ratioStrength(Number.NEGATIVE_INFINITY, 1, 3), 0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Local-Postgres detectors
// ─────────────────────────────────────────────────────────────────────────────

/** `n` users each with `count` qualifying rows, as Prisma's `groupBy` returns them. */
function group(n: number, count: number, key: 'userId' | 'referrerId' = 'userId') {
  return Array.from({ length: n }, (_, i) => ({
    [key]: `user-${i}`,
    _count: { _all: count },
  }));
}

function localDetectors(rows: {
  transaction?: ReturnType<typeof group>;
  referral?: ReturnType<typeof group>;
  promocodeActivation?: ReturnType<typeof group>;
  subscription?: ReturnType<typeof group>;
}): FraudDetectors {
  const prisma = {
    transaction: { groupBy: () => Promise.resolve(rows.transaction ?? []) },
    referral: { groupBy: () => Promise.resolve(rows.referral ?? []) },
    promocodeActivation: { groupBy: () => Promise.resolve(rows.promocodeActivation ?? []) },
    subscription: { groupBy: () => Promise.resolve(rows.subscription ?? []) },
  } as unknown as PrismaService;
  return new FraudDetectors(prisma);
}

describe('confidence — excessive failed payments', () => {
  const failures = async (users: number, each: number): Promise<number> => {
    const [candidate] = await localDetectors({
      transaction: group(users, each),
    }).detectExcessiveFailedPayments(NOW);
    return candidate.confidence;
  };

  // Depth: one user who barely cleared the 5-failure threshold against one who
  // cleared it fourfold. Same population, same everything else.
  it('rises with how far past the threshold the group sits', async () => {
    const barely = await failures(1, 5);
    const deep = await failures(1, 20);
    assert.equal(barely, 36, '90 × (0.4 + 0.6 × 0) — the weakest this detector can report');
    assert.equal(deep, 63, '90 × (0.4 + 0.6 × 0.5)');
    assert.ok(barely < deep);
  });

  // Breadth: five separate accounts doing the identical thing is the shape of a
  // card-testing run; one account is the shape of an expiring card.
  it('rises with how many users show the pattern at once', async () => {
    const alone = await failures(1, 5);
    const crowd = await failures(5, 5);
    assert.equal(crowd, 63);
    assert.ok(alone < crowd);
  });

  it('reaches the old flat 90 only when both agree', async () => {
    assert.equal(await failures(5, 20), 90);
  });

  // The group mean, not its peak: the signal names all N users, so one extreme
  // member must not speak for the rest.
  it('reads the group by its mean and not by its worst member', async () => {
    const uniform = await localDetectors({
      transaction: [...group(2, 12)],
    }).detectExcessiveFailedPayments(NOW);
    const lopsided = await localDetectors({
      transaction: [
        { userId: 'user-0', _count: { _all: 19 } },
        { userId: 'user-1', _count: { _all: 5 } },
      ],
    }).detectExcessiveFailedPayments(NOW);
    // Same mean (12), same population — so the same confidence, even though one
    // group contains a user with nearly four times the threshold.
    assert.equal(uniform[0].confidence, lopsided[0].confidence);
  });

  // Nothing about the panel, the calendar or the clock may reach this detector:
  // it reads local Postgres and the orchestrator classes it `authoritative`.
  it('does not move with the day it ran on, and never claims a partial read', async () => {
    const [today] = await localDetectors({
      transaction: group(3, 9),
    }).detectExcessiveFailedPayments(NOW);
    const [tomorrow] = await localDetectors({
      transaction: group(3, 9),
    }).detectExcessiveFailedPayments(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
    assert.notEqual(today.fingerprint, tomorrow.fingerprint, 'precondition: the bucket rolled');
    assert.equal(today.confidence, tomorrow.confidence);
    assert.equal(today.metadata.confidenceDataQuality, 1);
  });

  it('carries the inputs an operator would need to re-derive it', async () => {
    const [candidate] = await localDetectors({
      transaction: group(3, 10),
    }).detectExcessiveFailedPayments(NOW);
    assert.equal(candidate.metadata.meanFailuresPerUser, 10);
    assert.equal(candidate.metadata.confidenceCeiling, 90);
    assert.deepEqual(candidate.metadata.confidenceFactors, {
      failureDepth: { observed: 10, strength: 0.33 },
      affectedUsers: { observed: 3, strength: 0.5 },
    });
    // Severity is the untouched constant, not a function of any of this.
    assert.equal(candidate.severity, FraudSignalSeverity.HIGH);
  });
});

describe('confidence — the other local detectors', () => {
  it('bottoms out at 0.4 of each detector’s old literal', async () => {
    const [referral] = await localDetectors({
      referral: group(1, 10, 'referrerId'),
    }).detectRapidReferralVelocity(NOW);
    const [promo] = await localDetectors({
      promocodeActivation: group(1, 3),
    }).detectPromoAbuse(NOW);
    const [churn] = await localDetectors({
      subscription: group(1, 3),
    }).detectRapidChurn(NOW);
    assert.equal(referral.confidence, 30, '75 × 0.4');
    assert.equal(promo.confidence, 28, '70 × 0.4');
    assert.equal(churn.confidence, 24, '60 × 0.4');
  });

  it('reaches each detector’s old literal only on saturated evidence', async () => {
    const [referral] = await localDetectors({
      referral: group(5, 40, 'referrerId'),
    }).detectRapidReferralVelocity(NOW);
    const [promo] = await localDetectors({
      promocodeActivation: group(5, 12),
    }).detectPromoAbuse(NOW);
    // Churn ramps to 3× rather than 4× — nine expiries in a week is the top of
    // what a billing-cycle-scale object can produce.
    const [churn] = await localDetectors({
      subscription: group(5, 9),
    }).detectRapidChurn(NOW);
    assert.equal(referral.confidence, 75);
    assert.equal(promo.confidence, 70);
    assert.equal(churn.confidence, 60);
    assert.equal(referral.severity, FraudSignalSeverity.MEDIUM);
    assert.equal(promo.severity, FraudSignalSeverity.MEDIUM);
    assert.equal(churn.severity, FraudSignalSeverity.LOW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  HWID device overage
// ─────────────────────────────────────────────────────────────────────────────

interface PanelUser {
  uuid: string;
  panelId: number | null;
  hwidDeviceLimit: number;
}

interface TopUser {
  userUuid: string;
  username: string;
  telegramId: null;
  devicesCount: number;
  lastSeenAt: null;
}

interface IpRow {
  userId: number;
  ips: Array<{ ip: string; lastSeen: string }>;
}

function sharingDetectors(input: {
  topUsers?: TopUser[];
  panelUsers?: PanelUser[];
  /** Panel-reported row count; defaults to the number of users handed over. */
  panelTotal?: number;
  /** `false` marks the bulk read as a PREFIX of the panel. */
  panelComplete?: boolean;
  nodes?: Array<{ uuid: string; isConnected: boolean; isDisabled: boolean }>;
  ipsByNode?: Record<string, IpRow[]>;
  stored?: StoredAntiFraudSettings;
}): SharingDetectors {
  const panelUsers = input.panelUsers ?? [];
  const prisma = {
    subscription: {
      findMany: () =>
        Promise.resolve(
          panelUsers.map((u) => ({
            remnawaveId: u.uuid,
            userId: `rezeis-${u.uuid}`,
            deviceLimitReducedAt: null,
            deviceLimitBeforeReduction: null,
          })),
        ),
    },
    remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const api = {
    getHwidTopUsers: () => Promise.resolve(input.topUsers ?? []),
    strictGetAllPanelUsers: () =>
      Promise.resolve(
        strictOk({
          users: panelUsers,
          total: input.panelTotal ?? panelUsers.length,
          complete: input.panelComplete ?? true,
        }),
      ),
    getAllNodes: () =>
      Promise.resolve(
        (input.nodes ?? [{ uuid: 'n1', isConnected: true, isDisabled: false }]).map((n) => ({
          ...n,
          name: n.uuid,
          countryCode: 'DE',
          lastStatusChange: LONG_AGO,
        })),
      ),
    fetchUsersIpsForNode: (uuid: string) => Promise.resolve(input.ipsByNode?.[uuid] ?? []),
  } as unknown as RemnawaveApiService;

  const version = {
    getCapabilities: () => Promise.resolve({ liveIpControl: true, bandwidthNodesUsers: true }),
  } as unknown as RemnawaveVersionService;

  return new SharingDetectors(prisma, api, version, tunablesFromEnv(input.stored));
}

/** One offender at `devices` against `limit`, on an otherwise empty panel. */
async function hwidCandidate(
  devices: number,
  limit: number,
  extra: { panelTotal?: number; panelComplete?: boolean } = {},
) {
  const [candidate] = await sharingDetectors({
    topUsers: [
      { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: devices, lastSeenAt: null },
    ],
    panelUsers: [{ uuid: 'u1', panelId: 1, hwidDeviceLimit: limit }],
    ...extra,
  }).detectHwidOverage(NOW);
  return candidate;
}

describe('confidence — HWID device overage', () => {
  // Margin over the threshold, with the absolute surplus pinned. One device over
  // a limit of ten and one device over a limit of two are the same surplus and
  // very different overages.
  it('rises with the margin over the limit at a fixed surplus', async () => {
    const shallow = await hwidCandidate(11, 10);
    const steep = await hwidCandidate(3, 2);
    assert.deepEqual(shallow.metadata.confidenceFactors, {
      overageRatio: { observed: 1.1, strength: 0.05 },
      overageSurplus: { observed: 1, strength: 0 },
    });
    assert.deepEqual(steep.metadata.confidenceFactors, {
      overageRatio: { observed: 1.5, strength: 0.25 },
      overageSurplus: { observed: 1, strength: 0 },
    });
    assert.ok(
      shallow.confidence < steep.confidence,
      `expected 11/10 (${shallow.confidence}) to be weaker than 3/2 (${steep.confidence})`,
    );
    assert.equal(shallow.confidence, 33);
    assert.equal(steep.confidence, 38);
  });

  // Absolute surplus, with the ratio pinned. Doubling a limit of two is two
  // extra registrations; doubling a limit of ten is ten.
  it('rises with the absolute surplus at a fixed margin', async () => {
    const small = await hwidCandidate(4, 2);
    const large = await hwidCandidate(20, 10);
    assert.deepEqual(small.metadata.confidenceFactors, {
      overageRatio: { observed: 2, strength: 0.5 },
      overageSurplus: { observed: 2, strength: 0.25 },
    });
    assert.deepEqual(large.metadata.confidenceFactors, {
      overageRatio: { observed: 2, strength: 0.5 },
      overageSurplus: { observed: 10, strength: 1 },
    });
    assert.ok(small.confidence < large.confidence);
    assert.equal(small.confidence, 50);
    assert.equal(large.confidence, 68);
    // Both are `devices >= limit * 2`, i.e. the same HIGH branch. Severity did
    // not move; only the confidence did.
    assert.equal(small.severity, FraudSignalSeverity.HIGH);
    assert.equal(large.severity, FraudSignalSeverity.HIGH);
  });

  // The panel bulk read returns `ok` with `complete: false` when the page walk
  // stopped at its ceiling, so a truncated read passes the trustworthiness
  // guard and reaches the judgement. It is weaker ground and now says so.
  it('falls when the panel user list was a truncated prefix', async () => {
    const whole = await hwidCandidate(9, 2);
    const quarter = await hwidCandidate(9, 2, { panelComplete: false, panelTotal: 4 });
    assert.equal(whole.confidence, 80, 'precondition: a complete read reaches the old literal');
    assert.equal(whole.metadata.confidenceDataQuality, 1);
    // 1 row held of a reported 4 → quality 0.5 + 0.5 × 0.25.
    assert.equal(quarter.metadata.confidenceDataQuality, 0.25);
    assert.equal(quarter.confidence, 50);
    // Same panel state, same accusation, same severity — only the ground it
    // rests on changed.
    assert.equal(quarter.severity, whole.severity);
    assert.equal(quarter.score, whole.score);
  });

  // A prefix whose size the panel would not report: we know the list is short
  // and cannot say by how much, which is worth exactly as much as knowing we
  // hold half of it.
  it('assumes half a panel when a truncated read cannot be sized', async () => {
    const unsized = await hwidCandidate(9, 2, { panelComplete: false });
    assert.equal(unsized.metadata.confidenceDataQuality, 0.5);
    assert.equal(unsized.confidence, 60);
  });

  // Two accusations on one panel are two independent readings. A second, worse
  // offender appearing must not lend its evidence to the first.
  it('does not move because somebody else on the panel is also over', async () => {
    const alone = await hwidCandidate(3, 2);
    const [first] = await sharingDetectors({
      topUsers: [
        { userUuid: 'u1', username: 'alice', telegramId: null, devicesCount: 3, lastSeenAt: null },
        { userUuid: 'u2', username: 'bob', telegramId: null, devicesCount: 40, lastSeenAt: null },
      ],
      panelUsers: [
        { uuid: 'u1', panelId: 1, hwidDeviceLimit: 2 },
        { uuid: 'u2', panelId: 2, hwidDeviceLimit: 2 },
      ],
    }).detectHwidOverage(NOW);
    assert.equal(first.metadata.remnawaveUsername, 'alice');
    assert.equal(first.confidence, alone.confidence);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Concurrent-IP sharing
// ─────────────────────────────────────────────────────────────────────────────

const IP_ON = { sharing: { enableIpSharing: true } } satisfies StoredAntiFraudSettings;

/** `secondsAgo` before {@link NOW}, as the panel's ISO string. */
function ago(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

async function ipCandidate(
  ips: Array<{ ip: string; lastSeen: string }>,
  extra: { limit?: number; panelTotal?: number; panelComplete?: boolean; filler?: number } = {},
) {
  const panelUsers: PanelUser[] = [
    { uuid: 'u1', panelId: 1, hwidDeviceLimit: extra.limit ?? 2 },
    ...Array.from({ length: extra.filler ?? 0 }, (_, i) => ({
      uuid: `filler-${i}`,
      panelId: 100 + i,
      hwidDeviceLimit: 2,
    })),
  ];
  const [candidate] = await sharingDetectors({
    panelUsers,
    panelTotal: extra.panelTotal,
    panelComplete: extra.panelComplete,
    ipsByNode: { n1: [{ userId: 1, ips }] },
    stored: IP_ON,
  }).detectConcurrentIpSharing(NOW);
  return candidate;
}

/** `count` distinct /24s, one live sighting each. */
function oneIpPerNetwork(count: number) {
  return Array.from({ length: count }, (_, i) => ({ ip: `10.0.${i + 1}.1`, lastSeen: ago(10) }));
}

describe('confidence — concurrent-IP sharing', () => {
  // The brief's own example, and this detector's biggest exposure: the same
  // four-network count backed by four sightings and by sixteen.
  it('rises with how many sightings back each network', async () => {
    const thin = await ipCandidate(oneIpPerNetwork(4));
    const thick = await ipCandidate(
      Array.from({ length: 16 }, (_, i) => ({
        ip: `10.0.${(i % 4) + 1}.${Math.floor(i / 4) + 1}`,
        lastSeen: ago(10),
      })),
    );
    assert.equal(thin.metadata.distinctNetworkCount, 4, 'precondition: same network count');
    assert.equal(thick.metadata.distinctNetworkCount, 4);
    assert.equal(thin.confidence, 40);
    assert.equal(thick.confidence, 52);
    assert.ok(thin.confidence < thick.confidence);
  });

  // Margin over `deviceLimit + ipOverageMargin`, holding sightings-per-network
  // and retention at their base values.
  it('rises with the margin over the tolerated network count', async () => {
    const narrow = await ipCandidate(oneIpPerNetwork(4));
    const wide = await ipCandidate(oneIpPerNetwork(8));
    assert.equal(narrow.confidence, 40);
    assert.equal(wide.confidence, 48);
    assert.ok(narrow.confidence < wide.confidence);
  });

  // Retention: a cluster that IS the user's whole recent activity against one
  // picked out of a roamer's tail. The extra sightings are inside the 10-minute
  // staleness bound but outside the 180-second concurrency window, so they
  // count as observed and are not part of the network count.
  it('falls when the concurrent cluster is a small part of what was seen', async () => {
    const clean = await ipCandidate(oneIpPerNetwork(4));
    const roamer = await ipCandidate([
      ...oneIpPerNetwork(4),
      ...Array.from({ length: 12 }, (_, i) => ({
        ip: `10.9.${i + 1}.1`,
        lastSeen: ago(400),
      })),
    ]);
    assert.equal(roamer.metadata.distinctNetworkCount, 4, 'precondition: same network count');
    assert.equal(roamer.metadata.observedIpCount, 16);
    assert.equal(clean.confidence, 40);
    assert.equal(roamer.confidence, 34);
    assert.ok(roamer.confidence < clean.confidence);
  });

  it('falls when the panel user list was a truncated prefix', async () => {
    const whole = await ipCandidate(oneIpPerNetwork(4));
    const quarter = await ipCandidate(oneIpPerNetwork(4), {
      panelComplete: false,
      panelTotal: 4,
    });
    assert.equal(quarter.confidence, 25);
    assert.ok(quarter.confidence < whole.confidence);
    assert.equal(quarter.severity, whole.severity);
  });

  // This detector judges one user against that user's own limit — it is not
  // cohort-relative, so the size of the panel it happens to sit on is not
  // evidence about them either way.
  it('does not move with how many other accounts the panel holds', async () => {
    const small = await ipCandidate(oneIpPerNetwork(4));
    const large = await ipCandidate(oneIpPerNetwork(4), { filler: 40 });
    assert.equal(large.confidence, small.confidence);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Per-user node traffic
// ─────────────────────────────────────────────────────────────────────────────

function trafficDetectors(input: {
  cohort: Array<{ username: string; total: number }>;
  nodes?: Array<{ uuid: string; isConnected: boolean; isDisabled: boolean }>;
  stored?: StoredAntiFraudSettings;
}): RemnawaveDetectors {
  const prisma = {
    remnawaveMetricSample: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const api = {
    getAllNodes: () =>
      Promise.resolve(
        (input.nodes ?? [{ uuid: 'a1', isConnected: true, isDisabled: false }]).map((n) => ({
          ...n,
          name: n.uuid,
          countryCode: 'DE',
          lastStatusChange: LONG_AGO,
          usersOnline: 10,
          trafficLimitBytes: null,
          trafficUsedBytes: null,
        })),
      ),
    getNodeUsersBandwidth: () => Promise.resolve(input.cohort),
  } as unknown as RemnawaveApiService;

  const version = {
    getCapabilities: () => Promise.resolve({ bandwidthNodesUsers: true }),
  } as unknown as RemnawaveVersionService;

  return new RemnawaveDetectors(prisma, api, version, tunablesFromEnv(input.stored));
}

/** One heavy account plus `tail` ordinary ones. */
function cohortOf(heavyGb: number, tail: number, ordinaryGb: number) {
  return [
    { username: 'heavy', total: heavyGb * GB },
    ...Array.from({ length: tail }, (_, i) => ({
      username: `ordinary-${i}`,
      total: ordinaryGb * GB,
    })),
  ];
}

/**
 * `sharePercent: 100` makes the share test *usable* (its cohort gate is 3) but
 * unsatisfiable while anybody else has traffic, so the cohort-size and
 * median-margin factors can be moved one at a time without the share factor
 * changing underneath.
 */
const SHARE_TEST_NEUTRALISED = {
  trafficAbuse: { sharePercent: 100 },
} satisfies StoredAntiFraudSettings;

describe('confidence — per-user node traffic', () => {
  // The cohort is the population both relative tests are measured against, and
  // the class header already warns it is the number that collapses when a node
  // drops. Five samples is the bare minimum; fifty is a population.
  it('rises with the size of the cohort the user was judged against', async () => {
    const [tiny] = await trafficDetectors({
      cohort: cohortOf(1000, 4, 100),
      stored: SHARE_TEST_NEUTRALISED,
    }).detectPerUserNodeTrafficAbuse(NOW);
    const [large] = await trafficDetectors({
      cohort: cohortOf(1000, 49, 100),
      stored: SHARE_TEST_NEUTRALISED,
    }).detectPerUserNodeTrafficAbuse(NOW);
    assert.equal(tiny.metadata.cohortSize, 5, 'precondition: at the minimum cohort');
    assert.equal(large.metadata.cohortSize, 50);
    assert.equal(tiny.confidence, 32);
    assert.equal(large.confidence, 40);
    assert.ok(tiny.confidence < large.confidence);
  });

  // Margin over the median multiplier, with the offender's OWN traffic held
  // identical — only the baseline it is compared against moves.
  it('rises with the margin over the cohort median', async () => {
    const [narrow] = await trafficDetectors({
      cohort: cohortOf(1000, 4, 250),
      stored: SHARE_TEST_NEUTRALISED,
    }).detectPerUserNodeTrafficAbuse(NOW);
    const [wide] = await trafficDetectors({
      cohort: cohortOf(1000, 4, 100),
      stored: SHARE_TEST_NEUTRALISED,
    }).detectPerUserNodeTrafficAbuse(NOW);
    assert.equal(narrow.metadata.totalBytes, wide.metadata.totalBytes, 'same offender');
    assert.equal(narrow.confidence, 26, 'exactly 4× the median is the weakest median hit');
    assert.equal(wide.confidence, 32);
    assert.ok(narrow.confidence < wide.confidence);
  });

  // The reference model's core claim, and the reason this is not just a margin
  // calculator: two independent tests agreeing is worth more than one.
  it('rises when both tests fire rather than one', async () => {
    const cohort = cohortOf(900, 8, 20);
    const [onlyMedian] = await trafficDetectors({
      cohort,
      stored: { trafficAbuse: { sharePercent: 95 } },
    }).detectPerUserNodeTrafficAbuse(NOW);
    const [both] = await trafficDetectors({ cohort }).detectPerUserNodeTrafficAbuse(NOW);
    assert.equal(onlyMedian.metadata.shareTestApplied, true, 'the share test ran, and missed');
    assert.equal(onlyMedian.confidence, 34);
    assert.equal(both.confidence, 42);
    assert.ok(onlyMedian.confidence < both.confidence);
    // The severity mapping is the untouched `extreme ? MEDIUM : LOW`.
    assert.equal(onlyMedian.severity, FraudSignalSeverity.LOW);
    assert.equal(both.severity, FraudSignalSeverity.MEDIUM);
  });

  // Both tests are cohort-relative, so traffic on nodes we never asked about is
  // missing from the user's total AND from the denominator.
  it('falls when only part of the connected node set was aggregated', async () => {
    const nodes = ['a1', 'b2', 'c3', 'd4'].map((uuid) => ({
      uuid,
      isConnected: true,
      isDisabled: false,
    }));
    const [whole] = await trafficDetectors({
      cohort: cohortOf(900, 8, 20),
      nodes,
    }).detectPerUserNodeTrafficAbuse(NOW);
    const [sliced] = await trafficDetectors({
      cohort: cohortOf(900, 8, 20),
      nodes,
      stored: { trafficAbuse: { maxNodesPerRun: 1 } },
    }).detectPerUserNodeTrafficAbuse(NOW);
    assert.equal(whole.metadata.confidenceDataQuality, 1);
    assert.equal(sliced.metadata.confidenceDataQuality, 0.25);
    assert.equal(whole.confidence, 42);
    assert.equal(sliced.confidence, 27);
    assert.ok(sliced.confidence < whole.confidence);
  });

  // Node coverage is the SCANNED share of the ELIGIBLE nodes. A node that was
  // never a candidate for scanning is not a gap in the read.
  it('does not move because of nodes that were never eligible to be scanned', async () => {
    const connectedOnly = ['a1', 'b2'].map((uuid) => ({
      uuid,
      isConnected: true,
      isDisabled: false,
    }));
    const [plain] = await trafficDetectors({
      cohort: cohortOf(900, 8, 20),
      nodes: connectedOnly,
    }).detectPerUserNodeTrafficAbuse(NOW);
    const [withDeadNodes] = await trafficDetectors({
      cohort: cohortOf(900, 8, 20),
      nodes: [
        ...connectedOnly,
        { uuid: 'x9', isConnected: false, isDisabled: false },
        { uuid: 'y8', isConnected: true, isDisabled: true },
      ],
    }).detectPerUserNodeTrafficAbuse(NOW);
    assert.equal(withDeadNodes.confidence, plain.confidence);
    assert.equal(withDeadNodes.metadata.confidenceDataQuality, 1);
  });

  // The panel returns the TOP N by traffic. A response AT the adapter's row
  // ceiling is the panel saying the list was cut — and the light tail it cuts is
  // exactly what makes the median a baseline.
  it('falls when the cohort came back at the panel row ceiling', async () => {
    const saturated = cohortOf(900, NODE_USERS_BANDWIDTH_TOP_LIMIT - 1, 20);
    const roomToSpare = cohortOf(900, NODE_USERS_BANDWIDTH_TOP_LIMIT - 2, 20);
    assert.equal(saturated.length, NODE_USERS_BANDWIDTH_TOP_LIMIT, 'precondition: at the ceiling');

    const [cut] = await trafficDetectors({ cohort: saturated }).detectPerUserNodeTrafficAbuse(NOW);
    const [whole] = await trafficDetectors({
      cohort: roomToSpare,
    }).detectPerUserNodeTrafficAbuse(NOW);
    assert.equal(cut.metadata.cohortRowsSaturated, true);
    assert.equal(whole.metadata.cohortRowsSaturated, false);
    assert.equal(cut.metadata.confidenceDataQuality, 0.5);
    assert.equal(cut.confidence, 31);
    assert.equal(whole.confidence, 42);
    assert.ok(cut.confidence < whole.confidence);
  });
});
