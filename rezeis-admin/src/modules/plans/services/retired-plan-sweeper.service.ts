import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ArchivedPlanRenewMode, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { compactLivePlanOrder, isPlanSoftDeleted } from '../utils/plan-deletion.util';

import {
  isUnreferenced,
  PlanReferenceGuardService,
  presentReferences,
} from './plan-reference-guard.service';

/**
 * Which plans the sweep considers at all.
 *
 *  - a SOFT-deleted plan: an operator deleted it while something still used it
 *    (`PlanDeletionService`), and the row waits here for the last use to end;
 *  - an archived `REPLACE_ON_RENEW` plan: taken out of sale with somewhere for
 *    its customers to go.
 *
 * `SELF_RENEW` is excluded for a live plan. That mode exists to keep old
 * customers on their old price for ever, so a plan wearing it is not retired at
 * all — emptiness today says nothing about tomorrow. A DELETED plan is swept
 * whatever its mode: the operator has already said it goes.
 *
 * Except a stamped row still flagged ON SALE. The delete switches a plan off as
 * it stamps it, so this is a row something wrote over afterwards — and a plan on
 * sale may have a checkout inserting its invoice right now, the very race the
 * delete hides such a plan for instead of removing it. It is left alone.
 */
const SWEEP_CANDIDATE_WHERE = {
  OR: [
    { deletedAt: { not: null }, OR: [{ isActive: false }, { isArchived: true }] },
    { isArchived: true, archivedRenewMode: ArchivedPlanRenewMode.REPLACE_ON_RENEW },
  ],
} satisfies Prisma.PlanWhereInput;

/**
 * Well above the 5 s default: the shared guard reads fifteen kinds per sweep,
 * and the JSON-path ones scan tables no index serves. A timeout rolls the whole
 * sweep back, which costs one night, never a half-applied delete.
 */
const SWEEP_TIMEOUT_MS = 120_000;

/**
 * Removes a plan once nothing uses it any more.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * Archiving does the operator-facing half: an archived plan leaves the customer
 * catalogue, and on renewal `REPLACE_ON_RENEW` offers the replacements instead
 * of itself. What it never did is GO AWAY — the row stayed in the plans list for
 * ever. And since the delete button came back (plan-deletion contract v2), a
 * plan the operator deleted while something still used it is kept, hidden, for
 * exactly as long as that use lasts. This sweep is where both kinds of row end.
 *
 * ── When a plan is unused ─────────────────────────────────────────────────
 *
 * When `PlanReferenceGuardService` reports nothing — the SAME guard the delete
 * dialog and the delete itself read, so the three can never disagree about what
 * holds a plan. Two hand-maintained hold lists (seven checks here, two in the
 * plan validators) had drifted apart before that guard existed, and neither was
 * complete: the comment above this list claimed to protect promocodes that grant
 * the plan while its query only looked at `allowed_plan_ids`.
 *
 * Emptiness is the trigger and there is no timer: the customers drain off as
 * their subscriptions expire unrenewed (`ExpiredProfileCleanupService` flips
 * EXPIRED to DELETED past the grace window), the invoices settle, the prizes are
 * handed out or reconfigured — and the next night the row goes.
 *
 * ── Why the whole sweep is one transaction, with the rows locked ──────────
 *
 * The eligibility probes of the first version ran OUTSIDE the delete. Checked-
 * then-deleted leaves a window in which a customer buys the plan between the two
 * and the purchase sits on a row that no longer exists. They run inside it now,
 * after the candidates are locked `FOR UPDATE` — the same lock
 * `PlanDeletionService` takes — so an operator's delete and this sweep queue on
 * the row instead of each deciding from what the other has not committed yet.
 * The candidates are read AGAIN under the lock: an edit that un-archived one in
 * the meantime takes it out of the sweep.
 *
 * And `orderIndex` was once compacted per delete from a value captured before
 * any of them ran, which put two surviving plans on the same index. It is
 * compacted once, at the end, over the VISIBLE plans, from values re-read inside
 * the transaction (`compactLivePlanOrder`).
 */
