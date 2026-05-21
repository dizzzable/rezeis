import { Injectable, NotFoundException } from '@nestjs/common';
import { PromocodeRewardType } from '@prisma/client';

import { ActivatePromocodeDto } from '../dto/activate-promocode.dto';
import {
  PromocodeActivationResultInterface,
  PromocodeInterface,
} from '../interfaces/promocode.interface';
import { normalizeCode } from '../utils/code-normalizer.util';
import { PromocodeLifecycleService } from './promocode-lifecycle.service';
import { PromocodeRewardsService } from './promocode-rewards.service';
import { PromocodeValidationService } from './promocode-validation.service';

interface PortalActivationContext {
  readonly userId: string;
  readonly userTelegramId: bigint | null;
  readonly dto: ActivatePromocodeDto;
}

/**
 * Donor: `src/services/promocode_portal.py`.
 *
 * The portal layer wraps `PromocodeLifecycleService.activate(...)` with the
 * branching contract used by the operator UI and the public ruid edge:
 *
 *  - When the promo type expects a subscription target and the caller did
 *    not supply one, the service either auto-resolves the only candidate
 *    subscription, asks the caller to pick one (`SELECT_SUBSCRIPTION`), or
 *    asks them to confirm new-subscription creation (`CREATE_NEW`).
 *  - When validation outright fails, the upstream rejection is forwarded as
 *    is so the UI can render the same i18n key in both flows.
 */
@Injectable()
export class PromocodePortalService {
  public constructor(
    private readonly lifecycleService: PromocodeLifecycleService,
    private readonly validationService: PromocodeValidationService,
    private readonly rewardsService: PromocodeRewardsService,
  ) {}

  public async activate(
    context: PortalActivationContext,
  ): Promise<PromocodeActivationResultInterface> {
    const code = normalizeCode(context.dto.code);
    const promocode = await this.lifecycleService.getByCode(code);
    if (promocode === null) {
      // Defer to the lifecycle pipeline so the failure code/messageKey stay
      // consistent with operator-side direct activation.
      return this.lifecycleService.activate({
        rawCode: code,
        userId: context.userId,
        userTelegramId: context.userTelegramId,
        targetSubscriptionId: context.dto.subscriptionId ?? null,
      });
    }

    const targetSubscriptionId = context.dto.subscriptionId ?? null;
    const isResourceReward =
      promocode.rewardType === PromocodeRewardType.DURATION ||
      promocode.rewardType === PromocodeRewardType.TRAFFIC ||
      promocode.rewardType === PromocodeRewardType.DEVICES;
    const isSubscriptionReward =
      promocode.rewardType === PromocodeRewardType.SUBSCRIPTION;

    if (targetSubscriptionId === null && (isResourceReward || isSubscriptionReward)) {
      const eligibleIds = await this.validationService.getEligibleSubscriptionIds({
        userId: context.userId,
        promocode,
      });

      if (isResourceReward) {
        if (eligibleIds.length === 1) {
          return this.runActivation(context, promocode, eligibleIds[0]);
        }
        if (eligibleIds.length === 0) {
          return this.lifecycleService.activate({
            rawCode: code,
            userId: context.userId,
            userTelegramId: context.userTelegramId,
            targetSubscriptionId: null,
          });
        }
        return this.requestSubscriptionSelection(promocode, eligibleIds);
      }

      // SUBSCRIPTION reward branching:
      if (eligibleIds.length === 1) {
        return this.runActivation(context, promocode, eligibleIds[0]);
      }
      if (eligibleIds.length === 0) {
        if (context.dto.confirmCreateNew === true) {
          return this.runActivation(context, promocode, null);
        }
        return this.requestNewSubscription(promocode);
      }
      return this.requestSubscriptionSelection(promocode, eligibleIds);
    }

    return this.runActivation(context, promocode, targetSubscriptionId);
  }

  /// Read-only public projection of a promo by code. Returns `null` for
  /// unknown codes so the caller can surface a single rejection branch.
  public async getByCode(code: string): Promise<PromocodeInterface | null> {
    return this.lifecycleService.getByCode(code);
  }

  /// Throwing variant used by admin endpoints.
  public async getByIdOrThrow(promocodeId: string): Promise<PromocodeInterface> {
    const found = await this.lifecycleService.getById(promocodeId);
    if (found === null) {
      throw new NotFoundException('Promocode not found');
    }
    return found;
  }

  private async runActivation(
    context: PortalActivationContext,
    promocode: PromocodeInterface,
    targetSubscriptionId: string | null,
  ): Promise<PromocodeActivationResultInterface> {
    return this.lifecycleService.activate({
      rawCode: promocode.code,
      userId: context.userId,
      userTelegramId: context.userTelegramId,
      targetSubscriptionId,
    });
  }

  private requestSubscriptionSelection(
    promocode: PromocodeInterface,
    candidateIds: readonly string[],
  ): PromocodeActivationResultInterface {
    return {
      step: 'SELECT_SUBSCRIPTION',
      messageKey: 'ntf-promocode-select-subscription',
      errorCode: null,
      promocode,
      reward: this.buildRewardSnapshot(promocode),
      availableSubscriptionIds: [...candidateIds],
      activation: null,
    };
  }

  private requestNewSubscription(
    promocode: PromocodeInterface,
  ): PromocodeActivationResultInterface {
    return {
      step: 'CREATE_NEW',
      messageKey: 'ntf-promocode-confirm-create-new',
      errorCode: null,
      promocode,
      reward: this.buildRewardSnapshot(promocode),
      availableSubscriptionIds: [],
      activation: null,
    };
  }

  private buildRewardSnapshot(promocode: PromocodeInterface): {
    readonly type: PromocodeRewardType;
    readonly value: number;
  } {
    return {
      type: promocode.rewardType,
      value: this.rewardsService.resolveActivationRewardValue(promocode),
    };
  }
}
