import { PlanAvailability, Prisma } from '@prisma/client';

import { AdminPlanDurationDto } from '../dto/admin-plan-duration.dto';
import { CreatePlanDto } from '../dto/create-plan.dto';
import { TrafficLimitStrategyValue } from '../dto/traffic-limit-strategy.dto';
import { UpdatePlanDto } from '../dto/update-plan.dto';
import { ArchivedPlanRenewModeValue } from '../utils/archived-plan-renew-mode.util';
import { PlanRecord } from '../utils/plan-record.util';

export interface NormalizedPlanWriteInput {
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  readonly archivedRenewMode: ArchivedPlanRenewModeValue;
  readonly type: PlanRecord['type'];
  readonly availability: PlanAvailability;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly upgradeToPlanIds: readonly string[];
  readonly replacementPlanIds: readonly string[];
  readonly allowedUserIds: readonly string[];
  readonly durations: readonly AdminPlanDurationDto[];
}

/**
 * Normalises a `CreatePlanDto` into a uniform shape that downstream
 * validators and persistence functions can consume without branching on
 * "is this a partial update or a full create".
 */
export function normalizeCreatePlanInput(input: CreatePlanDto): NormalizedPlanWriteInput {
  return normalizePlanWriteInput({
    name: input.name.trim(),
    description: normalizeNullableString(input.description),
    tag: normalizeNullableString(input.tag),
    isActive: input.isActive ?? true,
    isArchived: input.isArchived ?? false,
    archivedRenewMode: input.archivedRenewMode ?? ArchivedPlanRenewModeValue.SELF_RENEW,
    type: input.type,
    availability: input.availability,
    trafficLimit: input.trafficLimit ?? null,
    deviceLimit: input.deviceLimit,
    trafficLimitStrategy: input.trafficLimitStrategy ?? TrafficLimitStrategyValue.NO_RESET,
    internalSquads: normalizeStringArray(input.internalSquads ?? []),
    externalSquad: normalizeNullableString(input.externalSquad),
    upgradeToPlanIds: normalizeUuidArray(input.upgradeToPlanIds ?? []),
    replacementPlanIds: normalizeUuidArray(input.replacementPlanIds ?? []),
    allowedUserIds: normalizeUuidArray(input.allowedUserIds ?? []),
    durations: input.durations,
  });
}

/**
 * Normalises an `UpdatePlanDto` patch by overlaying explicitly-supplied
 * fields onto the current persisted plan record. Fields not present in
 * the patch retain their existing values.
 */
export function normalizeUpdatePlanInput(
  input: UpdatePlanDto,
  currentPlan: PlanRecord,
): NormalizedPlanWriteInput {
  return normalizePlanWriteInput({
    name: input.name?.trim() ?? currentPlan.name,
    description:
      input.description === undefined ? currentPlan.description : normalizeNullableString(input.description),
    tag: input.tag === undefined ? currentPlan.tag : normalizeNullableString(input.tag),
    isActive: input.isActive ?? currentPlan.isActive,
    isArchived: input.isArchived ?? currentPlan.isArchived,
    archivedRenewMode: input.archivedRenewMode ?? currentPlan.archivedRenewMode,
    type: input.type ?? currentPlan.type,
    availability: input.availability ?? currentPlan.availability,
    trafficLimit: input.trafficLimit === undefined ? currentPlan.trafficLimit : input.trafficLimit,
    deviceLimit: input.deviceLimit ?? currentPlan.deviceLimit,
    trafficLimitStrategy: input.trafficLimitStrategy ?? currentPlan.trafficLimitStrategy,
    internalSquads:
      input.internalSquads === undefined
        ? [...currentPlan.internalSquads]
        : normalizeStringArray(input.internalSquads),
    externalSquad:
      input.externalSquad === undefined
        ? currentPlan.externalSquad
        : normalizeNullableString(input.externalSquad),
    upgradeToPlanIds:
      input.upgradeToPlanIds === undefined
        ? [...currentPlan.upgradeToPlanIds]
        : normalizeUuidArray(input.upgradeToPlanIds),
    replacementPlanIds:
      input.replacementPlanIds === undefined
        ? [...currentPlan.replacementPlanIds]
        : normalizeUuidArray(input.replacementPlanIds),
    allowedUserIds:
      input.allowedUserIds === undefined
        ? [...currentPlan.allowedUserIds]
        : normalizeUuidArray(input.allowedUserIds),
    durations:
      input.durations ??
      currentPlan.durations.map((duration) => ({
        days: duration.days,
        prices: duration.prices.map((price) => ({
          currency: price.currency,
          price: price.price.toString(),
        })),
      })),
  });
}

export function buildPlanWriteData(input: NormalizedPlanWriteInput): Prisma.PlanUncheckedCreateInput {
  return {
    name: input.name,
    description: input.description,
    tag: input.tag,
    isActive: input.isActive,
    isArchived: input.isArchived,
    archivedRenewMode: input.archivedRenewMode,
    type: input.type,
    availability: input.availability,
    trafficLimit: input.trafficLimit,
    deviceLimit: input.deviceLimit,
    trafficLimitStrategy: input.trafficLimitStrategy as never,
    internalSquads: [...input.internalSquads],
    externalSquad: input.externalSquad,
    upgradeToPlanIds: [...input.upgradeToPlanIds],
    replacementPlanIds: [...input.replacementPlanIds],
    allowedUserIds: [...input.allowedUserIds],
  };
}

export function buildPlanDurationCreateInput(
  durations: readonly AdminPlanDurationDto[],
): Prisma.PlanDurationUncheckedCreateWithoutPlanInput[] {
  return durations.map((duration) => ({
    days: duration.days,
    prices: {
      create: duration.prices.map((price) => ({
        currency: price.currency,
        price: price.price,
      })),
    },
  }));
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

function normalizeStringArray(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeUuidArray(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * Final pass that enforces the type-driven invariants for traffic and
 * device limits — `DEVICES` plans force traffic to null, `TRAFFIC` plans
 * force device limit to -1 (unlimited), `UNLIMITED` plans clear both.
 */
function normalizePlanWriteInput(input: NormalizedPlanWriteInput): NormalizedPlanWriteInput {
  let trafficLimit = input.trafficLimit;
  let deviceLimit = input.deviceLimit;
  if (input.type === 'DEVICES') {
    trafficLimit = null;
  } else if (input.type === 'TRAFFIC') {
    deviceLimit = -1;
  } else if (input.type === 'UNLIMITED') {
    trafficLimit = null;
    deviceLimit = -1;
  }
  return {
    ...input,
    trafficLimit,
    deviceLimit,
  };
}
