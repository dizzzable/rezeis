import {
  Prisma,
  Promocode,
  PromocodeActivation,
  PromocodeAvailability,
  PromocodeRewardType,
} from '@prisma/client';

import {
  PromocodeActivationInterface,
  PromocodeInterface,
  PromocodePlanSnapshotInterface,
} from '../interfaces/promocode.interface';

type PromocodeWithCount = Promocode & {
  readonly _count?: { readonly activations: number };
};

/**
 * Maps a Prisma `Promocode` record (optionally enriched with `_count`) to the
 * read-only interface returned to controllers. The mapping is intentionally
 * defensive — `plan` is parsed from JSON without throwing on malformed data
 * because the column accepts arbitrary admin input historically.
 */
export function mapPromocode(record: PromocodeWithCount): PromocodeInterface {
  return {
    id: record.id,
    code: record.code,
    isActive: record.isActive,
    availability: record.availability,
    rewardType: record.rewardType,
    reward: record.reward,
    plan: parsePromocodePlanSnapshot(record.plan),
    lifetime: record.lifetime,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    maxActivations: record.maxActivations,
    allowedTelegramIds: record.allowedTelegramIds.map(stringifyBigint),
    allowedPlanIds: [...record.allowedPlanIds],
    activationsCount: record._count?.activations ?? 0,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function mapPromocodeActivation(
  record: PromocodeActivation & {
    readonly promocode?: { readonly expiresAt: Date | null; readonly isActive: boolean } | null;
  },
): PromocodeActivationInterface {
  return {
    id: record.id,
    promocodeId: record.promocodeId,
    promocodeCode: record.promocodeCode,
    userId: record.userId,
    rewardType: record.rewardType,
    rewardValue: record.rewardValue,
    targetSubscriptionId: record.targetSubscriptionId,
    activatedAt: record.activatedAt.toISOString(),
    expiresAt: record.promocode?.expiresAt ? record.promocode.expiresAt.toISOString() : null,
    promocodeIsActive: record.promocode?.isActive ?? true,
  };
}

/**
 * Best-effort parser for the JSON plan snapshot column. Returns `null` for
 * any non-object payload so downstream code can treat absence as a single
 * branch without surfacing JSON shape errors to the operator UI.
 */
export function parsePromocodePlanSnapshot(
  value: Prisma.JsonValue | null | undefined,
): PromocodePlanSnapshotInterface | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null;
  }
  return {
    id: candidate.id,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    type: typeof candidate.type === 'string' ? candidate.type : 'BOTH',
    // CARRIED VERBATIM, INCLUDING AN UNMINTABLE `0` — on purpose. See
    // `isUnmintableSnapshotTrafficLimit` below: the refusal belongs at the
    // mint, not here, because this parser also feeds the admin promocode LIST,
    // which is the operator's only view of the bad row. Rewriting or hiding the
    // value here would take away the evidence needed to fix it.
    trafficLimit:
      typeof candidate.trafficLimit === 'number' ? candidate.trafficLimit : null,
    deviceLimit:
      typeof candidate.deviceLimit === 'number' ? candidate.deviceLimit : 0,
    trafficLimitStrategy:
      typeof candidate.trafficLimitStrategy === 'string'
        ? candidate.trafficLimitStrategy
        : 'NO_RESET',
    internalSquads: Array.isArray(candidate.internalSquads)
      ? candidate.internalSquads.filter((entry): entry is string => typeof entry === 'string')
      : [],
    externalSquad:
      typeof candidate.externalSquad === 'string' ? candidate.externalSquad : null,
    duration:
      typeof candidate.duration === 'number' && Number.isFinite(candidate.duration)
        ? candidate.duration
        : undefined,
    tag: typeof candidate.tag === 'string' ? candidate.tag : null,
    description:
      typeof candidate.description === 'string' ? candidate.description : null,
    icon: typeof candidate.icon === 'string' ? candidate.icon : null,
  };
}

