import { Injectable } from '@nestjs/common';
import { FraudSignalStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  DetectorAccuracyReport,
  DetectorAccuracyRow,
  MIN_ADJUDICATED_FOR_RATE,
} from '../interfaces/detector-accuracy.interface';

/**
 * Per-detector-code accuracy, read out of the signals an operator already
 * adjudicated.
 *
 * WHY THIS EXISTS. Neither this system nor the reference implementation it was
 * modelled on has any feedback loop: the detector thresholds are tuned by hand,
 * and whether a change made things better or worse has never been measurable.
 * We were one step from having it anyway — `FraudSignal` records `status`,
 * `resolvedBy` and `resolutionNote`, so every time an operator presses
 * "Dismiss — false positive" the verdict is written down. Nothing read it back.
 * This service is that read, and nothing more.
 *
 * READ-ONLY BY CONSTRUCTION. Every query below is a `groupBy`. Nothing here may
 * ever transition, resolve, dismiss or annotate a signal: an accuracy report
 * that changed the thing it measures would be worthless the first time somebody
 * opened it, and an operator has to be able to look at their own dismissal rate
 * without that being an action.
 *
 * WHAT COUNTS AS A FALSE POSITIVE, and what the denominator is.
 * ─────────────────────────────────────────────────────────────
 * The numerator is an OPERATOR dismissal. The admin UI labels the control
 * "Dismiss — false positive", so a dismissal is a human saying the detector was
 * wrong, and that is the only thing in this schema that means it.
 *
 * The denominator is NOT everything the detector raised. Three of the four
 * statuses are not verdicts about the detector at all:
 *
 *   • OPEN / ACKNOWLEDGED — nobody has decided yet. Counting these in the
 *     denominator would make a detector's measured accuracy rise and fall with
 *     the operator's BACKLOG, so a quiet week would look like a precision
 *     improvement and a busy one like a regression.
 *   • RESOLVED with `resolvedBy = null` — the SYSTEM closed it, not a person.
 *     `AntiFraudService.reconcileOpenSignals` writes exactly this when a run
 *     that could see the condition stopped producing it, and
 *     `transitionStatus` (the only path an operator's verdict takes) always
 *     stamps an admin id. That null is the whole difference between "an
 *     operator judged this" and "it went away on its own", and an auto-close
 *     is evidence of neither correctness nor error — the condition may have
 *     been real and simply ended.
 *
 * So the rate is `operatorDismissed / (operatorDismissed + operatorResolved)`:
 * of the signals a human actually ruled on, how many did they rule against the
 * detector. That is the only quotient in this schema that measures the detector
 * rather than the queue.
 *
 * DISMISSALS ARE SPLIT BY RESOLVER TOO, and deliberately, even though today
 * only `transitionStatus` can write DISMISSED and it always carries an admin
 * id. Its `adminId` parameter is typed `string | null`, so a future
 * system-authored dismissal is one caller away — and it would otherwise land
 * silently in the numerator and make every detector look worse the more
 * automation we add. Counting it separately costs one `groupBy` and makes the
 * distinction the brief asks for a fact rather than an assumption.
 */
@Injectable()
export class DetectorAccuracyService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Accuracy for the signals OPENED in the last `days` days.
   *
   * The window is on `detectedAt`, so the report is about one cohort — the
   * signals this detector raised in the period — and the status counts describe
   * what became of them. Windowing on `resolvedAt` instead would mix cohorts
   * (a signal raised in March and dismissed in June would count toward June's
   * accuracy) and would silently exclude every signal still open, which is the
   * one number an operator most wants next to the rate.
   */
  public async getReport(days: number): Promise<DetectorAccuracyReport> {
    const windowDays = clampDays(days);
    const until = new Date();
    const since = new Date(until.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const window: Prisma.FraudSignalWhereInput = { detectedAt: { gte: since, lte: until } };

    const [byStatus, autoResolved, systemDismissed] = await Promise.all([
      this.prismaService.fraudSignal.groupBy({
        by: ['code', 'status'],
        where: window,
        _count: { _all: true },
      }),
      // `resolvedBy: null` on a RESOLVED row is the system's own signature —
      // see the class header.
      this.prismaService.fraudSignal.groupBy({
        by: ['code'],
        where: { ...window, status: FraudSignalStatus.RESOLVED, resolvedBy: null },
        _count: { _all: true },
      }),
      this.prismaService.fraudSignal.groupBy({
        by: ['code'],
        where: { ...window, status: FraudSignalStatus.DISMISSED, resolvedBy: null },
        _count: { _all: true },
      }),
    ]);

    const autoResolvedByCode = countsByCode(autoResolved);
    const systemDismissedByCode = countsByCode(systemDismissed);

    const accumulator = new Map<string, MutableCounts>();
    for (const row of byStatus) {
      const counts = accumulator.get(row.code) ?? emptyCounts();
      counts[row.status] += row._count._all;
      accumulator.set(row.code, counts);
    }

    const rows: DetectorAccuracyRow[] = [];
    for (const [code, counts] of accumulator) {
      const resolved = counts.RESOLVED;
      // Clamped rather than trusted: the two reads are separate queries against
      // a live table, so a transition landing between them could in principle
      // make the subset larger than the set. A negative count is never a number
      // to show an operator.
      const autoResolvedCount = Math.min(autoResolvedByCode.get(code) ?? 0, resolved);
      const operatorResolved = resolved - autoResolvedCount;
      const dismissedTotal = counts.DISMISSED;
      const systemDismissedCount = Math.min(systemDismissedByCode.get(code) ?? 0, dismissedTotal);
      const dismissed = dismissedTotal - systemDismissedCount;
      const adjudicated = dismissed + operatorResolved;
      rows.push({
        code,
        total: counts.OPEN + counts.ACKNOWLEDGED + resolved + dismissedTotal,
        open: counts.OPEN,
        acknowledged: counts.ACKNOWLEDGED,
        resolved,
        operatorResolved,
        autoResolved: autoResolvedCount,
        dismissed,
        systemDismissed: systemDismissedCount,
        adjudicated,
        // `null`, never `0`, below the floor. A percentage derived from two
        // verdicts is not a measurement, and rendering one would invite exactly
        // the threshold change this report exists to inform.
        falsePositiveRate:
          adjudicated >= MIN_ADJUDICATED_FOR_RATE
            ? Math.round((dismissed / adjudicated) * 1000) / 10
            : null,
      });
    }

    // Busiest code first — the one generating the most operator work is the one
    // worth tuning — then alphabetically, so a tie is stable between reloads
    // rather than following whatever order Postgres grouped in.
    rows.sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));

    return {
      windowDays,
      since: since.toISOString(),
      until: until.toISOString(),
      minAdjudicatedForRate: MIN_ADJUDICATED_FOR_RATE,
      rows,
    };
  }
}

type MutableCounts = Record<FraudSignalStatus, number>;

function emptyCounts(): MutableCounts {
  return { OPEN: 0, ACKNOWLEDGED: 0, RESOLVED: 0, DISMISSED: 0 };
}

function countsByCode(
  rows: readonly { readonly code: string; readonly _count: { readonly _all: number } }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.code, (map.get(row.code) ?? 0) + row._count._all);
  return map;
}

/** Same 1–90 bound the trend endpoint uses, for the same reason. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(Math.trunc(days), 1), 90);
}
