import { Prisma } from '@prisma/client';

import {
  isRollingResetDay,
  nextRemnawaveReset,
  previousRemnawaveReset,
  REMNAWAVE_RESET_MINUTE,
  type RemnawaveResetScheduleInput,
  resolveRemnawaveTimeZone,
  type ResetStrategy,
} from '../domain/reset-cycle-policy';
import { ownTrafficResetSql } from '../services/own-traffic-resets';

/**
 * THE DAILY RESET-SCHEDULE CHECK — do Remnawave's real resets happen when
 * «Часовой пояс Remnawave» says they do?
 *
 * The panel predicts every reset from Remnawave's cron minutes and the zone the
 * operator set (`reset-cycle-policy.ts`), and nothing in Remnawave's API states
 * its zone. What the panel CAN see is the resets themselves: every answer of
 * Remnawave's carries `lastTrafficResetAt`, stamped on the subscription
 * (`remnawave_last_traffic_reset_at`). A scheduled run stamps the profiles it
 * resets with one instant per STATUS GROUP — the LIMITED ones about ten
 * milliseconds after the others, {@link RUN_STAMP_SPREAD_MS} — a few
 * milliseconds after the cron minute on Remnawave's clock. So a scheduled reset
 * is recognisable by its shape: within {@link SCHEDULED_RUN_SLACK_MS} of a
 * whole minute, and on a minute that is the strategy's cron minute in SOME real
 * zone (every zone's offset is a multiple of 15 minutes). A manual reset lands
 * on any second.
 *
 * …but not always: a renewal from the auto-renew cron (every minute, at second
 * 0) zeroes its counter a second or two after a whole minute, in the shape for
 * four minutes of every hour, and a single such reset made the check warn
 * about a correct zone — «так сбрасывает Remnawave в поясе UTC−02:15» — every
 * day on an install with auto-renew (review R3a-03). So what is judged is
 * evidence of a RUN:
 *  - the panel's own resets are left out by the reader (`own-traffic-resets.ts`:
 *    a renewal, the operator's «Сбросить», «Обнулить трафик»);
 *  - a reset that AGREES with the prediction is judged as it is: it can only
 *    ever say «ok»;
 *  - a reset in a run's shape that does not agree is judged only as a BATCH —
 *    its instant, give or take {@link RUN_STAMP_SPREAD_MS}, stamped on two or
 *    more profiles of the strategy, which one subscriber's reset never is —
 *    wherever a batch can exist: a calendar
 *    strategy with two or more profiles on the install
 *    ({@link ResetObservation.strategyProfiles}). An install with ONE profile
 *    on a strategy can show no batch; there a lone reset in the shape is
 *    judged, the panel's own already left out;
 *  - a rolling reset only on the profile's own day: the rolling job resets
 *    nobody else, so a reset on any other UTC date is no run at all. Its runs
 *    rarely share an instant (each profile has its own day), so the day is
 *    its evidence instead of the batch.
 *
 * Per strategy, the LATEST such observation is judged against the reset the
 * configured zone predicts nearest to it: within {@link RESET_SCHEDULE_AGREEMENT_MS}
 * it agrees; otherwise Remnawave runs on another clock, and the page warns
 * beside the zone field, naming what was observed and the zone that would
 * explain it. The latest one, so that fixing either side clears the warning at
 * once. 3.4.4's `subscription-refill-date` header is NOT used: it names rolling
 * days on the local clock and was proved wrong outside UTC (S4-lab, 25.09.2026).
 *
 * Nothing to warn about while no live subscription has a reset strategy.
 */

/** The strategies Remnawave resets on a schedule. */
export type ScheduledStrategy = Exclude<ResetStrategy, 'NO_RESET'>;

export const SCHEDULED_STRATEGIES: readonly ScheduledStrategy[] = ['DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING'];

