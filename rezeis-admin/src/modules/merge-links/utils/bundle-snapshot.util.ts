import { PlanAvailability, PlanType, Prisma, SubscriptionStatus, TrafficLimitStrategy } from '@prisma/client';

import { resolveVisiblePlanId } from './visible-plan.util';

/**
 * What the bundle sale reads: the grouping and the subscriptions. Both the
 * request-scoped client and a transaction client satisfy it, so a caller inside
 * a payment transaction reads the same rows it is about to write.
 */
export type BundleSaleClient = Pick<Prisma.TransactionClient, 'planBundle' | 'subscription'>;

/** `gatewayData` key of what a merged purchase CREATED — a refund reads it. */
export const BUNDLE_GRANT_KEY = 'bundleGrant';

/** `gatewayData` key of the days a merged RENEWAL bought — a refund takes them back. */
export const BUNDLE_RENEWAL_KEY = 'bundleRenewal';

/**
 * THE PRODUCT A SUBSCRIPTION WAS SOLD AS
 * ──────────────────────────────────────
 * A bundle is sold as ONE tariff («объединённая подписка»): the operator prices
 * the bundle's own plan row, the customer buys it once, and the panel mints one
 * ordinary subscription per member plan — one VPN profile each, merged into one
 * link by the merge service. The customer holds ONE product and must renew it
 * once, not twice.
 *
 * Nothing in a subscription row says that today, so every subscription minted
 * from a bundle carries two keys in `planSnapshot`:
 *
 *   `bundleId`     — WHICH bundle this subscription is one half of;
 *   `bundlePlanId` — the bundle's own plan row: the face the customer sees, the
 *                    tariff they were charged for, and the plan the renewal
 *                    prices onto.
 *
 * They are the WHOLE contract of the sale — there is no second table, and no
 * inference from "this customer happens to hold two plans of a bundle": a
 * customer who bought the two plans separately pays for them separately and
 * must keep renewing them separately. Only a subscription minted by a bundle
 * sale or a merged grant carries these keys, and a later plan change writes a
 * snapshot without them, which is exactly right — the customer left the product.
 *
 * `planSnapshot.id` stays the MEMBER plan (the profile's real squads and
 * traffic limit live there), so every existing reader of a snapshot — inherited
 * limits, plan sync, the merge service — keeps working unchanged.
 */
export interface BundleSnapshotMarker {
  /** The bundle this subscription is one half of. */
  readonly bundleId: string;
  /** The bundle's own plan row — what the customer bought and renews. */
  readonly bundlePlanId: string;
}

export const BUNDLE_SNAPSHOT_BUNDLE_ID_KEY = 'bundleId';
export const BUNDLE_SNAPSHOT_BUNDLE_PLAN_ID_KEY = 'bundlePlanId';

/** The marker a subscription sold as a bundle carries, or `null` for any other. */
export function readBundleMarker(planSnapshot: unknown): BundleSnapshotMarker | null {
  if (typeof planSnapshot !== 'object' || planSnapshot === null || Array.isArray(planSnapshot)) {
    return null;
  }
  const snapshot = planSnapshot as Record<string, unknown>;
  const bundleId = snapshot[BUNDLE_SNAPSHOT_BUNDLE_ID_KEY];
  const bundlePlanId = snapshot[BUNDLE_SNAPSHOT_BUNDLE_PLAN_ID_KEY];
  if (typeof bundleId !== 'string' || bundleId.length === 0) return null;
  if (typeof bundlePlanId !== 'string' || bundlePlanId.length === 0) return null;
  return { bundleId, bundlePlanId };
}

/** `snapshot` plus the two keys above — the write side, one shape for every minter. */
export function withBundleMarker<T extends Record<string, unknown>>(
  snapshot: T,
  marker: BundleSnapshotMarker,
): T & { readonly [BUNDLE_SNAPSHOT_BUNDLE_ID_KEY]: string; readonly [BUNDLE_SNAPSHOT_BUNDLE_PLAN_ID_KEY]: string } {
  return {
    ...snapshot,
    [BUNDLE_SNAPSHOT_BUNDLE_ID_KEY]: marker.bundleId,
    [BUNDLE_SNAPSHOT_BUNDLE_PLAN_ID_KEY]: marker.bundlePlanId,
  };
}

