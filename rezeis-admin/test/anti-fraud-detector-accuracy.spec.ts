import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FraudSignalStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminFraudController } from '../src/modules/anti-fraud/controllers/admin-fraud.controller';
import { MIN_ADJUDICATED_FOR_RATE } from '../src/modules/anti-fraud/interfaces/detector-accuracy.interface';
import { DetectorAccuracyService } from '../src/modules/anti-fraud/services/detector-accuracy.service';
import type { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from '../src/modules/rbac/decorators/require-permission.decorator';

/**
 * The feedback loop nobody had: how often was each detector WRONG, measured
 * from the verdicts operators already recorded.
 *
 * Three things have to hold or the number misleads the person tuning the
 * thresholds, which is worse than having no number at all:
 *
 *   1. an operator's dismissal ("false positive") and the detector run's own
 *      auto-close (`resolvedBy = null`) are counted as different things;
 *   2. the denominator is the signals a HUMAN ruled on — never the open queue,
 *      whose size tracks the operator's backlog and not the detector;
 *   3. a code with too few verdicts reports "not enough data", not a
 *      percentage.
 *
 * And the whole surface is READ-ONLY: the Prisma double below throws on every
 * write method, so a single stray `update` fails the suite rather than silently
 * mutating what the report measures.
 */

/** One `fraud_signals` row, reduced to the fields this report reads. */
interface Row {
  code: string;
  status: FraudSignalStatus;
  /** `null` = the system closed it; a string = an operator did. */
  resolvedBy: string | null;
  detectedAt: Date;
}

const NOW = new Date();
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function rows(spec: {
  code: string;
  status: FraudSignalStatus;
  resolvedBy?: string | null;
  count: number;
  detectedAt?: Date;
}): Row[] {
  return Array.from({ length: spec.count }, () => ({
    code: spec.code,
    status: spec.status,
    resolvedBy: spec.resolvedBy ?? null,
    detectedAt: spec.detectedAt ?? daysAgo(1),
  }));
}

/**
 * A `fraudSignal.groupBy` double that actually applies the `where` clause the
 * service sends — window, `status` and `resolvedBy: null` — because the point
 * of most of these cases is precisely which rows the filter selects. A mock
 * that ignored the filter would make every assertion below vacuous, which is
 * exactly the "green test whose branch production never reaches" shape.
 *
 * Every write method throws. `groupBy` is the only thing this service may do.
 */
function prismaFor(all: Row[]): PrismaService {
  const refuse = (name: string) => (): never => {
    throw new Error(`DetectorAccuracyService must be read-only, but called fraudSignal.${name}`);
  };
  return {
    fraudSignal: {
      groupBy: (args: {
        by: readonly string[];
        where: Prisma.FraudSignalWhereInput;
      }): Promise<unknown[]> => {
        const where = args.where;
        const detectedAt = where.detectedAt as { gte: Date; lte: Date };
        const matching = all.filter((row) => {
          if (row.detectedAt < detectedAt.gte || row.detectedAt > detectedAt.lte) return false;
          if (where.status !== undefined && row.status !== where.status) return false;
          if (where.resolvedBy === null && row.resolvedBy !== null) return false;
          return true;
        });
        const counts = new Map<string, { code: string; status: FraudSignalStatus; n: number }>();
        for (const row of matching) {
          const key = args.by.includes('status') ? `${row.code}|${row.status}` : row.code;
          const entry = counts.get(key) ?? { code: row.code, status: row.status, n: 0 };
          entry.n += 1;
          counts.set(key, entry);
        }
        return Promise.resolve(
          [...counts.values()].map((entry) =>
            args.by.includes('status')
              ? { code: entry.code, status: entry.status, _count: { _all: entry.n } }
              : { code: entry.code, _count: { _all: entry.n } },
          ),
        );
      },
      update: refuse('update'),
      updateMany: refuse('updateMany'),
      create: refuse('create'),
      createMany: refuse('createMany'),
      upsert: refuse('upsert'),
      delete: refuse('delete'),
      deleteMany: refuse('deleteMany'),
    },
  } as unknown as PrismaService;
}

const service = (all: Row[]): DetectorAccuracyService =>
  new DetectorAccuracyService(prismaFor(all));

describe('detector accuracy — counting', () => {
  it('counts every status of one code separately', async () => {
    const report = await service([
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.OPEN, count: 4 }),
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.ACKNOWLEDGED, count: 3 }),
      ...rows({
        code: 'PROMO_ABUSE',
        status: FraudSignalStatus.RESOLVED,
        resolvedBy: 'admin-1',
        count: 6,
      }),
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.RESOLVED, count: 5 }),
      ...rows({
        code: 'PROMO_ABUSE',
        status: FraudSignalStatus.DISMISSED,
        resolvedBy: 'admin-1',
        count: 2,
      }),
    ]).getReport(30);

    assert.equal(report.rows.length, 1);
    const [row] = report.rows;
    assert.equal(row.code, 'PROMO_ABUSE');
    assert.equal(row.total, 20);
    assert.equal(row.open, 4);
    assert.equal(row.acknowledged, 3);
    assert.equal(row.resolved, 11);
    assert.equal(row.operatorResolved, 6);
    assert.equal(row.autoResolved, 5);
    assert.equal(row.dismissed, 2);
    assert.equal(row.systemDismissed, 0);
    assert.equal(row.adjudicated, 8);
  });

  it('keeps codes apart', async () => {
    const report = await service([
      ...rows({ code: 'RAPID_CHURN', status: FraudSignalStatus.OPEN, count: 2 }),
      ...rows({
        code: 'SUBSCRIPTION_SHARING_HWID',
        status: FraudSignalStatus.DISMISSED,
        resolvedBy: 'admin-1',
        count: 5,
      }),
    ]).getReport(30);

    assert.deepEqual(
      report.rows.map((r) => [r.code, r.total, r.open, r.dismissed]),
      [
        ['SUBSCRIPTION_SHARING_HWID', 5, 0, 5],
        ['RAPID_CHURN', 2, 2, 0],
      ],
      'busiest code first, then alphabetical',
    );
  });

  // The window is on `detectedAt`, so the report is about one cohort — the
  // signals raised in the period — and every status count describes what became
  // of THOSE signals.
  it('ignores signals raised outside the window', async () => {
    const all = [
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.OPEN, count: 3, detectedAt: daysAgo(2) }),
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.OPEN, count: 9, detectedAt: daysAgo(40) }),
    ];
    assert.equal((await service(all).getReport(7)).rows[0].total, 3);
    assert.equal((await service(all).getReport(90)).rows[0].total, 12);
  });

  it('returns an empty report for a window in which nothing fired', async () => {
    const report = await service(
      rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.OPEN, count: 5, detectedAt: daysAgo(60) }),
    ).getReport(7);
    assert.deepEqual(report.rows, []);
    assert.equal(report.windowDays, 7);
    assert.equal(report.minAdjudicatedForRate, MIN_ADJUDICATED_FOR_RATE);
    assert.ok(new Date(report.since) < new Date(report.until));
  });

  it('returns an empty report when there are no signals at all', async () => {
    const report = await service([]).getReport(30);
    assert.deepEqual(report.rows, []);
  });

  it('clamps the window rather than trusting the caller', async () => {
    assert.equal((await service([]).getReport(0)).windowDays, 1);
    assert.equal((await service([]).getReport(9999)).windowDays, 90);
    assert.equal((await service([]).getReport(Number.NaN)).windowDays, 30);
  });
});

