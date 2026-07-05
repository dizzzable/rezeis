import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { RemnawaveApiService } from '../remnawave/services/remnawave-api.service';
import { SettingsService } from '../settings/services/settings.service';
import { ProfileSyncQueueService } from './profile-sync-queue.service';

/** Max subscriptions cleaned per sweep — bounds the load on the panel. */
const CLEANUP_BATCH = 100;

/**
 * ExpiredProfileCleanupService
 * ────────────────────────────
 * Worker-only cron that retires subscriptions once they've been expired past
 * the grace window: it removes the Remnawave **panel profile** AND soft-deletes
 * the local `Subscription` row (`status = DELETED`).
 *
 * Grace-window contract:
 *   A subscription expires (`expiresAt` passes) and stays EXPIRED — visible in
 *   the cabinet/bot and still renewable — for `graceDays` (default 3). After
 *   that the sweep cleans it on BOTH sides: the panel profile is deleted and
 *   the row flips to DELETED, so it disappears from the cabinet (the internal
 *   list filters `status != DELETED`) and can no longer be renewed. A timely
 *   renewal within the window keeps the same profile (no re-provisioning).
 *
 * Why soft-delete (keep the row) instead of hard-delete:
 *   Trial accounting (`grantTrial` / trial eligibility) counts `isTrial`
 *   subscriptions with **no status filter** (DELETED rows included), plus
 *   `TrialGrant` and paid-trial `Transaction` rows. Those must survive so a
 *   user can never re-claim a free trial or exceed a paid-trial limit just
 *   because their old subscription was cleaned. The row — incl. `isTrial`,
 *   `planSnapshot` — is retained as the durable trial-usage ledger.
 *
 * Two selectors run per sweep:
 *   1. Profile-bearing expired rows (no pending/in-flight `DELETE` job) →
 *      enqueue `ProfileSyncJob(DELETE)`; the panel call + `status = DELETED`
 *      happen in `ProfileSyncProcessor.handleDelete`.
 *   2. Already-detached expired rows (`remnawaveId = null`, not yet DELETED) —
 *      e.g. cleaned by an older build that only nulled the profile link — are
 *      soft-deleted directly here (nothing left to remove on the panel).
 *
 * See `.kiro/specs/trial-aware-profile-cleanup`.
 */
