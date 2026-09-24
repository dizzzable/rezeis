import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermHooksService } from '../../src/modules/add-on-entitlements/services/subscription-term-hooks.service';
import { SubscriptionTermService } from '../../src/modules/add-on-entitlements/services/subscription-term.service';

/**
 * The term-model hooks for a spec whose subscriptions are NOT in the term
 * model — every unit spec with a hand-built Prisma double. They answer exactly
 * what the real service answers for a subscription with no term (the shipped
 * default: stage 1 off, no cutover), without touching the double: nothing is
 * entered, nothing is aligned, nothing is rotated.
 *
 * A spec about the term model itself must use {@link realTermHooks} against
 * PostgreSQL instead — this stub cannot fail the way the real one can.
 */
export const NOT_IN_TERM_MODEL = {
  enterNewSubscriptionInTransaction: async () => null,
  followExpiryInTransaction: async () => ({ outcome: 'NOT_IN_MODEL' as const }),
  rotateForPlanChangeInTransaction: async () => ({ outcome: 'NO_ACTIVE_TERM' as const }),
  grantLimitBonusInTransaction: async () => ({ outcome: 'NOT_IN_MODEL' as const }),
} satisfies Pick<
  SubscriptionTermHooksService,
  | 'enterNewSubscriptionInTransaction'
  | 'followExpiryInTransaction'
  | 'rotateForPlanChangeInTransaction'
  | 'grantLimitBonusInTransaction'
>;

/** The real hooks, built the way `AddOnEntitlementsModule` wires them. */
export function realTermHooks(prisma: PrismaService): SubscriptionTermHooksService {
  const terms = new SubscriptionTermService();
  const projections = new EffectiveProjectionService();
  return new SubscriptionTermHooksService(
    terms,
    projections,
    new EntitlementCutoverService(prisma, terms, projections),
  );
}