/** How far back an observation counts: a day and a half, so that every zone's last daily run is inside it. */
export const RESET_SCHEDULE_WINDOW_MS = 36 * 60 * 60 * 1000;

/** How close to the predicted reset an observed one agrees with it. */
export const RESET_SCHEDULE_AGREEMENT_MS = 2 * 60 * 1000;

/** A scheduled run stamps its start: this close after a whole minute. */
export const SCHEDULED_RUN_SLACK_MS = 5_000;

/**
 * How far apart the instants ONE scheduled run stamps can lie (review R4-03).
 * A run stamps the profiles it resets with one instant per STATUS GROUP: the
 * ones that were LIMITED get their own, 7–10 ms after the others' (the S4 lab,
 * the same in 3.2.3, 3.3.2 and 3.4.4: `test/fixtures/remnawave-reset-lab`).
 * Instants this close count as one run. Two resets of different people are not
 * this close — the panel's own, a bulk toolbar's included, are left out before
 * this is asked (`own-traffic-resets.ts`); a bulk reset in Remnawave's own UI
 * is, and «Reset all users traffic» rightly reads as a run.
 */
export const RUN_STAMP_SPREAD_MS = 100;

/** One instant stamped on `profiles` profiles. */
export interface StampedInstant {
  readonly at: number;
  readonly profiles: number;
}

/**
 * How many profiles carry the run `at` belongs to: every stamp within
 * {@link RUN_STAMP_SPREAD_MS} of it, its own included. A run is two or more.
 */
export function profilesOfRun(stamps: readonly StampedInstant[], at: number): number {
  return stamps.reduce((sum, stamp) => (Math.abs(stamp.at - at) <= RUN_STAMP_SPREAD_MS ? sum + stamp.profiles : sum), 0);
}

/** One reset Remnawave reported for a profile. */
export interface ResetObservation {
  /** The strategy the panel pushes for the subscription (`planSnapshot.trafficLimitStrategy`). */
  readonly strategy: ScheduledStrategy;
  readonly observedAt: Date;
  /** The profile's `createdAt`: a rolling profile's anchor. */
  readonly createdAt: Date | null;
  /**
   * How many profiles on the install carry this strategy (linked, not
   * deleted) — whether a run of it can stamp two of them at all. Unknown
   * (absent) counts as "it can": a lone reset is then not taken for a run.
   */
  readonly strategyProfiles?: number;
}

/** A scheduled run at a time the configured zone does not predict. */
export interface ResetScheduleMismatch {
  readonly strategy: ScheduledStrategy;
  /** When Remnawave reset (ISO). */
  readonly observedAt: string;
  /** The reset the configured zone predicts nearest to it (ISO). */
  readonly expectedAt: string;
  /** The UTC offset, in minutes, under which the observed instant is the strategy's cron minute (Moscow: 180). */
  readonly impliedUtcOffsetMinutes: number;
}

export interface ResetScheduleVerdict {
  /**
   * `mismatch` — at least one strategy's latest scheduled run disagrees;
   * `ok` — every one judged agrees; `no_data` — no scheduled run observed in
   * the window; `nothing_to_check` — no live subscription resets on a schedule.
   */
  readonly status: 'ok' | 'mismatch' | 'no_data' | 'nothing_to_check';
  /** The zone the prediction used. */
  readonly timeZone: string;
  readonly checkedAt: string;
  readonly mismatches: readonly ResetScheduleMismatch[];
}

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

function isScheduledShape(strategy: ScheduledStrategy, observedAt: Date): boolean {
  const time = observedAt.getTime();
  if (((time % MINUTE_MS) + MINUTE_MS) % MINUTE_MS >= SCHEDULED_RUN_SLACK_MS) return false;
  const cron = REMNAWAVE_RESET_MINUTE[strategy];
  const minute = observedAt.getUTCMinutes();
  return [0, 15, 30, 45].some((step) => (cron + step) % 60 === minute);
}

