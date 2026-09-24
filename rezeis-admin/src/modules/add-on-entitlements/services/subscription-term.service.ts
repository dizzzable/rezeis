import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnLifetime,
  EntitlementIncidentKind,
  EntitlementIncidentSeverity,
  PlanType,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  TrafficLimitStrategy,
} from '@prisma/client';

import { displayPlanName } from '../../plans/utils/plan-deletion.util';
import { GIB_BYTES } from '../domain/cutover-baseline';
import { provisionalResetAnchor } from '../domain/reset-cycle-policy';
import { boundedTermWindow, LAPSED_TERM_WINDOW_MS } from '../domain/term-window';

export interface CreateScheduledTermInput {
  readonly subscriptionId: string;
  readonly planId?: string;
  readonly planRevision?: number;
  readonly planSnapshot: Prisma.InputJsonValue;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  readonly trafficResetStrategy: TrafficLimitStrategy;
  readonly resetAnchorAt: Date | null;
}

export interface ScheduledTermResult {
  readonly id: string;
  readonly generation: number;
  readonly status: SubscriptionTermStatus;
}

export interface TermActivationResult {
  readonly id: string;
  readonly status: SubscriptionTermStatus;
  readonly changed: boolean;
}

type LockedTerm = {
  readonly id: string;
  readonly subscriptionId: string;
  readonly status: SubscriptionTermStatus;
  readonly subscriptionStatus: SubscriptionStatus;
  readonly generation: number;
  readonly startsAt: Date;
};

/**
 * The plan a plan change rotates onto — every field the term snapshot records.
 * Structural on purpose: a Prisma `Plan` row and plan migration's
 * `MigrationTargetPlan` both satisfy it.
 */
