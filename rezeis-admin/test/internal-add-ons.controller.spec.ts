import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalAddOnsController } from '../src/modules/add-ons/controllers/internal-add-ons.controller';
import { CabinetView } from '../src/modules/reiwa-peers/cabinet-capabilities';

/** The cabinet registry, answering one view for every request and recording what it was asked. */
function peersAnswering(view: CabinetView) {
  const asked: Array<{ headers: unknown; surface: string }> = [];
  return {
    asked,
    peers: {
      viewOfRequest: async (headers: unknown, surface: string) => {
        asked.push({ headers, surface });
        return view;
      },
    },
  };
}

describe('InternalAddOnsController', () => {
  it('delegates the legacy plan listing to AddOnsService.listForPlan', async () => {
    const calls: string[] = [];
    const addOnsService = {
      listForPlan: async (planId: string) => { calls.push(planId); return []; },
    };
    const eligibility = { listForSubscription: async () => ({}) };
    const { peers } = peersAnswering(CabinetView.all());
    const controller = new InternalAddOnsController(addOnsService as never, eligibility as never, {} as never, peers as never);

    await controller.listForPlan('plan-1');
    assert.deepEqual(calls, ['plan-1']);
  });

  it('delegates the v2 subscription listing to AddOnEligibilityService.listForSubscription', async () => {
    const calls: Array<{ subscriptionId: string; owner: unknown; audience: unknown }> = [];
    const addOnsService = { listForPlan: async () => [] };
    const eligibility = {
      listForSubscription: async (subscriptionId: string, owner: unknown, audience: unknown) => {
        calls.push({ subscriptionId, owner, audience });
        return { contractVersion: 2 as const, availability: 'EMPTY' as const, target: null, addOns: [] };
      },
    };
    const view = CabinetView.floor();
    const { peers, asked } = peersAnswering(view);
    const controller = new InternalAddOnsController(addOnsService as never, eligibility as never, {} as never, peers as never);
    const headers = { 'x-reiwa-client': 'surface=api; version=0.9.7.54; instance=reiwa' };

    const result = await controller.listForSubscription('sub-9', 'user-7', undefined, headers);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.subscriptionId, 'sub-9');
    // The caller identity is forwarded so the service can scope ownership.
    assert.deepEqual(calls[0]!.owner, { userId: 'user-7', telegramId: undefined });
    // …and the caller is the audience: its own headers, read for the api surface.
    assert.deepEqual(asked, [{ headers, surface: 'api' }]);
    assert.equal(calls[0]!.audience, view);
    assert.equal(result.contractVersion, 2);
  });
});
