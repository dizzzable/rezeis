import { Injectable, Logger, Optional } from '@nestjs/common';
import { SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { planNameFromSnapshot } from '../../../common/utils/plan-snapshot.util';
import { claimFirstTraffic, connectEvidenceOf } from '../../connect-signal/connect-evidence.util';
import { safeZone } from '../../contests/contest-calendar.util';
import { storedIdentityOf, type StoredPanelIdentity } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { readPlatformBranding } from '../../settings/utils/platform-branding.util';
import {
  deriveClientAlerts,
  type ClientCard,
  type ClientCardPayment,
  type ClientCardSubscription,
} from '../support-client-card';

/** Subscriptions on the card; the rest is a different screen's job. */
const SUBSCRIPTIONS_SHOWN = 5;
/** Of those, how many are read live from Remnawave per card. */
const LIVE_READS = 3;
/** Payments on the card. */
const PAYMENTS_SHOWN = 6;
/** One Remnawave read; the card is built without it rather than late. */
const LIVE_READ_TIMEOUT_MS = 4_000;
/** An ended subscription older than this is history: not read live. */
const LIVE_READ_ENDED_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/** A payment number the cabinet shows without the importer's namespace. */
const IMPORTED_NAMESPACES = ['altshop', 'bedolaga', 'remnashop'] as const;

/**
 * SupportClientCardService
 * ════════════════════════
 * Reads `ClientCard` (see `support-client-card.ts`) for one person: the
 * panel's rows and, beside each recent subscription, the profile as Remnawave
 * states it now.
 *
 * Read on demand, never cached: the assistant asks before every reply and the
 * ticket page every time it opens and on its timer, and «свежесть» was the
 * whole complaint. A Remnawave read that is slow or failing costs the card
 * its live half for that subscription (`read: 'unavailable'`), never the card.
 *
 * One write: when the live read shows the profile has carried traffic and the
 * person's `firstTrafficAt` is still empty, it is claimed through the shared
 * conditional write every other connection writer uses — so the next card,
 * and the badge the ticket list draws from that column, stop saying «ни разу
 * не подключался» about somebody who is online.
 */
@Injectable()
export class SupportClientCardService {
  private readonly logger = new Logger(SupportClientCardService.name);

  public constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly remnawave?: RemnawaveApiService,
  ) {}

  /** The card, or `null` when there is no such person. */
  public async read(userId: string, now: Date = new Date()): Promise<ClientCard | null> {
    const [user, subscriptions, transactions, gateways, zone] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          createdAt: true,
          isBlocked: true,
          lastSurface: true,
          lastOs: true,
          lastSeenAt: true,
          firstTrafficAt: true,
        },
      }),
      this.prisma.subscription.findMany({
        where: { userId, status: { not: 'DELETED' } },
        orderBy: { createdAt: 'desc' },
        take: SUBSCRIPTIONS_SHOWN,
        select: {
          id: true,
          status: true,
          isTrial: true,
          planSnapshot: true,
          trafficLimit: true,
          deviceLimit: true,
          startedAt: true,
          expiresAt: true,
          remnawaveId: true,
          remnawavePanelId: true,
          remnawavePanelUsername: true,
          configUrl: true,
        },
      }),
      this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: PAYMENTS_SHOWN,
        select: {
          paymentId: true,
          status: true,
          purchaseType: true,
          amount: true,
          currency: true,
          gatewayType: true,
          planSnapshot: true,
          createdAt: true,
          fulfilledAt: true,
        },
      }),
      this.prisma.paymentGateway.findMany({ select: { type: true, displayName: true } }).catch(() => []),
      this.readZone(),
    ]);
    if (user === null) return null;

    const syncs = await this.readStuckSyncs(subscriptions.map((sub) => sub.id));
    const live = await this.readLive(subscriptions, now);

    let firstTrafficAt = user.firstTrafficAt;
    if (firstTrafficAt === null) {
      const evidence = live
        .map((entry) => (entry.profile === null ? null : connectEvidenceOf(entry.profile.userTraffic ?? null, now)))
        .find((found) => found?.kind === 'connected');
      if (evidence !== undefined && evidence !== null && evidence.kind === 'connected') {
        // A lost race means another writer filled it a moment ago with an
        // earlier time; this card shows the one it read, which is close enough.
        await claimFirstTraffic(this.prisma, user.id, evidence.at).catch((err: unknown) => {
          this.logger.warn(`First-traffic claim from the support card failed for ${user.id}: ${describe(err)}`);
        });
        firstTrafficAt = evidence.at;
      }
    }

    const gatewayNames = new Map(gateways.map((g) => [g.type as string, g.displayName]));
    const cardSubscriptions: ClientCardSubscription[] = subscriptions.map((sub, index) => {
      const entry = live[index];
      const profile = entry?.profile ?? null;
      return {
        id: sub.id,
        plan: planNameFromSnapshot(sub.planSnapshot),
        status: sub.status,
        isTrial: sub.isTrial,
        startedAt: iso(sub.startedAt),
        expiresAt: iso(sub.expiresAt),
        trafficLimitGb: sub.trafficLimit,
        deviceLimit: sub.deviceLimit,
        read: entry?.read ?? 'skipped',
        remnawave:
          profile === null
            ? null
            : {
                status: profile.status ?? null,
                expiresAt: profile.expireAt ?? null,
                usedBytes: profile.userTraffic?.usedTrafficBytes ?? null,
                onlineAt: profile.userTraffic?.onlineAt ?? null,
                firstConnectedAt: profile.userTraffic?.firstConnectedAt ?? null,
                devices: entry?.devices ?? null,
              },
        sync: syncs.get(sub.id) ?? null,
      };
    });
    const payments: ClientCardPayment[] = transactions.map((tx) => ({
      number: displayPaymentNumber(tx.paymentId),
      createdAt: tx.createdAt.toISOString(),
      status: tx.status,
      purchaseType: tx.purchaseType,
      amount: tx.amount.toString(),
      currency: tx.currency,
      gateway: gatewayNames.get(tx.gatewayType)?.trim() || readableGateway(tx.gatewayType),
      plan: planNameFromSnapshot(tx.planSnapshot),
      appliedAt: iso(tx.fulfilledAt),
    }));

    return {
      asOf: now.toISOString(),
      zone,
      account: {
        createdAt: user.createdAt.toISOString(),
        isBlocked: user.isBlocked,
        surface: user.lastSurface,
        os: user.lastOs,
        lastSeenAt: iso(user.lastSeenAt),
        firstTrafficAt: iso(firstTrafficAt),
      },
      subscriptions: cardSubscriptions,
      payments,
      alerts: deriveClientAlerts({ subscriptions: cardSubscriptions, payments }, now),
    };
  }

  /**
   * The live half, one entry per subscription in order. Only the newest few,
   * and only those that run or ended within the week: a profile that ended a
   * year ago answers no question a ticket asks today.
   */
  private async readLive(
    subscriptions: ReadonlyArray<{
      readonly status: string;
      readonly expiresAt: Date | null;
      readonly remnawaveId: string | null;
      readonly remnawavePanelId: number | null;
      readonly remnawavePanelUsername: string | null;
      readonly configUrl: string | null;
    }>,
    now: Date,
  ): Promise<Array<{ read: ClientCardSubscription['read']; profile: LiveProfile | null; devices: number | null }>> {
    let budget = LIVE_READS;
    return Promise.all(
      subscriptions.map(async (sub) => {
        const identity = storedIdentityOf(sub);
        if (identity === null) return { read: 'unlinked' as const, profile: null, devices: null };
        const recent =
          sub.status === 'ACTIVE' ||
          sub.status === 'LIMITED' ||
          (sub.expiresAt !== null && now.getTime() - sub.expiresAt.getTime() <= LIVE_READ_ENDED_WITHIN_MS);
        if (!recent) return { read: 'skipped' as const, profile: null, devices: null };
        if (this.remnawave === undefined) return { read: 'unavailable' as const, profile: null, devices: null };
        // Not «давно закончилась»: a fourth running subscription is as current
        // as the first, the card just does not spend a fourth read on it.
        if (budget <= 0) return { read: 'not_read' as const, profile: null, devices: null };
        budget -= 1;
        return this.readOne(identity);
      }),
    );
  }

  private async readOne(
    identity: StoredPanelIdentity,
  ): Promise<{ read: ClientCardSubscription['read']; profile: LiveProfile | null; devices: number | null }> {
    const remnawave = this.remnawave!;
    const [outcome, devices] = await Promise.all([
      withTimeout(remnawave.getPanelUserOutcome(identity), LIVE_READ_TIMEOUT_MS),
      withTimeout(remnawave.strictGetPanelUserDevices(identity), LIVE_READ_TIMEOUT_MS),
    ]);
    const count = devices !== null && devices.kind === 'ok' ? devices.value.total : null;
    if (outcome === null) return { read: 'unavailable', profile: null, devices: null };
    if (outcome.kind === 'missing') return { read: 'missing', profile: null, devices: null };
    if (outcome.kind !== 'ok') return { read: 'unavailable', profile: null, devices: null };
    return { read: 'live', profile: outcome.user, devices: count };
  }

  /** The newest push to Remnawave per subscription that has not landed and was not superseded. */
  private async readStuckSyncs(subscriptionIds: readonly string[]): Promise<Map<string, ClientCardSubscription['sync']>> {
    const found = new Map<string, ClientCardSubscription['sync']>();
    if (subscriptionIds.length === 0) return found;
    const jobs = await this.prisma.profileSyncJob
      .findMany({
        where: {
          subscriptionId: { in: [...subscriptionIds] },
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING, SyncJobStatus.FAILED] },
          supersededAt: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { subscriptionId: true, status: true, attempts: true, createdAt: true },
      })
      .catch((err: unknown) => {
        this.logger.warn(`Sync jobs unreadable for the support card: ${describe(err)}`);
        return [];
      });
    for (const job of jobs) {
      if (found.has(job.subscriptionId)) continue;
      found.set(job.subscriptionId, {
        status: job.status as 'PENDING' | 'RUNNING' | 'FAILED',
        since: job.createdAt.toISOString(),
        attempts: job.attempts,
      });
    }
    return found;
  }

  /** The project's clock — the same one a contest's monthly repeat lands on. */
  private async readZone(): Promise<string> {
    const settings = await this.prisma.settings
      .findUnique({ where: { id: 1 }, select: { platformPolicy: true } })
      .catch(() => null);
    return safeZone(readPlatformBranding(settings?.platformPolicy ?? null).timezone);
  }
}

type LiveProfile = NonNullable<Awaited<ReturnType<RemnawaveApiService['getPanelUser']>>>;

/** The read, or `null` when it failed or took longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The number the cabinet shows for `paymentId` (reiwa `displayPaymentNumber`). */
export function displayPaymentNumber(paymentId: string): string {
  for (const namespace of IMPORTED_NAMESPACES) {
    const prefix = `${namespace}:`;
    if (paymentId.startsWith(prefix) && paymentId.length > prefix.length) return paymentId.slice(prefix.length);
  }
  return paymentId;
}

/** `TELEGRAM_STARS` → «Telegram Stars», for a gateway with no name of its own. */
function readableGateway(type: string): string {
  return type
    .toLowerCase()
    .split('_')
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
