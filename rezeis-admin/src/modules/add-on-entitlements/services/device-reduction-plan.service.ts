import { Injectable, Logger } from '@nestjs/common';
import { DeviceReductionPlanState, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  DeviceReductionSourceError,
  selectDeviceReductionTargets,
} from '../domain/device-reduction-selection';

export type DeviceReductionPlanOutcome =
  | { readonly status: 'NOT_APPLICABLE'; readonly reason: string }
  | { readonly status: 'VERIFIED'; readonly projectionRevision: bigint }
  | { readonly status: 'PLANNED'; readonly planId: string; readonly targetCount: number }
  | { readonly status: 'DEFERRED'; readonly reason: string }
  | { readonly status: 'BLOCKED'; readonly reason: string };

/**
 * DeviceReductionPlanService (T-011, planning half)
 * ─────────────────────────────────────────────────
 * When an EXTRA_DEVICES entitlement expires the effective projection's desired
 * device limit drops. If the panel currently binds more HWID devices than the
 * new finite limit, the overage must be reduced — but NEVER by guessing a
 * victim. This service builds a deterministic, immutable removal plan:
 *
 *  1. read the authoritative projection (desired finite limit + revision);
 *  2. strict-read the panel device list (fail-closed: unavailable → defer,
 *     malformed → block, absent profile → not-applicable);
 *  3. select exact targets deterministically (newest-first, tie hwid DESC);
 *  4. persist an immutable {@link DeviceReductionPlan} keyed by
 *     `(subscriptionId, projectionRevision)` — re-planning at the same revision
 *     returns the identical plan (upsert with empty update).
 *
 * It NEVER deletes here. Execution is a separate, flag-gated
 * (`deviceCleanupAuto`) processor so operator-reviewed plans come first.
 *
 * WHY A PLAN DOWNGRADE DOES NOT COME THROUGH HERE.
 * ────────────────────────────────────────────────
 * A customer moving from a 5-device plan to a 2-device plan leaves the same
 * shape of overage this service was built for, so reusing it from the
 * profile-sync limit-change path is the obvious idea. It was considered and
 * rejected, for three reasons, in order of weight:
 *
 *  1. It would not run. Every entry point here reads
 *     `SubscriptionEffectiveProjection`, and that table is EMPTY on every
 *     deployment: `EffectiveProjectionService.recomputeInTransaction` throws
 *     unless the subscription has exactly one ACTIVE `SubscriptionTerm`, and
 *     terms are only created by the `directPurchase`-gated ledger path or by
 *     the manual `scripts/add-on-entitlement-cutover.ts`. Wiring a downgrade in
 *     would produce `NOT_APPLICABLE / NO_PROJECTION` for every subscription
 *     that exists — a branch with tests and no production reach.
 *  2. It would need a different key. The plan's identity is
 *     `(subscriptionId, projectionRevision)` and its guards re-read that
 *     revision before every delete. A downgrade has no revision, so it would
 *     need a second source of desired truth (`Subscription.deviceLimit`) and a
 *     surrogate revision — a redesign of the primary key and the guards, not a
 *     reuse.
 *  3. It should not delete anything anyway. An add-on entitlement EXPIRES —
 *     something the customer bought ran out, and reclaiming the slots is what
 *     they agreed to. A downgrade is the opposite: a deliberate choice, made
 *     now, by a customer who is still a customer, and the cabinet already lets
 *     them pick which devices to drop (`InternalUserDevicesController`) — a
 *     better choice than our newest-first rule, whose newest device after a
 *     downgrade is most likely the one they use every day.
 *
 *     An earlier version of this note added that Remnawave refuses a
 *     registration at or over the limit (`USER_HWID_DEVICE_LIMIT_REACHED`), so
 *     the overage "buys them nothing and needs no enforcement from us". DELETED,
 *     because it is false: there are tools and services that bypass the panel's
 *     HWID limit, which is precisely why `SharingDetectors.detectHwidOverage`
 *     exists at all. The three reasons above stand without it; the enforcement
 *     argument never did.
 *
 * So a downgrade leaves the devices alone. What it changes is that
 * `SharingDetectors.detectHwidOverage` stops accusing the customer of sharing
 * for the devices they already held under the old limit — and only for those.
 * Anything beyond that number is still named, at a lower confidence, inside the
 * window as well as outside it; see `HWID_DOWNGRADE_GRACE_DAYS`. An operator who
 * wants slots reclaimed on expiry still turns on `ADDON_DEVICE_CLEANUP_AUTO`
 * and gets exactly the behaviour documented above, unchanged.
 */
