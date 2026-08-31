import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ArchivedPlanRenewMode, Prisma, SubscriptionStatus, TransactionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';

/**
 * Removes a plan that was taken out of sale once the last customer has left it.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * Archiving already does the operator-facing half: an archived plan leaves the
 * customer catalogue, and on renewal `REPLACE_ON_RENEW` offers the replacements
 * instead of itself. What it never did is GO AWAY. The row stayed in the plans
 * list for ever, so a service that had reworked its offering three times showed
 * three generations of dead plans beside the live ones.
 *
 * Manual deletion is not the answer either, but NOT for the reason this file
 * first claimed. An earlier version of this comment said expired rows are never
 * cleaned up, so a plan anybody had ever bought could never be deleted by hand.
 * That was false: `ExpiredProfileCleanupService` flips a subscription from
 * EXPIRED to DELETED once it is `graceDays` past expiry (default 3), so
 * `assertPlanDeleteIsAllowed` self-clears a few days after the last customer
 * lapses. What is actually missing is that nobody ever presses the button — the
 * plans SPA has no delete control at all, so the row simply stays.
 *
 * ── When a plan is empty ──────────────────────────────────────────────────
 *
 * Emptiness is the trigger, and it is reached either way round: the customers
 * drain off it as their subscriptions expire unrenewed, or the operator moves
 * them all onto something current. Both end at the same place, and there is no
 * timer — a plan nobody is on is finished, whether that took a month or an hour.
 *
 * `status: { not: DELETED }` is the emptiness test, and it is deliberately the
 * SAME predicate the manual validator, the renewal loader
 * (`SubscriptionRenewalService`) and the cabinet's own subscription list already
 * use. An earlier version of this file narrowed it to ACTIVE/DISABLED/LIMITED
 * and treated EXPIRED as gone. That was wrong in the way that costs a customer:
 * an EXPIRED subscription inside the grace window is still RENEWABLE — the
 * cleanup service's own contract says so — so the narrower rule deleted the plan
 * out from under somebody who could still come back for it, and `REPLACE_ON_RENEW`
 * stores its replacements ON the plan row, so their renewal path went with it.
 *
 * The wide predicate loses nothing: it self-clears when the cleanup sweep runs,
 * which is exactly "they did not renew".
 *
 * ── What still holds a plan back, and why ─────────────────────────────────
 *
 * `SELF_RENEW` is excluded outright. That mode exists to keep old customers on
 * their old price for ever, so a plan wearing it is not retired at all — it is
 * deliberately kept, and emptiness today says nothing about tomorrow.
 *
 * A PENDING transaction holds it back, and this one guards a customer's money
 * rather than tidiness. Fulfilment prefers the transaction's own snapshot, but a
 * legacy in-flight draft written before snapshot verification shipped has no
 * snapshot to prefer — it reads the LIVE plan row, and
 * `payment-subscription-mutation.service.ts` throws `Renewal plan not found`
 * without one. Deleting the plan under such a payment takes the money and
 * delivers nothing.
 *
 * Transition references hold it back for the same reason manual deletion checks
 * them: a plan named in another plan's `replacementPlanIds` is somebody's
 * renewal destination, and deleting it would strand that renewal with nowhere
 * to go.
 *
 * ── Why the whole sweep is one transaction ────────────────────────────────
 *
 * Two reasons, and both were defects in the first version of this file.
 *
 * The eligibility probes used to run OUTSIDE the delete, which is the shape
 * `PlansAdminService.deletePlan` deliberately avoids: it asserts inside the same
 * transaction it deletes in. Checked-then-deleted leaves a window in which a
 * customer buys the plan between the two, and the purchase is then sitting on a
 * row that no longer exists.
 *
 * And `orderIndex` was compacted once per delete, from a value captured before
 * any of them ran. The second delete in a sweep therefore compacted from a stale
 * offset: with two retired plans at 0 and 1 and live plans at 2 and 3, the live
 * pair ended up BOTH at index 1 — a duplicate and a hole, in the column whose
 * compaction exists to prevent exactly that. `plans.order_index` carries no
 * unique constraint, so the database accepted it silently. Compacting once, at
 * the end, from values re-read inside the transaction, cannot drift that way.
 */
@Injectable()
export class RetiredPlanSweeperService {
  private readonly logger = new Logger(RetiredPlanSweeperService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    @Optional() private readonly events?: SystemEventsService,
  ) {}

