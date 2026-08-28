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
      // BOUNDED, and the bound is what keeps the cycle shorter than its own
      // tick. These reads used to sit outside any deadline, on the shared
      // 45-second outbound timeout, INSIDE a per-subscription loop — so a
      // half-open panel connection made one cycle take minutes while the cron
      // fires every minute. Two cycles then walked the same window and told the
      // same customers twice.
      //
      // A notice is worth sending with the facts we have; it is not worth
      // waiting three quarters of a minute for one number. The same reasoning
      // already bounds the webhook path.
      const usage = await withDeadline(
        this.remnawaveApiService.getPanelUserUsage(identity),
        PANEL_FACT_DEADLINE_MS,
      );
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
        const devices = await withDeadline(
          this.remnawaveApiService.strictListUserDevices(identity),
          PANEL_FACT_DEADLINE_MS,
        );
        if (devices !== null && devices.kind === 'ok') {
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

/**
 * How long one notice may wait on the panel for a display fact.
 *
 * Three seconds, the same bound the webhook path already applies for the same
 * reason. The alternative is the shared 45-second outbound timeout, and these
 * calls run inside a per-subscription loop under a cron that fires every
 * minute: one unresponsive panel turns a cycle into minutes, two cycles overlap
 * on the same window, and customers are told twice.
 */
const PANEL_FACT_DEADLINE_MS = 3_000;

/**
 * The promise's value, or `null` when it did not arrive in time.
 *
 * Resolves rather than rejects on the timeout, because a missing fact is a
 * notice with less detail and a thrown one is no notice at all. The underlying
 * request is left running — there is nothing useful to cancel, and its own
 * timeout will end it.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