/**
 * The plan fields a member's subscription is minted from, and the fields every
 * renewal term needs. One select, so the sale and the renewal cannot disagree
 * about what a member plan is.
 */
export const BUNDLE_MEMBER_PLAN_SELECT = {
  id: true,
  name: true,
  description: true,
  tag: true,
  icon: true,
  type: true,
  availability: true,
  trafficLimit: true,
  trafficLimitStrategy: true,
  deviceLimit: true,
  internalSquads: true,
  externalSquad: true,
  orderIndex: true,
} as const;

export interface BundleMemberPlanRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly icon: string | null;
  readonly type: PlanType;
  readonly availability: PlanAvailability;
  readonly trafficLimit: number | null;
  readonly trafficLimitStrategy: TrafficLimitStrategy;
  readonly deviceLimit: number;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly orderIndex: number;
}

export interface BundleMemberRow {
  readonly planId: string;
  readonly isVisibleInApp: boolean;
  readonly plan: BundleMemberPlanRow;
}

/** A bundle as the sale reads it: its own plan row and the plans it delivers. */
export interface SoldBundle {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  /** The bundle's own plan row — what it is sold and renewed as. */
  readonly planId: string;
  readonly members: readonly BundleMemberRow[];
}

const SOLD_BUNDLE_SELECT = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  planId: true,
  members: {
    select: {
      planId: true,
      isVisibleInApp: true,
      plan: { select: BUNDLE_MEMBER_PLAN_SELECT },
    },
  },
} as const;

/** The row shape `SOLD_BUNDLE_SELECT` produces, before the face plan is required to exist. */
interface SoldBundleRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly planId: string | null;
  readonly members: readonly BundleMemberRow[];
}

/**
 * The bundle whose FACE plan is `planId`, members and all, or `null` for an
 * ordinary plan. The sale asks this once per payment; nothing else does.
 */
/**
 * Whether the client can answer the bundle question at all. Production always
 * can; a unit harness that builds a partial Prisma client for one payment path
 * cannot, and an absent delegate must read as "not a bundle" rather than throw
 * in the middle of a payment.
 */
function canReadBundles(client: BundleSaleClient): boolean {
  return typeof client?.planBundle?.findFirst === 'function';
}

/**
 * The bundle whose FACE plan is `planId`, members and all, or `null` for an
 * ordinary plan. The sale asks this once per payment; nothing else does.
 */
export async function findBundleSoldAs(
  client: BundleSaleClient,
  planId: string,
): Promise<SoldBundle | null> {
  if (!canReadBundles(client)) return null;
  const bundle: SoldBundleRecord | null = await client.planBundle.findFirst({
    where: { planId },
    select: SOLD_BUNDLE_SELECT,
  });
  return bundle === null || bundle.planId === null ? null : mapSoldBundle(bundle, bundle.planId);
}

/**
 * The bundle a subscription's marker names — ONLY while it is still on sale:
 * the row must agree about its own face plan and still be active. A deleted or
 * re-pointed bundle answers `null`, and its subscriptions then behave like any
 * other: each renews itself, and the merged link is gone with the grouping.
 */
export async function findBundleSoldForMarker(
  client: BundleSaleClient,
  marker: BundleSnapshotMarker,
): Promise<SoldBundle | null> {
  if (!canReadBundles(client)) return null;
  const bundle: SoldBundleRecord | null = await client.planBundle.findFirst({
    where: { id: marker.bundleId, planId: marker.bundlePlanId, isActive: true },
    select: SOLD_BUNDLE_SELECT,
  });
  return bundle === null || bundle.planId === null ? null : mapSoldBundle(bundle, bundle.planId);
}

/** The member plan row a sold bundle's subscription is on, by snapshot plan id. */
export function findBundleMemberPlan(
  bundle: SoldBundle,
  memberPlanId: string,
): BundleMemberPlanRow | null {
  return bundle.members.find((member) => member.planId === memberPlanId)?.plan ?? null;
}

/** The plan the merged link faces — the member the cabinet's card shows. */
export function bundleVisiblePlanId(bundle: SoldBundle): string | null {
  return resolveVisiblePlanId(bundle.members);
}

