import { Prisma } from '@prisma/client';

/**
 * Plan row shape required to build a snapshot. Subset of `Plan` model so
 * we can call this from any controller/service without coupling to a
 * specific Prisma include.
 */
export interface PlanSnapshotInput {
  readonly id: string;
  readonly name: string;
  readonly tag: string | null;
  readonly type: string;
  /**
   * Plan icon identifier (lucide key, `custom:<id>`, or a `:emoji:` shortcode),
   * frozen at snapshot time so the cabinet's subscription card can show the
   * plan's own icon. `null`/absent → the card falls back to a status glyph.
   */
  readonly icon: string | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: string;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

/**
 * Builds the canonical `planSnapshot` JSON blob stored on `Subscription`.
 *
 * Mirrors the shape produced by `give-subscription` and the payment-side
 * mutation services so all subscription rows look identical regardless of
 * how they were created.
 *
 * There is a SECOND function of this name — `buildPlanSnapshot` in
 * `src/modules/payments/services/payment-subscription-mutation.service.ts`,
 * plus `buildItemPlanSnapshot` beside it. They legitimately differ (the
 * payment ones also freeze duration/amount/currency/gateway) and are
 * deliberately not merged, but all three MUST keep writing `trafficLimit`,
 * `deviceLimit`, `internalSquads` and `externalSquad`:
 * `resolveInheritedPlanLimitUpdate`
 * (`src/modules/subscriptions/services/plan-inherited-limits.util.ts`) decides
 * whether an operator individually overrode a column by comparing it against
 * exactly those keys. Drop one and that column silently stops tracking the
 * plan forever. `test/subscription-plan-inherited-limits.spec.ts` fails if any
 * of the three stops writing any of them.
 */
export function buildPlanSnapshot(plan: PlanSnapshotInput): Prisma.InputJsonValue {
  return {
    id: plan.id,
    name: plan.name,
    tag: plan.tag,
    type: plan.type,
    icon: plan.icon ?? null,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: Array.isArray(plan.internalSquads) ? [...plan.internalSquads] : [],
    externalSquad: plan.externalSquad ?? null,
  } as unknown as Prisma.InputJsonValue;
}
