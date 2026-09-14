import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { AdSignupBonusService } from '../src/modules/advertising/services/ad-signup-bonus.service';
import { PlanDeletionService } from '../src/modules/plans/services/plan-deletion.service';
import { PlanReferenceGuardService } from '../src/modules/plans/services/plan-reference-guard.service';
import { RetiredPlanSweeperService } from '../src/modules/plans/services/retired-plan-sweeper.service';
import { buildPlanReferenceDb, PlanReferenceDb, PlanReferenceDbSeed, Row } from './fixtures/plan-reference-db';

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
 * `test/plan-delete-postgres.spec.ts`. The ONE exception is the ad TARIFF bonus,
 * which grants a plan only while it is on sale: archiving a plan or switching it
 * off is how an operator stops it. So a deleted plan pays out only when it was on
 * sale at the delete (`deletedWhileOnSale`), and — the other half — a placement
 * whose bonus no longer grants its plan holds nothing: it must not keep that row
 * from being removed, nor be announced by the dialog as granting it. Both halves
 * read ONE rule (`AD_SIGNUP_BONUS_PLAN_WHERE`), and the matrix below drives the
 * real bonus and the real guard through every plan state to prove they agree.
 *
 * Over a double that evaluates the where. `grantIfEligible` swallows every error
 * into a warning, so an empty grant is only trusted when no such warning was
 * logged (`grantTariffBonus` asserts it).
 */

const PLAN = 'tariff-plan';
const NEW_ACCOUNT = { createdAt: new Date() };
const DELETED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000);

const DELETE_CONTEXT = {
  currentAdmin: { id: 'admin-1' } as never,
  requestMetadata: { requestId: 'req-1', remoteAddress: '203.0.113.7', userAgent: 'spec' },
};

/** The ACTIVE placement whose TARIFF signup bonus is the plan. */
const PLACEMENT: Row = {
  id: 'placement-1',
  signupBonusType: 'TARIFF',
  status: 'ACTIVE',
  signupBonus: { tariffPlanId: PLAN, tariffDurationDays: 14 },
};

/** Something that holds a plan whatever its sale state, so a delete keeps the row. */
const HOLDING_SUBSCRIPTION: Row = { id: 'sub-holder', status: 'ACTIVE', planSnapshot: { id: PLAN } };

function database(plan: Row | null, extra: PlanReferenceDbSeed = {}): PlanReferenceDb {
  return buildPlanReferenceDb({ plans: plan === null ? [] : [plan], adPlacements: [PLACEMENT], ...extra });
}

async function deleteThroughService(db: PlanReferenceDb, planId = PLAN): Promise<{ readonly removed: boolean }> {
  const deletion = new PlanDeletionService(db.client as never, new PlanReferenceGuardService(db.client as never));
  return deletion.deletePlan(planId, DELETE_CONTEXT);
}

/** What `AdSignupBonusService` grants a brand-new account from the placement's bonus. */
async function grantBonus(
  db: PlanReferenceDb,
  bonus: { readonly type: 'TARIFF' | 'TRIAL'; readonly json: Prisma.JsonObject },
): Promise<readonly string[]> {
  const granted: string[] = [];
  const failures: string[] = [];
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
  // The service turns any throw into a warning. Captured, so a fixture error
  // cannot pass for "the bonus rightly granted nothing".
  (service as unknown as { logger: { log: () => void; warn: (message: string) => void } }).logger = {
    log: () => undefined,
    warn: (message: string) => {
      if (message.includes('grant failed')) failures.push(message);
    },
  };
  await service.grantIfEligible({ userId: 'user-1', bonusType: bonus.type, bonusJson: bonus.json });
  assert.deepEqual(failures, [], 'the bonus threw, so its empty grant proves nothing');
  return granted;
}

const grantTariffBonus = (db: PlanReferenceDb): Promise<readonly string[]> =>
  grantBonus(db, { type: 'TARIFF', json: { tariffPlanId: PLAN, tariffDurationDays: 14 } });

describe('an ad placement’s TARIFF signup bonus', () => {
  it('keeps granting a plan the operator DELETED while it was on sale and the placement used it', async () => {
    const db = database({ id: PLAN });

    const result = await deleteThroughService(db);

    assert.equal(result.removed, false, 'the placement must keep the deleted plan’s row');
    assert.equal(db.plan(PLAN)?.deletedWhileOnSale, true);
    assert.deepEqual(await grantTariffBonus(db), [PLAN]);
  });

  // ── A DELETE DOES NOT UNDO THE ARCHIVE THAT STOPPED THE BONUS ─────────────
  //
  // Archiving (or switching off) a plan is how an operator stops a placement
  // from granting it. The delete then stamps the row and overwrites the flags
  // with "archived, off", so without a record of the state it found, a deleted
  // plan looked exactly like one deleted on sale — and the bonus the archive
  // had stopped started paying out again on the next signup. The row is kept
  // here by a subscription, so it is the stamp that is read, not a missing row.
  it('does not resume a bonus an ARCHIVED plan had stopped, when the plan is deleted later', async () => {
    const db = database({ id: PLAN, isArchived: true }, { subscriptions: [HOLDING_SUBSCRIPTION] });

    assert.equal((await deleteThroughService(db)).removed, false, 'fixture: the subscription keeps the row');
    assert.deepEqual(await grantTariffBonus(db), [], 'deleting an archived plan turned its stopped signup bonus back on');
  });

  it('does not resume a bonus a SWITCHED-OFF plan had stopped, when the plan is deleted later', async () => {
    const db = database({ id: PLAN, isActive: false }, { subscriptions: [HOLDING_SUBSCRIPTION] });

    assert.equal((await deleteThroughService(db)).removed, false, 'fixture: the subscription keeps the row');
    assert.deepEqual(await grantTariffBonus(db), [], 'deleting a switched-off plan turned its stopped signup bonus back on');
  });

  it('grants an active plan on sale', async () => {
    assert.deepEqual(await grantTariffBonus(database({ id: PLAN })), [PLAN]);
  });

  it('still skips a LIVE plan the operator archived — taking a plan off sale stops the bonus', async () => {
    assert.deepEqual(await grantTariffBonus(database({ id: PLAN, isArchived: true })), []);
  });

  it('still skips a LIVE plan the operator switched off', async () => {
    assert.deepEqual(await grantTariffBonus(database({ id: PLAN, isActive: false })), []);
  });

  it('skips a plan that does not exist at all', async () => {
    assert.deepEqual(await grantTariffBonus(database(null)), []);
  });
});