/** One live profile of a merged subscription, as the renewal reads it. */
export interface BundleGroupSubscription {
  readonly id: string;
  readonly planSnapshot: Prisma.JsonValue;
  readonly status: SubscriptionStatus;
  readonly expiresAt: Date | null;
  readonly remnawaveId: string | null;
  readonly createdAt: Date;
}

/**
 * The live subscriptions one customer holds of one bundle, oldest first — the
 * whole of a merged subscription, whichever half asked.
 *
 * Marker-based, never plan-based: a customer who bought the two member plans
 * separately owns two subscriptions the panel must NOT treat as one product.
 */
export async function liveBundleSubscriptions(
  client: BundleSaleClient,
  userId: string,
  bundleId: string,
): Promise<readonly BundleGroupSubscription[]> {
  return client.subscription.findMany({
    where: {
      userId,
      status: { not: SubscriptionStatus.DELETED },
      planSnapshot: { path: [BUNDLE_SNAPSHOT_BUNDLE_ID_KEY], equals: bundleId },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      planSnapshot: true,
      status: true,
      expiresAt: true,
      remnawaveId: true,
      createdAt: true,
    },
  });
}

/** The plan id a subscription's stored snapshot names — the member plan it is on. */
export function readSnapshotPlanId(planSnapshot: unknown): string | null {
  if (typeof planSnapshot !== 'object' || planSnapshot === null || Array.isArray(planSnapshot)) {
    return null;
  }
  const id = (planSnapshot as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The profiles a MERGED PURCHASE created, as fulfilment recorded them on the
 * payment (`gatewayData.bundleGrant`). A refund reads this to undo the whole
 * product; without it the refund would reach only the one profile the
 * transaction happens to name.
 */
export interface BundleGrantProvenance {
  readonly bundleId: string;
  readonly subscriptionIds: readonly string[];
}

export function readBundleGrant(gatewayData: unknown): BundleGrantProvenance | null {
  const record = asRecord(gatewayData);
  const grant = asRecord(record?.[BUNDLE_GRANT_KEY]);
  const bundleId = grant?.['bundleId'];
  const rawIds = grant?.['subscriptionIds'];
  if (typeof bundleId !== 'string' || bundleId.length === 0) return null;
  if (!Array.isArray(rawIds)) return null;
  const subscriptionIds = rawIds.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return subscriptionIds.length === 0 ? null : { bundleId, subscriptionIds };
}

/** One merged-tariff line a renewal applied: which profiles, and the days each got. */
export interface BundleRenewalLine {
  readonly bundleId: string;
  readonly days: number;
  readonly subscriptionIds: readonly string[];
}

/**
 * What a MERGED RENEWAL extended (`gatewayData.bundleRenewal`). A refund of that
 * payment takes the SAME days off every profile the line renewed.
 */
export function readBundleRenewal(
  gatewayData: unknown,
): { readonly lines: readonly BundleRenewalLine[] } | null {
  const record = asRecord(gatewayData);
  const renewal = asRecord(record?.[BUNDLE_RENEWAL_KEY]);
  const rawLines = renewal?.['lines'];
  if (!Array.isArray(rawLines)) return null;
  const lines: BundleRenewalLine[] = [];
  for (const raw of rawLines) {
    const line = asRecord(raw);
    const bundleId = line?.['bundleId'];
    const days = line?.['days'];
    const rawIds = line?.['subscriptionIds'];
    if (typeof bundleId !== 'string' || bundleId.length === 0) continue;
    if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) continue;
    if (!Array.isArray(rawIds)) continue;
    const subscriptionIds = rawIds.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (subscriptionIds.length === 0) continue;
    lines.push({ bundleId, days, subscriptionIds });
  }
  return lines.length === 0 ? null : { lines };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapSoldBundle(bundle: SoldBundleRecord, planId: string): SoldBundle {
  return {
    id: bundle.id,
    name: bundle.name,
    description: bundle.description,
    isActive: bundle.isActive,
    planId,
    members: [...bundle.members].sort((left, right) => left.plan.orderIndex - right.plan.orderIndex),
  };
}
