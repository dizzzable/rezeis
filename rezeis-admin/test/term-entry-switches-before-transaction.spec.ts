import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanAvailability, PromocodeAvailability, PromocodeRewardType } from '@prisma/client';

import { resolveAddOnRolloutFlags } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import type { PromocodeInterface } from '../src/modules/promocodes/interfaces/promocode.interface';
import { PromocodeLifecycleService } from '../src/modules/promocodes/services/promocode-lifecycle.service';
import { PromocodeRewardsService } from '../src/modules/promocodes/services/promocode-rewards.service';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';
import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

/**
 * A NEW SUBSCRIPTION ENTERS THE TERM MODEL WITH THE SWITCHES ITS WRITER READ
 * BEFORE ITS TRANSACTION (review R2b-07, S4-core's leftover for the three
 * callers outside its files): a free trial, «Выдать подписку», a promo code's
 * subscription. Read inside the transaction, a cold settings cache takes a
 * second pool connection while this one is held, and a burst of such writes
 * can wait on each other until the pool times out.
 *
 * Each case logs, in order, the read of the switches, the transaction opening
 * and the entry into the model — and which snapshot the entry was handed.
 */

/** The snapshot the writer read: stage 1 on, so the entry is not a no-op by accident. */
const SNAPSHOT = resolveAddOnRolloutFlags({ durableAccounting: true }, {});

function recordingHooks(log: string[]) {
  const entered: Array<{ subscriptionId: string; flags: unknown }> = [];
  return {
    entered,
    hooks: {
      readFlags: async () => {
        log.push('switches read');
        return SNAPSHOT;
      },
      enterNewSubscriptionInTransaction: async (_tx: unknown, subscriptionId: string, flags?: unknown) => {
        log.push('entered');
        entered.push({ subscriptionId, flags });
        return null;
      },
      followExpiryInTransaction: async () => ({ outcome: 'NOT_IN_MODEL' as const }),
      rotateForPlanChangeInTransaction: async () => ({ outcome: 'NO_ACTIVE_TERM' as const }),
      grantLimitBonusInTransaction: async () => ({ outcome: 'NOT_IN_MODEL' as const }),
    },
  };
}

