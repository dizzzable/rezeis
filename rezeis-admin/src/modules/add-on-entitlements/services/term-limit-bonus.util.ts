import { randomUUID } from 'node:crypto';

import { Prisma, SubscriptionTermStatus } from '@prisma/client';

import { GIB_BYTES } from '../domain/cutover-baseline';
import {
  bonusEndedAt,
  readTermLimitBonuses,
  type TermLimitBonus,
  type TermLimitBonusResource,
  type TermLimitBonusSource,
  withoutEndedTermLimitBonuses,
  withTermLimitBonus,
} from '../domain/term-limit-bonus';
import { EffectiveProjectionService, type RecomputeProjectionResult } from './effective-projection.service';

export interface GrantTermLimitBonusInput {
  readonly subscriptionId: string;
  readonly resource: TermLimitBonusResource;
  /** Gigabytes for TRAFFIC, devices for DEVICES: a positive whole number. */
  readonly value: number;
  readonly source: TermLimitBonusSource;
  readonly sourceRef: string;
  readonly now?: Date;
}

export type TermLimitBonusGrant =
  /** No ACTIVE term: the writer raises the column the legacy way. */
  | { readonly outcome: 'NOT_IN_MODEL' }
  | {
      readonly outcome: 'GRANTED';
      readonly bonusId: string;
      /** The ACTIVE term and every queued SCHEDULED one: the terms the bonus lasts through. */
      readonly termIds: readonly string[];
      /** The columns after the mirror — what the panel is sent. */
      readonly trafficLimit: number | null;
      readonly deviceLimit: number;
      readonly projection: RecomputeProjectionResult;
    };

/**
 * GIVES A FREE LIMIT BONUS TO A SUBSCRIPTION IN THE TERM MODEL, inside the
 * caller's transaction — see `../domain/term-limit-bonus.ts` for what a bonus
 * is and why it lives on the terms. The one writer every bonus path shares:
 * the promo code's TRAFFIC and DEVICES, the points exchange's TRAFFIC, and the
 * reward applier's TRAFFIC (quests and the wheel).
 *
 * `NOT_IN_MODEL` — nothing written — for a subscription with no ACTIVE term;
 * the caller then raises the column and the snapshot as it always has. Decided
 * by the term row, never by a rollout flag.
 *
 * Otherwise the bonus is appended to the ACTIVE term and to every SCHEDULED
 * one, the projection is recomputed in ACTIVE mode and the columns mirror it.
 * The stored `planSnapshot` is NOT rewritten: the bonus is a recorded
 * contribution now, which the ownership test subtracts like an add-on.
 *
 * THE CALLER HOLDS THE SUBSCRIPTION ROW LOCK (every bonus writer takes it
 * before it reads the column it checks), so the order is the one every term
 * writer keeps: the subscription, then its terms. The recompute takes the
 * same lock again, which costs nothing inside the transaction.
 *
 * A plain function over the transaction rather than a provider, so the reward
 * applier can call it without importing the add-on module: `RewardsModule`
 * and the wheel behind it stay DI leaves (`wheel-settings.util.spec.ts`).
 * `EffectiveProjectionService` holds no state and needs no collaborator.
 */
