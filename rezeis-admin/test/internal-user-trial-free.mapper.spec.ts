import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlanAvailability } from '@prisma/client';

import { readSubscriptionTrialFree } from '../src/modules/internal-user/services/internal-user.mappers';

describe('readSubscriptionTrialFree', () => {
  it('flags a FREE trial (grant snapshot carries the full plan)', () => {
    // A free-trial grant persists the whole plan, incl. availability + settings.
    const snapshot = {
      id: 'trial-plan',
      name: 'Trial',
      availability: PlanAvailability.TRIAL,
      trialSettings: { maxClaims: 1, free: true, availabilityScope: 'ALL' },
    };
    assert.equal(readSubscriptionTrialFree(true, snapshot), true);
  });

  it('does NOT flag a PAID trial (settings say free: false)', () => {
    const snapshot = {
      id: 'paid-trial-plan',
      name: 'Paid trial',
      availability: PlanAvailability.TRIAL,
      trialSettings: { maxClaims: 1, free: false, availabilityScope: 'ALL' },
    };
    assert.equal(readSubscriptionTrialFree(true, snapshot), false);
  });

  it('does NOT flag a paid trial whose completion snapshot omits availability/settings', () => {
    // createSubscriptionFromPayment stores a partial snapshot (no availability).
    const snapshot = { id: 'paid-trial-plan', name: 'Paid trial', type: 'BOTH' };
    assert.equal(readSubscriptionTrialFree(true, snapshot), false);
  });

  it('does NOT flag a non-trial subscription even if the snapshot looks trial-ish', () => {
    const snapshot = {
      id: 'plan',
      availability: PlanAvailability.TRIAL,
      trialSettings: { free: true },
    };
    assert.equal(readSubscriptionTrialFree(false, snapshot), false);
  });

  it('is defensive against null / non-object snapshots', () => {
    assert.equal(readSubscriptionTrialFree(true, null), false);
    assert.equal(readSubscriptionTrialFree(true, 'nonsense'), false);
    assert.equal(readSubscriptionTrialFree(true, ['array']), false);
  });
});
