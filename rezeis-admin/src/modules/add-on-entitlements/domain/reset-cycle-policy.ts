export type ResetStrategy = 'NO_RESET' | 'DAY' | 'WEEK' | 'MONTH' | 'MONTH_ROLLING';
export type ResetCapability = 'DISABLED' | 'SHADOW_VERIFIED' | 'ENABLED';
export type ResetCapabilityMap = Readonly<Partial<Record<ResetStrategy, ResetCapability>>>;

/**
 * WHEN REMNAWAVE RESETS TRAFFIC — its rule, restated from its sources (AGPL:
 * restated here, never copied). Paths are relative to the backend repository;
 * the lines are the same in every tag the panel serves, 3.2.0 to 3.4.4
 * (`$SCRATCH/swarm/W7-traffic-reset-report.md` §1).
 *
 *  - Four cron jobs of Remnawave's scheduler process reset traffic
 *    (`src/scheduler/intervals.ts:6-9` and `:28-33`): DAY every day at 00:05,
 *    MONTH_ROLLING a check every day at 00:10, WEEK on Monday at 00:15, MONTH
 *    on the 1st at 00:20. `@Cron` is given no `timeZone`
 *    (`src/scheduler/enqueue/reset-user-traffic-jobs/<strategy>/…task.ts:15-18`),
 *    so they run on the PROCESS clock: UTC on a default install, whose image
 *    sets no `TZ`; a `TZ` line in Remnawave's `.env` moves all four. No API
 *    says which zone that is, so the operator tells the panel
 *    («Часовой пояс Remnawave»), and every function here takes it.
 *  - MONTH_ROLLING mixes two clocks. The job fires on the process clock, but
 *    who it resets is decided in SQL (`src/modules/users/repositories/
 *    users.repository.ts:611-621`) against the DATABASE's `CURRENT_DATE`, which
 *    is pinned to UTC (`docker-compose-prod.yml:53`), and against `created_at`,
 *    a UTC timestamp: the profile's UTC day of month, clamped to the month's
 *    last day, must be today's UTC day, and the UTC date of `created_at + 1
 *    month` must not be after today. A profile is therefore reset by the
 *    firing that lands on its UTC anniversary — with `TZ=Europe/Moscow`, at
 *    21:10 UTC — never in its first month, and the clamp is recomputed from the
 *    original day every month, so it never drifts (31 → 30 → 28 → 31).
 *  - NO_RESET has no job.
 *
 * A CYCLE is the interval between two real resets, and a purchase belongs to
 * the cycle it was made in. An add-on sold «до следующего сброса» ends at the
 * reset that closes that cycle and is taken off {@link RESET_EXPIRY_MARGIN_MS}
 * after it, so the base limit reaches Remnawave after the counter is zeroed,
 * never before it. Until 25.09.2026 the panel ended these add-ons at 00:00 UTC
 * (and a rolling one at the anchor's time of day): 5 to 20 minutes before the
 * reset, which switched a customer who had used the extra traffic to LIMITED
 * until Remnawave switched them back on — and a purchase made between the two
 * instants landed in the wrong cycle, up to a whole cycle long or short.
 */
export const REMNAWAVE_RESET_MINUTE: Readonly<Record<Exclude<ResetStrategy, 'NO_RESET'>, number>> = {
  DAY: 5,
  MONTH_ROLLING: 10,
  WEEK: 15,
  MONTH: 20,
};

/**
 * How long after Remnawave's reset instant an add-on ending at it is taken off
 * (the owner's decision of 24.09.2026): the customer may keep up to half an
 * hour of extra traffic, and is never cut off before the counter is zeroed.
 */
export const RESET_EXPIRY_MARGIN_MS = 30 * 60 * 1000;

/** Remnawave's scheduler zone when nothing else is configured: its shipped image runs in UTC. */
export const DEFAULT_REMNAWAVE_TIME_ZONE = 'UTC';

export interface ResetEpochPlan {
  /** Informational: the strategy and the reset that closes the cycle. */
  readonly epochId: string;
  /** The Remnawave reset that opened this cycle — for MONTH_ROLLING before its first reset, the anchor. */
  readonly startsAt: Date;
  /** Remnawave's reset instant that closes this cycle. NOT plus the margin. */
  readonly plannedEndsAt: Date;
  /** `plannedEndsAt` + {@link RESET_EXPIRY_MARGIN_MS}: when an add-on of this cycle is taken off. */
  readonly expiresAt: Date;
}

export interface ResetEpochInput {
  readonly strategy: ResetStrategy;
  readonly capability: ResetCapability;
  readonly anchorAt: Date | null;
  readonly referenceAt: Date;
  /** IANA name of Remnawave's scheduler zone; `undefined` means UTC. */
  readonly timeZone?: string;
}

