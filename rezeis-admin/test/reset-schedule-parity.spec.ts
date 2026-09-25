import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import {
  isRollingResetDay,
  nextRemnawaveReset,
  planResetEpoch,
  previousRemnawaveReset,
  REMNAWAVE_RESET_MINUTE,
  RESET_EXPIRY_MARGIN_MS,
  remnawaveResetsBetween,
  ResetCyclePolicyError,
  type ResetStrategy,
} from '../src/modules/add-on-entitlements/domain/reset-cycle-policy';

/**
 * PARITY WITH REMNAWAVE'S OWN RESET SCHEDULE.
 *
 * The panel ends a «до следующего сброса» add-on at Remnawave's reset, so the
 * instant it predicts must be the instant Remnawave resets. Remnawave's rule
 * is restated here from its sources (AGPL: restated, never copied; the lines
 * are identical in 3.2.0, 3.2.3, 3.3.2, 3.4.0 and 3.4.4 — W7 §1.7):
 *
 *  [I]  `src/scheduler/intervals.ts:6-9`, `:28-33` — the four crons: DAY
 *       '5 0 * * *', MONTH_ROLLING '10 0 * * *' (a check every day), WEEK
 *       '15 0 * * 1', MONTH '20 0 1 * *';
 *  [T]  `src/scheduler/enqueue/reset-user-traffic-jobs/<strategy>/…task.ts:15-18`
 *       — `@Cron` without `timeZone`: the process clock (UTC unless Remnawave's
 *       `.env` sets `TZ`);
 *  [R]  `src/modules/users/repositories/users.repository.ts:611-621` — the
 *       rolling filter, against the database's `CURRENT_DATE`;
 *  [D]  `docker-compose-prod.yml:53` — the database is pinned to UTC, so
 *       `CURRENT_DATE` is the UTC date;
 *  [N]  NO_RESET has no job.
 *
 * The ORACLE below is a second, deliberately naive statement of that rule: it
 * walks the scheduler's local days one by one on a fixed-offset clock, fires
 * each cron, and asks the rolling filter the question [R] asks, verbatim. It
 * shares nothing with the implementation but the calendar.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const at = (iso: string): Date => new Date(iso);
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

interface Zone {
  readonly name: string;
  /** The zone's fixed distance from UTC — neither zone has had a daylight hour since 2014. */
  readonly offsetMs: number;
}

const UTC: Zone = { name: 'UTC', offsetMs: 0 };
const MOSCOW: Zone = { name: 'Europe/Moscow', offsetMs: 3 * HOUR };

// ── The oracle ──────────────────────────────────────────────────────────────

/** `[R]`, as the database evaluates it at the moment the rolling job fires. */
function rollingFilterResets(createdAt: number, firing: number): boolean {
  const created = new Date(createdAt);
  const today = new Date(firing); // `CURRENT_DATE` [D]: the UTC date of the firing
  const todayDate = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  // ("created_at" + interval '1 month')::date <= CURRENT_DATE — Postgres keeps
  // the day unless the next month is shorter, then takes its last day.
  const nextMonthDays = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth() + 2, 0)).getUTCDate();
  const plusOneMonth = Date.UTC(
    created.getUTCFullYear(),
    created.getUTCMonth() + 1,
    Math.min(created.getUTCDate(), nextMonthDays),
  );
  if (plusOneMonth > todayDate) return false;
  // LEAST(EXTRACT(DAY FROM created_at), last day of CURRENT_DATE's month) = EXTRACT(DAY FROM CURRENT_DATE)
  const lastDayOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.min(created.getUTCDate(), lastDayOfMonth) === today.getUTCDate();
}

