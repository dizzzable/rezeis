import { Injectable, Logger } from '@nestjs/common';
import { DeviceReductionPlanState, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
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
      select: { remnawaveId: true, status: true },
    });
    if (subscription === null || subscription.remnawaveId === null) {
      return { status: 'NOT_APPLICABLE', reason: 'NO_PANEL_PROFILE' };
    }
    if (subscription.status === SubscriptionStatus.DELETED) {
      return { status: 'NOT_APPLICABLE', reason: 'SUBSCRIPTION_DELETED' };
    }

    const listing = await this.remnawaveApiService.strictListUserDevices(subscription.remnawaveId);
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
