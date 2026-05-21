/**
 * Donor parity: altshop normalizes promocode strings by trimming surrounding
 * whitespace and uppercasing the entire code. Keep this helper pure so it can
 * be reused inside DTOs, services and tests without DI.
 */
export function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export const PROMOCODE_PATTERN = /^[A-Z0-9._-]+$/;

export function isValidCode(value: string): boolean {
  const normalized = normalizeCode(value);
  return (
    normalized.length >= 3 &&
    normalized.length <= 64 &&
    PROMOCODE_PATTERN.test(normalized)
  );
}