/** Every reset of `strategy` in `[from, to]`, by walking the scheduler's local days [I][T]. */
function oracleResets(
  strategy: Exclude<ResetStrategy, 'NO_RESET'>,
  createdAt: number | null,
  zone: Zone,
  from: number,
  to: number,
): number[] {
  const resets: number[] = [];
  const firstLocalDay = Math.floor((from + zone.offsetMs) / DAY) * DAY - 2 * DAY;
  for (let localDay = firstLocalDay; localDay <= to + zone.offsetMs + DAY; localDay += DAY) {
    const local = new Date(localDay);
    const firingAt = (minute: number): number => localDay + minute * MINUTE - zone.offsetMs;
    let firing: number | null = null;
    if (strategy === 'DAY') firing = firingAt(5);
    if (strategy === 'WEEK' && local.getUTCDay() === 1) firing = firingAt(15);
    if (strategy === 'MONTH' && local.getUTCDate() === 1) firing = firingAt(20);
    if (strategy === 'MONTH_ROLLING' && createdAt !== null && rollingFilterResets(createdAt, firingAt(10))) {
      firing = firingAt(10);
    }
    if (firing !== null && firing >= from && firing <= to) resets.push(firing);
  }
  return resets;
}

/** Longest a rolling profile can wait for a reset: its first month plus a month. */
const ORACLE_HORIZON = 70 * DAY;

function oracleNext(strategy: Exclude<ResetStrategy, 'NO_RESET'>, createdAt: number | null, zone: Zone, t: number) {
  return oracleResets(strategy, createdAt, zone, t + 1, t + ORACLE_HORIZON)[0] ?? null;
}

function oraclePrevious(
  strategy: Exclude<ResetStrategy, 'NO_RESET'>,
  createdAt: number | null,
  zone: Zone,
  t: number,
): number | null {
  const resets = oracleResets(strategy, createdAt, zone, t - ORACLE_HORIZON, t);
  return resets.length === 0 ? null : resets[resets.length - 1];
}

// ── The table ───────────────────────────────────────────────────────────────

interface TableCase {
  readonly name: string;
  readonly strategy: ResetStrategy;
  readonly zone: Zone;
  readonly anchorAt?: string;
  readonly at: string;
  /** Remnawave's next reset after `at`. */
  readonly next: string | null;
  /** Remnawave's last reset at or before `at`. */
  readonly previous: string | null;
  readonly cites: string;
}