describe('detector accuracy — the false-positive rate', () => {
  /** `dismissed` operator dismissals against `resolved` operator resolutions. */
  const rate = async (dismissed: number, resolved: number): Promise<number | null> => {
    const report = await service([
      ...rows({
        code: 'SUBSCRIPTION_SHARING_IP',
        status: FraudSignalStatus.DISMISSED,
        resolvedBy: 'admin-1',
        count: dismissed,
      }),
      ...rows({
        code: 'SUBSCRIPTION_SHARING_IP',
        status: FraudSignalStatus.RESOLVED,
        resolvedBy: 'admin-1',
        count: resolved,
      }),
    ]).getReport(30);
    return report.rows[0]?.falsePositiveRate ?? null;
  };

  it('is dismissals over the verdicts an operator actually made', async () => {
    assert.equal(await rate(6, 6), 50);
    assert.equal(await rate(3, 27), 10);
    assert.equal(await rate(0, 12), 0, 'a detector nobody dismissed reads 0, not null');
    assert.equal(await rate(15, 0), 100);
  });

  // The distinction the whole report rests on. Both of these look like "the
  // signal is no longer a problem" in the status column; only one is a person
  // saying the detector was right.
  it('does not count the system’s own auto-resolutions as operator verdicts', async () => {
    const report = await service([
      ...rows({
        code: 'NODE_TRAFFIC_USER_ABUSE',
        status: FraudSignalStatus.DISMISSED,
        resolvedBy: 'admin-1',
        count: 5,
      }),
      ...rows({
        code: 'NODE_TRAFFIC_USER_ABUSE',
        status: FraudSignalStatus.RESOLVED,
        resolvedBy: 'admin-1',
        count: 5,
      }),
      // 500 auto-closes: a detector whose condition simply stopped being
      // observed. Folding these into the denominator would report a 1% false
      // positive rate for a detector operators dismiss half the time.
      ...rows({ code: 'NODE_TRAFFIC_USER_ABUSE', status: FraudSignalStatus.RESOLVED, count: 500 }),
    ]).getReport(30);
    const [row] = report.rows;
    assert.equal(row.autoResolved, 500);
    assert.equal(row.operatorResolved, 5);
    assert.equal(row.adjudicated, 10);
    assert.equal(row.falsePositiveRate, 50);
  });

  // The queue's size is a fact about the operator, not about the detector.
  it('does not move when the undecided backlog grows', async () => {
    const verdicts = [
      ...rows({
        code: 'PROMO_ABUSE',
        status: FraudSignalStatus.DISMISSED,
        resolvedBy: 'admin-1',
        count: 4,
      }),
      ...rows({
        code: 'PROMO_ABUSE',
        status: FraudSignalStatus.RESOLVED,
        resolvedBy: 'admin-1',
        count: 6,
      }),
    ];
    const quiet = await service(verdicts).getReport(30);
    const swamped = await service([
      ...verdicts,
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.OPEN, count: 200 }),
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.ACKNOWLEDGED, count: 50 }),
    ]).getReport(30);
    assert.equal(quiet.rows[0].falsePositiveRate, 40);
    assert.equal(swamped.rows[0].falsePositiveRate, 40);
    assert.equal(swamped.rows[0].open, 200, 'the backlog is still reported, just not divided by');
  });

  // "A code with too few signals to be meaningful must say so rather than
  // showing a percentage computed from two data points."
  it('reports null rather than a percentage below the minimum sample', async () => {
    assert.equal(MIN_ADJUDICATED_FOR_RATE, 10);
    assert.equal(await rate(2, 1), null, '3 verdicts cannot support a percentage');
    assert.equal(await rate(0, 9), null);
    assert.equal(await rate(1, 9), 10, 'exactly at the minimum, the rate appears');
  });

  // `null` is "we cannot say", `0` is "operators never dismissed one". Collapsing
  // them would tell somebody tuning a brand-new detector that it is perfect.
  it('distinguishes “not enough data” from “no false positives”', async () => {
    const sparse = await rate(0, 2);
    const clean = await rate(0, 40);
    assert.equal(sparse, null);
    assert.equal(clean, 0);
    assert.notEqual(sparse, clean);
  });

  // Nothing writes a system dismissal today, but `transitionStatus` takes
  // `adminId: string | null`, so one caller away it could — and it must not
  // land silently in the false-positive numerator.
  it('keeps a null-resolver dismissal out of the operator numerator', async () => {
    const report = await service([
      ...rows({
        code: 'RAPID_CHURN',
        status: FraudSignalStatus.DISMISSED,
        resolvedBy: 'admin-1',
        count: 2,
      }),
      ...rows({ code: 'RAPID_CHURN', status: FraudSignalStatus.DISMISSED, count: 8 }),
      ...rows({
        code: 'RAPID_CHURN',
        status: FraudSignalStatus.RESOLVED,
        resolvedBy: 'admin-1',
        count: 8,
      }),
    ]).getReport(30);
    const [row] = report.rows;
    assert.equal(row.dismissed, 2, 'only the two an admin signed');
    assert.equal(row.systemDismissed, 8);
    assert.equal(row.adjudicated, 10);
    assert.equal(row.falsePositiveRate, 20, 'not the 50 an undivided DISMISSED count would give');
  });
});