export interface RemnawaveResetScheduleInput {
  readonly strategy: ResetStrategy;
  /** MONTH_ROLLING: the Remnawave profile's `createdAt` (`null`: no schedule is known). Calendar strategies ignore it. */
  readonly anchorAt: Date | null;
  /** IANA name of Remnawave's scheduler zone; `undefined` means UTC. */
  readonly timeZone?: string;
}

type ResetCyclePolicyErrorCode =
  | 'RESET_CAPABILITY_DISABLED'
  | 'INVALID_ANCHOR'
  | 'INVALID_REFERENCE'
  | 'INVALID_TIME_ZONE';

export class ResetCyclePolicyError extends Error {
  public readonly code: ResetCyclePolicyErrorCode;

  public constructor(code: ResetCyclePolicyErrorCode, message: string) {
    super(message);
    this.name = 'ResetCyclePolicyError';
    this.code = code;
  }
}

function assertValidDate(value: Date, code: 'INVALID_ANCHOR' | 'INVALID_REFERENCE', label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ResetCyclePolicyError(code, `${label} must be a valid Date`);
  }
}

export function getResetCapability(
  strategy: ResetStrategy,
  capabilities: ResetCapabilityMap,
): ResetCapability {
  return capabilities[strategy] ?? 'DISABLED';
}

/**
 * The reset anchor a term minted now takes.
 *
 * Calendar strategies ignore the anchor value, so they get the term's start.
 * MONTH_ROLLING does not: its anchor is the Remnawave profile's `createdAt`
 * (P2), which the panel stores on the subscription
 * (`remnawave_profile_created_at`) — pass it, or the rolling anchor a term of
 * the same subscription already carries, as `rollingAnchor`
 * (`readRollingResetAnchorInTransaction`). `term.startsAt` is never a stand-in:
 * it would silently shift the paid cycle. Unknown stays null, and nothing «до
 * сброса» is sold on the term until profile sync or the offer's one read
 * learns it.
 */
export function provisionalResetAnchor(
  strategy: ResetStrategy,
  startsAt: Date,
  rollingAnchor: Date | null = null,
): Date | null {
  return strategy === 'MONTH_ROLLING' ? rollingAnchor : startsAt;
}

/**
 * The anchor a SALE on a term counts its cycle from: the term's own, else —
 * MONTH_ROLLING only — the Remnawave profile's `createdAt` the panel stored on
 * the subscription (P2), for a term minted before it was known. The offer and
 * the checkout both read it here, so they cannot disagree about what is sold.
 */
export function saleResetAnchor(
  strategy: ResetStrategy,
  termAnchor: Date | null,
  profileCreatedAt: Date | null,
): Date | null {
  if (termAnchor !== null) return termAnchor;
  return strategy === 'MONTH_ROLLING' ? profileCreatedAt : null;
}

const RESET_STRATEGY_NAMES: ReadonlySet<string> = new Set(['NO_RESET', 'DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING']);

/**
 * The reset rule a SALE on this term counts by: the rule its subscriber is
 * MOVING TO (review R4-02). A plan edit commits the new rule into every
 * subscriber's snapshot at once and moves their terms one subscriber at a time
 * after it (`reset-rule-follow.ts`); in between, a sale by the term's own rule
 * quoted the rule that was on its way out, and the follow then re-dated what
 * was sold — earlier than the checkout said, or bound to a reset Remnawave no
 * longer runs.
 *
 * So when the snapshot names another rule for a term the follow will move — a
 * term of the snapshot's own plan, or any term when the snapshot names no plan
 * (the follow's own filter) — the sale counts by the snapshot's rule, from the
 * anchor the follow will give the term (`provisionalResetAnchor`: the term's
 * start, or for MONTH_ROLLING the profile's `createdAt`). Otherwise the term's
 * own rule and anchor ({@link saleResetAnchor}). The offer, the checkout and
 * the capture read it here; the capture follows the subscriber first, in its
 * own transaction, so what it binds is what was quoted.
 */
