import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdSignupBonusService } from '../src/modules/advertising/services/ad-signup-bonus.service';
import { buildPlanReferenceDb, Row } from './fixtures/plan-reference-db';

/**
 * THINGS THAT GRANT A PLAN KEEP GRANTING IT AFTER THE PLAN IS DELETED.
 *
 * The delete dialog promises it (plan-deletion contract v2, rule 4): promocodes,
 * quests, contests, the wheel, ad signup bonuses and referral gifts that grant a
 * plan keep granting it until the operator changes them — which is why a plan
 * they name is soft-deleted rather than removed.
 *
 * Every one of those paths resolves the plan BY ID with no status filter, and
 * so keeps working on the kept row unchanged (`grantTrial`, `mintPromocode`, the
 * referral gift, the wheel's plan check) — proved against PostgreSQL in
 * `test/plan-delete-postgres.spec.ts`. The ONE exception was the ad TARIFF bonus,
 * which only granted an active, unarchived plan: a soft-deleted plan is neither,
 * so the promised bonus would have been silently skipped for every new signup.
 * It is pinned here, both directions, over a double that evaluates the where.
 */

const NEW_ACCOUNT = { createdAt: new Date() };

async function tariffBonusFor(plan: Row | null): Promise<readonly string[]> {
  const db = buildPlanReferenceDb({ plans: plan === null ? [] : [plan] });
  const granted: string[] = [];
  const prisma = {
    plan: db.client.plan,
    subscription: { count: async () => 0 },
    user: { findUnique: async () => NEW_ACCOUNT },
  };
  const service = new AdSignupBonusService(
    prisma as never,
    {
      grantTrial: async (input: { planId: string }) => {
        granted.push(input.planId);
        return { subscriptionId: 'sub-1' };
      },
    } as never,
  );
  await service.grantIfEligible({
    userId: 'user-1',
    bonusType: 'TARIFF',
    bonusJson: { tariffPlanId: 'tariff-plan', tariffDurationDays: 14 },
  });
  return granted;
}

describe('an ad placement’s TARIFF signup bonus', () => {
  it('keeps granting a plan the operator DELETED while the placement used it', async () => {
    const granted = await tariffBonusFor({
      id: 'tariff-plan',
      deletedAt: new Date('2026-09-01T00:00:00.000Z'),
      isActive: false,
      isArchived: true,
    });

    assert.deepEqual(granted, ['tariff-plan']);
  });

  it('grants an active plan on sale', async () => {
    assert.deepEqual(await tariffBonusFor({ id: 'tariff-plan' }), ['tariff-plan']);
  });

  it('still skips a LIVE plan the operator archived — taking a plan off sale stops the bonus', async () => {
    assert.deepEqual(await tariffBonusFor({ id: 'tariff-plan', isArchived: true }), []);
  });

  it('still skips a LIVE plan the operator switched off', async () => {
    assert.deepEqual(await tariffBonusFor({ id: 'tariff-plan', isActive: false }), []);
  });

  it('skips a plan that does not exist at all', async () => {
    assert.deepEqual(await tariffBonusFor(null), []);
  });
});
