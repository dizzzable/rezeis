import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { compactLivePlanOrder } from '../utils/plan-deletion.util';

import {
  isUnreferenced,
  PlanReferenceGuardService,
  PlanReferenceInterface,
  presentReferences,
} from './plan-reference-guard.service';

/** `GET /admin/plans/:planId/references`. */
export interface PlanReferencesResponseInterface {
  readonly planId: string;
  /** Kinds with a count above zero, in `PLAN_REFERENCE_KINDS` order. */
  readonly references: readonly PlanReferenceInterface[];
}

/**
 * `DELETE /admin/plans/:planId`. The delete never refuses; `removed` says which
 * of the two outcomes happened — the row went (`true`), or it was hidden
 * (`false`): because something still used it, or because it was on sale at that
 * moment, in which case the nightly sweep removes it once nothing uses it.
 */
export interface PlanDeleteResultInterface {
  readonly deleted: true;
  readonly removed: boolean;
}

interface PlanDeletionContext {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
}

interface LockedPlanRow {
  readonly id: string;
  readonly name: string;
  readonly deletedAt: Date | null;
  readonly isActive: boolean;
  readonly isArchived: boolean;
}

/**
 * Generous next to the 5 s default: the guard reads fifteen kinds, and the
 * JSON-path ones scan `subscriptions` and `transactions`, which no index serves.
 * A delete that times out rolls back whole, so the cost of the ceiling being too
 * low is an operator retrying — never a half-deleted plan.
 */
const PLAN_DELETE_TIMEOUT_MS = 30_000;

/**
 * DELETING A PLAN (plan-deletion contract v2, 13.09.2026).
 *
 * The owner's decision: an operator with `plans:delete` presses the button and
 * the plan is deleted — no archive-first rule, no refusal because something uses
 * it. What the server decides is only HOW, and it decides it inside one
 * transaction with the plan row locked:
 *
 *   1. The plan is removed from every other plan's upgrade and replacement
 *      lists. A transition therefore never keeps a plan alive.
 *   2. `PlanReferenceGuardService` counts what still uses it.
 *   3. Nothing, and the plan already off sale → the row is deleted, and its
 *      durations and prices cascade. Something, or a plan still on sale → the
 *      row is SOFT-deleted: `deletedAt` stamped, archived, inactive (and
 *      `deletedWhileOnSale` records which of those flags it had). It is gone
 *      from every listing, picker, sale and renewal, but a paid invoice, a
 *      promocode or a quest prize that names it still resolves it by id —
 *      which is the whole reason the row stays. The nightly
 *      `RetiredPlanSweeperService` removes it once the same guard reports
 *      nothing.
 *
 * Unknown and already soft-deleted plans answer 404, which the SPA reports as
 * "already deleted".
 */
@Injectable()
export class PlanDeletionService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly referenceGuard: PlanReferenceGuardService,
  ) {}

  public async getReferences(planId: string): Promise<PlanReferencesResponseInterface> {
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId, deletedAt: null },
      select: { id: true },
    });
    if (plan === null) {
      throw new NotFoundException('Plan not found');
    }
    return { planId: plan.id, references: await this.referenceGuard.listReferences(plan.id) };
  }

  public async deletePlan(
    planId: string,
    context: PlanDeletionContext,
  ): Promise<PlanDeleteResultInterface> {
    return this.prismaService.$transaction(
      async (tx) => {
        // Locked FIRST, and re-read under the lock: two operators deleting the
        // same plan from two tabs queue here, and the second one reads the
        // stamp the first one committed and answers 404 instead of deciding a
        // second time.
        const locked = await tx.$queryRaw<LockedPlanRow[]>(Prisma.sql`
          SELECT "id", "name", "deleted_at" AS "deletedAt",
                 "is_active" AS "isActive", "is_archived" AS "isArchived"
            FROM "plans"
           WHERE "id" = ${planId}
             FOR UPDATE
        `);
        const plan = locked[0];
        if (plan === undefined || plan.deletedAt !== null) {
          throw new NotFoundException('Plan not found');
        }

        // `array_remove` in the statement rather than read-filter-write in this
        // process: the database applies it to the row version it locks, so an
        // unrelated edit of the other plan committing in between is not
        // overwritten with a stale copy of its lists.
        const transitionsStripped = await tx.$executeRaw(Prisma.sql`
          UPDATE "plans"
             SET "upgrade_to_plan_ids" = array_remove("upgrade_to_plan_ids", ${planId}),
                 "replacement_plan_ids" = array_remove("replacement_plan_ids", ${planId}),
                 "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" <> ${planId}
             AND (${planId} = ANY("upgrade_to_plan_ids") OR ${planId} = ANY("replacement_plan_ids"))
        `);

        const counts = (await this.referenceGuard.countReferences([planId], { client: tx })).get(
          planId,
        );
        if (counts === undefined) {
          // Never default to "nothing uses it": that answer destroys the row.
          throw new Error(`Plan reference guard returned no counts for plan ${planId}`);
        }
        const references = presentReferences(counts);
        // A plan that was ON SALE a moment ago is hidden even when nothing uses
        // it yet. Checkout reads the plan without locking it, so a buyer's
        // request can be between "the plan exists" and "insert the PENDING
        // invoice" right now; counting finds no invoice, a hard delete would
        // go through, and that invoice would then be paid for a plan fulfilment
        // can no longer find. Hidden, the plan is off sale for every new
        // checkout at once, the in-flight one still finds its row, and the
        // nightly sweep removes the row once the guard finds nothing — by then
        // no checkout can have started on it.
        const onSale = plan.isActive && !plan.isArchived;
        // `isUnreferenced`, not "no kind listed": an informational kind such as
        // `replacementOrphans` holds nothing (and is zero after the strip).
        const removed = isUnreferenced(counts) && !onSale;

        if (removed) {
          await tx.plan.delete({ where: { id: planId } });
        } else {
          await tx.plan.update({
            where: { id: planId },
            // `deletedWhileOnSale` keeps what the flags are about to lose: a
            // grant the operator had stopped by archiving or switching the
            // plan off must stay stopped once the plan is deleted.
            data: {
              deletedAt: new Date(),
              deletedWhileOnSale: onSale,
              isArchived: true,
              isActive: false,
            },
          });
        }
        // After BOTH outcomes: a hidden plan that kept its index would leave a
        // hole in the order the operator sees, exactly as a removed one would.
        await compactLivePlanOrder(tx);

        await tx.adminAuditLog.create({
          data: {
            action: 'plans.deleted',
            ipAddress: context.requestMetadata.remoteAddress,
            userAgent: context.requestMetadata.userAgent,
            metadata: {
              requestId: context.requestMetadata.requestId,
              planId,
              name: plan.name,
              removed,
              // What the decision was taken on — after the transitions were
              // stripped, so a plan kept alive says by what.
              references: references.map((reference) => ({
                kind: reference.kind,
                count: reference.count,
              })),
              transitionsStripped,
            },
            adminUser: { connect: { id: context.currentAdmin.id } },
          },
        });

        return { deleted: true, removed } as const;
      },
      { timeout: PLAN_DELETE_TIMEOUT_MS },
    );
  }
}
