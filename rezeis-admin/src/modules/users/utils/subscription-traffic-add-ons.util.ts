import { AddOnEntitlementState, AddOnLifetime, AddOnType } from '@prisma/client';

import type { PrismaService } from '../../../common/prisma/prisma.service';
import { entitlementEndBound } from '../../add-on-entitlements/domain/add-on-lifetime';

/**
 * THE ADD-ON SHARE OF A SUBSCRIPTION'S TRAFFIC LIMIT, FOR THE OPERATOR.
 *
 * With the durable model on, the subscription's `trafficLimit` is its base
 * plus every ACTIVE traffic add-on (`EffectiveProjectionService`), and the
 * limit the operator edits on the user page is that total. Nothing said which
 * part of it was an add-on with an end of its own, so an operator could take
 * the whole number for the plan's and type a new total around it — and the
 * add-on's end then took its gigabytes out of what the operator meant to
 * give. The editor now says it next to the limit: «из них докупки: +50 ГБ до
 * 01.10 03:20 (по Москве)» (the owner, 25.09.2026).
 *
 * Read from the ACTIVE entitlements, as the projection counts them. Add-ons
 * bought before the durable model have no row: they are part of the base,
 * permanently (decided 24.09.2026), and are not an add-on share any more.
 */

const GIB = 1024 ** 3;

/** Add-ons of one subscription that end at the same moment, summed. */
export interface TrafficAddOnShareItem {
  /** Gigabytes they add, two decimals (the ledger keeps bytes). */
  readonly gb: number;
  /** When the panel takes them off (ISO); `null` for a row with no end. */
  readonly endsAt: string | null;
  /**
   * For add-ons that end with Remnawave's traffic reset: the reset itself —
   * the time to show, half an hour before `endsAt`. `null` otherwise.
   */
  readonly resetAt: string | null;
}

export interface TrafficAddOnShare {
  readonly totalGb: number;
  /** Soonest end first; one with no end last. */
  readonly items: readonly TrafficAddOnShareItem[];
}

/** The fields of an entitlement the share is made from. */
export interface TrafficAddOnRow {
  readonly subscriptionId: string;
  readonly totalValue: bigint;
  readonly lifetime: AddOnLifetime;
  readonly expiresAt: Date | null;
  readonly expiryEpoch: { readonly plannedEndsAt: Date } | null;
}

/**
 * The reset a traffic add-on ends with, by the one rule every reader of a
 * sold add-on uses (`entitlementEndBound`): one the subscription's earlier end
 * caps ends with the subscription, and names no reset.
 */
function resetOf(row: TrafficAddOnRow): Date | null {
  const bound = entitlementEndBound({
    lifetime: row.lifetime,
    expiresAt: row.expiresAt,
    epochPlannedEndsAt: row.expiryEpoch?.plannedEndsAt ?? null,
  });
  return bound === 'reset' && row.expiryEpoch !== null ? row.expiryEpoch.plannedEndsAt : null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Each subscription's share, from its ACTIVE traffic entitlements; a subscription with none is absent. */
export function summariseTrafficAddOns(rows: readonly TrafficAddOnRow[]): Map<string, TrafficAddOnShare> {
  const bySubscription = new Map<string, Map<string, { bytes: bigint; endsAt: Date | null; resetAt: Date | null }>>();
  for (const row of rows) {
    const resetAt = resetOf(row);
    const key = `${row.expiresAt?.toISOString() ?? 'none'}|${resetAt?.toISOString() ?? ''}`;
    const groups = bySubscription.get(row.subscriptionId) ?? new Map();
    const group = groups.get(key) ?? { bytes: 0n, endsAt: row.expiresAt, resetAt };
    group.bytes += row.totalValue;
    groups.set(key, group);
    bySubscription.set(row.subscriptionId, groups);
  }
  const out = new Map<string, TrafficAddOnShare>();
  for (const [subscriptionId, groups] of bySubscription) {
    const items = [...groups.values()]
      .sort((left, right) => (left.endsAt?.getTime() ?? Infinity) - (right.endsAt?.getTime() ?? Infinity))
      .map((group) => ({
        gb: round2(Number(group.bytes) / GIB),
        endsAt: group.endsAt?.toISOString() ?? null,
        resetAt: group.resetAt?.toISOString() ?? null,
      }));
    const totalBytes = [...groups.values()].reduce((sum, group) => sum + group.bytes, 0n);
    out.set(subscriptionId, { totalGb: round2(Number(totalBytes) / GIB), items });
  }
  return out;
}

/** Reads the ACTIVE traffic entitlements of these subscriptions and summarises them. One query. */
export async function readTrafficAddOnShares(
  prisma: Pick<PrismaService, 'addOnEntitlement'>,
  subscriptionIds: readonly string[],
): Promise<Map<string, TrafficAddOnShare>> {
  if (subscriptionIds.length === 0) return new Map();
  const rows = await prisma.addOnEntitlement.findMany({
    where: {
      subscriptionId: { in: [...subscriptionIds] },
      state: AddOnEntitlementState.ACTIVE,
      type: AddOnType.EXTRA_TRAFFIC,
    },
    select: {
      subscriptionId: true,
      totalValue: true,
      lifetime: true,
      expiresAt: true,
      expiryEpoch: { select: { plannedEndsAt: true } },
    },
  });
  return summariseTrafficAddOns(rows);
}