const TABLE: readonly TableCase[] = [
  {
    name: 'DAY, bought 24.09 18:00 UTC: the reset at 00:05, not midnight',
    strategy: 'DAY', zone: UTC, at: '2026-09-24T18:00:00.000Z',
    next: '2026-09-25T00:05:00.000Z', previous: '2026-09-24T00:05:00.000Z', cites: '[I] :6 :29, [T]',
  },
  {
    name: 'DAY, bought 24.09 00:02 UTC — inside the gap: this morning\'s 00:05 closes the cycle',
    strategy: 'DAY', zone: UTC, at: '2026-09-24T00:02:00.000Z',
    next: '2026-09-24T00:05:00.000Z', previous: '2026-09-23T00:05:00.000Z', cites: '[I] :6 :29',
  },
  {
    name: 'WEEK, bought on a Thursday: Monday 00:15',
    strategy: 'WEEK', zone: UTC, at: '2026-09-24T12:00:00.000Z',
    next: '2026-09-28T00:15:00.000Z', previous: '2026-09-21T00:15:00.000Z', cites: '[I] :8 :31',
  },
  {
    name: 'WEEK, bought Monday 28.09 00:07 — inside the gap: the same Monday 00:15',
    strategy: 'WEEK', zone: UTC, at: '2026-09-28T00:07:00.000Z',
    next: '2026-09-28T00:15:00.000Z', previous: '2026-09-21T00:15:00.000Z', cites: '[I] :8 :31',
  },
  {
    name: 'MONTH, bought 24.09: the 1st at 00:20',
    strategy: 'MONTH', zone: UTC, at: '2026-09-24T12:00:00.000Z',
    next: '2026-10-01T00:20:00.000Z', previous: '2026-09-01T00:20:00.000Z', cites: '[I] :9 :32',
  },
  {
    name: 'MONTH, bought 01.10 00:10 — inside the gap: the same day 00:20',
    strategy: 'MONTH', zone: UTC, at: '2026-10-01T00:10:00.000Z',
    next: '2026-10-01T00:20:00.000Z', previous: '2026-09-01T00:20:00.000Z', cites: '[I] :9 :32',
  },
  {
    name: 'ROLLING, anchor the 15th at 23:30: 00:10 on the anniversary, not the anchor\'s time of day',
    strategy: 'MONTH_ROLLING', zone: UTC, anchorAt: '2026-08-15T23:30:00.000Z', at: '2026-10-15T00:00:00.000Z',
    next: '2026-10-15T00:10:00.000Z', previous: '2026-09-15T00:10:00.000Z', cites: '[I] :7 :30, [R]',
  },
  {
    name: 'ROLLING, anchor the 15th at 08:00, bought 15.10 03:00: already reset at 00:10, next month',
    strategy: 'MONTH_ROLLING', zone: UTC, anchorAt: '2026-08-15T08:00:00.000Z', at: '2026-10-15T03:00:00.000Z',
    next: '2026-11-15T00:10:00.000Z', previous: '2026-10-15T00:10:00.000Z', cites: '[R]',
  },
  {
    name: 'ROLLING, anchor 31.01, bought 10.02: clamped to 28.02',
    strategy: 'MONTH_ROLLING', zone: UTC, anchorAt: '2026-01-31T15:00:00.000Z', at: '2026-02-10T00:00:00.000Z',
    next: '2026-02-28T00:10:00.000Z', previous: null, cites: '[R] LEAST(…) and the first month',
  },
  {
    name: 'ROLLING, anchor 31.01.2024, a leap year: 29.02',
    strategy: 'MONTH_ROLLING', zone: UTC, anchorAt: '2024-01-31T15:00:00.000Z', at: '2024-02-10T00:00:00.000Z',
    next: '2024-02-29T00:10:00.000Z', previous: null, cites: '[R]',
  },
  {
    name: 'ROLLING, day 31 after a short month does not drift: 30.04 then 31.05',
    strategy: 'MONTH_ROLLING', zone: UTC, anchorAt: '2024-01-31T08:00:00.000Z', at: '2024-05-01T00:00:00.000Z',
    next: '2024-05-31T00:10:00.000Z', previous: '2024-04-30T00:10:00.000Z', cites: '[R]',
  },
  {
    name: 'ROLLING, created 20.09: no reset in the first month',
    strategy: 'MONTH_ROLLING', zone: UTC, anchorAt: '2026-09-20T10:00:00.000Z', at: '2026-09-21T00:00:00.000Z',
    next: '2026-10-20T00:10:00.000Z', previous: null, cites: '[R] ("created_at" + interval \'1 month\')::date',
  },
  {
    name: 'Moscow, ROLLING, created 15.08 12:00 UTC: the firing that evening is in its first month — no reset',
    strategy: 'MONTH_ROLLING', zone: MOSCOW, anchorAt: '2026-08-15T12:00:00.000Z', at: '2026-08-15T13:00:00.000Z',
    next: '2026-09-15T21:10:00.000Z', previous: null, cites: '[R] ("created_at" + interval \'1 month\')::date',
  },
  {
    name: 'Moscow, DAY: 00:05 by Moscow is 21:05 UTC the evening before',
    strategy: 'DAY', zone: MOSCOW, at: '2026-09-24T18:00:00.000Z',
    next: '2026-09-24T21:05:00.000Z', previous: '2026-09-23T21:05:00.000Z', cites: '[T]',
  },
  {
    name: 'Moscow, WEEK: Monday 00:15 by Moscow is Sunday 21:15 UTC',
    strategy: 'WEEK', zone: MOSCOW, at: '2026-09-27T21:00:00.000Z',
    next: '2026-09-27T21:15:00.000Z', previous: '2026-09-20T21:15:00.000Z', cites: '[I] :8, [T]',
  },
  {
    name: 'Moscow, MONTH: the 1st 00:20 by Moscow is the 30th/31st 21:20 UTC',
    strategy: 'MONTH', zone: MOSCOW, at: '2026-09-30T21:00:00.000Z',
    next: '2026-09-30T21:20:00.000Z', previous: '2026-08-31T21:20:00.000Z', cites: '[I] :9, [T]',
  },
  {
    name: 'Moscow, ROLLING: the firing on the UTC anchor day, 21:10 UTC',
    strategy: 'MONTH_ROLLING', zone: MOSCOW, anchorAt: '2026-08-15T12:00:00.000Z', at: '2026-10-01T00:00:00.000Z',
    next: '2026-10-15T21:10:00.000Z', previous: '2026-09-15T21:10:00.000Z', cites: '[R] [D] [T]',
  },
  {
    name: 'Moscow, ROLLING, created 15.08 at 22:00 UTC (the 16th by Moscow): the UTC day decides',
    strategy: 'MONTH_ROLLING', zone: MOSCOW, anchorAt: '2026-08-15T22:00:00.000Z', at: '2026-10-01T00:00:00.000Z',
    next: '2026-10-15T21:10:00.000Z', previous: '2026-09-15T21:10:00.000Z', cites: '[R] [D]',
  },
  {
    name: 'NO_RESET never resets on a schedule',
    strategy: 'NO_RESET', zone: UTC, at: '2026-09-24T12:00:00.000Z',
    next: null, previous: null, cites: '[N]',
  },
];