export function saleResetRule(input: {
  readonly term: {
    readonly planId: string | null;
    readonly trafficResetStrategy: ResetStrategy;
    readonly resetAnchorAt: Date | null;
    readonly startsAt: Date;
  };
  readonly planSnapshot: unknown;
  readonly profileCreatedAt: Date | null;
}): { readonly strategy: ResetStrategy; readonly anchorAt: Date | null; readonly moving: boolean } {
  const snapshot =
    typeof input.planSnapshot === 'object' && input.planSnapshot !== null && !Array.isArray(input.planSnapshot)
      ? (input.planSnapshot as Record<string, unknown>)
      : {};
  const named = snapshot['trafficLimitStrategy'];
  const snapshotPlanId = typeof snapshot['id'] === 'string' ? snapshot['id'] : null;
  const moving =
    typeof named === 'string' &&
    RESET_STRATEGY_NAMES.has(named) &&
    named !== input.term.trafficResetStrategy &&
    (snapshotPlanId === null || snapshotPlanId === input.term.planId);
  if (!moving) {
    return {
      strategy: input.term.trafficResetStrategy,
      anchorAt: saleResetAnchor(input.term.trafficResetStrategy, input.term.resetAnchorAt, input.profileCreatedAt),
      moving: false,
    };
  }
  const strategy = named as ResetStrategy;
  return {
    strategy,
    anchorAt: saleResetAnchor(
      strategy,
      provisionalResetAnchor(strategy, input.term.startsAt, input.profileCreatedAt),
      input.profileCreatedAt,
    ),
    moving: true,
  };
}

// ── Zone arithmetic ─────────────────────────────────────────────────────────
//
// Plain `Intl`, no library: the zone's offset at an instant is read off
// `formatToParts`, and a wall-clock time is turned back into an instant by
// trying the offsets on either side of it.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Names that are UTC: they skip `Intl` altogether. */
const UTC_ZONE_NAMES: ReadonlySet<string> = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']);

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    throw new ResetCyclePolicyError('INVALID_TIME_ZONE', `Unknown time zone ${JSON.stringify(timeZone)}`);
  }
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * The zone Remnawave's scheduler runs in: `timeZone`, or UTC when none is
 * given. An unknown name throws `INVALID_TIME_ZONE` rather than falling back
 * to UTC — selling a cycle against the wrong clock is worse than not selling.
 */
export function resolveRemnawaveTimeZone(timeZone?: string | null): string {
  const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : DEFAULT_REMNAWAVE_TIME_ZONE;
  if (!UTC_ZONE_NAMES.has(zone)) zoneFormatter(zone);
  return zone;
}