@Injectable()
export class ExpiredProfileCleanupService {
  private readonly logger = new Logger(ExpiredProfileCleanupService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly events: SystemEventsService,
    private readonly settingsService: SettingsService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'expired-profile-cleanup' })
  public async sweepExpiredProfiles(): Promise<void> {
    if (!shouldRunSchedules()) return;
    await this.runSweep();
  }

  /**
   * One sweep pass:
   *   1. Enqueue a `DELETE` job for up to `CLEANUP_BATCH` expired,
   *      profile-bearing subscriptions with no pending/in-flight `DELETE` job
   *      (the job deletes the panel profile AND flips the row to DELETED).
   *   2. Directly soft-delete expired rows that are already detached
   *      (`remnawaveId = null`) but not yet DELETED — nothing to remove on the
   *      panel, so no job is needed.
   * Returns the total number of subscriptions acted on (exposed for tests).
   */
  public async runSweep(): Promise<number> {
    // Panel-managed policy: operators can disable profile deletion entirely
    // (critical when one Remnawave panel is shared by multiple projects) or
    // widen the grace window. Defaults: deletion ON, 3-day grace.
    const policy = await this.settingsService.getRemnawaveCleanupSettings();
    if (!policy.deleteEnabled) return 0;

    const now = new Date();
    // Only act on subscriptions expired more than `graceDays` ago — gives the
    // user a renewal window before the profile is detached and the row is
    // retired. graceDays=0 ⇒ act as soon as expired.
    const cutoff = new Date(now.getTime() - policy.graceDays * 24 * 60 * 60 * 1000);
    const enqueued = await this.enqueueProfileDeletions(cutoff);
    const softDeleted = await this.softDeleteDetachedExpired(cutoff);
    return enqueued + softDeleted;
  }

  /**
   * Soft-deletes expired subscriptions that no longer carry a panel profile
   * (`remnawaveId = null`) and aren't already DELETED — e.g. rows an older
   * build detached but left EXPIRED. Bulk `updateMany`; nothing to call on the
   * panel. Returns the number of rows flipped to DELETED.
   */
  private async softDeleteDetachedExpired(cutoff: Date): Promise<number> {
    const { count } = await this.prismaService.subscription.updateMany({
      where: {
        remnawaveId: null,
        status: { not: SubscriptionStatus.DELETED },
        expiresAt: { not: null, lt: cutoff },
      },
      data: { status: SubscriptionStatus.DELETED },
    });
    if (count > 0) {
      this.logger.log(`Expired-profile cleanup: soft-deleted ${count} already-detached subscription(s)`);
    }
    return count;
  }

  /**
   * Selects up to `CLEANUP_BATCH` expired, profile-bearing subscriptions with
   * no pending/in-flight `DELETE` job and enqueues a `DELETE` job for each —
   * BUT only after re-confirming expiry against the live Remnawave panel.
   *
   * Why the panel re-check: the sweep decides "expired" from the LOCAL
   * `expiresAt`, which can be stale — e.g. the operator extended the profile
   * directly in the panel and the `user.*` webhook that would refresh
   * `expiresAt` never arrived (observed on Remnawave 2.7.x manual edits). With
   * no periodic pull-reconcile, the stale local date would delete a
   * still-valid subscription. So for every candidate we fetch the panel's
   * canonical `expireAt` first:
   *   • panel expiry ≥ cutoff  → NOT actually cleanable. Self-heal the local
   *     `expiresAt` (and revive status to ACTIVE when the panel expiry is in
   *     the future) and SKIP the deletion.
   *   • panel expiry < cutoff  → panel confirms expired past grace → delete.
   *   • panel profile missing (`null`) → nothing to protect → delete/clean up.
   *   • panel unreachable (throws) → DEFER; never delete on an unverifiable
   *     date. Re-evaluated next sweep.
   *
   * Returns the number of subscriptions enqueued for deletion.
   */
  private async enqueueProfileDeletions(cutoff: Date): Promise<number> {
    const candidates = await this.prismaService.subscription.findMany({
      where: {
        remnawaveId: { not: null },
        // A DELETED row is already retired — never a cleanup candidate.
        status: { not: SubscriptionStatus.DELETED },
        // Expired strictly before the grace cutoff. We require a concrete
        // `expiresAt` so the grace window is well-defined; subscriptions with
        // no expiry date are never auto-cleaned (operator can delete manually).
        expiresAt: { not: null, lt: cutoff },
        // Skip subscriptions that already have a DELETE job in flight so the
        // sweep is idempotent across overlapping runs.
        syncJobs: {
          none: {
            action: SyncAction.DELETE,
            status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
          },
        },
      },
      select: { id: true, userId: true, isTrial: true, remnawaveId: true },
      take: CLEANUP_BATCH,
      orderBy: { expiresAt: 'asc' },
    });

    if (candidates.length === 0) return 0;

    let enqueued = 0;
    let selfHealed = 0;
    for (const subscription of candidates) {
      const remnawaveId = subscription.remnawaveId;
      if (remnawaveId === null) continue; // defensive — query already filters this

      // ── Panel-authoritative expiry re-check ──────────────────────────────
      let panelExpiryMs: number | null = null;
      let panelSubscriptionUrl: string | null = null;
      try {
        const panelUser = await this.remnawaveApiService.getPanelUser(remnawaveId);
        if (panelUser !== null) {
          const parsed = new Date(panelUser.expireAt);
          panelExpiryMs = Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
          panelSubscriptionUrl =
            typeof panelUser.subscriptionUrl === 'string' && panelUser.subscriptionUrl.length > 0
              ? panelUser.subscriptionUrl
              : null;
        }
        // panelUser === null → profile already gone from the panel → fall
        // through to enqueue the cleanup (nothing to protect).
      } catch (err: unknown) {
        // Panel unreachable — defer rather than delete an unverifiable sub.
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(
          `Expired-profile cleanup: panel check failed for ${subscription.id}, deferring: ${message}`,
        );
        continue;
      }

      // Panel says the subscription is NOT expired past the grace cutoff — the
      // local `expiresAt` was stale. Self-heal it and skip deletion.
      if (panelExpiryMs !== null && panelExpiryMs >= cutoff.getTime()) {
        const reviveActive = panelExpiryMs > Date.now();
        try {
          await this.prismaService.subscription.update({
            where: { id: subscription.id },
            data: {
              expiresAt: new Date(panelExpiryMs),
              ...(panelSubscriptionUrl !== null ? { configUrl: panelSubscriptionUrl } : {}),
              ...(reviveActive ? { status: SubscriptionStatus.ACTIVE } : {}),
            },
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          this.logger.warn(
            `Expired-profile cleanup: self-heal update failed for ${subscription.id}: ${message}`,
          );
          continue;
        }
        selfHealed += 1;
        this.events.info(
          EVENT_TYPES.SUBSCRIPTION_SYNCED,
          'SUBSCRIPTION',
          'Expired-cleanup self-heal: refreshed stale expiry from panel (deletion skipped)',
          {
            subscriptionId: subscription.id,
            userId: subscription.userId,
            isTrial: subscription.isTrial,
            panelExpiresAt: new Date(panelExpiryMs).toISOString(),
            revived: reviveActive,
            source: 'EXPIRED_PROFILE_CLEANUP',
          },
        );
        this.logger.log(
          `Expired-profile cleanup: skipped ${subscription.id} — panel expiry ${new Date(
            panelExpiryMs,
          ).toISOString()} is newer than the stale local date; self-healed`,
        );
        continue;
      }

      // Panel confirms expired-past-grace, or the profile is already gone from
      // the panel — proceed with the deletion.
      try {
        const job = await this.prismaService.profileSyncJob.create({
          data: {
            subscriptionId: subscription.id,
            action: SyncAction.DELETE,
            status: SyncJobStatus.PENDING,
            payload: { source: 'EXPIRED_PROFILE_CLEANUP' } as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        await this.profileSyncQueueService.enqueue(job.id);
        enqueued += 1;
        this.events.info(
          EVENT_TYPES.SUBSCRIPTION_DELETED,
          'SUBSCRIPTION',
          'Expired profile cleanup scheduled',
          {
            subscriptionId: subscription.id,
            userId: subscription.userId,
            isTrial: subscription.isTrial,
            source: 'EXPIRED_PROFILE_CLEANUP',
          },
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(
          `Failed to schedule cleanup for subscription ${subscription.id}: ${message}`,
        );
      }
    }

    if (enqueued > 0) {
      this.logger.log(`Expired-profile cleanup: scheduled ${enqueued} profile deletion(s)`);
    }
    if (selfHealed > 0) {
      this.logger.log(
        `Expired-profile cleanup: self-healed ${selfHealed} subscription(s) with stale local expiry`,
      );
    }
    return enqueued;
  }
}