/**
 * A PLACEMENT HOLDS EXACTLY THE PLANS ITS BONUS GRANTS.
 *
 * The expected answer is named for each state FIRST, then both readers are
 * asked: agreement alone would also be satisfied by a guard and a bonus that
 * are wrong together.
 */
describe('a placement holds exactly the plans its bonus grants', () => {
  const states: ReadonlyArray<readonly [string, Row, boolean]> = [
    ['on sale', {}, true],
    ['archived', { isArchived: true }, false],
    ['switched off', { isActive: false }, false],
    ['archived and switched off', { isActive: false, isArchived: true }, false],
    ['deleted while on sale', { isActive: false, isArchived: true, deletedAt: DELETED_AT, deletedWhileOnSale: true }, true],
    ['deleted while off sale', { isActive: false, isArchived: true, deletedAt: DELETED_AT, deletedWhileOnSale: false }, false],
    // Flags an older image turned back on over the stamp: the stamp decides.
    ['deleted while off sale, flags turned back on', { deletedAt: DELETED_AT, deletedWhileOnSale: false }, false],
    ['deleted while on sale, flags turned back on', { deletedAt: DELETED_AT, deletedWhileOnSale: true }, true],
  ];

  for (const [state, overrides, grants] of states) {
    it(`${grants ? 'grants and holds' : 'neither grants nor holds'} a plan that is ${state}`, async () => {
      const db = database({ id: PLAN, ...overrides });

      const granted = await grantTariffBonus(db);
      const counts = (await new PlanReferenceGuardService(db.client as never).countReferences([PLAN])).get(PLAN);

      assert.deepEqual(granted, grants ? [PLAN] : [], `the bonus ${grants ? 'skipped' : 'granted'} a plan that is ${state}`);
      assert.equal(
        counts?.adPlacements,
        grants ? 1 : 0,
        grants
          ? `the guard lets a plan that is ${state} go while its bonus still grants it`
          : `the guard keeps a plan that is ${state} for a bonus that grants nothing`,
      );
    });
  }

  it('removes an archived plan that only a placement names, and says nothing about the placement', async () => {
    const db = database({ id: PLAN, isArchived: true });
    const guard = new PlanReferenceGuardService(db.client as never);

    assert.deepEqual(await guard.listReferences(PLAN), [], 'the dialog would announce a bonus that has stopped');
    const result = await deleteThroughService(db);

    assert.deepEqual(result, { deleted: true, removed: true }, 'a stopped bonus kept the plan’s row');
    assert.equal(db.plan(PLAN), undefined);
  });

  it('the nightly sweep removes a plan deleted while off sale that an unarchived placement still names', async () => {
    const db = database({ id: PLAN, isActive: false, isArchived: true, deletedAt: DELETED_AT, deletedWhileOnSale: false });
    const sweeper = new RetiredPlanSweeperService(db.client as never, new PlanReferenceGuardService(db.client as never));

    const removed = await sweeper.sweep();

    assert.deepEqual(removed.map((plan) => plan.id), [PLAN], 'the hidden row lingers for a placement that grants nothing');
    assert.equal(db.plan(PLAN), undefined);
  });

  it('the sweep removes a retired archived plan an unarchived placement names', async () => {
    const db = database({ id: PLAN, isActive: false, isArchived: true, archivedRenewMode: 'REPLACE_ON_RENEW' });
    const sweeper = new RetiredPlanSweeperService(db.client as never, new PlanReferenceGuardService(db.client as never));

    assert.deepEqual((await sweeper.sweep()).map((plan) => plan.id), [PLAN]);
  });

  it('the sweep keeps a plan deleted while on sale for exactly as long as a placement grants it', async () => {
    const db = database({ id: PLAN, isActive: false, isArchived: true, deletedAt: DELETED_AT, deletedWhileOnSale: true });
    const sweeper = new RetiredPlanSweeperService(db.client as never, new PlanReferenceGuardService(db.client as never));

    assert.deepEqual(await sweeper.sweep(), [], 'the sweep removed a plan a live placement still pays out');
    assert.deepEqual(await grantTariffBonus(db), [PLAN]);

    // Anti-vacuity: it was the placement that held it.
    db.tables.adPlacement[0]!.status = 'ARCHIVED';
    assert.deepEqual((await sweeper.sweep()).map((plan) => plan.id), [PLAN]);
  });
});

describe('an ad placement’s TRIAL signup bonus', () => {
  it('never grants a deleted trial plan, even one whose flags were turned back on', async () => {
    // The deleted row comes first, which is what an unordered `findFirst` hands
    // back; only the stamp keeps it out.
    const db = buildPlanReferenceDb({
      plans: [
        { id: 'trial-deleted', availability: 'TRIAL', deletedAt: DELETED_AT, deletedWhileOnSale: false },
        { id: 'trial-live', availability: 'TRIAL' },
      ],
    });

    assert.deepEqual(await grantBonus(db, { type: 'TRIAL', json: { trialDurationDays: 3 } }), ['trial-live']);
  });
});
