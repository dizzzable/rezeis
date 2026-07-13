import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalAddOnsController } from '../src/modules/add-ons/controllers/internal-add-ons.controller';

describe('InternalAddOnsController', () => {
  it('delegates the legacy plan listing to AddOnsService.listForPlan', async () => {
    const calls: string[] = [];
    const addOnsService = {
      listForPlan: async (planId: string) => { calls.push(planId); return []; },
    };
    const eligibility = { listForSubscription: async () => ({}) };
    const controller = new InternalAddOnsController(addOnsService as never, eligibility as never);

    await controller.listForPlan('plan-1');
    assert.deepEqual(calls, ['plan-1']);
  });

  it('delegates the v2 subscription listing to AddOnEligibilityService.listForSubscription', async () => {
    const calls: Array<{ subscriptionId: string; owner: unknown }> = [];
    const addOnsService = { listForPlan: async () => [] };
    const eligibility = {
      listForSubscription: async (subscriptionId: string, owner: unknown) => {
        calls.push({ subscriptionId, owner });
        return { contractVersion: 2 as const, availability: 'EMPTY' as const, target: null, addOns: [] };
      },
    };
    const controller = new InternalAddOnsController(addOnsService as never, eligibility as never);

    const result = await controller.listForSubscription('sub-9', 'user-7', undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.subscriptionId, 'sub-9');
    // The caller identity is forwarded so the service can scope ownership.
    assert.deepEqual(calls[0]!.owner, { userId: 'user-7', telegramId: undefined });
    assert.equal(result.contractVersion, 2);
  });
});
