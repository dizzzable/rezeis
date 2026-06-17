import {
  PromocodeAvailability,
  PromocodeRewardType,
} from '@prisma/client';

/**
 * Plan snapshot stored inside `Promocode.plan` for SUBSCRIPTION rewards.
 *
 * The shape matches the donor altshop `PlanSnapshotDto` so existing UI labels
 * and notification templates keep rendering correctly. New fields can be added
 * here only when the corresponding renderer handles their absence gracefully.
 */
export interface PromocodePlanSnapshotInterface {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: string;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  /// Optional default duration (days) used as a fallback reward magnitude.
  readonly duration?: number;
  readonly tag?: string | null;
  readonly description?: string | null;
}

export interface PromocodeInterface {
  readonly id: string;
  readonly code: string;
  readonly isActive: boolean;
  readonly availability: PromocodeAvailability;
  readonly rewardType: PromocodeRewardType;
  readonly reward: number | null;
  readonly plan: PromocodePlanSnapshotInterface | null;
  readonly lifetime: number | null;
  readonly expiresAt: string | null;
  readonly maxActivations: number | null;
  readonly allowedTelegramIds: readonly string[];
  readonly allowedPlanIds: readonly string[];
  readonly activationsCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PromocodeActivationInterface {
  readonly id: string;
  readonly promocodeId: string;
  readonly promocodeCode: string;
  readonly userId: string;
  readonly rewardType: PromocodeRewardType;
  readonly rewardValue: number;
  readonly targetSubscriptionId: string | null;
  readonly activatedAt: string;
}

/**
 * Outcome contract for `PromocodeService.activate(...)`.
 *
 * The activation pipeline can require the caller to supply more context
 * before the reward can be applied (donor parity, `next_step` codes):
 *  - `SELECT_SUBSCRIPTION` — promotion needs a target subscription that the
 *    user owns; the candidate ids are returned so the UI can prompt.
 *  - `CREATE_NEW`          — promotion is a SUBSCRIPTION reward and the user
 *    does not own an eligible subscription yet; the UI confirms creation.
 *  - `REJECTED`            — validation failed; `errorCode` carries the
 *    machine-readable reason and `messageKey` carries the i18n label.
 */
export type PromocodeActivationStep =
  | 'ACTIVATED'
  | 'SELECT_SUBSCRIPTION'
  | 'CREATE_NEW'
  | 'REJECTED';

export type PromocodeActivationErrorCode =
  | 'NOT_FOUND'
  | 'INACTIVE'
  | 'EXPIRED'
  | 'DEPLETED'
  | 'ALREADY_ACTIVATED'
  | 'NOT_AVAILABLE_FOR_USER'
  | 'PLAN_NOT_ELIGIBLE'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'SUBSCRIPTION_FOREIGN'
  | 'NO_ELIGIBLE_SUBSCRIPTION'
  | 'REWARD_NOT_APPLICABLE'
  | 'INTERNAL_ERROR';

export interface PromocodeActivationRewardSnapshotInterface {
  readonly type: PromocodeRewardType;
  readonly value: number;
}

export interface PromocodeActivationResultInterface {
  readonly step: PromocodeActivationStep;
  /// Stable i18n key, e.g. `ntf-promocode-activated-duration`.
  readonly messageKey: string;
  readonly errorCode: PromocodeActivationErrorCode | null;
  readonly promocode: PromocodeInterface | null;
  readonly reward: PromocodeActivationRewardSnapshotInterface | null;
  readonly availableSubscriptionIds: readonly string[];
  readonly activation: PromocodeActivationInterface | null;
}