export interface PlanChangeTarget {
  readonly id: string;
  readonly name: string;
  readonly deletedAt: Date | null;
  readonly description: string | null;
  readonly tag: string | null;
  readonly type: PlanType;
  readonly icon: string | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategy;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

export interface RotateForPlanChangeInput {
  readonly subscriptionId: string;
  readonly plan: PlanChangeTarget;
  /**
   * Written into the term's `planSnapshot.snapshotSource` so a term can be
   * traced to the path that minted it (`PLAN_MIGRATION_TERM`,
   * `ADMIN_PLAN_ASSIGNMENT_TERM`, …).
   */
  readonly snapshotSource: string;
  /**
   * What a queued SCHEDULED term does to the rotation. It always blocks the
   * new term's activation (`activateInTransaction` only activates the LOWEST
   * scheduled generation, and the new one is the highest), so the caller must
   * choose:
   *   - `REFUSE`: leave everything alone and report it. Plan migration's rule —
   *     nobody paid for the move, so it may not cancel a paid renewal.
   *   - `CANCEL_UNBOUND`: cancel queued terms that carry no live add-on, and
   *     refuse only when one does — «Назначить план» and the bulk assignment:
   *     a queued term left in place would activate later and put the
   *     superseded plan's baseline back. Only the renewal add-ons (stage 5,
   *     deleted on 24.09.2026) ever bound an add-on to a queued term, so the
   *     refusal is left for the rows they left behind. The paid upgrade does
   *     not come through here: it cancels every queued term
   *     (`startUpgradeTermInTransaction`), because the money is already in.
   */
  readonly scheduledTerms: 'REFUSE' | 'CANCEL_UNBOUND';
  readonly now?: Date;
}

export type RotateForPlanChangeResult =
  | {
      readonly outcome: 'ROTATED';
      readonly termId: string;
      readonly previousTermId: string;
      readonly startsAt: Date;
      readonly endsAt: Date | null;
      readonly canceledScheduledTermIds: readonly string[];
    }
  /** The subscription is not in the term model; the caller stays on the column path. */
  | { readonly outcome: 'NO_ACTIVE_TERM' }
  /** Nothing was written. */
  | {
      readonly outcome: 'SCHEDULED_TERMS_BLOCK';
      readonly scheduledTermIds: readonly string[];
      readonly boundEntitlements: number;
    };

export interface RebaseActiveTermInput {
  readonly subscriptionId: string;
  /**
   * The base the new ACTIVE term records, per field, in the term's own units
   * (bytes, devices; `null` is unlimited). A field left out keeps the current
   * term's base.
   */
  readonly base: {
    readonly trafficLimitBytes?: bigint | null;
    readonly deviceLimit?: number | null;
  };
  /** Written into the new term's `planSnapshot.snapshotSource`. */
  readonly snapshotSource: string;
  readonly now?: Date;
}

export type RebaseActiveTermResult =
  /** No ACTIVE term (or no such row): nothing to rebase. */
  | { readonly outcome: 'NO_ACTIVE_TERM' }
  | { readonly outcome: 'SUBSCRIPTION_DELETED' }
  /** The ACTIVE term already records that base; nothing written. */
  | { readonly outcome: 'UNCHANGED'; readonly termId: string }
  | {
      readonly outcome: 'REBASED';
      readonly termId: string;
      readonly previousTermId: string;
      /** Queued terms moved above the new one, in their own order. */
      readonly movedScheduledTermIds: readonly string[];
    };

export interface AlignTailOptions {
  /** Correlates the entitlement re-timing events; defaults to `term-align:<subscriptionId>`. */
  readonly correlationId?: string;
  readonly actorType?: AddOnEntitlementActorType;
  readonly actorId?: string;
  /** The event reason; defaults to `TERM_WINDOW_ALIGNED`. */
  readonly reason?: string;
}

export type AlignTailResult =
  /** No such row, or no ACTIVE term: nothing to align. */
  | { readonly outcome: 'NOT_IN_MODEL' }
  /** The row is DELETED. Nothing written; retiring its durable rows is the caller's call. */
  | { readonly outcome: 'SUBSCRIPTION_DELETED' }
  | { readonly outcome: 'UNCHANGED'; readonly termId: string }
  | {
      readonly outcome: 'ALIGNED';
      readonly termId: string;
      readonly previousEndsAt: Date | null;
      readonly endsAt: Date | null;
      readonly retimedEntitlementIds: readonly string[];
    }
  /**
   * `expiresAt` was moved to or before the start of a queued SCHEDULED term.
   * Nothing was written; one incident names it.
   */
  | {
      readonly outcome: 'SCHEDULED_SUCCESSOR_BLOCKS';
      readonly termId: string;
      readonly incidentId: string;
    };

/** `summaryCode` of the incident {@link SubscriptionTermService.alignTailToExpiryInTransaction} raises. */
export const TERM_SHORTENED_ACROSS_SCHEDULED_TERM = 'TERM_SHORTENED_ACROSS_SCHEDULED_TERM';

/** Entitlement states whose `expiresAt` a tail alignment may still move. */
const RETIMABLE_STATES: readonly AddOnEntitlementState[] = [
  AddOnEntitlementState.PENDING_ACTIVATION,
  AddOnEntitlementState.ACTIVE,
];

/** Entitlement states that make a queued term "carry" paid goods. */
const LIVE_ENTITLEMENT_STATES: readonly AddOnEntitlementState[] = [
  AddOnEntitlementState.PENDING_ACTIVATION,
  AddOnEntitlementState.ACTIVE,
  AddOnEntitlementState.EXPIRING,
];

function sameInstant(left: Date | null, right: Date | null): boolean {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

@Injectable()
export class SubscriptionTermService {
  public async createScheduledInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateScheduledTermInput,
  ): Promise<ScheduledTermResult> {
    const parent = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    if (parent.length !== 1) {
      throw new NotFoundException('Subscription not found');
    }
    if (parent[0]!.status === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot schedule a term for a deleted subscription');
    }

    const latest = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId },
      orderBy: { generation: 'desc' },
      select: { generation: true },
    });
    const generation = (latest?.generation ?? 0) + 1;

    return tx.subscriptionTerm.create({
      data: {
        subscriptionId: input.subscriptionId,
        generation,
        planId: input.planId,
        planRevision: input.planRevision,
        planSnapshot: input.planSnapshot,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: SubscriptionTermStatus.SCHEDULED,
        baseTrafficLimitBytes: input.baseTrafficLimitBytes,
        baseDeviceLimit: input.baseDeviceLimit,
        trafficResetStrategy: input.trafficResetStrategy,
        resetAnchorAt: input.resetAnchorAt,
      },
      select: { id: true, generation: true, status: true },
    });
  }

  public async activateInTransaction(
    tx: Prisma.TransactionClient,
    termId: string,
    now = new Date(),
  ): Promise<TermActivationResult> {
    const rows = await tx.$queryRaw<LockedTerm[]>(Prisma.sql`
      SELECT
        st."id",
        st."subscription_id" AS "subscriptionId",
        s."status"::text AS "subscriptionStatus",
        st."status"::text AS "status",
        st."generation",
        st."starts_at" AS "startsAt"
      FROM "subscription_terms" AS st
      INNER JOIN "subscriptions" AS s ON s."id" = st."subscription_id"
      WHERE st."id" = ${termId}
      FOR UPDATE OF s, st
    `);
    const term = rows[0];
    if (term === undefined) {
      throw new NotFoundException('Subscription term not found');
    }
    if (term.subscriptionStatus === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot activate a term for a deleted subscription');
    }
    if (term.status === SubscriptionTermStatus.ACTIVE) {
      return { id: term.id, status: term.status, changed: false };
    }
    if (term.status !== SubscriptionTermStatus.SCHEDULED) {
      throw new ConflictException(`Term ${term.id} is not scheduled for activation`);
    }

    const nextScheduled = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: term.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      orderBy: [{ generation: 'asc' }, { id: 'asc' }],
      select: { id: true, generation: true, startsAt: true },
    });
    const active = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: term.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { generation: true },
    });
    if (nextScheduled?.id !== term.id) {
      throw new ConflictException('Subscription term is not the next scheduled generation');
    }
    if (term.startsAt.getTime() > now.getTime()) {
      throw new ConflictException('Subscription term is not due for activation');
    }
    if (active !== null && term.generation <= active.generation) {
      throw new ConflictException('Subscription term generation is not newer than the active term');
    }

    await tx.subscriptionTerm.updateMany({
      where: {
        subscriptionId: term.subscriptionId,
        status: SubscriptionTermStatus.ACTIVE,
        id: { not: term.id },
      },
      data: { status: SubscriptionTermStatus.ENDED, endedAt: now },
    });

    const claimed = await tx.subscriptionTerm.updateMany({
      where: { id: term.id, status: SubscriptionTermStatus.SCHEDULED },
      data: { status: SubscriptionTermStatus.ACTIVE },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Subscription term activation was superseded');
    }

    return { id: term.id, status: SubscriptionTermStatus.ACTIVE, changed: true };
  }

  public async closeForSubscriptionDeletion(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<void> {
    const endedAt = new Date();
    await tx.subscriptionTerm.updateMany({
      where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      data: { status: SubscriptionTermStatus.ENDED, endedAt },
    });
    await tx.subscriptionTerm.updateMany({
      where: { subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      data: { status: SubscriptionTermStatus.CANCELED, endedAt },
    });
  }

  /**
   * Moves a subscription that is IN the term model onto another plan: ends the
   * ACTIVE term and activates one on `plan` that ends where the subscription
   * does. The shared form of what plan migration did privately
   * (`rotateActiveTerm`), for every path that changes a plan without selling
   * time: plan migration, «Назначить план», bulk plan assignment.
   *
   * WHY A PLAN CHANGE MUST ROTATE. A term's base limits are written once and
   * never edited; the projection takes them as the base whenever the
   * subscription's columns still match its stored snapshot (INHERITED). So a
   * plan change that writes only the columns and the snapshot leaves the OLD
   * term's base in force, and the next recompute — an add-on expiry, a
   * purchase, an activation — mirrors the old plan's limits back and pushes
   * them to the panel.
   *
   * DECIDED BY THE TERM ROW, NEVER BY A ROLLOUT FLAG. An ACTIVE term means the
   * subscription is in the model and must be rotated whatever the flags say
   * now; no ACTIVE term means it is not, and nothing is written
   * (`NO_ACTIVE_TERM`). Reading a flag here is what would make turning stage 1
   * off unsafe.
   *
   * THE WINDOW is `boundedTermWindow(now, expiresAt)`, read under the row lock:
   * it starts now and ends at the subscription's CURRENT `expiresAt` — so a
   * caller that also moves the expiry must write it first, in the same
   * transaction. An already-expired subscription gets the one-second window
   * ending at its expiry (`subscription_terms_generation_check` forbids
   * anything shorter); the renewal that brings it back appends from now.
   *
   * The new term's base limits are the PLAN's (what a term records is what the
   * plan gives). The subscription's own individual values reach `desired`
   * through the projection recompute, which the CALLER runs after this in
   * ACTIVE mode, together with the column mirror and the sync job — this
   * method writes terms only. Add-ons bound to the ended term stay ACTIVE and
   * keep counting: the projection sums a subscription's active add-ons
   * whatever term they hang on.
   */
  public async rotateForPlanChangeInTransaction(
    tx: Prisma.TransactionClient,
    input: RotateForPlanChangeInput,
  ): Promise<RotateForPlanChangeResult> {
    const now = input.now ?? new Date();
    const locked = await tx.$queryRaw<
      Array<{ id: string; status: SubscriptionStatus; expiresAt: Date | null; planSnapshot: Prisma.JsonValue }>
    >(Prisma.sql`
      SELECT "id", "status"::text AS "status", "expires_at" AS "expiresAt", "plan_snapshot" AS "planSnapshot"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    const subscription = locked[0];
    if (subscription === undefined) {
      throw new NotFoundException('Subscription not found');
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot rotate the term of a deleted subscription');
    }

    const active = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { id: true },
    });
    if (active === null) return { outcome: 'NO_ACTIVE_TERM' };

    const scheduled = await tx.subscriptionTerm.findMany({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      orderBy: { generation: 'asc' },
      select: { id: true },
    });
    const scheduledTermIds = scheduled.map((term) => term.id);
    if (scheduledTermIds.length > 0) {
      const boundEntitlements = await tx.addOnEntitlement.count({
        where: { termId: { in: scheduledTermIds }, state: { in: [...LIVE_ENTITLEMENT_STATES] } },
      });
      if (input.scheduledTerms === 'REFUSE' || boundEntitlements > 0) {
        return { outcome: 'SCHEDULED_TERMS_BLOCK', scheduledTermIds, boundEntitlements };
      }
      await tx.subscriptionTerm.updateMany({
        where: { id: { in: scheduledTermIds }, status: SubscriptionTermStatus.SCHEDULED },
        data: { status: SubscriptionTermStatus.CANCELED, endedAt: now },
      });
    }

    const { startsAt, endsAt } = boundedTermWindow(now, subscription.expiresAt);
    const stored =
      typeof subscription.planSnapshot === 'object' &&
      subscription.planSnapshot !== null &&
      !Array.isArray(subscription.planSnapshot)
        ? (subscription.planSnapshot as Record<string, unknown>)
        : {};
    const selectedDurationDays = stored['selectedDurationDays'];
    const plan = input.plan;
    const created = await this.createScheduledInTransaction(tx, {
      subscriptionId: input.subscriptionId,
      planId: plan.id,
      planSnapshot: {
        id: plan.id,
        name: displayPlanName(plan),
        description: plan.description,
        tag: plan.tag,
        type: plan.type,
        icon: plan.icon ?? null,
        trafficLimit: plan.trafficLimit,
        deviceLimit: plan.deviceLimit,
        trafficLimitStrategy: plan.trafficLimitStrategy,
        internalSquads: [...plan.internalSquads],
        externalSquad: plan.externalSquad,
        ...(typeof selectedDurationDays === 'number' ? { selectedDurationDays } : {}),
        snapshotSource: input.snapshotSource,
      } as Prisma.InputJsonValue,
      startsAt,
      endsAt,
      baseTrafficLimitBytes: plan.trafficLimit === null ? null : BigInt(plan.trafficLimit) * GIB_BYTES,
      baseDeviceLimit: plan.deviceLimit <= 0 ? null : plan.deviceLimit,
      trafficResetStrategy: plan.trafficLimitStrategy,
      resetAnchorAt: provisionalResetAnchor(plan.trafficLimitStrategy, startsAt),
    });
    await this.activateInTransaction(tx, created.id, now);
    return {
      outcome: 'ROTATED',
      termId: created.id,
      previousTermId: active.id,
      startsAt,
      endsAt,
      canceledScheduledTermIds: scheduledTermIds,
    };
  }

  /**
   * Replaces the ACTIVE term with one that records a different BASE for the
   * rest of the same period — the same plan, snapshot (its limit bonuses
   * included), reset strategy and anchor, from now to where the current term
   * ends. Under the subscription row lock; decided by the term row, never by a
   * flag. The caller recomputes the projection after it, in ACTIVE mode, and
   * mirrors it, as after a rotation.
   *
   * WHY A NEW TERM. A term's base is written once and never edited; what the
   * subscription holds changes by a term taking over, as at a renewal or a plan
   * change. The one caller: the refund of an add-on bought before the term
   * model, which the background cutover folded into the base it minted from
   * the columns (`AddOnRefundService`). A refund ends the add-on at once (owner,
   * 24.09.2026), so the rest of the period stands on a base without it.
   *
   * QUEUED TERMS ARE KEPT, moved above the new one. `activateInTransaction`
   * activates only the LOWEST scheduled generation, and the new term takes the
   * next free one, so each queued SCHEDULED term is renumbered above it in its
   * own order — the same move a paid upgrade makes with the terms it keeps.
   * They are paid periods of their own, minted from the plan, and nothing about
   * them changes; the add-ons bound to them keep pointing at the same rows.
   */
  public async rebaseActiveTermInTransaction(
    tx: Prisma.TransactionClient,
    input: RebaseActiveTermInput,
  ): Promise<RebaseActiveTermResult> {
    const now = input.now ?? new Date();
    const locked = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    const subscription = locked[0];
    if (subscription === undefined) return { outcome: 'NO_ACTIVE_TERM' };
    if (subscription.status === SubscriptionStatus.DELETED) return { outcome: 'SUBSCRIPTION_DELETED' };

    const active = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: {
        id: true,
        planId: true,
        planRevision: true,
        planSnapshot: true,
        endsAt: true,
        baseTrafficLimitBytes: true,
        baseDeviceLimit: true,
        trafficResetStrategy: true,
        resetAnchorAt: true,
      },
    });
    if (active === null) return { outcome: 'NO_ACTIVE_TERM' };
    const baseTrafficLimitBytes =
      input.base.trafficLimitBytes === undefined ? active.baseTrafficLimitBytes : input.base.trafficLimitBytes;
    const baseDeviceLimit = input.base.deviceLimit === undefined ? active.baseDeviceLimit : input.base.deviceLimit;
    if (baseTrafficLimitBytes === active.baseTrafficLimitBytes && baseDeviceLimit === active.baseDeviceLimit) {
      return { outcome: 'UNCHANGED', termId: active.id };
    }

    const queued = await tx.subscriptionTerm.findMany({
      where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      orderBy: { generation: 'asc' },
      select: { id: true },
    });
    const { startsAt, endsAt } = boundedTermWindow(now, active.endsAt);
    const stored =
      typeof active.planSnapshot === 'object' && active.planSnapshot !== null && !Array.isArray(active.planSnapshot)
        ? (active.planSnapshot as Record<string, unknown>)
        : {};
    const created = await this.createScheduledInTransaction(tx, {
      subscriptionId: input.subscriptionId,
      ...(active.planId === null ? {} : { planId: active.planId }),
      ...(active.planRevision === null ? {} : { planRevision: active.planRevision }),
      planSnapshot: {
        ...stored,
        snapshotSource: input.snapshotSource,
        rebasedFromTermId: active.id,
      } as Prisma.InputJsonValue,
      startsAt,
      endsAt,
      baseTrafficLimitBytes,
      baseDeviceLimit,
      trafficResetStrategy: active.trafficResetStrategy,
      resetAnchorAt: active.resetAnchorAt,
    });
    for (const [index, term] of queued.entries()) {
      await tx.subscriptionTerm.update({
        where: { id: term.id },
        data: { generation: created.generation + 1 + index },
      });
    }
    await this.activateInTransaction(tx, created.id, now);
    return {
      outcome: 'REBASED',
      termId: created.id,
      previousTermId: active.id,
      movedScheduledTermIds: queued.map((term) => term.id),
    };
  }

  /**
   * Makes the TAIL term end where the subscription does.
   *
   * ── Why ──────────────────────────────────────────────────────────────────
   *
   * `subscription.expiresAt` has some fifteen writers — promo and referral
   * days, points, rewards, the operator's editor, `extend`, bulk operations,
   * automations, the Remnawave pull and webhook, anti-fraud — and none of them
   * touches a term. An ACTIVE term is only ever ended by its successor's
   * activation, so its `endsAt` is where the period stood when the term was
   * minted. After bonus days the two disagree, and everything read off the
   * term is wrong in the customer's disfavour: an UNTIL_SUBSCRIPTION_END add-on
   * bound to `term.endsAt` expires days before the subscription does, the next
   * renewal term starts at the stale end, and a purchase against a term whose
   * `endsAt` has passed falls back to the PERMANENT legacy increment.
   *
   * THE INVARIANT THIS CHANGES, DELIBERATELY: a tail term's WINDOW follows the
   * subscription's expiry; its BASE never changes.
   *
   * ── The rules ────────────────────────────────────────────────────────────
   *
   * Under the subscription row lock. The TAIL is the last SCHEDULED term when
   * one is queued, else the ACTIVE term. The target end is `expiresAt`:
   *
   *  - EXTENSION (`expiresAt` later than the tail's end, or the tail open-ended
   *    and the subscription no longer lifetime): the tail's `endsAt` moves to
   *    `expiresAt`, and every PENDING/ACTIVE UNTIL_SUBSCRIPTION_END add-on of
   *    the subscription whose `expiresAt` was the old end moves with it. An
   *    add-on with its own, earlier date keeps it.
   *  - SHORTENING, still after the tail's start: the tail's `endsAt` moves back
   *    to `expiresAt`; the add-ons that ended with the old end move with it,
   *    and any UNTIL_SUBSCRIPTION_END add-on that would now outlive the
   *    subscription is clamped to the new end. The boundary sweep expires the
   *    ones that are then due.
   *  - SHORTENING to or before the start of the ACTIVE tail: its window cannot
   *    close before it opened (`ends_at > starts_at`), so it ends one second
   *    after its start — the earliest end it can have — and the add-ons are
   *    clamped to that.
   *  - NEVER ACROSS A SCHEDULED SUCCESSOR: shortening to or before the start of
   *    a SCHEDULED tail would need that paid, queued period cancelled, which is
   *    not an alignment. Nothing is written; one incident
   *    (`TERM_SHORTENED_ACROSS_SCHEDULED_TERM`, one per tail and expiry)
   *    names it. The ACTIVE term under a queued successor is never touched: its
   *    end is the successor's start.
   *  - LIFETIME (`expiresAt = null`): the tail becomes open-ended, and so do the
   *    add-ons that ended with it.
   *
   * An add-on is never moved to or before its own activation instant
   * (`add_on_entitlements_boundary_check`); such a clamp lands one second after
   * it, which is already due. Each move bumps the add-on's version and writes an
   * `AddOnEntitlementEvent` (same state in and out) carrying both dates.
   *
   * No projection recompute: neither a window nor an add-on's date is part of
   * `desired`. No flag is read.
   */
  public async alignTailToExpiryInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    options: AlignTailOptions = {},
  ): Promise<AlignTailResult> {
    const locked = await tx.$queryRaw<
      Array<{ id: string; status: SubscriptionStatus; expiresAt: Date | null }>
    >(Prisma.sql`
      SELECT "id", "status"::text AS "status", "expires_at" AS "expiresAt"
      FROM "subscriptions"
      WHERE "id" = ${subscriptionId}
      FOR UPDATE
    `);
    const subscription = locked[0];
    if (subscription === undefined) return { outcome: 'NOT_IN_MODEL' };
    if (subscription.status === SubscriptionStatus.DELETED) return { outcome: 'SUBSCRIPTION_DELETED' };

    const active = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { id: true, status: true, startsAt: true, endsAt: true },
    });
    if (active === null) return { outcome: 'NOT_IN_MODEL' };
    const lastScheduled = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      orderBy: { generation: 'desc' },
      select: { id: true, status: true, startsAt: true, endsAt: true },
    });
    const tail = lastScheduled ?? active;

    const expiresAt = subscription.expiresAt;
    let target: Date | null;
    if (expiresAt === null) {
      target = null;
    } else if (expiresAt.getTime() > tail.startsAt.getTime()) {
      target = expiresAt;
    } else if (tail.status === SubscriptionTermStatus.ACTIVE) {
      target = new Date(tail.startsAt.getTime() + LAPSED_TERM_WINDOW_MS);
    } else {
      const supportRef =
        `term-align-scheduled:${subscriptionId}:${tail.id}:${expiresAt.toISOString()}`;
      const incident = await tx.entitlementIncident.upsert({
        where: { supportRef },
        update: {},
        create: {
          subscriptionId,
          kind: EntitlementIncidentKind.RECONCILIATION_REQUIRED,
          severity: EntitlementIncidentSeverity.WARNING,
          supportRef,
          summaryCode: TERM_SHORTENED_ACROSS_SCHEDULED_TERM,
          metadata: {
            termId: tail.id,
            termStartsAt: tail.startsAt.toISOString(),
            termEndsAt: tail.endsAt?.toISOString() ?? null,
            expiresAt: expiresAt.toISOString(),
          },
        },
        select: { id: true },
      });
      return { outcome: 'SCHEDULED_SUCCESSOR_BLOCKS', termId: tail.id, incidentId: incident.id };
    }

    const previousEndsAt = tail.endsAt;
    if (sameInstant(previousEndsAt, target)) return { outcome: 'UNCHANGED', termId: tail.id };

    await tx.subscriptionTerm.update({ where: { id: tail.id }, data: { endsAt: target } });

    // The add-ons that end with the subscription: those that ended with the
    // old tail, and — when there is a finite end — any that would outlive it.
    const candidates = await tx.addOnEntitlement.findMany({
      where: {
        subscriptionId,
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        state: { in: [...RETIMABLE_STATES] },
        OR: [
          { expiresAt: previousEndsAt },
          ...(target === null ? [] : [{ expiresAt: null }, { expiresAt: { gt: target } }]),
        ],
      },
      orderBy: { id: 'asc' },
      select: { id: true, state: true, version: true, expiresAt: true, scheduledActivationAt: true },
    });
    const correlationId = options.correlationId ?? `term-align:${subscriptionId}`;
    const retimedEntitlementIds: string[] = [];
    for (const entitlement of candidates) {
      const next =
        target === null
          ? null
          : new Date(
              Math.max(
                target.getTime(),
                entitlement.scheduledActivationAt.getTime() + LAPSED_TERM_WINDOW_MS,
              ),
            );
      if (sameInstant(entitlement.expiresAt, next)) continue;
      const claimed = await tx.addOnEntitlement.updateMany({
        where: { id: entitlement.id, state: entitlement.state, version: entitlement.version },
        data: { expiresAt: next, version: { increment: 1 } },
      });
      // A transition that won the row (the boundary sweep expiring it) does
      // not take the subscription lock; it owns the row now, and an add-on
      // leaving PENDING/ACTIVE has nothing left for this method to move.
      if (claimed.count !== 1) continue;
      await tx.addOnEntitlementEvent.create({
        data: {
          entitlementId: entitlement.id,
          fromState: entitlement.state,
          toState: entitlement.state,
          reason: options.reason ?? 'TERM_WINDOW_ALIGNED',
          actorType: options.actorType ?? AddOnEntitlementActorType.SYSTEM,
          actorId: options.actorId,
          correlationId,
          // The version the move produced: unique per entitlement by
          // construction, so moving A→B→A→B never replays an old key.
          commandKey: `term-align:v${entitlement.version + 1}`,
          metadata: {
            termId: tail.id,
            previousTermEndsAt: previousEndsAt?.toISOString() ?? null,
            termEndsAt: target?.toISOString() ?? null,
            previousExpiresAt: entitlement.expiresAt?.toISOString() ?? null,
            expiresAt: next?.toISOString() ?? null,
          },
        },
      });
      retimedEntitlementIds.push(entitlement.id);
    }

    return {
      outcome: 'ALIGNED',
      termId: tail.id,
      previousEndsAt,
      endsAt: target,
      retimedEntitlementIds,
    };
  }
}
