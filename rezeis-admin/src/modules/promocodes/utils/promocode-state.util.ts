export function isPromocodeExpired(input: {
  readonly createdAt: Date;
  readonly lifetime: number | null;
  readonly expiresAt?: Date | null;
  readonly now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  if (input.expiresAt != null && input.expiresAt.getTime() < now) return true;
  if (input.lifetime === null || input.lifetime <= 0) return false;
  return input.createdAt.getTime() + input.lifetime * 24 * 60 * 60 * 1000 < now;
}

export function isPromocodeDepleted(used: number, maxActivations: number | null): boolean {
  return maxActivations !== null && maxActivations > 0 && used >= maxActivations;
}