/** How far the zone's clock is ahead of UTC at `instant`, in ms (Moscow: +3 h). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  if (UTC_ZONE_NAMES.has(timeZone)) return 0;
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instant))) {
    const value = Number(part.value);
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
    else if (part.type === 'hour') hour = value % 24;
    else if (part.type === 'minute') minute = value;
    else if (part.type === 'second') second = value;
  }
  const wholeSecond = instant - (((instant % 1000) + 1000) % 1000);
  return Date.UTC(year, month - 1, day, hour, minute, second) - wholeSecond;
}

/** A calendar date, month 0–11, with no time and no zone. */
interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function utcDateOf(instant: number): CalendarDate {
  const date = new Date(instant);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

/** Normalised: `month` 12 is next January, `day` 0 the previous month's last day. */
function calendarDate(year: number, month: number, day: number): CalendarDate {
  return utcDateOf(Date.UTC(year, month, day));
}

function shiftDays(date: CalendarDate, days: number): CalendarDate {
  return calendarDate(date.year, date.month, date.day + days);
}

function sameDate(left: CalendarDate, right: CalendarDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthIndex(date: CalendarDate): number {
  return date.year * 12 + date.month;
}

/** The date the zone's clock shows at `instant`. */
function zonedDateOf(instant: number, timeZone: string): CalendarDate {
  return utcDateOf(instant + zoneOffsetMs(instant, timeZone));
}

/**
 * The instant the zone's clock reads `minute` minutes past midnight on `date`.
 * A local time the clock jumps over is moved forward by the jump; one the
 * clock passes twice is the earlier instant. (Only zones that change their
 * clocks at midnight can meet either.)
 */
function zonedMidnightPlus(date: CalendarDate, minute: number, timeZone: string): number {
  const wall = Date.UTC(date.year, date.month, date.day, 0, minute);
  if (UTC_ZONE_NAMES.has(timeZone)) return wall;
  const before = zoneOffsetMs(wall - DAY_MS, timeZone);
  const after = zoneOffsetMs(wall + DAY_MS, timeZone);
  let found: number | null = null;
  for (const offset of before === after ? [before] : [before, after]) {
    const candidate = wall - offset;
    if (zoneOffsetMs(candidate, timeZone) === offset && (found === null || candidate < found)) {
      found = candidate;
    }
  }
  return found ?? wall - Math.min(before, after);
}

// ── Remnawave's instants ────────────────────────────────────────────────────

/**
 * A calendar strategy's firing `step` periods from the one `local` is in:
 * step 0 is this local day's 00:05 (DAY), this week's Monday 00:15 (WEEK) or
 * this month's 1st 00:20 (MONTH).
 */
function calendarFiring(
  strategy: 'DAY' | 'WEEK' | 'MONTH',
  local: CalendarDate,
  step: number,
  timeZone: string,
): number {
  const minute = REMNAWAVE_RESET_MINUTE[strategy];
  if (strategy === 'DAY') return zonedMidnightPlus(shiftDays(local, step), minute, timeZone);
  if (strategy === 'WEEK') {
    const weekday = new Date(Date.UTC(local.year, local.month, local.day)).getUTCDay();
    const monday = shiftDays(local, -((weekday + 6) % 7));
    return zonedMidnightPlus(shiftDays(monday, 7 * step), minute, timeZone);
  }
  return zonedMidnightPlus(calendarDate(local.year, local.month + step, 1), minute, timeZone);
}

/** The anchor's `monthsAfter`-th UTC anniversary: its day, clamped to that month's last day. */
function anniversaryDate(anchor: CalendarDate, monthsAfter: number): CalendarDate {
  const first = calendarDate(anchor.year, anchor.month + monthsAfter, 1);
  return { year: first.year, month: first.month, day: Math.min(anchor.day, daysInMonth(first.year, first.month)) };
}

/**
 * The rolling job's firings that land on the UTC date `date`, ascending. The
 * job fires at 00:10 on every local date; the one landing on this UTC day can
 * only belong to the local date before, the same or the next. Normally one.
 */
function rollingFiringsOn(date: CalendarDate, timeZone: string): number[] {
  const firings = new Set<number>();
  for (const step of [-1, 0, 1]) {
    const firing = zonedMidnightPlus(shiftDays(date, step), REMNAWAVE_RESET_MINUTE.MONTH_ROLLING, timeZone);
    if (sameDate(utcDateOf(firing), date)) firings.add(firing);
  }
  return [...firings].sort((left, right) => left - right);
}

/** How many anniversaries past `from` a search may walk before giving up: far more than a real schedule needs. */
const ROLLING_SEARCH_MONTHS = 24;

function nextRollingReset(anchorAt: number, at: number, timeZone: string): number | null {
  const anchor = utcDateOf(anchorAt);
  const from = Math.max(1, monthIndex(utcDateOf(at)) - monthIndex(anchor) - 1);
  for (let monthsAfter = from; monthsAfter <= from + ROLLING_SEARCH_MONTHS; monthsAfter += 1) {
    for (const firing of rollingFiringsOn(anniversaryDate(anchor, monthsAfter), timeZone)) {
      if (firing > at) return firing;
    }
  }
  return null;
}

function previousRollingReset(anchorAt: number, at: number, timeZone: string): number | null {
  const anchor = utcDateOf(anchorAt);
  const to = monthIndex(utcDateOf(at)) - monthIndex(anchor) + 1;
  for (let monthsAfter = to; monthsAfter >= 1 && monthsAfter >= to - ROLLING_SEARCH_MONTHS; monthsAfter -= 1) {
    const firings = rollingFiringsOn(anniversaryDate(anchor, monthsAfter), timeZone);
    for (let index = firings.length - 1; index >= 0; index -= 1) {
      if (firings[index] <= at) return firings[index];
    }
  }
  return null;
}

/**
 * Does the rolling job, firing at `at`, reset a profile created at
 * `createdAt`? It is Remnawave's day filter on the UTC date of `at` (its
 * database's `CURRENT_DATE`): the anniversary day clamped to the month's end,
 * and never before the date of `createdAt` + 1 month. «Reset all users
 * traffic» (`POST /api/users/bulk/all/reset-traffic`) applies the same filter
 * to rolling profiles.
 */
export function isRollingResetDay(createdAt: Date, at: Date): boolean {
  assertValidDate(createdAt, 'INVALID_ANCHOR', 'createdAt');
  assertValidDate(at, 'INVALID_REFERENCE', 'at');
  const anchor = utcDateOf(createdAt.getTime());
  const today = utcDateOf(at.getTime());
  const monthsAfter = monthIndex(today) - monthIndex(anchor);
  return monthsAfter >= 1 && sameDate(anniversaryDate(anchor, monthsAfter), today);
}

function scheduledReset(
  input: RemnawaveResetScheduleInput,
  at: Date,
  direction: 'next' | 'previous',
): Date | null {
  assertValidDate(at, 'INVALID_REFERENCE', 'at');
  const timeZone = resolveRemnawaveTimeZone(input.timeZone);
  const instant = at.getTime();
  switch (input.strategy) {
    case 'NO_RESET':
      return null;
    case 'MONTH_ROLLING': {
      if (input.anchorAt === null) return null;
      assertValidDate(input.anchorAt, 'INVALID_ANCHOR', 'anchorAt');
      const found =
        direction === 'next'
          ? nextRollingReset(input.anchorAt.getTime(), instant, timeZone)
          : previousRollingReset(input.anchorAt.getTime(), instant, timeZone);
      return found === null ? null : new Date(found);
    }
    case 'DAY':
    case 'WEEK':
    case 'MONTH': {
      const local = zonedDateOf(instant, timeZone);
      for (let step = 0; step <= 2; step += 1) {
        const firing = calendarFiring(input.strategy, local, direction === 'next' ? step : -step, timeZone);
        if (direction === 'next' ? firing > instant : firing <= instant) return new Date(firing);
      }
      return null;
    }
    default:
      throw new ResetCyclePolicyError('INVALID_REFERENCE', `Unsupported reset strategy: ${String(input.strategy)}`);
  }
}

/** Remnawave's first reset strictly after `at`; `null` for NO_RESET and for MONTH_ROLLING without an anchor. */
export function nextRemnawaveReset(input: RemnawaveResetScheduleInput, at: Date): Date | null {
  return scheduledReset(input, at, 'next');
}

/**
 * Remnawave's last reset at or before `at`; `null` for NO_RESET, and for
 * MONTH_ROLLING without an anchor or before its first reset.
 */
export function previousRemnawaveReset(input: RemnawaveResetScheduleInput, at: Date): Date | null {
  return scheduledReset(input, at, 'previous');
}

/** At most this many instants per {@link remnawaveResetsBetween}: a year of DAY resets fits twice over. */
const MAX_RESETS_BETWEEN = 1000;

/** Every Remnawave reset in `[from, to]`, ascending. */
export function remnawaveResetsBetween(input: RemnawaveResetScheduleInput, from: Date, to: Date): Date[] {
  assertValidDate(from, 'INVALID_REFERENCE', 'from');
  assertValidDate(to, 'INVALID_REFERENCE', 'to');
  const resets: Date[] = [];
  let cursor = new Date(from.getTime() - 1);
  for (;;) {
    const next = nextRemnawaveReset(input, cursor);
    if (next === null || next.getTime() > to.getTime()) return resets;
    if (resets.length === MAX_RESETS_BETWEEN) {
      throw new ResetCyclePolicyError('INVALID_REFERENCE', `More than ${MAX_RESETS_BETWEEN} resets between from and to`);
    }
    resets.push(next);
    cursor = next;
  }
}

/** When an add-on ending at the reset `resetAt` is taken off. */
export function resetExpiryAt(resetAt: Date): Date {
  return new Date(resetAt.getTime() + RESET_EXPIRY_MARGIN_MS);
}

/**
 * The reset cycle `referenceAt` falls in: `startsAt <= referenceAt <
 * plannedEndsAt`, both Remnawave's own reset instants in `timeZone`. A
 * reference exactly on a reset belongs to the cycle that reset opens.
 */
export function planResetEpoch(input: ResetEpochInput): ResetEpochPlan | null {
  assertValidDate(input.referenceAt, 'INVALID_REFERENCE', 'referenceAt');

  if (input.strategy === 'NO_RESET') {
    return null;
  }
  if (input.anchorAt === null) {
    throw new ResetCyclePolicyError('INVALID_ANCHOR', 'anchorAt must be a valid Date');
  }
  assertValidDate(input.anchorAt, 'INVALID_ANCHOR', 'anchorAt');
  if (input.capability !== 'ENABLED') {
    throw new ResetCyclePolicyError(
      'RESET_CAPABILITY_DISABLED',
      `Reset strategy ${input.strategy} is not enabled for commercial expiry`,
    );
  }

  const schedule: RemnawaveResetScheduleInput = {
    strategy: input.strategy,
    anchorAt: input.anchorAt,
    timeZone: input.timeZone,
  };
  const plannedEndsAt = nextRemnawaveReset(schedule, input.referenceAt);
  if (plannedEndsAt === null) return null;
  // Before a rolling profile's first reset the cycle opened when the profile
  // was created — or at the reference itself, should the panel's clock be a
  // moment behind Remnawave's.
  const startsAt =
    previousRemnawaveReset(schedule, input.referenceAt) ??
    new Date(Math.min(input.anchorAt.getTime(), input.referenceAt.getTime()));
  return {
    epochId: `${input.strategy}:${plannedEndsAt.toISOString()}`,
    startsAt,
    plannedEndsAt,
    expiresAt: resetExpiryAt(plannedEndsAt),
  };
}
