import { Prisma } from '@prisma/client';

/**
 * THE THREE RULES A DELETED PLAN LIVES BY, IN ONE PLACE.
 *
 * `DELETE /api/admin/plans/:planId` always succeeds (plan-deletion contract v2,
 * 13.09.2026). A plan nothing uses is removed; a plan something still uses is
 * SOFT-deleted — `deletedAt` stamped, `isArchived` on, `isActive` off — and the
 * row stays so the obligations already taken keep resolving it by id. What that
 * row may and may not do from then on is decided here, so the deletion service,
 * the nightly sweeper, the plan editor and the renewal quote cannot each grow a
 * slightly different idea of it.
 */

/**
 * Whether a plan row is a soft-deleted one.
 *
 * `!= null` rather than `!== null`, deliberately: a row read through a `select`
 * that forgot the column arrives WITHOUT the key, and `undefined !== null` would
 * call every such plan deleted — a renewal quote would then hide a live plan
 * from every subscriber on it. The parameter type still REQUIRES the column, so
 * a real `select` that omits it does not compile; the loose comparison only
 * decides what an untyped double means, and it means "live", which is what the
 * rows looked like before the column existed.
 */
export function isPlanSoftDeleted(plan: { readonly deletedAt: Date | null }): boolean {
  return plan.deletedAt != null;
}

/** The `where` fragment every operator-facing listing of plans carries. */
export const LIVE_PLAN_WHERE = { deletedAt: null } as const satisfies Prisma.PlanWhereInput;

/**
 * Renumbers the VISIBLE plans to `0..n-1`, keeping their current order.
 *
 * Absolute rather than relative, for the reason `RetiredPlanSweeperService`
 * gives: a decrement per deleted plan has to know how many deletions preceded
 * it, and getting that wrong is what once put two plans on the same index in a
 * column with no unique constraint. Renumbering from what the table holds has
 * no such state and is idempotent.
 *
 * Soft-deleted plans are left out on purpose. They are never listed, moved or
 * reordered again, so their index means nothing — and counting them would leave
 * a hole in the order the operator sees exactly where the deleted plan used to
 * be. The sort is the plans page's own (`orderIndex`, then `createdAt`), so a
 * pre-existing tie resolves the same way here as on screen.
 */
export async function compactLivePlanOrder(
  client: Pick<Prisma.TransactionClient, 'plan'>,
): Promise<void> {
  const visible = await client.plan.findMany({
    where: LIVE_PLAN_WHERE,
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, orderIndex: true },
  });
  for (const [position, plan] of visible.entries()) {
    if (plan.orderIndex === position) continue;
    await client.plan.update({ where: { id: plan.id }, data: { orderIndex: position } });
  }
}

/** `CreatePlanDto.name` / `UpdatePlanDto.name` — `@MaxLength(128)`. */
export const PLAN_NAME_MAX_LENGTH = 128;

/**
 * The name a soft-deleted plan is moved to when an operator wants its old one.
 *
 * `plans.name` is UNIQUE and a soft-deleted row still holds its name, so without
 * this a plan the operator deleted would block them from ever creating one
 * called the same — a refusal about something they cannot see. The contract's
 * answer is to rename the hidden row instead.
 *
 * The suffix carries the tail of the plan's own id, which is unique among plans,
 * so the first candidate is almost always free; `attempt` widens it for the
 * pathological case of an operator having typed exactly that name. Truncated by
 * CODE POINT so an emoji at the cut is dropped whole rather than halved into a
 * lone surrogate, and bounded by the same 128 the DTO enforces, so the row stays
 * a name the editor would accept.
 */
export function buildDeletedPlanName(name: string, planId: string, attempt: number): string {
  const tail = planId.slice(-8);
  const suffix = attempt === 0 ? ` (deleted ${tail})` : ` (deleted ${tail}-${attempt + 1})`;
  const room = PLAN_NAME_MAX_LENGTH - suffix.length;
  let head = '';
  for (const codePoint of Array.from(name)) {
    if (head.length + codePoint.length > room) break;
    head += codePoint;
  }
  return `${head.trimEnd()}${suffix}`;
}

const MAX_RENAME_ATTEMPTS = 20;

export interface ReleasedPlanName {
  readonly planId: string;
  readonly previousName: string;
  readonly newName: string;
}

/**
 * Moves a soft-deleted plan off `holder.name` so a live plan can take it. Runs
 * inside the caller's transaction, beside the create or rename that needs the
 * name, so the two commit together or not at all.
 *
 * Conditional on the row STILL being that soft-deleted holder: the lookup that
 * found it ran before this transaction, and the nightly sweep may have removed
 * the row since — in which case the name is already free and there is nothing
 * to move. `null` means exactly that.
 */
export async function releasePlanNameFromDeletedPlan(
  client: Pick<Prisma.TransactionClient, 'plan'>,
  holder: { readonly id: string; readonly name: string },
): Promise<ReleasedPlanName | null> {
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt += 1) {
    const candidate = buildDeletedPlanName(holder.name, holder.id, attempt);
    const taken = await client.plan.findFirst({ where: { name: candidate }, select: { id: true } });
    if (taken !== null) continue;
    const moved = await client.plan.updateMany({
      where: { id: holder.id, name: holder.name, deletedAt: { not: null } },
      data: { name: candidate },
    });
    return moved.count === 1
      ? { planId: holder.id, previousName: holder.name, newName: candidate }
      : null;
  }
  throw new Error(
    `Could not find a free name for deleted plan ${holder.id} after ${MAX_RENAME_ATTEMPTS} attempts`,
  );
}
