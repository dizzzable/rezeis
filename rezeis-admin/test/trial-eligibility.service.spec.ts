import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { TRIAL_CLAIM_LIMIT_MESSAGE } from '../src/modules/plans/utils/trial-settings.util';

/**
 * Eligibility must mean "grantable right now".
 *
 * The cabinet decides whether to show the trial offer purely from this answer, so
 * any condition checked only at activation produced an offer that could not be
 * accepted: the block stayed on screen, the button failed every time, and the
 * user was shown an entitlement they did not have.
 */
function build(opts: {
  trialPlan: Record<string, unknown> | null;
  trialSubscriptions?: number;
  activeSubscriptions?: number;
  telegramId?: bigint | null;
  grantThrows?: Error;
}) {
  const prisma = {
    user: {
      findUnique: async (args: { select?: Record<string, unknown> }) =>
        args.select !== undefined && 'telegramId' in args.select
          ? { telegramId: opts.telegramId ?? 1n }
          : { id: 'u1' },
      findFirst: async () => ({ id: 'u1' }),
    },
    plan: {
      findFirst: async () => opts.trialPlan,
    },
    subscription: {
      count: async (args: { where: Record<string, unknown> }) => {
        if ('isTrial' in args.where) {
          // A consumed trial keeps counting after the user deletes it, because
          // deletion is a soft delete. Pin the shape: adding a status filter
          // here would hand the offer back to everyone who already spent their
          // trial, and a stub that only checked `'isTrial' in where` would stay
          // green through exactly that regression.
          assert.deepEqual(
            Object.keys(args.where).sort(),
            ['isTrial', 'userId'],
            'the trial claim count must not filter by subscription status',
          );
          return opts.trialSubscriptions ?? 0;
        }
        return opts.activeSubscriptions ?? 0;
      },
    },
  } as unknown as PrismaService;

  const service = new InternalUserEdgeService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // `resolveUserId` is a private lookup around the same prisma stub; the public
  // surface under test takes a reference and resolves it internally.
  return { service };
}

// Both paths now read the same shape — the smallest duration row — so the stub
// carries one list and either caller sees the same plan.
const PLAN_WITH_DURATION = {
  id: 'trial-plan',
  trialSettings: { free: true, maxClaims: 1 },
  durations: [{ days: 3 }],
};

describe('trial eligibility', () => {
  it('refuses when the trial plan has no duration to grant', async () => {
    // The grant reads `durations[0].days`. Checking this only at activation is
    // what let the cabinet show an offer whose button always failed.
    const { service } = build({
      trialPlan: { ...PLAN_WITH_DURATION, durations: [] },
    });
    const result = await service.getTrialEligibility('1');
    assert.deepEqual(result, { eligible: false, reason: 'TRIAL_NOT_CONFIGURED' });
  });

  it('refuses a duration of zero days, which would expire the instant it is granted', async () => {
    // Imported plans are not validated the way the admin API validates them, so
    // `days: 0` is reachable. Granting it would spend the user's one lifetime
    // claim on a subscription that is already expired.
    const { service } = build({
      trialPlan: { ...PLAN_WITH_DURATION, durations: [{ days: 0 }] },
    });
    assert.deepEqual(await service.getTrialEligibility('1'), {
      eligible: false,
      reason: 'TRIAL_NOT_CONFIGURED',
    });
    assert.deepEqual(
      await service.activateTrial('1', async () => {
        throw new Error('grantTrial must not be reached for an ungrantable duration');
      }),
      { activated: false, reason: 'TRIAL_NOT_CONFIGURED' },
    );
  });

  it('refuses a user who already consumed the trial, deleted subscription included', async () => {
    // Deletion is a soft delete, so the row is still counted — a consumed trial
    // must stay consumed, otherwise the offer reappears after every deletion.
    const { service } = build({ trialPlan: PLAN_WITH_DURATION, trialSubscriptions: 1 });
    const result = await service.getTrialEligibility('1');
    assert.deepEqual(result, { eligible: false, reason: 'TRIAL_ALREADY_USED' });
  });

  it('allows a fresh user when the plan is fully configured', async () => {
    const { service } = build({ trialPlan: PLAN_WITH_DURATION, trialSubscriptions: 0 });
    const result = await service.getTrialEligibility('1');
    assert.deepEqual(result, { eligible: true, reason: null });
  });

  it('reports the claim-limit refusal as a reason instead of throwing', async () => {
    // `grantTrial` enforces the limit by throwing. A bare 400 gave the cabinet
    // nothing to act on, so it kept the offer up with one generic sentence.
    const { service } = build({ trialPlan: PLAN_WITH_DURATION, trialSubscriptions: 0 });
    const result = await service.activateTrial('1', async () => {
      // The one shared constant, so a reworded message cannot drift the guard
      // and the handler apart.
      throw new Error(TRIAL_CLAIM_LIMIT_MESSAGE);
    });
    assert.deepEqual(result, { activated: false, reason: 'TRIAL_ALREADY_USED' });
  });

  it('still surfaces an unexpected grant failure as an error', async () => {
    // Only the claim-limit case is a "reason"; a real fault must not be reported
    // to the user as a calm refusal.
    const { service } = build({ trialPlan: PLAN_WITH_DURATION, trialSubscriptions: 0 });
    await assert.rejects(
      () =>
        service.activateTrial('1', async () => {
          throw new Error('Remnawave unreachable');
        }),
      /Remnawave unreachable/,
    );
  });
});