describe('Remnawave reset schedule — the cited cases', () => {
  for (const row of TABLE) {
    it(`${row.name} (${row.cites})`, () => {
      const input = {
        strategy: row.strategy,
        anchorAt: row.anchorAt === undefined ? null : at(row.anchorAt),
        timeZone: row.zone.name,
      };
      assert.equal(iso(nextRemnawaveReset(input, at(row.at))), row.next);
      assert.equal(iso(previousRemnawaveReset(input, at(row.at))), row.previous);
    });
  }

  it('the table itself agrees with the oracle (a wrong row would pin a wrong schedule)', () => {
    for (const row of TABLE) {
      if (row.strategy === 'NO_RESET') continue;
      const anchor = row.anchorAt === undefined ? null : at(row.anchorAt).getTime();
      const t = at(row.at).getTime();
      assert.equal(iso(new Date(oracleNext(row.strategy, anchor, row.zone, t) ?? Number.NaN)), row.next, row.name);
      const previous = oraclePrevious(row.strategy, anchor, row.zone, t);
      assert.equal(previous === null ? null : new Date(previous).toISOString(), row.previous, row.name);
    }
  });

  it('pins the cron minutes and the half-hour margin as literals', () => {
    assert.deepEqual(REMNAWAVE_RESET_MINUTE, { DAY: 5, MONTH_ROLLING: 10, WEEK: 15, MONTH: 20 });
    assert.equal(RESET_EXPIRY_MARGIN_MS, 1_800_000);
  });

  it('a cycle runs between two real resets and the add-on comes off 30 minutes after the second', () => {
    const plan = planResetEpoch({
      strategy: 'MONTH',
      capability: 'ENABLED',
      anchorAt: at('2026-01-01T00:00:00.000Z'),
      referenceAt: at('2026-10-01T00:10:00.000Z'),
    });
    assert.deepEqual(
      plan && { startsAt: iso(plan.startsAt), plannedEndsAt: iso(plan.plannedEndsAt), expiresAt: iso(plan.expiresAt) },
      {
        startsAt: '2026-09-01T00:20:00.000Z',
        plannedEndsAt: '2026-10-01T00:20:00.000Z',
        expiresAt: '2026-10-01T00:50:00.000Z',
      },
    );
  });

  it('a purchase exactly on a reset belongs to the cycle that reset opens', () => {
    const plan = planResetEpoch({
      strategy: 'DAY',
      capability: 'ENABLED',
      anchorAt: at('2026-01-01T00:00:00.000Z'),
      referenceAt: at('2026-09-24T00:05:00.000Z'),
    });
    assert.equal(iso(plan?.startsAt ?? null), '2026-09-24T00:05:00.000Z');
    assert.equal(iso(plan?.plannedEndsAt ?? null), '2026-09-25T00:05:00.000Z');
  });

  it('before a rolling profile\'s first reset the cycle opened at its creation', () => {
    const plan = planResetEpoch({
      strategy: 'MONTH_ROLLING',
      capability: 'ENABLED',
      anchorAt: at('2026-09-20T10:00:00.000Z'),
      referenceAt: at('2026-09-21T00:00:00.000Z'),
    });
    assert.equal(iso(plan?.startsAt ?? null), '2026-09-20T10:00:00.000Z');
    assert.equal(iso(plan?.plannedEndsAt ?? null), '2026-10-20T00:10:00.000Z');
  });

  it('refuses a zone it does not know instead of guessing UTC', () => {
    assert.throws(
      () => nextRemnawaveReset({ strategy: 'DAY', anchorAt: null, timeZone: 'Mars/Olympus_Mons' }, at('2026-09-24T00:00:00.000Z')),
      (error: unknown) => error instanceof ResetCyclePolicyError && error.code === 'INVALID_TIME_ZONE',
    );
  });

  it('an operator zone with a daylight hour follows it (Berlin, 29.03.2026)', () => {
    assert.deepEqual(
      remnawaveResetsBetween(
        { strategy: 'DAY', anchorAt: null, timeZone: 'Europe/Berlin' },
        at('2026-03-27T12:00:00.000Z'),
        at('2026-03-30T12:00:00.000Z'),
      ).map((value) => value.toISOString()),
      ['2026-03-27T23:05:00.000Z', '2026-03-28T23:05:00.000Z', '2026-03-29T22:05:00.000Z'],
    );
  });
});

