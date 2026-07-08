import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReferralInviteLimitsService } from '../src/modules/referrals/services/referral-invite-limits.service';

function createService(referralSettings: unknown): ReferralInviteLimitsService {
  const prismaService = {
    settings: { findFirst: async () => ({ referralSettings }) },
  };
  return new ReferralInviteLimitsService(prismaService as never);
}

function createCapacityService(input: {
  readonly referralSettings: unknown;
  readonly userOverride: unknown;
  readonly inviteCount: number;
  readonly qualifiedCount: number;
}): ReferralInviteLimitsService {
  const prismaService = {
    settings: { findFirst: async () => ({ referralSettings: input.referralSettings }) },
    user: { findUnique: async () => ({ referralInviteSettings: input.userOverride }) },
    referralInvite: { count: async () => input.inviteCount },
    referral: { count: async () => input.qualifiedCount },
  };
  return new ReferralInviteLimitsService(prismaService as never);
}

describe('ReferralInviteLimitsService.getEffectiveLimits', () => {
  it('reads the admin FORM shape (camelCase inviteLimits)', async () => {
    // Regression: the form persists `inviteLimits.linkTtlEnabled` etc.
    // (camelCase). The old reader only understood snake_case, so operator
    // limits silently never took effect.
    const service = createService({
      inviteLimits: {
        linkTtlEnabled: true,
        linkTtlSeconds: 259200,
        slotsEnabled: true,
        initialSlots: 5,
      },
    });

    assert.deepStrictEqual(await service.getEffectiveLimits(), {
      linkTtlEnabled: true,
      linkTtlSeconds: 259200,
      slotsEnabled: true,
      initialSlots: 5,
      refillThresholdQualified: null,
      refillAmount: null,
    });
  });

  it('still reads the legacy snake_case shape (backward compatible)', async () => {
    const service = createService({
      invite_limits: {
        link_ttl_enabled: true,
        link_ttl_seconds: 86400,
        slots_enabled: true,
        initial_slots: 3,
        refill_threshold_qualified: 2,
        refill_amount: 1,
      },
    });

    assert.deepStrictEqual(await service.getEffectiveLimits(), {
      linkTtlEnabled: true,
      linkTtlSeconds: 86400,
      slotsEnabled: true,
      initialSlots: 3,
      refillThresholdQualified: 2,
      refillAmount: 1,
    });
  });

  it('falls back to disabled defaults when nothing is configured', async () => {
    const service = createService({});

    assert.deepStrictEqual(await service.getEffectiveLimits(), {
      linkTtlEnabled: false,
      linkTtlSeconds: null,
      slotsEnabled: false,
      initialSlots: null,
      refillThresholdQualified: null,
      refillAmount: null,
    });
  });
});

describe('ReferralInviteLimitsService.getCapacity (per-user override applied)', () => {
  it('applies the per-user slot override even when global slots are disabled', async () => {
    // Regression: getCapacity used the GLOBAL limits only, so a per-user slot
    // override (saved via the admin user-detail page) was silently ignored.
    const service = createCapacityService({
      referralSettings: {}, // global: slots disabled
      userOverride: { slotsEnabled: true, initialSlots: 10 },
      inviteCount: 3,
      qualifiedCount: 0,
    });

    assert.deepStrictEqual(await service.getCapacity('user-1'), {
      totalSlots: 10,
      usedSlots: 3,
      remainingSlots: 7,
      canCreateInvite: true,
    });
  });
});