export async function grantTermLimitBonusInTransaction(
  tx: Prisma.TransactionClient,
  input: GrantTermLimitBonusInput,
  projections: Pick<EffectiveProjectionService, 'recomputeInTransaction'> = new EffectiveProjectionService(),
): Promise<TermLimitBonusGrant> {
  if (!Number.isInteger(input.value) || input.value < 1) {
    throw new RangeError(`A limit bonus must be a positive whole number, got ${input.value}`);
  }
  const active = await tx.subscriptionTerm.findFirst({
    where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    orderBy: { generation: 'desc' },
    select: { id: true, planSnapshot: true },
  });
  if (active === null) return { outcome: 'NOT_IN_MODEL' };
  const queued = await tx.subscriptionTerm.findMany({
    where: { subscriptionId: input.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
    orderBy: { generation: 'asc' },
    select: { id: true, planSnapshot: true },
  });

  const bonus: TermLimitBonus = {
    id: randomUUID(),
    resource: input.resource,
    value: input.value,
    source: input.source,
    sourceRef: input.sourceRef,
    grantedAt: (input.now ?? new Date()).toISOString(),
  };
  const terms = [active, ...queued];
  for (const term of terms) {
    await tx.subscriptionTerm.update({
      where: { id: term.id },
      data: { planSnapshot: withTermLimitBonus(term.planSnapshot, bonus) as Prisma.InputJsonValue },
    });
  }

  const projection = await projections.recomputeInTransaction(tx, {
    subscriptionId: input.subscriptionId,
    mode: 'ACTIVE',
  });
  const trafficLimit =
    projection.desiredTrafficLimitBytes === null ? null : Number(projection.desiredTrafficLimitBytes / GIB_BYTES);
  const deviceLimit = projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit;
  await tx.subscription.update({
    where: { id: input.subscriptionId },
    data: { trafficLimit, deviceLimit },
  });
  return {
    outcome: 'GRANTED',
    bonusId: bonus.id,
    termIds: terms.map((term) => term.id),
    trafficLimit,
    deviceLimit,
    projection,
  };
}

/** A live bonus of a subscription, and its own end. */
export interface LiveTermLimitBonus {
  readonly bonus: TermLimitBonus;
  /**
   * Where it ends of itself: its `until` when it has one, else the end of the
   * last live term carrying it. `null` is open-ended (a lifetime subscription).
   */
  readonly endsAt: Date | null;
}

const LIVE_TERM_STATES = [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED];

/**
 * The bonuses the live terms of a subscription carry, each with its own end —
 * read by a paid upgrade BEFORE it ends, cancels or re-bases those terms, and
 * after it aligned the tail to the expiry, so the end is today's. Under the
 * subscription row lock the caller holds.
 */
export async function readLiveTermLimitBonusesInTransaction(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<LiveTermLimitBonus[]> {
  // Not in the model: nothing to read, and one cheap question to know it.
  const active = await tx.subscriptionTerm.findFirst({
    where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    select: { id: true },
  });
  if (active === null) return [];
  const terms = await tx.subscriptionTerm.findMany({
    where: { subscriptionId, status: { in: LIVE_TERM_STATES } },
    orderBy: { generation: 'asc' },
    select: { planSnapshot: true, endsAt: true },
  });
  const byId = new Map<string, { bonus: TermLimitBonus; endsAt: Date | null }>();
  for (const term of terms) {
    for (const bonus of readTermLimitBonuses(term.planSnapshot)) {
      const seen = byId.get(bonus.id);
      const endsAt =
        seen === undefined
          ? term.endsAt
          : seen.endsAt === null || term.endsAt === null
            ? null
            : new Date(Math.max(seen.endsAt.getTime(), term.endsAt.getTime()));
      byId.set(bonus.id, { bonus, endsAt });
    }
  }
  return [...byId.values()].map(({ bonus, endsAt }) => ({
    bonus,
    endsAt: bonus.until === undefined ? endsAt : new Date(bonus.until),
  }));
}

/**
 * A PAID UPGRADE CARRIES THE BONUSES — the owner's rule for a live add-on
 * across a paid upgrade (24.09.2026): each keeps its own end, never later than
 * the subscription's new end (`endsAt`). Written, with that end as `until`,
 * onto the upgrade's ACTIVE term and every term kept after it that starts
 * before the end; one whose end has passed by `now` is not carried. Run after
 * the upgrade minted its terms, before its recompute. Returns how many were
 * carried.
 */
export async function carryTermLimitBonusesAcrossUpgradeInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly subscriptionId: string;
    readonly bonuses: readonly LiveTermLimitBonus[];
    readonly endsAt: Date | null;
    readonly now: Date;
  },
): Promise<number> {
  if (input.bonuses.length === 0) return 0;
  const terms = await tx.subscriptionTerm.findMany({
    where: { subscriptionId: input.subscriptionId, status: { in: LIVE_TERM_STATES } },
    orderBy: { generation: 'asc' },
    select: { id: true, startsAt: true, planSnapshot: true },
  });
  const snapshots = new Map<string, unknown>(terms.map((term) => [term.id, term.planSnapshot]));
  const changed = new Set<string>();
  let carried = 0;
  for (const { bonus, endsAt } of input.bonuses) {
    const until =
      endsAt === null
        ? input.endsAt
        : input.endsAt === null
          ? endsAt
          : new Date(Math.min(endsAt.getTime(), input.endsAt.getTime()));
    if (until !== null && until.getTime() <= input.now.getTime()) continue;
    const { until: _ownEnd, ...rest } = bonus;
    const dated: TermLimitBonus = until === null ? rest : { ...rest, until: until.toISOString() };
    let onAny = false;
    for (const term of terms) {
      if (until !== null && term.startsAt.getTime() >= until.getTime()) continue;
      const snapshot = snapshots.get(term.id);
      if (readTermLimitBonuses(snapshot).some((entry) => entry.id === bonus.id)) continue;
      snapshots.set(term.id, withTermLimitBonus(snapshot, dated));
      changed.add(term.id);
      onAny = true;
    }
    if (onAny) carried += 1;
  }
  for (const termId of changed) {
    await tx.subscriptionTerm.update({
      where: { id: termId },
      data: { planSnapshot: snapshots.get(termId) as Prisma.InputJsonValue },
    });
  }
  return carried;
}

/**
 * Takes off every live term of a subscription the bonuses whose own end
 * (`until`) has passed at `now` — the boundary sweep's step for them
 * (`EntitlementBoundaryService.expireDueForSubscription`), which then
 * recomputes and pushes. Under the subscription row lock the caller holds.
 * Returns how many terms changed.
 */
export async function pruneEndedTermLimitBonusesInTransaction(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  now: Date,
): Promise<number> {
  // What the sweep selects on: the ACTIVE term carrying a bonus past its own
  // end. Nothing else to do otherwise — the common case, one cheap read.
  const active = await tx.subscriptionTerm.findFirst({
    where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
    select: { planSnapshot: true },
  });
  if (active === null || !readTermLimitBonuses(active.planSnapshot).some((bonus) => bonusEndedAt(bonus, now))) {
    return 0;
  }
  const terms = await tx.subscriptionTerm.findMany({
    where: { subscriptionId, status: { in: LIVE_TERM_STATES } },
    select: { id: true, planSnapshot: true },
  });
  let changed = 0;
  for (const term of terms) {
    const pruned = withoutEndedTermLimitBonuses(term.planSnapshot, now);
    if (pruned === null) continue;
    await tx.subscriptionTerm.update({
      where: { id: term.id },
      data: { planSnapshot: pruned as Prisma.InputJsonValue },
    });
    changed += 1;
  }
  return changed;
}
