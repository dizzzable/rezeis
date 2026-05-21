import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROMOCODE_ACTIVATION_ERROR_CODES,
  PROMOCODE_ACTIVATION_NEXT_STEPS,
  PromocodeActivationNextStep,
} from '../src/modules/promocodes/interfaces/promocode-contract.interface';

describe('promocode-contract enums and types', () => {
  describe('PROMOCODE_ACTIVATION_ERROR_CODES', () => {
    it('contains all 12 expected error codes', () => {
      const expectedCodes = [
        'NOT_FOUND',
        'INACTIVE',
        'EXPIRED',
        'DEPLETED',
        'ALREADY_ACTIVATED',
        'NOT_AVAILABLE_FOR_USER',
        'PLAN_NOT_ELIGIBLE',
        'SUBSCRIPTION_REQUIRED',
        'NO_ELIGIBLE_SUBSCRIPTIONS',
        'CREATE_NEW_REQUIRED',
        'REWARD_EXECUTION_FAILED',
        'INTERNAL_ERROR',
      ];

      assert.equal(PROMOCODE_ACTIVATION_ERROR_CODES.length, 12);
      for (const code of expectedCodes) {
        assert.ok(
          (PROMOCODE_ACTIVATION_ERROR_CODES as readonly string[]).includes(code),
          `Expected ${code} to be in PROMOCODE_ACTIVATION_ERROR_CODES`,
        );
      }
    });

    it('is a readonly tuple', () => {
      assert.ok(Array.isArray(PROMOCODE_ACTIVATION_ERROR_CODES));
      const mutableCopy = [...PROMOCODE_ACTIVATION_ERROR_CODES];
      mutableCopy.push('NEW_CODE');
      assert.equal(mutableCopy.length, PROMOCODE_ACTIVATION_ERROR_CODES.length + 1);
      assert.equal(PROMOCODE_ACTIVATION_ERROR_CODES.length, 12);
    });

    it('can be used as a discriminated union type', () => {
      const errorCode = 'NOT_FOUND' as (typeof PROMOCODE_ACTIVATION_ERROR_CODES)[number];
      assert.equal(errorCode, 'NOT_FOUND');

      const anyCode = 'INTERNAL_ERROR' as (typeof PROMOCODE_ACTIVATION_ERROR_CODES)[number];
      assert.equal(anyCode, 'INTERNAL_ERROR');
    });
  });

  describe('PROMOCODE_ACTIVATION_NEXT_STEPS', () => {
    it('contains exactly three steps', () => {
      assert.equal(PROMOCODE_ACTIVATION_NEXT_STEPS.length, 3);
    });

    it('contains NONE, SELECT_SUBSCRIPTION, CREATE_NEW', () => {
      assert.ok(PROMOCODE_ACTIVATION_NEXT_STEPS.includes('NONE'));
      assert.ok(PROMOCODE_ACTIVATION_NEXT_STEPS.includes('SELECT_SUBSCRIPTION'));
      assert.ok(PROMOCODE_ACTIVATION_NEXT_STEPS.includes('CREATE_NEW'));
    });

    it('can be used as a discriminated union type', () => {
      const nextStep = 'SELECT_SUBSCRIPTION' as PromocodeActivationNextStep;
      assert.equal(nextStep, 'SELECT_SUBSCRIPTION');

      const noneStep = 'NONE' as PromocodeActivationNextStep;
      assert.equal(noneStep, 'NONE');
    });
  });

  describe('PromocodeActivationNextStep type', () => {
    it('is a union of the three next steps', () => {
      const steps: PromocodeActivationNextStep[] = ['NONE', 'SELECT_SUBSCRIPTION', 'CREATE_NEW'];
      assert.equal(steps.length, 3);
    });

    it('assigns correctly from the const tuple values', () => {
      for (const step of PROMOCODE_ACTIVATION_NEXT_STEPS) {
        const typed: PromocodeActivationNextStep = step;
        assert.ok(typeof typed === 'string');
      }
    });
  });
});
