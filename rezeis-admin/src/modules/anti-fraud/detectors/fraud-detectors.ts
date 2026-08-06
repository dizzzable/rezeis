import { Injectable } from '@nestjs/common';
import {
  FraudSignalSeverity,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { computeConfidence, ratioStrength } from '../confidence.util';
import { FraudSignalCandidate } from '../interfaces/fraud-signal.interface';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * Every detector in this file reads local Postgres and nothing else, so its
 * data quality is not a variable: either the query ran and returned the truth,
 * or it threw and the orchestrator recorded the detector as having observed
 * nothing. This is the `authoritative` evidence class in `AntiFraudService`,
 * and it is why no panel outage, node flap or truncated read can move any
 * confidence computed here.
 */
const LOCAL_READ_QUALITY = 1;

/**
 * Pure detector functions. Each returns 0 or more candidate signals
 * keyed by a stable `(code, fingerprint)` pair.
 *
 * Fingerprint strategy
 *   We bucket each detector by **affected user ids + UTC date**. That
 *   way the orchestrator deduplicates "same problem detected on
 *   the same day" but still creates a fresh row when the situation
 *   reappears the next day.
 *
 * Confidence strategy
 *   Each of these detectors makes ONE aggregate accusation covering every
 *   user the `having` clause returned, so it has exactly two independent
 *   things to be confident about, and they are weighed as such (see
 *   `confidence.util.ts` for the arithmetic):
 *
 *     • DEPTH — how far past the per-user threshold the flagged group
 *       actually is, taken as the group MEAN rather than its peak. The signal
 *       claims something about all N users, so one extreme member must not
 *       speak for the rest; the corollary — that adding a barely-qualifying
 *       user lowers confidence while raising the score — is the correct
 *       reading of a wider, shallower group.
 *     • BREADTH — how many distinct users show the pattern at once. A
 *       card-testing run, a referral farm and a promo sweep are all
 *       fundamentally population-scale events; one user clearing a threshold
 *       is the shape a benign explanation takes (an expiring card, a genuine
 *       burst of invites), so a lone user contributes nothing here and the
 *       signal lands near the bottom of its range.
 *
 *   Neither the thresholds in the `having` clauses nor the severities below
 *   depend on any of this — what gets flagged is exactly what was flagged
 *   before.
 */
@Injectable()
export class FraudDetectors {
  public constructor(private readonly prismaService: PrismaService) {}

  // ── Detector 1: Excessive failed payments ─────────────────────────────

  public async detectExcessiveFailedPayments(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const threshold = new Date(now.getTime() - ONE_DAY_MS);
    const grouped = await this.prismaService.transaction.groupBy({
      by: ['userId'],
      where: { status: TransactionStatus.FAILED, createdAt: { gte: threshold } },
      _count: { _all: true },
      having: { userId: { _count: { gte: 5 } } },
    });
    if (grouped.length === 0) return [];
    const userIds = grouped.map((g) => g.userId).sort();
    const meanFailures = meanGroupCount(grouped);
    // Depth ramps to 4× the threshold (20 failures in a day): a card-testing
    // script clears that inside a minute, an expiring card never does.
    const { confidence, explanation } = computeConfidence({
      ceiling: 90,
      dataQuality: LOCAL_READ_QUALITY,
      factors: [
        {
          name: 'failureDepth',
          observed: meanFailures,
          strength: ratioStrength(meanFailures / 5, 1, 4),
        },
        {
          name: 'affectedUsers',
          observed: grouped.length,
          strength: ratioStrength(grouped.length, 1, 5),
        },
      ],
    });
    return [
      {
        code: 'EXCESSIVE_FAILED_PAYMENTS',
        fingerprint: dailyFingerprint(now, userIds),
        severity: FraudSignalSeverity.HIGH,
        title: 'Excessive failed payments detected',
        description: `${grouped.length} user(s) with 5+ failed transactions in the last 24h`,
        score: clamp(50 + grouped.length * 5, 50, 100),
        confidence,
        affectedUserIds: userIds,
        metadata: {
          windowHours: 24,
          minFailuresPerUser: 5,
          userCount: grouped.length,
          meanFailuresPerUser: round1(meanFailures),
          ...explanation,
        },
      },
    ];
  }

  // ── Detector 2: Rapid referral velocity ───────────────────────────────

  public async detectRapidReferralVelocity(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const threshold = new Date(now.getTime() - ONE_DAY_MS);
    const grouped = await this.prismaService.referral.groupBy({
      by: ['referrerId'],
      where: { createdAt: { gte: threshold } },
      _count: { _all: true },
      having: { referrerId: { _count: { gte: 10 } } },
    });
    if (grouped.length === 0) return [];
    const userIds = grouped.map((g) => g.referrerId).sort();
    const meanReferrals = meanGroupCount(grouped);
    // 40 referrals in a day is beyond what any real social graph produces in
    // one sitting, so that is where depth is conclusive.
    const { confidence, explanation } = computeConfidence({
      ceiling: 75,
      dataQuality: LOCAL_READ_QUALITY,
      factors: [
        {
          name: 'referralDepth',
          observed: meanReferrals,
          strength: ratioStrength(meanReferrals / 10, 1, 4),
        },
        {
          name: 'affectedUsers',
          observed: grouped.length,
          strength: ratioStrength(grouped.length, 1, 5),
        },
      ],
    });
    return [
      {
        code: 'RAPID_REFERRAL_VELOCITY',
        fingerprint: dailyFingerprint(now, userIds),
        severity: FraudSignalSeverity.MEDIUM,
        title: 'Rapid referral velocity detected',
        description: `${grouped.length} user(s) referred 10+ people in the last 24h`,
        score: 60 + Math.min(grouped.length * 4, 40),
        confidence,
        affectedUserIds: userIds,
        metadata: {
          windowHours: 24,
          minReferralsPerUser: 10,
          userCount: grouped.length,
          meanReferralsPerUser: round1(meanReferrals),
          ...explanation,
        },
      },
    ];
  }

  // ── Detector 3: Promocode abuse ───────────────────────────────────────

  public async detectPromoAbuse(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const threshold = new Date(now.getTime() - 6 * ONE_HOUR_MS);
    const grouped = await this.prismaService.promocodeActivation.groupBy({
      by: ['userId'],
      where: { activatedAt: { gte: threshold } },
      _count: { _all: true },
      having: { userId: { _count: { gte: 3 } } },
    });
    if (grouped.length === 0) return [];
    const userIds = grouped.map((g) => g.userId).sort();
    const meanActivations = meanGroupCount(grouped);
    // 12 activations in six hours is a sweep of the whole promo catalogue;
    // three is one campaign a customer happened to qualify for three ways.
    const { confidence, explanation } = computeConfidence({
      ceiling: 70,
      dataQuality: LOCAL_READ_QUALITY,
      factors: [
        {
          name: 'activationDepth',
          observed: meanActivations,
          strength: ratioStrength(meanActivations / 3, 1, 4),
        },
        {
          name: 'affectedUsers',
          observed: grouped.length,
          strength: ratioStrength(grouped.length, 1, 5),
        },
      ],
    });
    return [
      {
        code: 'PROMO_ABUSE',
        fingerprint: dailyFingerprint(now, userIds),
        severity: FraudSignalSeverity.MEDIUM,
        title: 'Potential promocode abuse detected',
        description: `${grouped.length} user(s) activated 3+ promos in the last 6h`,
        score: 55 + Math.min(grouped.length * 3, 30),
        confidence,
        affectedUserIds: userIds,
        metadata: {
          windowHours: 6,
          minActivationsPerUser: 3,
          userCount: grouped.length,
          meanActivationsPerUser: round1(meanActivations),
          ...explanation,
        },
      },
    ];
  }

  // ── Detector 4: Rapid subscription churn ──────────────────────────────

  public async detectRapidChurn(now: Date): Promise<readonly FraudSignalCandidate[]> {
    const threshold = new Date(now.getTime() - 7 * ONE_DAY_MS);
    const grouped = await this.prismaService.subscription.groupBy({
      by: ['userId'],
      where: { status: SubscriptionStatus.EXPIRED, updatedAt: { gte: threshold } },
      _count: { _all: true },
      having: { userId: { _count: { gte: 3 } } },
    });
    if (grouped.length === 0) return [];
    const userIds = grouped.map((g) => g.userId).sort();
    const meanExpired = meanGroupCount(grouped);
    // Ramped to 3× rather than the 4× the other three use. A subscription is a
    // billing-cycle-scale object, so nine expiries inside a week is already the
    // top of what the mechanism can produce; asking for twelve would put the
    // conclusive end of this factor out of reach and flatten it into a constant.
    const { confidence, explanation } = computeConfidence({
      ceiling: 60,
      dataQuality: LOCAL_READ_QUALITY,
      factors: [
        {
          name: 'churnDepth',
          observed: meanExpired,
          strength: ratioStrength(meanExpired / 3, 1, 3),
        },
        {
          name: 'affectedUsers',
          observed: grouped.length,
          strength: ratioStrength(grouped.length, 1, 5),
        },
      ],
    });
    return [
      {
        code: 'RAPID_CHURN',
        fingerprint: weeklyFingerprint(now, userIds),
        severity: FraudSignalSeverity.LOW,
        title: 'Rapid subscription churn detected',
        description: `${grouped.length} user(s) with 3+ expired subscriptions in the last 7 days`,
        score: 30 + Math.min(grouped.length * 2, 20),
        confidence,
        affectedUserIds: userIds,
        metadata: {
          windowDays: 7,
          minExpiredPerUser: 3,
          userCount: grouped.length,
          meanExpiredPerUser: round1(meanExpired),
          ...explanation,
        },
      },
    ];
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Mean of the per-user `_count._all` across a `groupBy` result — how deep past
 * its threshold the flagged group sits, on average.
 *
 * The count is the one field every `having` clause in this file filters on, so
 * it is guaranteed present and guaranteed at or above the threshold. A row
 * whose count is missing or unreadable contributes `0`, which drags the mean
 * toward the weak end: an input we cannot read must never be able to make an
 * accusation more confident. An empty group returns `0` and never divides by
 * zero, though no caller reaches it (they all return early on `length === 0`).
 */
function meanGroupCount(grouped: readonly { readonly _count: { readonly _all: number } }[]): number {
  if (grouped.length === 0) return 0;
  let sum = 0;
  for (const row of grouped) {
    const count = row._count?._all;
    if (typeof count === 'number' && Number.isFinite(count)) sum += count;
  }
  return sum / grouped.length;
}

/** One decimal — enough to show a mean is not an integer, small in JSON. */
function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/**
 * Stable fingerprint for daily-bucketed detectors. The set of affected
 * users is part of the key so distinct user populations create distinct
 * signals on the same day.
 */
function dailyFingerprint(now: Date, userIds: readonly string[]): string {
  const day = now.toISOString().slice(0, 10);
  return `${day}|${hashIds(userIds)}`;
}

function weeklyFingerprint(now: Date, userIds: readonly string[]): string {
  // Simple ISO week bucket — Sunday-anchored is fine for our LOW-severity
  // detector; we prioritise stability over calendar exactness.
  const week = isoWeekKey(now);
  return `${week}|${hashIds(userIds)}`;
}

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Tiny non-cryptographic hash. We only need a stable short summary of
 * the affected-user set; Postgres stores the row keyed by
 * (code, fingerprint) and 16 hex chars give us enough uniqueness for
 * our daily/weekly buckets.
 */
function hashIds(userIds: readonly string[]): string {
  const joined = userIds.join('|');
  let h = 2166136261;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0).toString(16)).padStart(8, '0');
}