  @Cron('30 4 * * *', { name: 'retired-plan-sweep' })
  public async sweepScheduled(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      await this.sweep();
    } catch (err) {
      // A tidying sweep must never be the thing that takes the worker down.
      this.logger.error(
        `Retired-plan sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Returns the plans it removed. Safe to call twice; the second pass is empty. */
  public async sweep(): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const removed = await this.prismaService.$transaction(async (tx) => {
      const retired = await tx.plan.findMany({
        where: {
          isArchived: true,
          // Not `SELF_RENEW`: that mode is a promise to keep the plan alive.
          archivedRenewMode: ArchivedPlanRenewMode.REPLACE_ON_RENEW,
        },
        select: { id: true, name: true },
        orderBy: { orderIndex: 'asc' },
      });
      if (retired.length === 0) return [];

      const held = await this.readHolds(
        tx,
        retired.map((plan) => plan.id),
      );
      const doomed = retired.filter((plan) => !held.has(plan.id));
      for (const plan of retired) {
        const reason = held.get(plan.id);
        if (reason !== undefined) {
          // Logged rather than discarded: an operator who archived a plan and
          // watched it stay put is owed the sentence saying what still points
          // at it.
          this.logger.debug(`Retired plan ${plan.name} (${plan.id}) kept — ${reason}`);
        }
      }
      if (doomed.length === 0) return [];

      await tx.plan.deleteMany({ where: { id: { in: doomed.map((plan) => plan.id) } } });
      await this.compactOrder(tx);
      // ── THE SAME AUDIT ACTION A HUMAN DELETION WRITES ────────────────────
      //
      // `PlansAdminService.deletePlan` records `plans.deleted`. Writing our own
      // type instead would mean an operator asking "who removed the Старт 2024
      // plan?" filters the audit log by the obvious action and finds NOTHING —
      // the answer sitting under a different name, on a different tab.
      //
      // `adminUser` is left unconnected, which is what marks it as ours: the
      // audit reader already renders an actorless row as the system. And it is
      // written INSIDE the delete transaction, unlike the system event below,
      // which is fire-and-forget — so the record cannot survive without the
      // deletion, or the deletion without the record.
      for (const plan of doomed) {
        await tx.adminAuditLog.create({
          data: {
            action: 'plans.deleted',
            ipAddress: 'system',
            metadata: {
              planId: plan.id,
              name: plan.name,
              automated: true,
              reason: 'retired-plan-sweep',
            },
          },
        });
      }
      return doomed;
    });

    for (const plan of removed) {
      this.logger.log(`Removed retired plan ${plan.name} (${plan.id}) — nobody was left on it`);
      // Announced AFTER the commit, because a plan disappearing on its own is
      // otherwise indistinguishable from one an operator deleted by hand — or
      // from a bug. `SYSTEM` matches the repo's other plan-catalogue event
      // (`IMPORT_PLAN_ASSIGNED`); the category selects the Telegram topic and
      // the realtime permission gate, so it is not decoration.
      this.events?.warn(
        EVENT_TYPES.PLAN_RETIRED_REMOVED,
        'SYSTEM',
        `Retired plan "${plan.name}" was removed: no customers remained on it`,
        { planId: plan.id, planName: plan.name },
      );
    }
    return removed;
  }

  /**
   * For each plan id that may NOT be deleted, the first reason why.
   *
   * Three queries for the whole sweep rather than three per plan. Neither
   * `subscriptions.plan_snapshot->>'id'` nor `transaction_items.plan_id` is
   * indexed, so a per-plan probe is a sequential scan per plan per night; an
   * install carrying several generations of retired plans would pay for all of
   * them.
   */
  private async readHolds(
    tx: Prisma.TransactionClient,
    planIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const held = new Map<string, string>();

    // Native, not raw SQL. The identical predicate is expressed this way in
    // `PlanSquadPropagationService`, where it is typed and cannot drift from a
    // column rename.
    for (const planId of planIds) {
      const live = await tx.subscription.findFirst({
        where: {
          planSnapshot: { path: ['id'], equals: planId },
          status: { not: SubscriptionStatus.DELETED },
        },
        select: { id: true },
      });
      if (live !== null) held.set(planId, 'a subscription that can still be renewed names it');
    }

    // ── BOTH shapes of purchase, because they store the plan differently ──
    //
    // `TransactionItem` is one line of a COMBINED multi-subscription renewal —
    // the schema says so. Every `NEW`, `ADDITIONAL`, `UPGRADE` and legacy single
    // `RENEW` has no items at all, and names its plan only in the transaction's
    // own `planSnapshot`. An item-only probe therefore missed the majority of
    // purchases, and those are the ones that hurt: `getRequiredPlan` reads the
    // LIVE plan row for them and throws `Purchased plan not found`, so the
    // payment settles against a plan that no longer exists — money taken,
    // nothing delivered, and a reconciler that retries it for ever.
    for (const planId of planIds) {
      if (held.has(planId)) continue;
      const unsettled = await tx.transaction.findFirst({
        where: {
          status: TransactionStatus.PENDING,
          planSnapshot: { path: ['id'], equals: planId },
        },
        select: { id: true },
      });
      if (unsettled !== null) held.set(planId, 'a payment for it has not settled');
    }

    const unsettledItems = await tx.transactionItem.findMany({
      where: {
        planId: { in: [...planIds] },
        transaction: { status: TransactionStatus.PENDING },
      },
      select: { planId: true },
      distinct: ['planId'],
    });
    for (const row of unsettledItems) {
      if (!held.has(row.planId)) held.set(row.planId, 'a payment for it has not settled');
    }

    const referencing = await tx.plan.findMany({
      where: {
        OR: [
          { upgradeToPlanIds: { hasSome: [...planIds] } },
          { replacementPlanIds: { hasSome: [...planIds] } },
        ],
      },
      select: { upgradeToPlanIds: true, replacementPlanIds: true },
    });
    const targeted = new Set(
      referencing.flatMap((plan) => [...plan.upgradeToPlanIds, ...plan.replacementPlanIds]),
    );
    for (const planId of planIds) {
      if (targeted.has(planId) && !held.has(planId)) {
        held.set(planId, 'another plan names it as a transition target');
      }
    }

    // ── CONFIGURATION THAT NAMES A PLAN BY ID, WITH NO FOREIGN KEY ────────
    //
    // None of these columns is a relation, so the database will not stop the
    // delete and nothing cleans them up afterwards. Each one resolves back to a
    // LIVE plan row at the moment it is used, so a dangling id is not untidy —
    // it is a feature that stops working, quietly:
    //
    //  • a quest reward calls `grantTrial` with the dead id, throws, releases
    //    its mutex and is retried by the reconciler for ever — a quest that
    //    silently never pays out, showing no reward plan in the editor;
    //  • an add-on refuses EVERY edit, because `assertPlansExist` re-validates
    //    the whole list the form round-trips — a rename or an on/off toggle is
    //    rejected, and the operator cannot get out of it from the panel;
    //  • a promocode mints a subscription on a plan that no longer exists,
    //    un-renewable from the day it is redeemed.
    //
    // Holding the plan is the cheap half. The dangling ids that already exist
    // from manual deletions are a separate cleanup.
    const questReward = await tx.quest.findMany({
      where: { rewardPlanId: { in: [...planIds] } },
      select: { rewardPlanId: true },
    });
    for (const row of questReward) {
      if (row.rewardPlanId !== null && !held.has(row.rewardPlanId)) {
        held.set(row.rewardPlanId, 'a quest gives it away as a reward');
      }
    }

    const addOns = await tx.addOn.findMany({
      where: { applicablePlanIds: { hasSome: [...planIds] } },
      select: { applicablePlanIds: true },
    });
    const promocodes = await tx.promocode.findMany({
      where: { allowedPlanIds: { hasSome: [...planIds] } },
      select: { allowedPlanIds: true },
    });
    const named = new Map<string, string>();
    for (const row of addOns) {
      for (const id of row.applicablePlanIds) named.set(id, 'an add-on is sold against it');
    }
    for (const row of promocodes) {
      for (const id of row.allowedPlanIds) named.set(id, 'a promocode is restricted to it');
    }
    for (const planId of planIds) {
      const reason = named.get(planId);
      if (reason !== undefined && !held.has(planId)) held.set(planId, reason);
    }

    return held;
  }

  /**
   * Renumbers every remaining plan to `0..n-1` in its current order.
   *
   * Absolute rather than relative: a decrement applied per deleted plan has to
   * know how many deletions preceded it, and getting that wrong is what put two
   * plans on the same index. Renumbering from what the table actually holds has
   * no such state, and is idempotent — running it on an already-compact table
   * writes the same values back.
   */
  private async compactOrder(tx: Prisma.TransactionClient): Promise<void> {
    const remaining = await tx.plan.findMany({
      orderBy: { orderIndex: 'asc' },
      select: { id: true, orderIndex: true },
    });
    for (const [position, plan] of remaining.entries()) {
      if (plan.orderIndex === position) continue;
      await tx.plan.update({ where: { id: plan.id }, data: { orderIndex: position } });
    }
  }
}
