import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Prisma,
  Promocode,
  PromocodeAvailability,
  PromocodeRewardType,
} from '@prisma/client';

import {
  mapPromocode,
  parsePromocodePlanSnapshot,
} from '../src/modules/promocodes/utils/promocode-mappers.util';

type PromocodeWithCount = Promocode & {
  readonly _count?: { readonly activations: number };
};

function makePromocode(overrides: Partial<PromocodeWithCount> = {}): PromocodeWithCount {
  return {
    id: 'promo-1',
    code: 'SUMMER2026',
    isActive: true,
    availability: PromocodeAvailability.ALL,
    rewardType: PromocodeRewardType.SUBSCRIPTION,
    reward: 30,
    plan: null,
    lifetime: null,
    expiresAt: null,
    maxActivations: 100,
    allowedTelegramIds: [BigInt('1001'), BigInt('1002')],
    allowedPlanIds: ['plan-a', 'plan-b'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    _count: { activations: 5 },
    ...overrides,
  } as PromocodeWithCount;
}

describe('promocode mappers', () => {
  it('maps current promocode records to the public controller contract', () => {
    const result = mapPromocode(makePromocode());

    assert.deepStrictEqual(result, {
      id: 'promo-1',
      code: 'SUMMER2026',
      isActive: true,
      availability: PromocodeAvailability.ALL,
      rewardType: PromocodeRewardType.SUBSCRIPTION,
      reward: 30,
      plan: null,
      lifetime: null,
      expiresAt: null,
      maxActivations: 100,
      allowedTelegramIds: ['1001', '1002'],
      allowedPlanIds: ['plan-a', 'plan-b'],
      activationsCount: 5,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('defaults missing activation counts to zero', () => {
    const result = mapPromocode(makePromocode({ _count: undefined }));

    assert.equal(result.activationsCount, 0);
  });

  it('parses valid subscription reward plan snapshots defensively', () => {
    const result = parsePromocodePlanSnapshot({
      id: 'plan-1',
      name: 'Premium',
      type: 'BOTH',
      trafficLimit: 1024,
      deviceLimit: 5,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: ['squad-a', 42, 'squad-b'],
      externalSquad: 'external-a',
      duration: 30,
      tag: 'recommended',
      description: 'Premium plan',
    } as Prisma.JsonObject);

    assert.deepStrictEqual(result, {
      id: 'plan-1',
      name: 'Premium',
      type: 'BOTH',
      trafficLimit: 1024,
      deviceLimit: 5,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: ['squad-a', 'squad-b'],
      externalSquad: 'external-a',
      duration: 30,
      tag: 'recommended',
      description: 'Premium plan',
      icon: null,
    });
  });

  it('carries the plan icon through the reward snapshot', () => {
    // The parser rebuilds the snapshot from a whitelist, so anything it does not
    // name is dropped. A promo / quest / referral-granted subscription must
    // freeze the same icon a paid purchase would.
    const withIcon = parsePromocodePlanSnapshot({
      id: 'plan-1',
      name: 'Premium',
      type: 'BOTH',
      trafficLimit: null,
      deviceLimit: 0,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
      icon: 'custom:abc123',
    } as Prisma.JsonObject);

    assert.equal(withIcon?.icon, 'custom:abc123');
    // A non-string icon degrades to null instead of leaking into the snapshot.
    const malformed = parsePromocodePlanSnapshot({
      id: 'plan-1',
      name: 'Premium',
      type: 'BOTH',
      trafficLimit: null,
      deviceLimit: 0,
      trafficLimitStrategy: 'NO_RESET',
      internalSquads: [],
      externalSquad: null,
      icon: 42,
    } as Prisma.JsonObject);
    assert.equal(malformed?.icon, null);
  });

  it('returns null for malformed plan snapshot payloads', () => {
    assert.equal(parsePromocodePlanSnapshot(null), null);
    assert.equal(parsePromocodePlanSnapshot('not-json-object'), null);
    assert.equal(parsePromocodePlanSnapshot({ name: 'Missing id' } as Prisma.JsonObject), null);
  });
});