/** The zone offset under which `observedAt` reads as the strategy's cron minute past midnight. */
export function impliedUtcOffsetMinutes(strategy: ScheduledStrategy, observedAt: Date): number {
  const cron = REMNAWAVE_RESET_MINUTE[strategy];
  const utcMinutes = observedAt.getUTCHours() * 60 + observedAt.getUTCMinutes();
  const offset = (((cron - utcMinutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  // Real zones run from UTC−12 to UTC+14.
  return offset > 14 * 60 ? offset - DAY_MINUTES : offset;
}

/** The reset the zone predicts nearest to `observedAt`, or `null` when there is none to compare with. */
function nearestPredicted(observation: ResetObservation, timeZone: string): Date | null {
  if (observation.strategy === 'MONTH_ROLLING' && observation.createdAt === null) return null;
  const schedule: RemnawaveResetScheduleInput = {
    strategy: observation.strategy,
    anchorAt: observation.strategy === 'MONTH_ROLLING' ? observation.createdAt : null,
    timeZone,
  };
  const before = previousRemnawaveReset(schedule, observation.observedAt);
  const after = nextRemnawaveReset(schedule, observation.observedAt);
  const candidates = [before, after].filter((value): value is Date => value !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate.getTime() - observation.observedAt.getTime()) <
    Math.abs(best.getTime() - observation.observedAt.getTime())
      ? candidate
      : best,
  );
}

/**
 * The verdict over the observations of the window — pure; the caller reads
 * them (`readResetObservations`). An unknown `timeZone` judges nothing and
 * says so as `no_data`: the money path refuses such a zone too.
 */
export function judgeResetSchedule(input: {
  readonly observations: readonly ResetObservation[];
  readonly timeZone: string | undefined;
  readonly resetScoped: boolean;
  readonly now: Date;
}): ResetScheduleVerdict {
  const base = { checkedAt: input.now.toISOString(), mismatches: [] as ResetScheduleMismatch[] };
  let zone: string;
  try {
    zone = resolveRemnawaveTimeZone(input.timeZone);
  } catch {
    return { ...base, status: input.resetScoped ? 'no_data' : 'nothing_to_check', timeZone: String(input.timeZone) };
  }
  if (!input.resetScoped) return { ...base, status: 'nothing_to_check', timeZone: zone };

  const since = input.now.getTime() - RESET_SCHEDULE_WINDOW_MS;
  let judged = 0;
  const mismatches: ResetScheduleMismatch[] = [];
  for (const strategy of SCHEDULED_STRATEGIES) {
    const inWindow = input.observations
      .filter((row) => row.strategy === strategy)
      .filter((row) => row.observedAt.getTime() >= since && row.observedAt.getTime() <= input.now.getTime());
    // Each profile's stamp, to count the profiles one run stamped (`profilesOfRun`).
    const stamps = inWindow.map((row) => ({ at: row.observedAt.getTime(), profiles: 1 }));
    // The latest observation that says something about the schedule: an
    // exact agreement, or a run — see the header. Other resets say nothing.
    const latest = inWindow
      .map((row) => ({ row, expected: nearestPredicted(row, zone) }))
      .filter(({ row, expected }) => {
        if (expected === null) return false;
        if (Math.abs(row.observedAt.getTime() - expected.getTime()) <= RESET_SCHEDULE_AGREEMENT_MS) return true;
        if (!isScheduledShape(strategy, row.observedAt)) return false;
        if (strategy === 'MONTH_ROLLING') {
          return row.createdAt !== null && isRollingResetDay(row.createdAt, row.observedAt);
        }
        const batchPossible = row.strategyProfiles === undefined || row.strategyProfiles >= 2;
        return !batchPossible || profilesOfRun(stamps, row.observedAt.getTime()) >= 2;
      })
      .sort((left, right) => right.row.observedAt.getTime() - left.row.observedAt.getTime())[0];
    if (latest === undefined || latest.expected === null) continue;
    judged += 1;
    if (Math.abs(latest.row.observedAt.getTime() - latest.expected.getTime()) <= RESET_SCHEDULE_AGREEMENT_MS) continue;
    mismatches.push({
      strategy,
      observedAt: latest.row.observedAt.toISOString(),
      expectedAt: latest.expected.toISOString(),
      impliedUtcOffsetMinutes: impliedUtcOffsetMinutes(strategy, latest.row.observedAt),
    });
  }
  return {
    checkedAt: base.checkedAt,
    timeZone: zone,
    mismatches,
    status: mismatches.length > 0 ? 'mismatch' : judged > 0 ? 'ok' : 'no_data',
  };
}

/** A client that can read the observations: `PrismaService` or a transaction. */
export type ResetObservationsClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Most observations read per check: the latest per strategy is what decides. */
const MAX_OBSERVATIONS = 2_000;

/**
 * The resets Remnawave reported inside the window, with the strategy the panel
 * pushes for each subscription and how many profiles on the install carry
 * that strategy, and whether any live subscription resets on a schedule at
 * all. The panel's own resets are left out (`ownTrafficResetSql`): a renewal,
 * the operator's «Сбросить», «Обнулить трафик» say nothing about Remnawave's
 * schedule.
 */
export async function readResetObservations(
  client: ResetObservationsClient,
  now: Date,
): Promise<{ readonly observations: ResetObservation[]; readonly resetScoped: boolean }> {
  const strategies = [...SCHEDULED_STRATEGIES];
  const [scoped] = await client.$queryRaw<Array<{ scoped: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "subscriptions" s
      WHERE s."status" IN ('ACTIVE', 'LIMITED')
        AND s."plan_snapshot"->>'trafficLimitStrategy' = ANY(${strategies}::text[])
    ) AS "scoped"
  `);
  const rows = await client.$queryRaw<
    Array<{ strategy: ScheduledStrategy; observedAt: Date; createdAt: Date | null; strategyProfiles: number }>
  >(Prisma.sql`
    WITH "profiles" AS (
      SELECT p."plan_snapshot"->>'trafficLimitStrategy' AS "strategy", COUNT(*)::int AS "profiles"
      FROM "subscriptions" p
      WHERE p."status" <> 'DELETED'
        AND p."remnawave_id" IS NOT NULL
        AND p."plan_snapshot"->>'trafficLimitStrategy' = ANY(${strategies}::text[])
      GROUP BY 1
    )
    SELECT s."plan_snapshot"->>'trafficLimitStrategy' AS "strategy",
           s."remnawave_last_traffic_reset_at" AS "observedAt",
           s."remnawave_profile_created_at" AS "createdAt",
           COALESCE(pr."profiles", 0) AS "strategyProfiles"
    FROM "subscriptions" s
    LEFT JOIN "profiles" pr ON pr."strategy" = s."plan_snapshot"->>'trafficLimitStrategy'
    WHERE s."status" <> 'DELETED'
      AND s."remnawave_last_traffic_reset_at" >= ${new Date(now.getTime() - RESET_SCHEDULE_WINDOW_MS)}
      AND s."remnawave_last_traffic_reset_at" <= ${now}
      AND s."plan_snapshot"->>'trafficLimitStrategy' = ANY(${strategies}::text[])
      AND NOT ${ownTrafficResetSql(Prisma.sql`s."id"`, Prisma.sql`s."remnawave_last_traffic_reset_at"`)}
    ORDER BY s."remnawave_last_traffic_reset_at" DESC
    LIMIT ${MAX_OBSERVATIONS}
  `);
  return {
    resetScoped: scoped?.scoped === true,
    observations: rows.map((row) => ({
      strategy: row.strategy,
      observedAt: new Date(row.observedAt),
      createdAt: row.createdAt === null ? null : new Date(row.createdAt),
      strategyProfiles: Number(row.strategyProfiles),
    })),
  };
}