describe('a new subscription enters the model with the switches read before its transaction', () => {
  it('a free trial (SubscriptionMutationsService.grantTrial)', async () => {
    const log: string[] = [];
    const { hooks, entered } = recordingHooks(log);
    const prisma = {
      plan: {
        findUnique: async () => ({
          id: 'trial-plan',
          name: 'Trial',
          type: 'BOTH',
          icon: null,
          trafficLimit: 10,
          deviceLimit: 1,
          trafficLimitStrategy: 'NO_RESET',
          internalSquads: [],
          externalSquad: null,
          tag: null,
          availability: PlanAvailability.TRIAL,
          trialSettings: { free: true, maxClaims: 1, availabilityScope: 'ALL' },
          deletedAt: null,
        }),
      },
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
        log.push('transaction opened');
        return callback({
          $queryRaw: async () => [{ id: 'user-1' }],
          trialClaim: { aggregate: async () => ({ _sum: { units: 0 } }), create: async () => ({ id: 'claim-1' }) },
          subscription: { create: async () => ({ id: 'sub-trial' }) },
          trialGrant: { upsert: async () => undefined },
          profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
        });
      },
    };
    const service = new SubscriptionMutationsService(prisma as never, { enqueue: async () => undefined } as never, hooks as never);

    await service.grantTrial({ userId: 'user-1', planId: 'trial-plan', durationDays: 7 });

    assert.deepEqual(log, ['switches read', 'transaction opened', 'entered']);
    assert.deepEqual(entered, [{ subscriptionId: 'sub-trial', flags: SNAPSHOT }]);
  });

  it('«Выдать подписку» (AdminUserSubscriptionsController.giveSubscription)', async () => {
    const log: string[] = [];
    const { hooks, entered } = recordingHooks(log);
    const controller = new AdminUserSubscriptionsController(
      {
        user: { findFirst: async () => ({ id: 'user-1', telegramId: BigInt(42) }) },
        plan: {
          findUnique: async () => ({
            id: 'plan-1',
            name: 'Pro',
            type: 'BOTH',
            trafficLimit: 100,
            deviceLimit: 3,
            trafficLimitStrategy: 'MONTH',
            internalSquads: [],
            externalSquad: null,
            deletedAt: null,
          }),
        },
        profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
        adminAuditLog: { create: async () => undefined },
        $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
          log.push('transaction opened');
          return callback({
            subscription: { create: async () => ({ id: 'sub-given', remnawaveId: null }) },
          });
        },
      } as never,
      {} as never,
      { enqueue: async () => undefined } as never,
      { warn: () => undefined, info: () => undefined } as never,
      {} as never,
      {} as never,
      hooks as never,
    );

    await controller.giveSubscription(
      '42',
      { planId: 'plan-1', durationDays: 30 },
      { id: 'admin-1' } as never,
      { headers: {}, ip: '10.0.0.7', socket: { remoteAddress: null } } as never,
    );

    assert.deepEqual(log, ['switches read', 'transaction opened', 'entered']);
    assert.deepEqual(entered, [{ subscriptionId: 'sub-given', flags: SNAPSHOT }]);
  });

  describe('a promo code\'s subscription', () => {
    function promocode(actions: PromocodeRewardType[]): PromocodeInterface {
      return {
        id: 'promo-1',
        code: 'GIFT',
        isActive: true,
        availability: PromocodeAvailability.ALL,
        rewardType: actions[0]!,
        actions: actions.map((type) => ({
          type,
          value: type === PromocodeRewardType.DURATION ? 7 : null,
          plan: null,
          discountAllowedPlanIds: [],
          discountValidForDays: null,
        })),
        reward: null,
        plan: null,
        lifetime: null,
        expiresAt: null,
        maxActivations: null,
        allowedTelegramIds: [],
        allowedPlanIds: [],
        activationsCount: 0,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      };
    }

    function lifecycle(code: PromocodeInterface, log: string[], handed: unknown[]) {
      const transactionClient = {
        $queryRaw: async () => [{ id: code.id }],
        promocode: {
          findUnique: async () => ({
            isActive: true,
            archivedAt: null,
            createdAt: new Date(code.createdAt),
            updatedAt: new Date(code.updatedAt),
            lifetime: null,
            expiresAt: null,
            maxActivations: null,
          }),
        },
        promocodeActivation: {
          count: async () => 0,
          create: async () => ({
            id: 'act-1',
            promocodeId: code.id,
            promocodeCode: code.code,
            userId: 'user-1',
            rewardType: code.rewardType,
            rewardValue: 30,
            targetSubscriptionId: null,
            activatedAt: new Date('2026-09-25T00:00:00.000Z'),
          }),
        },
        promocodeActivationEffect: { create: async () => ({}) },
      };
      return new PromocodeLifecycleService(
        {
          $transaction: async (callback: (tx: typeof transactionClient) => unknown) => {
            log.push('transaction opened');
            return callback(transactionClient);
          },
        } as never,
        {
          resolveActivationContext: async () => ({ hasActiveSubscriptions: false, isInvitedUser: false }),
          validate: async () => ({ success: true, promocode: code }),
          resolveTargetSubscription: async () => ({ subscriptionId: null, errorCode: null }),
        } as never,
        {
          resolveActivationRewardValue: () => 30,
          readTermFlags: async () => {
            log.push('switches read');
            return SNAPSHOT;
          },
          applyAction: async (input: { termFlags?: unknown }) => {
            log.push('action applied');
            handed.push(input.termFlags);
            return { applied: true, rewardValue: 30 };
          },
          getSuccessMessageKey: () => 'ntf-promocode-activated-subscription',
        } as never,
        { info: () => undefined, error: () => undefined, emit: () => undefined } as never,
        { enqueue: async () => undefined } as never,
      );
    }

    it('the activation reads the switches before its transaction and hands them to its actions', async () => {
      const log: string[] = [];
      const handed: unknown[] = [];
      await lifecycle(promocode([PromocodeRewardType.SUBSCRIPTION]), log, handed).activate({
        rawCode: 'GIFT',
        userId: 'user-1',
      } as never);

      assert.deepEqual(log, ['switches read', 'transaction opened', 'action applied']);
      assert.deepEqual(handed, [SNAPSHOT]);
    });

    it('a code with no SUBSCRIPTION action reads no switches at all', async () => {
      const log: string[] = [];
      const handed: unknown[] = [];
      await lifecycle(promocode([PromocodeRewardType.DURATION]), log, handed).activate({
        rawCode: 'GIFT',
        userId: 'user-1',
      } as never);

      assert.deepEqual(log, ['transaction opened', 'action applied']);
      assert.deepEqual(handed, [undefined]);
    });

    it('the SUBSCRIPTION action enters the subscription it creates with the snapshot it was handed', async () => {
      const log: string[] = [];
      const { hooks, entered } = recordingHooks(log);
      const rewards = new PromocodeRewardsService(hooks as never);

      await rewards.applyAction({
        transactionClient: {
          subscription: { create: async () => ({ id: 'sub-promo' }) },
          user: { updateMany: async () => ({ count: 1 }) },
          profileSyncJob: { create: async () => ({ id: 'sync-1' }) },
        } as never,
        promocode: promocode([PromocodeRewardType.SUBSCRIPTION]),
        userId: 'user-1',
        targetSubscriptionId: null,
        action: {
          type: PromocodeRewardType.SUBSCRIPTION,
          value: null,
          plan: {
            id: 'plan-1',
            name: 'Premium',
            type: 'BOTH',
            trafficLimit: 100,
            deviceLimit: 5,
            trafficLimitStrategy: 'NO_RESET',
            internalSquads: [],
            externalSquad: null,
            duration: 30,
          },
          discountAllowedPlanIds: [],
          discountValidForDays: null,
        } as never,
        termFlags: SNAPSHOT,
      });

      assert.deepEqual(log, ['entered'], 'nothing read inside: the snapshot handed in is used');
      assert.deepEqual(entered, [{ subscriptionId: 'sub-promo', flags: SNAPSHOT }]);
    });
  });
});