describe('Remnawave reset schedule — who the rolling filter resets [R]', () => {
  const cases: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ['created 31.01, on 28.02 (clamp)', '2026-01-31T15:00:00.000Z', '2026-02-28T00:10:00.000Z', true],
    ['created 31.01, on 27.02', '2026-01-31T15:00:00.000Z', '2026-02-27T00:10:00.000Z', false],
    ['created 31.01, on 31.01 (its own month)', '2026-01-31T15:00:00.000Z', '2026-01-31T23:00:00.000Z', false],
    ['created 31.01, on 30.04', '2026-01-31T15:00:00.000Z', '2026-04-30T00:10:00.000Z', true],
    ['created 31.01, on 29.04', '2026-01-31T15:00:00.000Z', '2026-04-29T00:10:00.000Z', false],
    ['created 20.09, on 20.10 (first anniversary)', '2026-09-20T10:00:00.000Z', '2026-10-20T00:10:00.000Z', true],
    ['created 15.08 22:00 UTC, firing 15.10 21:10 UTC (Moscow 16.10 00:10)', '2026-08-15T22:00:00.000Z', '2026-10-15T21:10:00.000Z', true],
    ['created 15.08 22:00 UTC, firing 16.10 21:10 UTC', '2026-08-15T22:00:00.000Z', '2026-10-16T21:10:00.000Z', false],
  ];
  for (const [name, createdAt, firing, expected] of cases) {
    it(name, () => {
      assert.equal(isRollingResetDay(at(createdAt), at(firing)), expected);
      assert.equal(rollingFilterResets(at(createdAt).getTime(), at(firing).getTime()), expected, 'oracle');
    });
  }
});

// ── The property ────────────────────────────────────────────────────────────

const YEARS = fc.integer({ min: 2024, max: 2029 });

