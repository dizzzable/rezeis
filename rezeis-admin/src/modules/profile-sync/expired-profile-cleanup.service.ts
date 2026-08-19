import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from '../../common/services/system-events.service';
import { storedIdentityOf } from '../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../remnawave/services/remnawave-api.service';
import { SettingsService } from '../settings/services/settings.service';
import { SubscriptionDeletionService } from '../subscriptions/services/subscription-deletion.service';

/** Max subscriptions cleaned per sweep — bounds the load on the panel. */
const CLEANUP_BATCH = 100;

/**
 * True when a row with no `remnawaveId` nonetheless owns a live panel profile.
 *
 * The fingerprint is exact, and it is the same one
 * `PanelLinkReconciliationService` selects on, because it describes one
 * historical write and nothing else. `persistProfileLink` set four columns in a
 * single statement: `remnawaveId` and `remnawavePanelId` came from a panel body
 * that used to be CAST rather than decoded — `undefined` on 3.x, which Prisma
 * reads as "leave the column alone" — while `remnawavePanelUsername` and
 * `configUrl` came from arguments and landed. No other state produces the
 * combination:
 *   • a row that was never provisioned has neither column;
 *   • `reprovisionMissingProfile` and the DELETE worker's retirement clear all
 *     four in one statement;
 *   • the manual re-link endpoint refuses unless `remnawaveId` is null and
 *     writes them together.
 *
 * `undefined` is treated as absent on purpose: a caller whose `select` omits a
 * column must fall through to the ordinary detached path rather than have every
 * row look repairable.
 */
