import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import {
  MIN_INVITE_COUNT_SETTING,
  MIN_LINK_TTL_SECONDS,
  ReferralInviteLimitsService,
} from '../src/modules/referrals/services/referral-invite-limits.service';
import { UpdateUserInviteSettingsDto } from '../src/modules/users/dto/update-user-invite-settings.dto';

/**
 * `linkTtlSeconds` feeds `resolveInviteExpiry`, which returns
 * `now + linkTtlSeconds`. It had no usable lower bound in either place it can
 * be set:
 *
 *   - the per-user DTO permitted `@Min(0)`, and a TTL of 0 makes
 *     `expiresAt === now` - an invite already expired when it is written;
 *   - the GLOBAL value is raw JSON out of `Settings.referralSettings`, read by
 *     a helper that accepted any finite number, NEGATIVES included, so an
 *     invite could be born expired by configuration.
 *
 * Both are bounded now. The DTO refuses new out-of-range values; the reader
 * CLAMPS stored ones, because it runs on every invite-hub view and throwing
 * there would take the whole referral feature down over one bad number.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: UpdateUserInviteSettingsDto,
  data: undefined,
};

function validate(raw: Record<string, unknown>): Promise<unknown> {
  return pipe.transform(raw, metadata);
}

/**
 * The pipe returns a CLASS INSTANCE and `assert/strict`'s `deepEqual` compares
 * prototypes, so flatten to a plain object before comparing shape.
 */
async function validatedFields(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dto = (await validate(raw)) as Record<string, unknown>;
  return { ...dto };
}

interface WarnRecord {
  readonly message: string;
}

/**
 * Builds the service over a settings row and an optional per-user override,
 * capturing anything the logger warns about so "clamped" can be told apart
 * from "clamped silently".
 */
function buildLimitsService(input: {
  readonly globalInviteLimits: Record<string, unknown> | null;
  readonly userOverride?: Record<string, unknown> | null;
}): { service: ReferralInviteLimitsService; warnings: WarnRecord[] } {
  const warnings: WarnRecord[] = [];
  const prisma = {
    settings: {
      findFirst: async (): Promise<unknown> =>
        input.globalInviteLimits === null
          ? { referralSettings: {} }
          : { referralSettings: { inviteLimits: input.globalInviteLimits } },
    },
    user: {
      findUnique: async (): Promise<unknown> => ({
        referralInviteSettings: input.userOverride ?? null,
      }),
    },
  };
  const service = new ReferralInviteLimitsService(prisma as never);
  (service as unknown as { logger: { warn: (message: string) => void } }).logger = {
    warn: (message: string): void => {
      warnings.push({ message });
    },
  };
  return { service, warnings };
}

describe('UpdateUserInviteSettingsDto linkTtlSeconds floor', () => {
  it('refuses a TTL of 0, which minted an invite expiring at its own creation', async () => {
    await assert.rejects(
      () => validate({ linkTtlSeconds: 0 }),
      (error: unknown) => {
        const response = (error as { getResponse: () => { message?: unknown } }).getResponse();
        const messages = Array.isArray(response.message) ? response.message : [];
        assert.ok(
          messages.some((entry: string) => entry.includes('linkTtlSeconds')),
          `expected a linkTtlSeconds constraint, got ${JSON.stringify(response.message)}`,
        );
        return true;
      },
    );
  });

  it('refuses a sub-minute TTL', async () => {
    await assert.rejects(() => validate({ linkTtlSeconds: MIN_LINK_TTL_SECONDS - 1 }));
    await assert.rejects(() => validate({ linkTtlSeconds: 1 }));
  });

  it('refuses a negative TTL', async () => {
    await assert.rejects(() => validate({ linkTtlSeconds: -86400 }));
  });

  // ANTI-VACUITY CONTROL: a bound that also rejects good values is its own
  // outage. The floor itself, and an ordinary day, must both pass.
  it('accepts the floor exactly, and an ordinary TTL', async () => {
    const atFloor = await validatedFields({ linkTtlSeconds: MIN_LINK_TTL_SECONDS });
    assert.deepEqual(atFloor, { linkTtlSeconds: MIN_LINK_TTL_SECONDS });

    const aDay = await validatedFields({ linkTtlSeconds: 86400 });
    assert.deepEqual(aDay, { linkTtlSeconds: 86400 });
  });

  it('still accepts null, which means "no expiry" rather than a bad number', async () => {
    const dto = await validatedFields({ linkTtlSeconds: null });

    assert.deepEqual(dto, { linkTtlSeconds: null });
  });
});

describe('ReferralInviteLimitsService stored TTL normalisation', () => {
  it('clamps a stored zero TTL up to the floor, and says so', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 0 },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.linkTtlSeconds, MIN_LINK_TTL_SECONDS);
    assert.equal(warnings.length, 1, 'a clamp must never be silent');
    assert.ok(warnings[0]?.message.includes('linkTtlSeconds=0'));
  });

  it('clamps a stored NEGATIVE TTL, which minted already-expired invites', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: -86400 },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.linkTtlSeconds, MIN_LINK_TTL_SECONDS);
    assert.equal(warnings.length, 1);
  });

  it('clamps an out-of-range per-user override, not just the global value', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 86400 },
      userOverride: { linkTtlEnabled: true, linkTtlSeconds: -5 },
    });

    const limits = await service.getEffectiveLimitsForUser('user-1');

    assert.equal(limits.linkTtlSeconds, MIN_LINK_TTL_SECONDS);
    assert.ok(warnings.some((entry) => entry.message.includes('user override')));
  });

  // ANTI-VACUITY CONTROL: normalisation must leave good configuration alone,
  // and must not warn about values it did not change.
  it('leaves a valid TTL untouched and silent', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 86400 },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.linkTtlSeconds, 86400);
    assert.deepEqual(warnings, []);
  });

  it('leaves null alone - "no expiry" is a setting, not an out-of-range number', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: null },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.linkTtlSeconds, null);
    assert.deepEqual(warnings, []);
  });

  it('does not warn about a bad TTL that is switched off and never read', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: false, linkTtlSeconds: 0 },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.linkTtlEnabled, false);
    assert.deepEqual(warnings, []);
  });
});

