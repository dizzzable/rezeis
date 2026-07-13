export type ResetStrategy = 'NO_RESET' | 'DAY' | 'WEEK' | 'MONTH' | 'MONTH_ROLLING';
export type ResetCapability = 'DISABLED' | 'SHADOW_VERIFIED' | 'ENABLED';
export type ResetCapabilityMap = Readonly<Partial<Record<ResetStrategy, ResetCapability>>>;

export interface ResetEpochPlan {
  readonly epochId: string;
  readonly startsAt: Date;
  readonly plannedEndsAt: Date;
}

export interface ResetEpochInput {
  readonly strategy: ResetStrategy;
  readonly capability: ResetCapability;
  readonly anchorAt: Date | null;
  readonly referenceAt: Date;
}

type ResetCyclePolicyErrorCode = 'RESET_CAPABILITY_DISABLED' | 'INVALID_ANCHOR' | 'INVALID_REFERENCE';

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

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function utcWeekStart(value: Date): Date {
  const result = utcDayStart(value);
  const daysSinceMonday = (result.getUTCDay() + 6) % 7;
  result.setUTCDate(result.getUTCDate() - daysSinceMonday);
  return result;
}

function utcMonthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function anniversaryAt(anchorAt: Date, monthOffset: number): Date {
  const targetMonthIndex = anchorAt.getUTCFullYear() * 12 + anchorAt.getUTCMonth() + monthOffset;
  const year = Math.floor(targetMonthIndex / 12);
  const month = targetMonthIndex - year * 12;
  const day = Math.min(anchorAt.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchorAt.getUTCHours(),
      anchorAt.getUTCMinutes(),
      anchorAt.getUTCSeconds(),
      anchorAt.getUTCMilliseconds(),
    ),
  );
}

function rollingMonthEpoch(anchorAt: Date, referenceAt: Date): ResetEpochPlan {
  const roughMonths =
    (referenceAt.getUTCFullYear() - anchorAt.getUTCFullYear()) * 12 +
    referenceAt.getUTCMonth() - anchorAt.getUTCMonth();
  let monthOffset = roughMonths;
  let startsAt = anniversaryAt(anchorAt, monthOffset);

  if (startsAt.getTime() > referenceAt.getTime()) {
    monthOffset -= 1;
    startsAt = anniversaryAt(anchorAt, monthOffset);
  }

  let plannedEndsAt = anniversaryAt(anchorAt, monthOffset + 1);
  while (plannedEndsAt.getTime() <= referenceAt.getTime()) {
    monthOffset += 1;
    startsAt = plannedEndsAt;
    plannedEndsAt = anniversaryAt(anchorAt, monthOffset + 1);
  }

  return {
    epochId: `MONTH_ROLLING:${startsAt.toISOString().slice(0, 10)}`,
    startsAt,
    plannedEndsAt,
  };
}

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

  if (input.strategy === 'MONTH_ROLLING') {
    return rollingMonthEpoch(input.anchorAt, input.referenceAt);
  }

  let startsAt: Date;
  let plannedEndsAt: Date;
  let epochId: string;

  switch (input.strategy) {
    case 'DAY':
      startsAt = utcDayStart(input.referenceAt);
      plannedEndsAt = new Date(startsAt.getTime());
      plannedEndsAt.setUTCDate(plannedEndsAt.getUTCDate() + 1);
      epochId = `DAY:${startsAt.toISOString().slice(0, 10)}`;
      break;
    case 'WEEK':
      startsAt = utcWeekStart(input.referenceAt);
      plannedEndsAt = new Date(startsAt.getTime());
      plannedEndsAt.setUTCDate(plannedEndsAt.getUTCDate() + 7);
      epochId = `WEEK:${startsAt.toISOString().slice(0, 10)}`;
      break;
    case 'MONTH':
      startsAt = utcMonthStart(input.referenceAt);
      plannedEndsAt = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1, 1));
      epochId = `MONTH:${startsAt.toISOString().slice(0, 7)}`;
      break;
    default:
      throw new ResetCyclePolicyError('INVALID_REFERENCE', `Unsupported reset strategy: ${input.strategy}`);
  }

  return { epochId, startsAt, plannedEndsAt };
}
