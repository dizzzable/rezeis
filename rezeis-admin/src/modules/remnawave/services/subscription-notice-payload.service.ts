import { Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveApiService } from './remnawave-api.service';

/**
 * The facts a subscription notice prints, gathered in one place.
 *
 * ── Why this is a service and not a method on the emitter ────────────────
 *
 * Two very different things now send notices about the same subscription: the
 * scheduled cycle, which warns before an expiry and reports one after, and the
 * VPN panel webhook, which is the only thing that can know a traffic limit was
 * reached. If each assembled its own payload, the same customer would receive
 * two messages describing their subscription in two different vocabularies —
 * and the second one to be written would quietly omit whatever the first had
 * learned to include.
 *
 * ── Raw numbers, never rendered strings ─────────────────────────────────
 *
 * Gigabytes and counts, plus the expiry as an ISO instant. The words —
 * "Безлимит", "28 августа" — are produced when the template is rendered,
 * because that is where the reader's locale is known.
 *
 * ── An unreachable panel is not an error ────────────────────────────────
 *
 * `getPanelUserUsage` answers `null` on any failure. The notice still goes out
 * carrying what the local row knows; the fields only the panel has are omitted,
 * and the renderer prints nothing for them. A notification the customer never
 * receives is a worse outcome than one missing a figure.
 */
@Injectable()
export class SubscriptionNoticePayloadService {
  private readonly logger = new Logger(SubscriptionNoticePayloadService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    /**
     * Optional so a container without the VPN integration still builds a
     * notice — from the local row alone, which knows the plan, the allowances
     * and the deadline.
     */
    @Optional() private readonly remnawaveApiService?: RemnawaveApiService,
  ) {}

  /** Everything a notice needs from the row. Shared so two emitters cannot drift. */
  public static readonly SELECT = {
    id: true,
    userId: true,
    expiresAt: true,
    planSnapshot: true,
    trafficLimit: true,
    deviceLimit: true,
    remnawaveId: true,
    remnawavePanelId: true,
    remnawavePanelUsername: true,
  } as const;

  public async build(
    subscription: SubscriptionNoticeSource,
    context: { readonly daysLeft: number },
  ): Promise<Record<string, unknown>> {
    const planName = readPlanName(subscription.planSnapshot);
    const payload: Record<string, unknown> = {
      subscriptionId: subscription.id,
      expiresAt: subscription.expiresAt?.toISOString() ?? null,
      plan: planName,
      planName,
      daysLeft: context.daysLeft,
      // Local columns. `0` means unlimited by the product rule, and the
      // renderer applies that rule — it is not translated here.
      trafficLimitGb: subscription.trafficLimit,
      deviceLimit: subscription.deviceLimit,
    };
    if (subscription.remnawavePanelUsername !== null) {
      payload['profile'] = subscription.remnawavePanelUsername;
    }

    if (this.remnawaveApiService === undefined || subscription.remnawaveId === null) {
      return payload;
    }
    const identity = {
      remnawaveId: subscription.remnawaveId,
      panelId: subscription.remnawavePanelId,
      panelUsername: subscription.remnawavePanelUsername,
    };
    try {
      const usage = await this.remnawaveApiService.getPanelUserUsage(identity);
      if (usage !== null) {
        if (usage.username !== null) payload['profile'] = usage.username;
        if (usage.usedTrafficBytes !== null) {
          payload['trafficUsedGb'] = toGb(usage.usedTrafficBytes);
        }
        // The panel is authoritative for the limits: an operator editing a
        // profile there directly is a supported thing to do, and a notice
        // quoting the stale local number would contradict the cabinet.
        if (usage.trafficLimitBytes !== null) {
          payload['trafficLimitGb'] = toGb(usage.trafficLimitBytes);
        }
        if (usage.hwidDeviceLimit !== null) payload['deviceLimit'] = usage.hwidDeviceLimit;
      }

      // Bound devices, and ONLY for a finite allowance: counting them against
      // an unlimited plan answers a question nobody asked and spends a second
      // panel call to do it.
      const limit = payload['deviceLimit'];
      if (typeof limit === 'number' && limit > 0) {
        const devices = await this.remnawaveApiService.strictListUserDevices(identity);
        if (devices.kind === 'ok') {
          payload['devicesUsed'] = devices.value.devices.length;
        }
      }
    } catch (err) {
      this.logger.warn(
        `Notice for ${subscription.id}: panel facts unavailable (${(err as Error).message})`,
      );
    }
    return payload;
  }

  /** Loads the row and builds in one step, for callers holding only an id. */
  public async buildForSubscription(
    subscriptionId: string,
    context: { readonly daysLeft: number },
  ): Promise<Record<string, unknown> | null> {
    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: SubscriptionNoticePayloadService.SELECT,
    });
    if (subscription === null) return null;
    return this.build(subscription, context);
  }
}

export interface SubscriptionNoticeSource {
  readonly id: string;
  readonly expiresAt: Date | null;
  readonly planSnapshot: unknown;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
}

function toGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

/** The plan name out of the purchase-time snapshot, or an empty string. */
function readPlanName(planSnapshot: unknown): string {
  if (planSnapshot === null || typeof planSnapshot !== 'object') return '';
  const name = (planSnapshot as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}
