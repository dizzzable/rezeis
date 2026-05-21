import { Injectable } from '@nestjs/common';
import {
  FraudSignalSeverity,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { FraudSignalCandidate } from '../interfaces/fraud-signal.interface';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * Pure detector functions. Each returns 0 or more candidate signals
 * keyed by a stable `(code, fingerprint)` pair.
 *
 * Fingerprint strategy
 *   We bucket each detector by **affected user ids + UTC date**. That
 *   way the orchestrator deduplicates "same problem detected on
 *   the same day" but still creates a fresh row when the situation
 *   reappears the next day.
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
    return [
      {
        code: 'EXCESSIVE_FAILED_PAYMENTS',
        fingerprint: dailyFingerprint(now, userIds),
        severity: FraudSignalSeverity.HIGH,
        title: 'Excessive failed payments detected',
        description: `${grouped.length} user(s) with 5+ failed transactions in the last 24h`,
        score: clamp(50 + grouped.length * 5, 50, 100),
        confidence: 90,
        affectedUserIds: userIds,
        metadata: {
          windowHours: 24,
          minFailuresPerUser: 5,
          userCount: grouped.length,
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
    return [
      {
        code: 'RAPID_REFERRAL_VELOCITY',
        fingerprint: dailyFingerprint(now, userIds),
        severity: FraudSignalSeverity.MEDIUM,
        title: 'Rapid referral velocity detected',
        description: `${grouped.length} user(s) referred 10+ people in the last 24h`,
        score: 60 + Math.min(grouped.length * 4, 40),
        confidence: 75,
        affectedUserIds: userIds,
        metadata: {
          windowHours: 24,
          minReferralsPerUser: 10,
          userCount: grouped.length,
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
    return [
      {
        code: 'PROMO_ABUSE',
        fingerprint: dailyFingerprint(now, userIds),
        severity: FraudSignalSeverity.MEDIUM,
        title: 'Potential promocode abuse detected',
        description: `${grouped.length} user(s) activated 3+ promos in the last 6h`,
        score: 55 + Math.min(grouped.length * 3, 30),
        confidence: 70,
        affectedUserIds: userIds,
        metadata: {
          windowHours: 6,
          minActivationsPerUser: 3,
          userCount: grouped.length,
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
    return [
      {
        code: 'RAPID_CHURN',
        fingerprint: weeklyFingerprint(now, userIds),
        severity: FraudSignalSeverity.LOW,
        title: 'Rapid subscription churn detected',
        description: `${grouped.length} user(s) with 3+ expired subscriptions in the last 7 days`,
        score: 30 + Math.min(grouped.length * 2, 20),
        confidence: 60,
        affectedUserIds: userIds,
        metadata: {
          windowDays: 7,
          minExpiredPerUser: 3,
          userCount: grouped.length,
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
