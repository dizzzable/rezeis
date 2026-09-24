import { ConflictException, Injectable } from '@nestjs/common';
import {
  AddOnEntitlementState,
  AddOnType,
  EffectiveProjectionState,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { resolveEntitlementBaseline } from '../domain/entitlement-baseline';
import { addDeviceLimit, addTrafficLimit } from '../domain/subscription-limit';
import { sumTermLimitBonuses } from '../domain/term-limit-bonus';

/**
 * Recompute the desired effective limits for a subscription from its
 * authoritative baseline term plus the sum of its ACTIVE add-on entitlements.
 *
 * Source of truth is `baseline + active entitlements` (and the ACTIVE term's
 * free limit bonuses). The baseline is the subscription's own share of its
 * `trafficLimit`/`deviceLimit` columns — the column less the contribution the
 * previous row recorded — whoever wrote it; the term's base is the fallback for
 * a column that cannot be read that way — see
 * `../domain/entitlement-baseline.ts` for the rule and its reasoning. The
 * columns mirror `desired`, so the recorded contribution is exactly what
 * separates the two. Unlimited is the canonical `null` and is absorbing:
 * an unlimited baseline stays unlimited regardless of contributions.
 */
export interface RecomputeProjectionInput {
  readonly subscriptionId: string;
  /**
   * Projection mode:
   *  - `SHADOW` (default): compute desired state for observation only; the
   *    projection never drives an upstream write. Legacy fulfillment stays
   *    authoritative during rollout.
   *  - `ACTIVE`: a real desired-state change that must be synced upstream; a
   *    changed projection is marked `PENDING`.
   */
  readonly mode?: 'SHADOW' | 'ACTIVE';
}

export interface RecomputeProjectionResult {
  readonly subscriptionId: string;
  readonly baselineTermId: string;
  readonly desiredRevision: bigint;
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  readonly activeTrafficContributionBytes: bigint;
  readonly activeDeviceContribution: number;
  readonly desiredTrafficLimitBytes: bigint | null;
  readonly desiredDeviceLimit: number | null;
  readonly state: EffectiveProjectionState;
  /** True when the desired state (or baseline) changed and the revision advanced. */
  readonly changed: boolean;
}

type LockedSubscription = { readonly id: string; readonly status: SubscriptionStatus };
type ActiveTerm = {
  readonly id: string;
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  /** Read for its free limit bonuses (`../domain/term-limit-bonus.ts`). */
  readonly planSnapshot: unknown;
};
type ExistingProjection = {
  readonly id: string;
  readonly baselineTermId: string;
  readonly desiredRevision: bigint;
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  readonly activeTrafficContributionBytes: bigint;
  readonly activeDeviceContribution: number;
  readonly desiredTrafficLimitBytes: bigint | null;
  readonly desiredDeviceLimit: number | null;
  readonly state: EffectiveProjectionState;
};

@Injectable()
export class EffectiveProjectionService {
  /**
   * Recompute and persist the subscription's effective projection inside the
   * caller's transaction. Serializes per subscription on the subscription row
   * so concurrent purchase/expiry/renewal recomputes cannot lose an update.
   * Value-idempotent: identical inputs never advance `desiredRevision`.
   */
  public async recomputeInTransaction(
    tx: Prisma.TransactionClient,
    input: RecomputeProjectionInput,
  ): Promise<RecomputeProjectionResult> {
    const mode = input.mode ?? 'SHADOW';

    const locked = await tx.$queryRaw<LockedSubscription[]>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    if (locked.length !== 1) {
      throw new ConflictException('Subscription not found for projection recompute');
    }
    if (locked[0]!.status === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot recompute projection for a deleted subscription');
    }

    const activeTerms = await tx.$queryRaw<ActiveTerm[]>(Prisma.sql`
      SELECT
        "id",
        "base_traffic_limit_bytes" AS "baseTrafficLimitBytes",
        "base_device_limit" AS "baseDeviceLimit",
        "plan_snapshot" AS "planSnapshot"
      FROM "subscription_terms"
      WHERE "subscription_id" = ${input.subscriptionId} AND "status" = 'ACTIVE'
    `);
    if (activeTerms.length !== 1) {
      throw new ConflictException('Subscription has no single active term for projection');
    }
    const term = activeTerms[0]!;

    const contributions = await tx.addOnEntitlement.findMany({
      where: { subscriptionId: input.subscriptionId, state: AddOnEntitlementState.ACTIVE },
      select: { type: true, totalValue: true },
    });

    const trafficContribs: bigint[] = [];
    const deviceContribs: number[] = [];
    for (const row of contributions) {
      if (row.type === AddOnType.EXTRA_TRAFFIC) {
        trafficContribs.push(row.totalValue);
      } else if (row.type === AddOnType.EXTRA_DEVICES) {
        deviceContribs.push(Number(row.totalValue));
      }
    }
    // The ACTIVE term's free limit bonuses (a promo code, a points exchange, a
    // quest or a prize) count exactly like a live add-on, for exactly as long
    // as that term is the active one — `../domain/term-limit-bonus.ts`. Being
    // a contribution is also what keeps them out of the ownership test below:
    // the recorded share is subtracted from the columns before they are
    // compared with the snapshot.
    const bonuses = sumTermLimitBonuses(term.planSnapshot);
    if (bonuses.trafficBytes > 0n) trafficContribs.push(bonuses.trafficBytes);
    if (bonuses.devices > 0) deviceContribs.push(bonuses.devices);

    // Checked sums (overflow/negative → LimitArithmeticError). Using a 0/[]
    // base gives the total contribution while reusing the same guards.
    const activeTrafficContributionBytes = addTrafficLimit(0n, trafficContribs) as bigint;
    const activeDeviceContribution = addDeviceLimit(0, deviceContribs) as number;

    const existing = await tx.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId: input.subscriptionId },
      select: {
        id: true,
        baselineTermId: true,
        desiredRevision: true,
        baseTrafficLimitBytes: true,
        baseDeviceLimit: true,
        activeTrafficContributionBytes: true,
        activeDeviceContribution: true,
        desiredTrafficLimitBytes: true,
        desiredDeviceLimit: true,
        state: true,
      },
    });

    // What this ONE subscription is entitled to before add-ons is what its
    // columns hold less what the previous row recorded as add-ons — an
    // operator's value, an import's own limits, a legacy increment, a refund's
    // lowering alike. The term's base is minted once and never moves, so
    // taking it for every field that reads as the plan's (or cannot be read)
    // undid each of those at the next recompute, and — because the versioned
    // sync worker reads `desired*` off the projection row — pushed the undoing
    // into the panel.
    //
    // This is the one place the rule can live: every writer that mirrors a
    // projection (term activation, boundary expiry, `forceReconcile`,
    // `reverseEntitlement`, add-on fulfillment, plan change) reads the desired
    // state from here. Correcting it at those call sites instead would be five
    // copies of one rule, which is how they drift.
    //
    // The row is already locked FOR UPDATE above, so this re-read is
    // consistent. A missing row is not reachable behind that lock; the term
    // baseline stands if it ever is.
    const configured = await tx.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { trafficLimit: true, deviceLimit: true, planSnapshot: true },
    });
    const baseline =
      configured === null
        ? {
            baseTrafficLimitBytes: term.baseTrafficLimitBytes,
            baseDeviceLimit: term.baseDeviceLimit,
          }
        : resolveEntitlementBaseline({
            term,
            subscription: configured,
            // The contribution the PREVIOUS row recorded — the one the columns
            // were mirrored from, and therefore the only quantity that can be
            // subtracted back out of them. No row yet: nothing recorded, and
            // the term's base stands (`resolveEntitlementBaseline`).
            recorded:
              existing === null
                ? null
                : {
                    activeTrafficContributionBytes: existing.activeTrafficContributionBytes,
                    activeDeviceContribution: existing.activeDeviceContribution,
                  },
          });

    const baseTraffic = baseline.baseTrafficLimitBytes;
    const baseDevice = baseline.baseDeviceLimit;
    const desiredTrafficLimitBytes = addTrafficLimit(baseTraffic, trafficContribs);
    const desiredDeviceLimit = addDeviceLimit(baseDevice, deviceContribs);

    const desiredState =
      mode === 'SHADOW' ? EffectiveProjectionState.SHADOW : EffectiveProjectionState.PENDING;

    if (existing !== null) {
      const unchanged =
        existing.baselineTermId === term.id &&
        existing.baseTrafficLimitBytes === baseTraffic &&
        existing.baseDeviceLimit === baseDevice &&
        existing.activeTrafficContributionBytes === activeTrafficContributionBytes &&
        existing.activeDeviceContribution === activeDeviceContribution &&
        existing.desiredTrafficLimitBytes === desiredTrafficLimitBytes &&
        existing.desiredDeviceLimit === desiredDeviceLimit &&
        // In SHADOW mode the state must already be SHADOW to be a true no-op.
        (mode === 'SHADOW' ? existing.state === EffectiveProjectionState.SHADOW : true);

      if (unchanged) {
        return this.toResult(input.subscriptionId, {
          ...existing,
          baselineTermId: term.id,
        });
      }

      const nextRevision = existing.desiredRevision + 1n;
      const updated = await tx.subscriptionEffectiveProjection.update({
        where: { subscriptionId: input.subscriptionId },
        data: {
          baselineTermId: term.id,
          desiredRevision: nextRevision,
          baseTrafficLimitBytes: baseTraffic,
          baseDeviceLimit: baseDevice,
          activeTrafficContributionBytes,
          activeDeviceContribution,
          desiredTrafficLimitBytes: desiredTrafficLimitBytes,
          desiredDeviceLimit: desiredDeviceLimit,
          // SHADOW mode stays SHADOW; any desired change in ACTIVE mode
          // re-enters PENDING so the sync worker reconverges upstream.
          state: desiredState,
        },
        select: this.projectionSelect(),
      });
      return this.toResult(input.subscriptionId, { ...updated, changed: true });
    }

    // First projection for this subscription: baseline snapshot at revision 0.
    const created = await tx.subscriptionEffectiveProjection.create({
      data: {
        subscriptionId: input.subscriptionId,
        baselineTermId: term.id,
        desiredRevision: 0n,
        baseTrafficLimitBytes: baseTraffic,
        baseDeviceLimit: baseDevice,
        activeTrafficContributionBytes,
        activeDeviceContribution,
        desiredTrafficLimitBytes: desiredTrafficLimitBytes,
        desiredDeviceLimit: desiredDeviceLimit,
        state: desiredState,
      },
      select: this.projectionSelect(),
    });
    return this.toResult(input.subscriptionId, { ...created, changed: true });
  }

  private projectionSelect() {
    return {
      baselineTermId: true,
      desiredRevision: true,
      baseTrafficLimitBytes: true,
      baseDeviceLimit: true,
      activeTrafficContributionBytes: true,
      activeDeviceContribution: true,
      desiredTrafficLimitBytes: true,
      desiredDeviceLimit: true,
      state: true,
    } as const;
  }

  private toResult(
    subscriptionId: string,
    row: Omit<ExistingProjection, 'id'> & { changed?: boolean },
  ): RecomputeProjectionResult {
    return {
      subscriptionId,
      baselineTermId: row.baselineTermId,
      desiredRevision: row.desiredRevision,
      baseTrafficLimitBytes: row.baseTrafficLimitBytes,
      baseDeviceLimit: row.baseDeviceLimit,
      activeTrafficContributionBytes: row.activeTrafficContributionBytes,
      activeDeviceContribution: row.activeDeviceContribution,
      desiredTrafficLimitBytes: row.desiredTrafficLimitBytes,
      desiredDeviceLimit: row.desiredDeviceLimit,
      state: row.state,
      changed: row.changed ?? false,
    };
  }
}