/** Purchase instants, with most of the weight on the edges the schedule turns on. */
function purchaseInstant(zone: Zone): fc.Arbitrary<number> {
  // Around the zone's midnight — the 00:00–00:20 gaps — on month ends, the 1st, 29.02.
  const nearMidnight = fc
    .record({
      year: YEARS,
      month: fc.integer({ min: 0, max: 11 }),
      day: fc.constantFrom(1, 2, 28, 29, 30, 31),
      minute: fc.integer({ min: -45, max: 50 }),
    })
    .map(({ year, month, day, minute }) => Date.UTC(year, month, day, 0, minute) - zone.offsetMs);
  // Mondays around midnight (1 January 2024 was a Monday).
  const monday = fc
    .record({ week: fc.integer({ min: 0, max: 310 }), minute: fc.integer({ min: -45, max: 50 }) })
    .map(({ week, minute }) => Date.UTC(2024, 0, 1 + 7 * week, 0, minute) - zone.offsetMs);
  // Any time on 28.02 / 29.02 / 01.03 of a leap year.
  const leap = fc
    .record({ year: fc.constantFrom(2024, 2028), day: fc.integer({ min: 28, max: 30 }), minuteOfDay: fc.integer({ min: 0, max: 1439 }) })
    .map(({ year, day, minuteOfDay }) => Date.UTC(year, 1, day, 0, minuteOfDay) - zone.offsetMs);
  const anywhere = fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2029, 11, 31, 23, 59) });
  return fc.oneof(nearMidnight, monday, leap, anywhere);
}

/** Rolling anchors: every day of month that clamps, at times on both sides of the UTC and the Moscow midnight. */
function rollingAnchor(t: number): fc.Arbitrary<number> {
  const reference = new Date(t);
  return fc
    .record({
      monthsBack: fc.integer({ min: 0, max: 26 }),
      day: fc.constantFrom(1, 2, 15, 27, 28, 29, 30, 31),
      hour: fc.constantFrom(0, 1, 12, 20, 21, 22, 23),
      minute: fc.integer({ min: 0, max: 59 }),
    })
    .map(({ monthsBack, day, hour, minute }) =>
      Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - monthsBack, day, hour, minute),
    );
}

function checkAgainstOracle(
  strategy: Exclude<ResetStrategy, 'NO_RESET'>,
  zone: Zone,
  t: number,
  anchor: number | null,
): void {
  const expectedNext = oracleNext(strategy, anchor, zone, t);
  const expectedPrevious = oraclePrevious(strategy, anchor, zone, t);
  assert.notEqual(expectedNext, null, 'the oracle must find a reset within its horizon');
  const plan = planResetEpoch({
    strategy,
    capability: 'ENABLED',
    anchorAt: new Date(anchor ?? Date.UTC(2020, 0, 1)),
    referenceAt: new Date(t),
    timeZone: zone.name,
  });
  const context = `${strategy} ${zone.name} at ${new Date(t).toISOString()} anchor ${anchor === null ? '-' : new Date(anchor).toISOString()}`;
  assert.ok(plan, context);
  assert.equal(plan.plannedEndsAt.getTime(), expectedNext, `next reset: ${context}`);
  assert.equal(plan.expiresAt.getTime(), (expectedNext ?? 0) + 30 * MINUTE, `take-off: ${context}`);
  assert.equal(
    plan.startsAt.getTime(),
    expectedPrevious ?? Math.min(anchor ?? t, t),
    `cycle start: ${context}`,
  );
  assert.ok(plan.startsAt.getTime() <= t && t < plan.plannedEndsAt.getTime(), `containment: ${context}`);
}

describe('Remnawave reset schedule — every purchase instant, UTC and UTC+3', () => {
  for (const zone of [UTC, MOSCOW]) {
    for (const strategy of ['DAY', 'WEEK', 'MONTH'] as const) {
      it(`${strategy} in ${zone.name}: the cycle is closed by Remnawave's next reset`, () => {
        fc.assert(
          fc.property(purchaseInstant(zone), (t) => checkAgainstOracle(strategy, zone, t, null)),
          { numRuns: 400 },
        );
      });
    }
    it(`MONTH_ROLLING in ${zone.name}: the firing on the UTC anniversary, first month excluded`, () => {
      fc.assert(
        fc.property(
          purchaseInstant(zone).chain((t) => rollingAnchor(t).map((anchor) => [t, anchor] as const)),
          ([t, anchor]) => checkAgainstOracle('MONTH_ROLLING', zone, t, anchor),
        ),
        { numRuns: 600 },
      );
    });
  }
});