@Injectable()
export class DeviceReductionPlanService {
  private readonly logger = new Logger(DeviceReductionPlanService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async planForSubscription(subscriptionId: string): Promise<DeviceReductionPlanOutcome> {
    const projection = await this.prismaService.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId },
      select: { id: true, desiredRevision: true, desiredDeviceLimit: true },
    });
    if (projection === null) {
      return { status: 'NOT_APPLICABLE', reason: 'NO_PROJECTION' };
    }
    // Unlimited desired devices ⇒ nothing can be over the limit.
    if (projection.desiredDeviceLimit === null) {
      return { status: 'NOT_APPLICABLE', reason: 'UNLIMITED_DEVICES' };
    }

    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      // The two supplementary identity columns travel with `remnawaveId`
      // because the row is about to name a profile to the panel. Without them a
      // profile created on 2.x is unaddressable once the operator upgrades to
      // 3.x, and `strictListUserDevices` would answer `unavailable` for a
      // subscription whose devices are sitting right there.
      select: {
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        configUrl: true,
        status: true,
      },
    });
    const identity = storedIdentityOf(subscription);
    if (subscription === null || identity === null) {
      return { status: 'NOT_APPLICABLE', reason: 'NO_PANEL_PROFILE' };
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      return { status: 'NOT_APPLICABLE', reason: 'SUBSCRIPTION_DELETED' };
    }

    const listing = await this.remnawaveApiService.strictListUserDevices(identity);
    switch (listing.kind) {
      case 'unavailable':
        return { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
      case 'notFound':
        // No panel profile to reduce.
        return { status: 'NOT_APPLICABLE', reason: 'PANEL_PROFILE_ABSENT' };
      case 'unsupported':
      case 'invalidContract':
        this.logger.warn(
          `Device reduction blocked for ${subscriptionId}: strict list ${listing.kind}`,
        );
        return { status: 'BLOCKED', reason: `STRICT_LIST_${listing.kind.toUpperCase()}` };
      case 'ok':
        break;
    }

    let selection;
    try {
      selection = selectDeviceReductionTargets(listing.value.devices, projection.desiredDeviceLimit);
    } catch (err: unknown) {
      if (err instanceof DeviceReductionSourceError) {
        this.logger.warn(`Device reduction blocked for ${subscriptionId}: ${err.message}`);
        return { status: 'BLOCKED', reason: 'INVALID_SOURCE_DATA' };
      }
      throw err;
    }

    if (selection.overage === 0) {
      return { status: 'VERIFIED', projectionRevision: projection.desiredRevision };
    }

    // Persist the immutable plan. The unique (subscriptionId, projectionRevision)
    // makes re-planning at the same revision idempotent — the empty `update`
    // preserves the original selected targets.
    const plan = await this.prismaService.deviceReductionPlan.upsert({
      where: {
        subscriptionId_projectionRevision: {
          subscriptionId,
          projectionRevision: projection.desiredRevision,
        },
      },
      update: {},
      create: {
        subscriptionId,
        projectionId: projection.id,
        projectionRevision: projection.desiredRevision,
        desiredLimit: projection.desiredDeviceLimit,
        selectedDevices: selection.targets.map((d) => ({
          hwid: d.hwid,
          createdAt: d.createdAt,
        })) as Prisma.InputJsonValue,
        state: DeviceReductionPlanState.PENDING,
      },
      select: { id: true },
    });

    return { status: 'PLANNED', planId: plan.id, targetCount: selection.targets.length };
  }
}