describe('detector accuracy — access and side effects', () => {
  // The Prisma double throws on every write method, so reaching this assertion
  // at all is the proof. Stated as its own case because "read-only" is a
  // requirement of the surface, not an accident of the current implementation.
  it('never writes to a signal while reporting on it', async () => {
    const report = await service([
      ...rows({
        code: 'PROMO_ABUSE',
        status: FraudSignalStatus.DISMISSED,
        resolvedBy: 'admin-1',
        count: 12,
      }),
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.RESOLVED, count: 3 }),
      ...rows({ code: 'PROMO_ABUSE', status: FraudSignalStatus.OPEN, count: 7 }),
    ]).getReport(30);
    assert.equal(report.rows[0].total, 22);
  });

  // Checked against the neighbours rather than guessed: every read on
  // `AdminFraudController` takes `fraud_signals:view`, and this is a read.
  it('is gated on the same permission as the neighbouring fraud reads', () => {
    const proto = AdminFraudController.prototype as unknown as Record<string, unknown>;
    const permissionOf = (method: string): readonly RequiredPermission[] =>
      (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto[method] as object) ??
        []) as readonly RequiredPermission[];
    assert.deepEqual(permissionOf('getDetectorAccuracy'), [
      { resource: 'fraud_signals', action: 'view' },
    ]);
    assert.deepEqual(permissionOf('getDetectorAccuracy'), permissionOf('getStats'));
    assert.deepEqual(permissionOf('getDetectorAccuracy'), permissionOf('getTrend'));
  });

  it('defaults the window to 30 days and survives an unparseable one', async () => {
    const calls: number[] = [];
    const controller = new AdminFraudController({} as unknown as AntiFraudService, {
      getReport: (days: number) => {
        calls.push(days);
        return Promise.resolve({
          windowDays: days,
          since: NOW.toISOString(),
          until: NOW.toISOString(),
          minAdjudicatedForRate: MIN_ADJUDICATED_FOR_RATE,
          rows: [],
        });
      },
    } as unknown as DetectorAccuracyService);

    await controller.getDetectorAccuracy(undefined);
    await controller.getDetectorAccuracy('7');
    await controller.getDetectorAccuracy('not-a-number');
    assert.deepEqual(calls, [30, 7, 30]);
  });
});
