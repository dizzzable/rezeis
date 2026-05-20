import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PromoCode, PromoCodeAvailability } from '@prisma/client';

import { mapPromoCodeRecord } from '../src/modules/promocodes/utils/plan-record.util';

function makePromoCode(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: 'pc-1',
    code: 'SUMMER2024',
    codeNormalized: 'SUMMER2024',
    planSnapshot: null,
    isActive: true,
    availability: 'ALL',
    rewardType: 'SUBSCRIPTION',
    rewardValue: 30,
    maxActivations: 100,
    expiresAt: null,
    allowedUserIds: [],
    allowedPlanIds: [],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as PromoCode;
}

describe('mapPromoCodeRecord', () => {
  it('maps all promo code fields from database record', () => {
    const promo = makePromoCode();
    const result = mapPromoCodeRecord(promo, 5);

    assert.equal(result.id, 'pc-1');
    assert.equal(result.code, 'SUMMER2024');
    assert.equal(result.codeNormalized, 'SUMMER2024');
    assert.equal(result.isActive, true);
    assert.equal(result.availability, 'ALL');
    assert.equal(result.rewardType, 'SUBSCRIPTION');
    assert.equal(result.rewardValue, 30);
    assert.equal(result.maxActivations, 100);
  });

  it('computes remainingUses as maxActivations minus activationsCount', () => {
    const promo = makePromoCode({ maxActivations: 100 });
    const result = mapPromoCodeRecord(promo, 25);

    assert.equal(result.remainingUses, 75);
  });

  it('computes remainingUses as 0 when activationsCount equals maxActivations', () => {
    const promo = makePromoCode({ maxActivations: 10 });
    const result = mapPromoCodeRecord(promo, 10);

    assert.equal(result.remainingUses, 0);
  });

  it('sets remainingUses to null when maxActivations is null (unlimited)', () => {
    const promo = makePromoCode({ maxActivations: null });
    const result = mapPromoCodeRecord(promo, 999);

    assert.equal(result.remainingUses, null);
  });

  it('sets remainingUses to null when maxActivations is null (no activations)', () => {
    const promo = makePromoCode({ maxActivations: null });
    const result = mapPromoCodeRecord(promo, 0);

    assert.equal(result.remainingUses, null);
  });

  it('converts expiresAt to ISO string when set', () => {
    const expiresAt = new Date('2024-12-31T23:59:59.000Z');
    const promo = makePromoCode({ expiresAt });
    const result = mapPromoCodeRecord(promo, 0);

    assert.equal(result.expiresAt, '2024-12-31T23:59:59.000Z');
  });

  it('sets expiresAt to null when expiresAt is null', () => {
    const promo = makePromoCode({ expiresAt: null });
    const result = mapPromoCodeRecord(promo, 0);

    assert.equal(result.expiresAt, null);
  });

  it('converts createdAt and updatedAt to ISO strings', () => {
    const promo = makePromoCode({
      createdAt: new Date('2024-03-15T10:30:00.000Z'),
      updatedAt: new Date('2024-04-20T12:00:00.000Z'),
    });
    const result = mapPromoCodeRecord(promo, 0);

    assert.equal(result.createdAt, '2024-03-15T10:30:00.000Z');
    assert.equal(result.updatedAt, '2024-04-20T12:00:00.000Z');
  });

  it('maps allowedUserIds as readonly array', () => {
    const promo = makePromoCode({ allowedUserIds: ['user-1', 'user-2'] });
    const result = mapPromoCodeRecord(promo, 0);

    assert.deepStrictEqual(result.allowedUserIds, ['user-1', 'user-2']);
  });

  it('maps allowedPlanIds as readonly array', () => {
    const promo = makePromoCode({ allowedPlanIds: ['plan-a', 'plan-b'] });
    const result = mapPromoCodeRecord(promo, 0);

    assert.deepStrictEqual(result.allowedPlanIds, ['plan-a', 'plan-b']);
  });

  it('records activationsCount correctly', () => {
    const promo = makePromoCode({ maxActivations: 50 });
    const result = mapPromoCodeRecord(promo, 42);

    assert.equal(result.activationsCount, 42);
    assert.equal(result.remainingUses, 8);
  });

  it('handles zero activations', () => {
    const promo = makePromoCode({ maxActivations: 10 });
    const result = mapPromoCodeRecord(promo, 0);

    assert.equal(result.activationsCount, 0);
    assert.equal(result.remainingUses, 10);
  });

  it('maps non-ALL availability correctly', () => {
    const promo = makePromoCode({ availability: 'NEW' as PromoCodeAvailability });
    const result = mapPromoCodeRecord(promo, 0);

    assert.equal(result.availability, 'NEW');
  });
});