function hasLostPanelLink(row: {
  readonly remnawavePanelUsername?: string | null;
  readonly configUrl?: string | null;
}): boolean {
  return (
    typeof row.remnawavePanelUsername === 'string' &&
    row.remnawavePanelUsername.length > 0 &&
    typeof row.configUrl === 'string' &&
    row.configUrl.length > 0
  );
}

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
    private readonly events: SystemEventsService,
    private readonly settingsService: SettingsService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly subscriptionDeletionService: SubscriptionDeletionService,
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
    const candidates = await this.prismaService.subscription.findMany({
      where: {
        remnawaveId: null,
        status: { not: SubscriptionStatus.DELETED },
        expiresAt: { not: null, lt: cutoff },
      },
      // The two columns that separate "no profile" from "a profile we can no
      // longer name" — see `hasLostPanelLink`. Selected rather than filtered in
      // the query so the excluded rows can be COUNTED and reported; a `NOT` in
      // the `where` would hide them from this sweep as completely as the old
      // behaviour deleted them.
      select: { id: true, expiresAt: true, remnawavePanelUsername: true, configUrl: true },
      take: CLEANUP_BATCH,
      orderBy: { expiresAt: 'asc' },
    });
    let deleted = 0;
    let lostLink = 0;
    for (const candidate of candidates) {
      if (candidate.expiresAt === null) continue;
      // NOT DETACHED — LINK LOST. "Detached" means the panel profile is gone;
      // for this population it is very much alive and merely unnameable. The
      // create/update decoder used to CAST an undecoded panel body into the
      // typed shape, so on 3.x `uuid` and `id` arrived undefined and Prisma
      // left both columns alone, while the panel username and the subscription
      // URL — which came from arguments — landed.
      //
      // Soft-deleting one of those wrote `status = DELETED` with no revocation:
      // the profile kept serving a customer who had stopped paying, and the row
      // simultaneously left the cabinet, this sweep, and
      // `PanelLinkReconciliationService`, which selects `status <> DELETED` and
      // is the only thing that can put the id back. One sweep turned a
      // repairable row into a permanent unbilled profile, and counted it as a
      // success.
      //
      // Leaving them EXPIRED is recoverable and reported. It costs a slot in
      // this batch, which is bounded and drains as soon as the reconciliation
      // is run — the alternative costs a live profile, permanently.
      if (hasLostPanelLink(candidate)) {
        lostLink += 1;
        continue;
      }
      const result = await this.subscriptionDeletionService.deleteExpiredIfUnchanged({
        subscriptionId: candidate.id,
        expectedExpiresAt: candidate.expiresAt,
        expectedRemnawaveId: null,
        cutoff,
      });
      if (result.deleted) deleted += 1;
    }
    if (deleted > 0) {
      this.logger.log(`Expired-profile cleanup: soft-deleted ${deleted} already-detached subscription(s)`);
    }
    if (lostLink > 0) {
      // Once per sweep with a count, not once per row: the population is
      // whatever the decoder defect touched before it was fixed, and a line per
      // row would bury it under itself.
      const message =
        `Expired-profile cleanup: left ${lostLink} expired subscription(s) alone — their panel ` +
        'link was lost, so their panel profile is probably still live and unbilled. Soft-deleting ' +
        'them would strand the profile and put the row out of reach of the panel-link repair. Run ' +
        'the panel-link reconciliation; they retire normally once relinked.';
      this.logger.warn(message);
      this.events.warn(EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC, 'SYSTEM', message, {
        subscriptions: lostLink,
      });
    }
    return deleted;
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
   *   • `ok`, panel expiry ≥ cutoff → NOT actually cleanable. Self-heal the
   *     local `expiresAt` (and revive status to ACTIVE when the panel expiry is
   *     in the future) and SKIP the deletion.
   *   • `ok`, panel expiry < cutoff → panel confirms expired past grace → delete.
   *   • `notFound` → the profile really is gone from the panel → nothing to
   *     protect → delete/clean up. Note what this outcome does and does not
   *     mean: the adapter only produces it for a 404 carrying one of Remnawave's
   *     own no-such-user envelopes — `A025` on the writes, `A063` on THIS read;
   *     the panel picks by endpoint, not by meaning, and both are pinned in
   *     `PANEL_USER_NOT_FOUND_ERROR_CODES`. A BARE 404 is not a missing profile —
   *     a reverse proxy mid-deploy answers every request that way, and this
   *     branch is the one non-`ok` outcome that deletes, so reading a bare 404
   *     as "gone" retired CLEANUP_BATCH live subscriptions per sweep for the
   *     length of the outage. That distinction lives in
   *     `RemnawaveApiService.mapStrictProfileTransport`, because the outcome
   *     union carries no evidence a caller could re-derive; a bare 404 now
   *     arrives here as `unavailable` and defers.
   *   • ANY other outcome — `unavailable`, `unsupported`, `invalidContract` →
   *     DEFER; never delete on an unverifiable date. Re-evaluated next sweep.
   *
   * The read MUST be the strict one. `getPanelUser` is best-effort: it
   * collapses every failure — outage, expired token, 5xx, timeout — into
   * `null`, and `null` here means "gone". Reading through it made the DEFER
   * branch unreachable by construction, so one sweep during a panel outage
   * deleted up to CLEANUP_BATCH live subscriptions while the log looked
   * ordinary. The test that covered the DEFER branch fed the stub a `throw`,
   * which the real method cannot produce.
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
      // The supplementary identity columns are selected because the re-check
      // below ADDRESSES the profile on the panel. A 2.x-created profile whose
      // panel has since been upgraded to 3.x cannot be named by `remnawaveId`
      // alone, and an unaddressable profile reads as `unavailable` — a deferral
      // every sweep, forever, for a subscription that will never be retired.
      select: {
        id: true,
        userId: true,
        isTrial: true,
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        configUrl: true,
        expiresAt: true,
      },
      take: CLEANUP_BATCH,
      orderBy: { expiresAt: 'asc' },
    });

    if (candidates.length === 0) return 0;

    let enqueued = 0;
    let selfHealed = 0;
    let deferred = 0;
    const deferredKinds = new Set<string>();
    for (const subscription of candidates) {
      const identity = storedIdentityOf(subscription);
      const expectedExpiresAt = subscription.expiresAt;
      if (identity === null || expectedExpiresAt === null) continue;

      // ── Panel-authoritative expiry re-check ──────────────────────────────
      const panelOutcome = await this.remnawaveApiService.strictGetPanelUserExpiry(identity);
      let panelExpiryMs: number | null = null;
      let panelSubscriptionUrl: string | null = null;
      if (panelOutcome.kind === 'ok') {
        panelExpiryMs = panelOutcome.value.expireAtMs;
        panelSubscriptionUrl = panelOutcome.value.subscriptionUrl;
      } else if (panelOutcome.kind === 'notFound') {
        // The panel itself says the profile is gone (404 + USER_NOT_FOUND
        // envelope) → nothing left to protect → fall through to the cleanup.
        // Named positively on purpose: deletion is the destructive branch, so
        // it is entered by matching the one outcome that permits it, never by
        // falling out of the bottom of a `!==` guard. Any outcome added to the
        // union later defers by default rather than deleting by default.
      } else {
        // Could not verify the date — defer. Counted rather than logged per
        // row: a panel outage would otherwise emit CLEANUP_BATCH warnings a
        // tick, burying the one line that says the sweep is degraded.
        deferred += 1;
        deferredKinds.add(panelOutcome.kind);
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
        const result = await this.subscriptionDeletionService.deleteExpiredIfUnchanged({
          subscriptionId: subscription.id,
          expectedExpiresAt,
          // The stored COLUMN, not the address the panel was asked at. This
          // fence is a compare-and-swap: it refuses the delete if `remnawaveId`
          // moved between the re-check and now, which is exactly what a
          // re-provision does. Widening it to the resolved identity would let a
          // subscription that has since been re-linked to a live profile be
          // retired on the strength of a read against the dead one.
          expectedRemnawaveId: identity.remnawaveId,
          cutoff,
        });
        if (!result.deleted) {
          continue;
        }
        enqueued += 1;
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
    if (deferred > 0) {
      // Deliberately `warn`, and deliberately unconditional on the count: a
      // deferral means the panel could not confirm the expiry, so the sweep is
      // running degraded. Silence here is what let the old unreachable-DEFER
      // bug delete live subscriptions unnoticed.
      this.logger.warn(
        `Expired-profile cleanup: deferred ${deferred} of ${candidates.length} candidate(s) — ` +
          `panel could not confirm expiry (${[...deferredKinds].sort().join(', ')})`,
      );
    }
    return enqueued;
  }
}
