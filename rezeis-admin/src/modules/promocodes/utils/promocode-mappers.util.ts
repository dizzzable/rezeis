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
  record: PromocodeActivation,
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
  };
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