@Injectable()
export class RetiredPlanSweeperService {
  private readonly logger = new Logger(RetiredPlanSweeperService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly referenceGuard: PlanReferenceGuardService,
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
  public async sweep(): Promise<
    readonly { readonly id: string; readonly name: string; readonly wasDeleted: boolean }[]
  > {
    const removed = await this.prismaService.$transaction(
      async (tx) => {
        const seen = await tx.plan.findMany({
          where: SWEEP_CANDIDATE_WHERE,
          select: { id: true },
        });
        if (seen.length === 0) return [];

        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "plans"
           WHERE "id" IN (${Prisma.join(seen.map((plan) => plan.id))})
           ORDER BY "id"
             FOR UPDATE
        `);
        const candidates = await tx.plan.findMany({
          where: { AND: [SWEEP_CANDIDATE_WHERE, { id: { in: seen.map((plan) => plan.id) } }] },
          select: { id: true, name: true, deletedAt: true },
          orderBy: { orderIndex: 'asc' },
        });
        if (candidates.length === 0) return [];

        const counts = await this.referenceGuard.countReferences(
          candidates.map((plan) => plan.id),
          { client: tx },
        );
        const doomed: { id: string; name: string; wasDeleted: boolean }[] = [];
        for (const plan of candidates) {
          const planCounts = counts.get(plan.id);
          // A plan the guard returned nothing for is KEPT: "no answer" must
          // never read as "nothing uses it" in the one place that destroys rows.
          if (planCounts !== undefined && isUnreferenced(planCounts)) {
            doomed.push({ id: plan.id, name: plan.name, wasDeleted: isPlanSoftDeleted(plan) });
            continue;
          }
          // Logged rather than discarded: an operator who deleted or archived a
          // plan and watched it stay is owed the sentence saying what holds it.
          const holds =
            planCounts === undefined
              ? 'no reference counts'
              : presentReferences(planCounts)
                  .map((reference) => `${reference.kind}=${reference.count}`)
                  .join(', ');
          this.logger.debug(`Plan ${plan.name} (${plan.id}) kept — still used: ${holds}`);
        }
        if (doomed.length === 0) return [];

        await tx.plan.deleteMany({ where: { id: { in: doomed.map((plan) => plan.id) } } });
        await compactLivePlanOrder(tx);
        // ── THE SAME AUDIT ACTION A HUMAN DELETION WRITES ──────────────────
        //
        // `PlanDeletionService` records `plans.deleted`. Writing our own type
        // instead would mean an operator asking "who removed the Старт 2024
        // plan?" filters the audit log by the obvious action and finds NOTHING.
        //
        // `adminUser` is left unconnected, which is what marks it as ours: the
        // audit reader already renders an actorless row as the system. And it is
        // written INSIDE the delete transaction, unlike the system event below,
        // so the record cannot survive without the deletion, or the reverse.
        for (const plan of doomed) {
          await tx.adminAuditLog.create({
            data: {
              action: 'plans.deleted',
              ipAddress: 'system',
              metadata: {
                planId: plan.id,
                name: plan.name,
                automated: true,
                reason: plan.wasDeleted ? 'deleted-plan-sweep' : 'retired-plan-sweep',
              },
            },
          });
        }
        return doomed;
      },
      { timeout: SWEEP_TIMEOUT_MS },
    );

    for (const plan of removed) {
      this.logger.log(
        plan.wasDeleted
          ? `Removed deleted plan ${plan.name} (${plan.id}) — nothing used it any more`
          : `Removed retired plan ${plan.name} (${plan.id}) — nobody was left on it`,
      );
      // Announced AFTER the commit, because a plan disappearing on its own is
      // otherwise indistinguishable from one an operator deleted by hand — or
      // from a bug. `SYSTEM` matches the repo's other plan-catalogue event
      // (`IMPORT_PLAN_ASSIGNED`); the category selects the Telegram topic and
      // the realtime permission gate, so it is not decoration.
      this.events?.warn(
        EVENT_TYPES.PLAN_RETIRED_REMOVED,
        'SYSTEM',
        plan.wasDeleted
          ? `Deleted plan "${plan.name}" was removed: nothing used it any more`
          : `Retired plan "${plan.name}" was removed: no customers remained on it`,
        { planId: plan.id, planName: plan.name },
      );
    }
    return removed;
  }
}
