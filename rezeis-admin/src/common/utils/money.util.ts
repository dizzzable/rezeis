import { Prisma } from '@prisma/client';

/**
 * Convert a major-unit monetary amount (Prisma `Decimal`, number, or numeric
 * string) into integer minor units (e.g. rubles/dollars → kopecks/cents).
 *
 * ALWAYS rounds: `Number(decimal) * 100` alone accumulates binary-float error
 * (e.g. `999.99 * 100 = 99998.99999…`), which would silently corrupt partner
 * earnings / balances. Use this everywhere a Decimal amount crosses into the
 * integer-minor-unit domain so every call site rounds identically.
 */
export function toMinorUnits(amount: Prisma.Decimal | number | string): number {
  const major = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(major)) return 0;
  return Math.round(major * 100);
}

/**
 * Minor units to a major-unit string, by integer arithmetic.
 *
 * Every balance in the product is stored ×100 (`toMinorUnits`), whatever the
 * currency. Whole amounts print without a fraction, the way the cabinet shows
 * them; anything else prints exactly two digits. No float division, so no
 * `0.1 + 0.2` in a partner's payout notice.
 */
export function formatMinorUnits(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(amountMinor));
  const cents = absolute % 100;
  // A multiple of 100 divides exactly, so this is integer arithmetic too.
  const major = (absolute - cents) / 100;
  return cents === 0 ? `${sign}${major}` : `${sign}${major}.${String(cents).padStart(2, '0')}`;
}