/**
 * Whether a snapshot's stored `trafficLimit` is a value we must refuse to mint
 * a subscription from.
 *
 * ── This is a PRODUCT DECISION, not a bug fix. Reverse it in one line. ─────
 *
 * `Subscription.trafficLimit` counts whole gigabytes, `null` is unlimited, and
 * `0` is a state that must never exist: Remnawave has no encoding for "zero
 * bytes allowed" — its `0` IS unlimited — so a stored `0` is pushed upstream as
 * NO CAP (the exact opposite of the row) and read back as `null`, which never
 * matches what was sent, so the projection is never stamped APPLIED and the
 * sync job reports drift on every sweep forever.
 *
 * The WRITE side is now closed: `promocode-plan-snapshot.dto.ts` carries
 * `@Min(1)`. This is the READ side, and the population is NOT empty — that
 * decorator was `@Min(0)` until it was raised, and `promocode-lifecycle`'s
 * create/update write `dto.plan` into the JSON column VERBATIM, so every
 * promocode authored before the raise could be carrying a `0` right now. There
 * is no migration to sweep them (the column is JSON and the schema is frozen),
 * so the read side has to have an answer.
 *
 * ── Why refusing, and not one of the two rewrites ─────────────────────────
 *
 *   • `0` → `null` hands the customer UNLIMITED traffic — the most expensive
 *     product we sell — because a number looked wrong. Invisible when right,
 *     invisible when wrong.
 *   • `0` → `1` invents a cap the operator never chose and that no plan ever
 *     offered, and it looks deliberate forever after.
 *
 * Both are guesses that succeed. A refusal is a guess that announces itself:
 * a promocode that errors gets reported, a wrong traffic limit does not.
 *
 * ── Why the refusal is SOFT, and what "loud" means here ───────────────────
 *
 * The caller (`promocode-rewards.service.ts`) answers `applied: false`, which
 * `promocode-lifecycle.service.ts` turns into `REWARD_NOT_APPLICABLE` /
 * `ntf-promocode-reward-failed` and — this is the part that matters — ROLLS
 * BACK the activation row. So the refusal does not spend the customer's
 * promocode: once an operator edits the snapshot, the same code still works.
 * The loudness is a `logger.error` at the call site naming the promocode, the
 * plan and the offending value, because `REWARD_NOT_APPLICABLE` on its own is
 * shared with half a dozen ordinary outcomes and would say nothing.
 *
 * ── To reverse ────────────────────────────────────────────────────────────
 *
 * Delete the `isUnmintableSnapshotTrafficLimit` branch in
 * `promocode-rewards.service.ts#applySubscription`. `trafficLimit: plan
 * .trafficLimit ?? null` alone restores the previous behaviour (mint the `0`);
 * `?? null` with a `|| null` restores "give it away as unlimited". Either way
 * `test/promocode-snapshot-unmintable-traffic.spec.ts` will say which one you
 * chose.
 *
 * Negative values are covered by the same branch for the same reason: nothing
 * can express them either, and `Math.max`-ing them to `1` would be the same
 * invention as the `0` case.
 */
export function isUnmintableSnapshotTrafficLimit(value: number | null | undefined): boolean {
  // `null`/absent is UNLIMITED and perfectly mintable — it is the only thing
  // this must not catch, or the gate would refuse every unlimited promocode.
  if (value === null || value === undefined) return false;
  return !Number.isInteger(value) || value < 1;
}

/**
 * Donor compatibility helper: altshop stores `allowed_telegram_ids` as int[],
 * while the rezeis schema uses `BigInt[]`. We expose them as decimal strings
 * so JSON serialization works without needing BigInt support on the wire.
 */
function stringifyBigint(value: bigint): string {
  return value.toString();
}

export function isAvailability(value: unknown): value is PromocodeAvailability {
  return (
    typeof value === 'string' &&
    Object.values(PromocodeAvailability).includes(value as PromocodeAvailability)
  );
}

export function isRewardType(value: unknown): value is PromocodeRewardType {
  return (
    typeof value === 'string' &&
    Object.values(PromocodeRewardType).includes(value as PromocodeRewardType)
  );
}

/** Common Prisma include used everywhere we need the activation count. */
export const PROMOCODE_INCLUDE_ACTIVATIONS_COUNT = {
  _count: { select: { activations: true } },
} as const;