describe('ReferralInviteLimitsService resolved expiry', () => {
  it('resolves a strictly future expiry even from a stored zero TTL', async () => {
    const { service } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 0 },
    });

    const before = Date.now();
    const expiry = await service.resolveInviteExpiry('user-1');

    assert.ok(expiry instanceof Date);
    assert.ok(
      expiry.getTime() > before,
      `expiry ${expiry.toISOString()} must be strictly after ${new Date(before).toISOString()}`,
    );
    // This is the invariant `ReferralsService`'s past-date guard depends on.
    assert.ok(expiry.getTime() >= before + MIN_LINK_TTL_SECONDS * 1000);
  });

  it('still returns null when TTL is disabled - permanent invites survive', async () => {
    const { service } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: false, linkTtlSeconds: 86400 },
    });

    assert.equal(await service.resolveInviteExpiry('user-1'), null);
  });

  it('refuses a TTL so large it does not resolve to a valid date', async () => {
    const { service } = buildLimitsService({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 1e18 },
    });

    await assert.rejects(() => service.resolveInviteExpiry('user-1'), BadRequestException);
  });
});

/**
 * `initialSlots`, `refillThresholdQualified` and `refillAmount` go through the
 * same unbounded `num()` reader the TTL did. The floor for all three is ZERO,
 * not one: zero is a coherent setting in each (no slots / no refills / refills
 * that add nothing). NEGATIVE is the broken case, and it is worse than the TTL
 * bug was - `remainingSlots = Math.max(0, totalSlots - usedSlots)` floors a
 * negative `initialSlots` into a silent lockout with no invite and no
 * explanation, and a negative `refillAmount` takes slots AWAY as the user
 * qualifies more referrals.
 */
describe('UpdateUserInviteSettingsDto slot-accounting floors', () => {
  const fields = ['initialSlots', 'refillThresholdQualified', 'refillAmount'] as const;

  for (const field of fields) {
    it(`refuses a negative ${field}`, async () => {
      await assert.rejects(
        () => validate({ [field]: -1 }),
        (error: unknown) => {
          const response = (error as { getResponse: () => { message?: unknown } }).getResponse();
          const messages = Array.isArray(response.message) ? response.message : [];
          assert.ok(
            messages.some((entry: string) => entry.includes(field)),
            `expected a ${field} constraint, got ${JSON.stringify(response.message)}`,
          );
          return true;
        },
      );
    });

    // ANTI-VACUITY CONTROL: zero means something real in every one of these,
    // so a floor of 1 would forbid a legitimate configuration.
    it(`still accepts ${field} = 0, which is a real setting`, async () => {
      assert.deepEqual(await validatedFields({ [field]: MIN_INVITE_COUNT_SETTING }), {
        [field]: 0,
      });
    });

    it(`still accepts an ordinary ${field}`, async () => {
      assert.deepEqual(await validatedFields({ [field]: 5 }), { [field]: 5 });
    });
  }
});

describe('ReferralInviteLimitsService stored slot-accounting normalisation', () => {
  it('clamps a negative initialSlots, which silently locked the user out', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { slotsEnabled: true, initialSlots: -5 },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.initialSlots, MIN_INVITE_COUNT_SETTING);
    assert.equal(warnings.length, 1, 'a clamp must never be silent');
    assert.ok(warnings[0]?.message.includes('initialSlots=-5'));
  });

  it('clamps a negative refillAmount, which inverted the reward', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { slotsEnabled: true, initialSlots: 3, refillAmount: -2 },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.refillAmount, MIN_INVITE_COUNT_SETTING);
    assert.ok(warnings.some((entry) => entry.message.includes('refillAmount=-2')));
  });

  it('clamps a negative refillThresholdQualified', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { slotsEnabled: true, initialSlots: 3, refillThresholdQualified: -1 },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.refillThresholdQualified, MIN_INVITE_COUNT_SETTING);
    assert.equal(warnings.length, 1);
  });

  it('clamps an out-of-range per-user override, not just the global value', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { slotsEnabled: true, initialSlots: 10 },
      userOverride: { slotsEnabled: true, initialSlots: -3 },
    });

    const limits = await service.getEffectiveLimitsForUser('user-1');

    assert.equal(limits.initialSlots, MIN_INVITE_COUNT_SETTING);
    assert.ok(warnings.some((entry) => entry.message.includes('user override')));
  });

  // ANTI-VACUITY CONTROL: good configuration must survive untouched and quiet,
  // INCLUDING the zeroes that mean something.
  it('leaves zero and positive slot settings untouched and silent', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: {
        slotsEnabled: true,
        initialSlots: 0,
        refillThresholdQualified: 3,
        refillAmount: 0,
      },
    });

    const limits = await service.getEffectiveLimits();

    assert.equal(limits.initialSlots, 0);
    assert.equal(limits.refillThresholdQualified, 3);
    assert.equal(limits.refillAmount, 0);
    assert.deepEqual(warnings, []);
  });

  it('does not warn about bad slot settings that are switched off', async () => {
    const { service, warnings } = buildLimitsService({
      globalInviteLimits: { slotsEnabled: false, initialSlots: -5 },
    });

    await service.getEffectiveLimits();

    assert.deepEqual(warnings, []);
  });
});
