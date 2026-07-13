export const MAX_TRAFFIC_LIMIT = (1n << 63n) - 1n;
export const MAX_DEVICE_LIMIT = 2_147_483_647;

type LimitArithmeticErrorCode =
  | 'INVALID_VALUE'
  | 'NEGATIVE_CONTRIBUTION'
  | 'OVERFLOW';

export class LimitArithmeticError extends Error {
  public readonly code: LimitArithmeticErrorCode;

  public constructor(code: LimitArithmeticErrorCode, message: string) {
    super(message);
    this.name = 'LimitArithmeticError';
    this.code = code;
  }
}

function assertTrafficContribution(value: bigint): void {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new LimitArithmeticError(
      value < 0n ? 'NEGATIVE_CONTRIBUTION' : 'INVALID_VALUE',
      'Traffic contribution must be a non-negative bigint',
    );
  }
}

function assertDeviceValue(value: number, label: string): void {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value < 0) {
    throw new LimitArithmeticError(
      value < 0 ? 'NEGATIVE_CONTRIBUTION' : 'INVALID_VALUE',
      `${label} must be a non-negative integer`,
    );
  }
}

export function addTrafficLimit(
  base: bigint | null,
  contributions: readonly bigint[],
): bigint | null {
  if (base === null) {
    return null;
  }
  if (typeof base !== 'bigint' || base < 0n) {
    throw new LimitArithmeticError('INVALID_VALUE', 'Traffic base must be null or a non-negative bigint');
  }

  let total = base;
  for (const contribution of contributions) {
    assertTrafficContribution(contribution);
    if (total > MAX_TRAFFIC_LIMIT - contribution) {
      throw new LimitArithmeticError('OVERFLOW', 'Traffic limit exceeds PostgreSQL BIGINT range');
    }
    total += contribution;
  }

  return base === null ? null : total;
}

export function addDeviceLimit(
  base: number | null,
  contributions: readonly number[],
): number | null {
  if (base === null) {
    return null;
  }
  assertDeviceValue(base, 'Device base');

  let total = base;
  for (const contribution of contributions) {
    assertDeviceValue(contribution, 'Device contribution');
    if (total > MAX_DEVICE_LIMIT - contribution) {
      throw new LimitArithmeticError('OVERFLOW', 'Device limit exceeds PostgreSQL INTEGER range');
    }
    total += contribution;
  }

  return base === null ? null : total;
}
