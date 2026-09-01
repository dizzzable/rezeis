import { BadRequestException } from '@nestjs/common';
import { Prisma, PromocodeRewardType } from '@prisma/client';

import { clampDiscountPercent } from '../../../common/utils/discount.util';
import { PromocodeActionDto } from '../dto/promocode-action.dto';
import { PromocodePlanSnapshotDto } from '../dto/promocode-plan-snapshot.dto';

/**
 * What a write request says the promocode should DO, as one list.
 *
 * ── Why a request can say it two ways ─────────────────────────────────────
 *
 * `actions` is the shape that lets a code do several things. The legacy
 * `rewardType` / `reward` / `plan` are still accepted because an older panel
 * sends only those, and because they are what every donor import writes.
 *
 * Resolving both to one list HERE means the write path has a single thing to
 * store, and the legacy columns are then filled FROM that list rather than
 * beside it — which is the only way the two cannot end up describing different
 * offers.
 */

export interface ResolvedPromocodeAction {
  readonly type: PromocodeRewardType;
  readonly value: number | null;
  readonly plan: PromocodePlanSnapshotDto | null;
  readonly discountAllowedPlanIds: readonly string[];
  readonly discountValidForDays: number | null;
}

interface PromocodeWriteShape {
  readonly rewardType?: PromocodeRewardType;
  readonly reward?: number | null;
  readonly plan?: PromocodePlanSnapshotDto | null;
  readonly actions?: PromocodeActionDto[];
}

/**
 * Ordered exactly as the read path orders it: SUBSCRIPTION first, because it
 * replaces the subscription every other action would otherwise mutate. Written
 * in this order too, so the stored list reads the way it runs.
 */
const rank = (type: PromocodeRewardType): number =>
  type === PromocodeRewardType.SUBSCRIPTION ? 0 : 1;

/**
 * A percentage is bounded WHERE IT IS WRITTEN as well as where it is read.
 *
 * Reading alone left the stored number and the applied number disagreeing: a
 * code configured at 95 showed 95 on its card, wrote 95 into the activation
 * row, and gave the customer 90. The operator has no way to see which number is
 * the real one.
 */
const boundedValue = (type: PromocodeRewardType, value: number | null): number | null => {
  if (value === null) return null;
  const isPercent =
    type === PromocodeRewardType.PERSONAL_DISCOUNT ||
    type === PromocodeRewardType.PURCHASE_DISCOUNT;
  return isPercent ? clampDiscountPercent(value) : value;
};

export function resolvePromocodeActions(dto: PromocodeWriteShape): ResolvedPromocodeAction[] {
  const fromList = (dto.actions ?? []).map((action) => ({
    type: action.type,
    value: boundedValue(action.type, action.value ?? null),
    // ── THE TOP-LEVEL PLAN IS A FALLBACK, NOT A LEFTOVER ────────────────
    //
    // The panel sends the plan snapshot as a top-level `plan` — that field
    // predates actions and drives the plan/duration pickers — while the action
    // it belongs to carries only a type. Discarding it made every SUBSCRIPTION
    // promocode from the panel fail creation with "requires a plan snapshot",
    // and made saving an existing one wipe the plan it already had.
    //
    // Only for a SUBSCRIPTION action, and only when the action itself says
    // nothing: two SUBSCRIPTION actions cannot exist (one action per type), so
    // there is no ambiguity about whose plan it is.
    plan:
      action.plan ??
      (action.type === PromocodeRewardType.SUBSCRIPTION ? (dto.plan ?? null) : null),
    discountAllowedPlanIds: action.discountAllowedPlanIds ?? [],
    discountValidForDays: action.discountValidForDays ?? null,
  }));

  const actions =
    fromList.length > 0
      ? fromList
      : dto.rewardType === undefined
        ? []
        : [
            {
              type: dto.rewardType,
              value: boundedValue(dto.rewardType, dto.reward ?? null),
              plan: dto.plan ?? null,
              discountAllowedPlanIds: [] as readonly string[],
              discountValidForDays: null,
            },
          ];

  if (actions.length === 0) {
    // Neither shape said anything. The caller decides what to do about it; an
    // empty list must never reach the database, because a promocode with no
    // actions activates to nothing while still consuming the customer's one
    // activation of that code.
    // A BOUNDED error. Nest maps a bare `Error` to 500, so the operator saw an
    // opaque failure for a request they could have corrected.
    throw new BadRequestException('A promocode must declare at least one action');
  }

  // One action per type: "+7 days and another +3 days" is one action for ten,
  // and the database enforces the same thing. Caught here so the operator gets
  // a bounded error instead of a unique-constraint failure.
  const seen = new Set<PromocodeRewardType>();
  for (const action of actions) {
    if (seen.has(action.type)) {
      throw new BadRequestException(`A promocode may carry each action once: ${action.type}`);
    }
    seen.add(action.type);
  }

  return [...actions].sort((a, b) => rank(a.type) - rank(b.type));
}

/** The action-specific extras, as the JSON column stores them. */
export function buildActionPayload(action: ResolvedPromocodeAction): Prisma.InputJsonValue | undefined {
  const payload: Record<string, unknown> = {};
  if (action.type === PromocodeRewardType.SUBSCRIPTION && action.plan !== null) {
    payload.plan = action.plan;
  }
  if (action.type === PromocodeRewardType.PURCHASE_DISCOUNT) {
    if (action.discountAllowedPlanIds.length > 0) {
      payload.allowedPlanIds = [...action.discountAllowedPlanIds];
    }
    if (action.discountValidForDays !== null) {
      payload.validForDays = action.discountValidForDays;
    }
  }
  // `undefined` rather than `{}` so an action with no extras stores SQL NULL —
  // an empty object would read back as "there is a payload" and invite code
  // that trusts its presence.
  return Object.keys(payload).length === 0 ? undefined : (payload as Prisma.InputJsonValue);
}
