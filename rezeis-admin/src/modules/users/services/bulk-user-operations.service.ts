import { randomUUID } from 'node:crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { parseTelegramId } from '../../../common/utils/postgres-bigint.util';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { observePanelEra, type PanelEraObservation } from '../../remnawave/services/panel-version.util';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import { UserBlockService } from './user-block.service';
import { UserDeletionService } from './user-deletion.service';

export type BulkUserAction =
  | 'block'
  | 'unblock'
  | 'delete'
  | 'set_language'
  | 'set_max_subscriptions'
  /** Zero the traffic counter on every linked VPN profile. */
  | 'reset_traffic'
  /** Push local subscription state to the VPN panel — drift repair. */
  | 'resync_profiles'
  /** Unbind every device from the VPN profile. */
  | 'revoke_devices'
  /** Add days to every live subscription — the compensation action. */
  | 'extend_subscription';

export interface BulkUserOperationInputInterface {
  readonly userIds: readonly string[];
  readonly action: BulkUserAction;
  /** Optional payload for parametric actions (e.g. set_language:'EN'). */
  readonly payload?: Record<string, unknown>;
  /**
   * The operator, not merely their id. `adminId: string | null` used to sit
   * here; the null was never reachable — the one caller is behind
   * `AdminJwtAuthGuard` — but a nullable actor makes an audit write carry a
   * branch for a case that cannot happen, and an unreachable branch on an audit
   * path is how an audit path stops being written.
   */
  readonly currentAdmin: CurrentAdminInterface;
  /** ip / user-agent / request id, for the audit rows this run writes. */
  readonly requestMetadata: RequestMetadataInterface;
}

export interface BulkUserOperationItemResultInterface {
  readonly userId: string;
  readonly status: 'ok' | 'error' | 'skipped';
  readonly message?: string;
}

export interface BulkUserOperationResultInterface {
  readonly action: BulkUserAction;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly items: readonly BulkUserOperationItemResultInterface[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

const MAX_BATCH = 1_000;

/**
 * A bulk run leaves ONE AUDIT ROW PER AFFECTED USER, under the SAME action name
 * the single-user route writes, with the origin in `metadata.source`.
 *
 * There was no `adminAuditLog` write in this file at all. Deleting one account
 * from the user card wrote `user.deleted`; deleting a thousand from the bulk
 * toolbar wrote zero rows — only system events, tagged `source: 'bulk'`. The
 * deletion itself was already converged (both call
 * `UserDeletionService.deleteUser`); only the operator record diverged, and the
 * shipped `operator` role holds `users:bulk_operations`.
 *
 * ── Why per user, and not one row naming the set ─────────────────────────────
 *
 * The question this log is asked is "who deleted THIS account", and it is asked
 * about ONE user. `AdminAuditLog` has no entity columns — the subject lives in
 * `metadata` — so the per-user answer is
 *
 *   SELECT ... WHERE action = 'user.deleted' AND metadata->>'userId' = $1
 *
 * and that query has to find the bulk deletion too, or it answers "nobody"
 * about an account a bulk click removed. One row naming the whole set answers
 * "which click did this" cheaply and the per-user question not at all without a
 * second, differently-shaped query (`metadata->'userIds' @> '["X"]'`) unioned
 * in — and a reader that has to remember to union a second shape is a reader
 * that will eventually forget. Same reasoning that put the origin of
 * `partner.balance.adjusted` in `metadata.source` rather than in a second
 * action name.
 *
 * `metadata.batchId` recovers the grouping the single-row shape would have
 * given, without the second shape: every row of one run carries it, and so does
 * the run's summary event. It is generated here rather than taken from
 * `requestId`, which is a client header and is null more often than not.
 *
 * The cost is real and bounded — at most `MAX_BATCH` rows per click — and it is
 * already precedented in this file, which emits one system event per affected
 * user for exactly the same reason.
 *
 * `set_language` and `set_max_subscriptions` were left out of the first pass
 * because their single-user counterpart is `user.profile.updated`, which keys
 * on a `changes` array rather than on a per-field action name. That is now
 * resolved the only way that keeps ONE query answering "who changed this user":
 * both bulk actions write `user.profile.updated` with the same `changes` array
 * the user card writes, so a search by action and `metadata.userId` finds the
 * card edit and the toolbar edit together. The new value is carried alongside,
 * which the card does not do — an audit row that names the field but not what
 * it became answers half the question, and there was no reason to copy that.
 *
 * `language` still has no single-user route. The action name is chosen to be
 * the one that route WOULD use, so adding it later needs no migration of rows
 * already written.
 */
const BULK_AUDIT_ACTION = {
  block: 'user.blocked',
  unblock: 'user.unblocked',
  delete: 'user.deleted',
  set_language: 'user.profile.updated',
  set_max_subscriptions: 'user.profile.updated',
  // Named after what happened to the SUBSCRIPTION, because that is what
  // somebody reading the trail later is asking about — and the same names a
  // single-subscription action would use, so one query answers the question
  // whichever screen performed it.
  reset_traffic: 'user.subscription.traffic_reset',
  resync_profiles: 'user.sync.requested',
  revoke_devices: 'user.subscription.devices_revoked',
  extend_subscription: 'user.subscription.extended',
} as const;

/** Which surface performed the mutation — see {@link BULK_AUDIT_ACTION}. */
const BULK_AUDIT_SOURCE = 'bulk';

/**
 * Executes admin-driven bulk operations against the `users` table.
 *
 * Design
 *   - Each row is processed individually so a partial failure doesn't
 *     break the whole batch (operators commonly mix valid/invalid IDs
 *     when copy-pasting from a spreadsheet).
 *   - Every successful mutation emits a SystemEvents notification —
 *     downstream subscribers (webhooks, telegram alerts, automations)
 *     react to bulk operations the same way as one-off admin actions.
 *   - We hard-cap the batch at `MAX_BATCH` to keep the JSON payload
 *     and DB write volume bounded.
 *
 * Backed by a single endpoint (`POST /admin/users/bulk`) — the UI
 * surfaces a checkbox column on the user search list and a
 * confirmation dialog with progress tracking.
 */
@Injectable()
export class BulkUserOperationsService {
  private readonly logger = new Logger(BulkUserOperationsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly events: SystemEventsService,
    private readonly userDeletionService: UserDeletionService,
    private readonly userBlockService: UserBlockService,
    /**
     * Optional, like everywhere else the VPN panel is reached: a container
     * without it must still block, unblock and delete. The panel-backed
     * actions report `skipped` with a reason rather than failing the run.
     */
    @Optional() private readonly remnawaveApiService?: RemnawaveApiService,
    @Optional() private readonly profileSyncQueue?: ProfileSyncQueueService,
  ) {}

  public async execute(input: BulkUserOperationInputInterface): Promise<BulkUserOperationResultInterface> {
    const startedAt = new Date();
    const ids = Array.from(new Set(input.userIds.filter((id) => typeof id === 'string' && id.length > 0)));
    if (ids.length === 0) {
      return emptyResult(input.action, startedAt);
    }
    if (ids.length > MAX_BATCH) {
      throw new Error(`Bulk operation exceeds the ${MAX_BATCH}-row limit`);
    }

    // Groups every row and every event this one click produces. See the note on
    // {@link BULK_AUDIT_ACTION} for why the grouping lives here and not in a
    // single set-shaped audit row.
    const batchId = randomUUID();

    const items: BulkUserOperationItemResultInterface[] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const userId of ids) {
      try {
        const outcome = await this.dispatchOne(userId, input, batchId);
        items.push(outcome);
        if (outcome.status === 'ok') succeeded += 1;
        else if (outcome.status === 'skipped') skipped += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        items.push({
          userId,
          status: 'error',
          message: (err as Error).message,
        });
      }
    }

    this.events.info(
      EVENT_TYPES.SYSTEM_BULK_USERS_EXECUTED,
      'SYSTEM',
      `Bulk user operation "${input.action}" executed (${succeeded}/${ids.length})`,
      {
        action: input.action,
        adminId: input.currentAdmin.id,
        batchId,
        total: ids.length,
        succeeded,
        failed,
        skipped,
      },
    );

    return {
      action: input.action,
      total: ids.length,
      succeeded,
      failed,
      skipped,
      items,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  // ── Token resolution ────────────────────────────────────────────────────

  /**
   * Resolves an operator-supplied token to a canonical user.
   *
   * Accepts any of the identifiers an operator is likely to paste from a
   * spreadsheet / their own block-list:
   *   - canonical CUID (`user.id`)
   *   - numeric Telegram ID
   *   - email (case-insensitive)
   *   - web-cabinet login (case-insensitive, tolerant of a leading `@`)
   *
   * Returns `null` when nothing matches so the caller can mark the row as
   * `skipped` (not `error`) — a missing entry in a pasted list is expected.
   */
  /**
   * The subscriptions a panel action applies to.
   *
   * DELETED rows are excluded: their profile is already gone upstream and
   * their link is cleared, so an action against one is a call that can only
   * fail.
   */
  private async loadLiveSubscriptions(userId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly status: SubscriptionStatus;
      readonly expiresAt: Date | null;
      readonly remnawaveId: string | null;
      readonly remnawavePanelId: number | null;
      readonly remnawavePanelUsername: string | null;
    }>
  > {
    return this.prismaService.subscription.findMany({
      where: { userId, status: { not: SubscriptionStatus.DELETED } },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
      },
    });
  }

  /** The live subscriptions that actually have a profile upstream. */
  private async loadLinkedSubscriptions(userId: string) {
    const subscriptions = await this.loadLiveSubscriptions(userId);
    return subscriptions.filter((subscription) => subscription.remnawaveId !== null);
  }

  /**
   * Runs one panel call against every linked profile of a user.
   *
   * ── Why the outcome is counted rather than thrown ────────────────────
   *
   * A bulk run is per-row, and a customer with three profiles where one call
   * fails is neither a success nor a failed row — reporting either would be
   * a lie in one direction. The counts let the branch say `2 of 3 failed`
   * and let the audit row record what actually landed.
   *
   * `attempted === 0` carries a REASON, because "no profiles" and "no panel
   * integration" are different things for an operator to act on.
   */
  private async forEachPanelProfile(
    userId: string,
    run: (
      identity: {
        readonly remnawaveId: string;
        readonly panelId: number | null;
        readonly panelUsername: string | null;
      },
      era: PanelEraObservation,
    ) => Promise<void>,
  ): Promise<{
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly reason: string;
  }> {
    if (this.remnawaveApiService === undefined) {
      return { attempted: 0, succeeded: 0, failed: 0, reason: 'VPN panel is not configured' };
    }
    const subscriptions = await this.loadLinkedSubscriptions(userId);
    // ONE reading of the panel era for this whole operation, carried by value
    // into every profile. `getPanelShape()` caches a FAILURE for fifteen
    // seconds, so two adjacent reads can legitimately disagree — and an action
    // that addressed one profile as 2.x and the next as 3.x would half work.
    const era = await observePanelEra(() => this.remnawaveApiService!.getPanelShape());
    let succeeded = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await run(
          {
            remnawaveId: subscription.remnawaveId as string,
            panelId: subscription.remnawavePanelId,
            panelUsername: subscription.remnawavePanelUsername,
          },
          era,
        );
        succeeded += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `Bulk panel action failed for subscription ${subscription.id}: ${(err as Error).message}`,
        );
      }
    }
    return {
      attempted: subscriptions.length,
      succeeded,
      failed,
      reason: 'No linked VPN profiles',
    };
  }

  private async resolveUser(
    token: string,
  ): Promise<{ id: string; telegramId: bigint | null; isBlocked: boolean } | null> {
    const trimmed = token.trim();
    if (trimmed.length === 0) return null;

    // The old gate was `^\d{1,19}$`, which reads like a range check and is not
    // one: `9999999999999999999` is nineteen digits and still larger than
    // Postgres `int8`. It was bound anyway and Postgres answered `22003 numeric
    // field value out of range`, failing the WHOLE bulk run on one bad row in a
    // pasted list — the opposite of the per-row `skipped` this method promises.
    // Dropping the branch is not a narrowing: no row's `telegramId` can equal a
    // value the column cannot store, and the id / email / login branches below
    // still run.
    const telegramId = parseTelegramId(trimmed);
    const handle = trimmed.replace(/^@+/, '');

    return this.prismaService.user.findFirst({
      where: {
        OR: [
          { id: trimmed },
          ...(telegramId !== null ? [{ telegramId }] : []),
          { email: { equals: trimmed, mode: 'insensitive' as const } },
          ...(handle.length > 0
            ? [{ webAccount: { login: { equals: handle, mode: 'insensitive' as const } } }]
            : []),
        ],
      },
      select: { id: true, telegramId: true, isBlocked: true },
    });
  }

  // ── Per-row dispatch ────────────────────────────────────────────────────

  private async dispatchOne(
    token: string,
    input: BulkUserOperationInputInterface,
    batchId: string,
  ): Promise<BulkUserOperationItemResultInterface> {
    // The result item always reports the ORIGINAL token so operators can map
    // outcomes back to the exact list they pasted (CUID / TG ID / email / login).
    const userId = token;
    const user = await this.resolveUser(token);
    if (!user) {
      return { userId, status: 'skipped', message: 'User not found' };
    }

    switch (input.action) {
      case 'block':
        // ALREADY BLOCKED IS NOT A REASON TO STAND DOWN, and treating it as one
        // made a half-executed ban impossible to finish.
        //
        // `block()` writes the flag FIRST — deliberately, so an unreachable
        // panel cannot lose it — and then captures identities, devices and the
        // address before pushing the VPN state. Any of those later steps can
        // throw. The account is then flagged with nothing listed, an ACTIVE
        // panel profile and live connections; the row reports `error`; and the
        // operator's obvious move, re-running the batch, answered
        // "skipped — Already blocked" and left the tunnel up.
        //
        // Re-running is safe: the flag write is idempotent, a duplicate
        // blocklist entry is reported as a duplicate rather than an error, and
        // a second sync job supersedes the first.
        //
        // The same act as the user card performs, through the same service.
        // Two inline `is_blocked` updates is exactly how the two screens came
        // to disagree about what a ban does.
        await this.userBlockService.block({
          userId: user.id,
          adminId: input.currentAdmin.id,
        });
        await this.recordOperatorRow(BULK_AUDIT_ACTION.block, input, batchId, user);
        this.events.warn(EVENT_TYPES.USER_BLOCKED, 'USER', `User bulk-blocked: ${user.id}`, {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.currentAdmin.id,
          batchId,
          source: BULK_AUDIT_SOURCE,
        });
        return { userId, status: 'ok' };

      case 'unblock':
        if (!user.isBlocked) return { userId, status: 'skipped', message: 'Already unblocked' };
        await this.userBlockService.unblock({
          userId: user.id,
          adminId: input.currentAdmin.id,
        });
        await this.recordOperatorRow(BULK_AUDIT_ACTION.unblock, input, batchId, user);
        this.events.info(EVENT_TYPES.USER_UNBLOCKED, 'USER', `User bulk-unblocked: ${user.id}`, {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.currentAdmin.id,
          batchId,
          source: BULK_AUDIT_SOURCE,
        });
        return { userId, status: 'ok' };

      case 'delete':
        // The audit row goes AFTER the deletion boundary returns, never before:
        // a row for a deletion that threw would answer "who deleted this" about
        // an account that is still there. A row that is never written for a
        // deletion that landed is the defect this whole block exists to fix, so
        // the ordering is one way round only.
        await this.userDeletionService.deleteUser(user.id);
        await this.recordOperatorRow(BULK_AUDIT_ACTION.delete, input, batchId, user);
        this.events.warn(EVENT_TYPES.USER_DELETED, 'USER', 'User account deleted', {
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
          adminId: input.currentAdmin.id,
          batchId,
          source: BULK_AUDIT_SOURCE,
        });
        return { userId, status: 'ok' };

      case 'set_language': {
        const lang = String(input.payload?.['language'] ?? '').toUpperCase();
        if (!lang || lang.length < 2 || lang.length > 4) {
          return { userId, status: 'skipped', message: 'Missing or invalid language' };
        }
        try {
          await this.prismaService.user.update({
            where: { id: user.id },
            data: { language: lang as never },
          });
          // AFTER the update, like every other branch here: the log records
          // what was done, so a throw above leaves nothing behind.
          await this.recordOperatorRow(BULK_AUDIT_ACTION.set_language, input, batchId, user, {
            changes: ['language'],
            language: lang,
          });
          return { userId, status: 'ok' };
        } catch (err) {
          return { userId, status: 'error', message: (err as Error).message };
        }
      }

      case 'set_max_subscriptions': {
        const value = Number(input.payload?.['maxSubscriptions']);
        if (!Number.isFinite(value) || value < 1 || value > 50) {
          return { userId, status: 'skipped', message: 'maxSubscriptions must be 1..50' };
        }
        const maxSubscriptions = Math.floor(value);
        await this.prismaService.user.update({
          where: { id: user.id },
          data: { maxSubscriptions },
        });
        await this.recordOperatorRow(
          BULK_AUDIT_ACTION.set_max_subscriptions,
          input,
          batchId,
          user,
          { changes: ['maxSubscriptions'], maxSubscriptions },
        );
        return { userId, status: 'ok' };
      }


      // ── Panel-backed actions ────────────────────────────────────────────
      //
      // All four operate on the user's LIVE subscriptions and all four report
      // `skipped` for an account with none. That is the honest answer: the
      // action did not fail, there was nothing to apply it to, and reporting
      // `ok` would tell an operator their reset reached a hundred profiles
      // when it reached six.

      case 'reset_traffic': {
        const outcome = await this.forEachPanelProfile(user.id, async (identity) => {
          await this.remnawaveApiService?.resetPanelUserTraffic(identity);
        });
        if (outcome.attempted === 0) {
          return { userId, status: 'skipped', message: outcome.reason };
        }
        await this.recordOperatorRow(BULK_AUDIT_ACTION.reset_traffic, input, batchId, user, {
          profiles: outcome.succeeded,
          failed: outcome.failed,
        });
        return outcome.failed === 0
          ? { userId, status: 'ok' }
          : {
              userId,
              status: 'error',
              message: `${outcome.failed} of ${outcome.attempted} profiles failed`,
            };
      }

      case 'revoke_devices': {
        const outcome = await this.forEachPanelProfile(user.id, async (identity, era) => {
          await this.remnawaveApiService?.deleteAllPanelUserDevices(identity, era);
        });
        if (outcome.attempted === 0) {
          return { userId, status: 'skipped', message: outcome.reason };
        }
        await this.recordOperatorRow(BULK_AUDIT_ACTION.revoke_devices, input, batchId, user, {
          profiles: outcome.succeeded,
          failed: outcome.failed,
        });
        return outcome.failed === 0
          ? { userId, status: 'ok' }
          : {
              userId,
              status: 'error',
              message: `${outcome.failed} of ${outcome.attempted} profiles failed`,
            };
      }

      case 'resync_profiles': {
        // A QUEUED job, not a direct push. The point of this action is to
        // repair drift after the panel was unreachable, so doing it with a
        // call that needs the panel to be reachable right now would fail
        // exactly when it is wanted.
        const subscriptions = await this.loadLinkedSubscriptions(user.id);
        if (subscriptions.length === 0) {
          return { userId, status: 'skipped', message: 'No linked VPN profiles' };
        }
        for (const subscription of subscriptions) {
          const job = await this.prismaService.profileSyncJob.create({
            data: {
              subscriptionId: subscription.id,
              action: SyncAction.UPDATE,
              status: SyncJobStatus.PENDING,
              payload: { source: 'BULK_RESYNC', propagateStatus: false } as Prisma.InputJsonObject,
            },
            select: { id: true },
          });
          // A job row with nothing enqueued is picked up by the sweep minutes
          // later, so a failure to enqueue is a DELAY and not a loss — which is
          // exactly why it must not abort the loop and take the audit row with
          // it. Without this the work still happened (the rows are durable) and
          // the operator trail said nothing at all.
          try {
            await this.profileSyncQueue?.enqueue(job.id);
          } catch (err) {
            this.logger.warn(
              `Bulk resync: job ${job.id} was written but not enqueued; the sweep will run it ` +
                `(${(err as Error).message})`,
            );
          }
        }
        await this.recordOperatorRow(BULK_AUDIT_ACTION.resync_profiles, input, batchId, user, {
          profiles: subscriptions.length,
        });
        return { userId, status: 'ok' };
      }

      case 'extend_subscription': {
        const days = Number(input.payload?.['days']);
        if (!Number.isFinite(days) || days < 1 || days > 365) {
          return { userId, status: 'skipped', message: 'days must be 1..365' };
        }
        const wholeDays = Math.floor(days);
        const subscriptions = await this.loadLiveSubscriptions(user.id);
        if (subscriptions.length === 0) {
          return { userId, status: 'skipped', message: 'No live subscriptions' };
        }
        const now = new Date();
        let extended = 0;
        // WHAT ACTUALLY LANDED IS RECORDED EVEN WHEN THE REST DID NOT.
        //
        // This loop had no per-subscription guard, so a throw on the second of
        // three rows propagated out, the row was reported `error`, and the
        // FIRST subscription was already extended in the database with no audit
        // evidence at all. The operator then re-runs that id — and the first
        // subscription gets the days twice while the trail says once.
        //
        // The two panel actions beside this one already count per profile and
        // report what succeeded; extension was the one that did not.
        let failure: Error | null = null;
        for (const subscription of subscriptions) {
          if (failure !== null) break;
          try {
          // Measured from NOW when the subscription has already lapsed, and
          // from its own expiry when it has not. Adding to a date in the past
          // would hand somebody three days that expired last week, which is
          // the opposite of what a compensation is for.
          const from =
            subscription.expiresAt === null || subscription.expiresAt < now
              ? now
              : subscription.expiresAt;
          const expiresAt = new Date(from.getTime() + wholeDays * 24 * 60 * 60 * 1000);
          await this.prismaService.subscription.update({
            where: { id: subscription.id },
            data: {
              expiresAt,
              // A lapsed subscription comes back to life. Without this the
              // customer keeps a longer expiry on a row the product still
              // treats as finished.
              ...(subscription.status === SubscriptionStatus.EXPIRED
                ? { status: SubscriptionStatus.ACTIVE }
                : {}),
            },
          });
          if (subscription.remnawaveId !== null) {
            const job = await this.prismaService.profileSyncJob.create({
              data: {
                subscriptionId: subscription.id,
                action: SyncAction.UPDATE,
                status: SyncJobStatus.PENDING,
                // The status IS propagated here, unlike the resync: a row
                // brought back from EXPIRED has to be re-enabled upstream or
                // the customer has a longer expiry and no VPN.
                payload: {
                  source: 'BULK_EXTEND',
                  propagateStatus: true,
                } as Prisma.InputJsonObject,
              },
              select: { id: true },
            });
            await this.profileSyncQueue?.enqueue(job.id);
          }
          extended += 1;
          } catch (err) {
            // Remembered, not rethrown: the audit row below has to be written
            // for the subscriptions that DID move before this one failed.
            failure = err as Error;
          }
        }
        // Written whenever anything changed, success or not. An audit trail
        // that records only complete runs is one that quietly loses every
        // partial one — and a partial run is exactly the state somebody has to
        // reconstruct later.
        if (extended > 0) {
          await this.recordOperatorRow(
            BULK_AUDIT_ACTION.extend_subscription,
            input,
            batchId,
            user,
            {
              days: wholeDays,
              subscriptions: extended,
              // Present only when the run fell short, so a complete row keeps
              // exactly the shape it always had.
              ...(failure !== null ? { partial: true, of: subscriptions.length } : {}),
            },
          );
        }
        if (failure !== null) {
          return {
            userId,
            status: 'error',
            // The count is in the message because it is what decides whether a
            // re-run is safe: re-running this id extends those rows again.
            message: `Extended ${extended} of ${subscriptions.length} subscriptions, then failed: ${failure.message}`,
          };
        }
        return { userId, status: 'ok' };
      }

      default: {
        const exhaustive: never = input.action;
        return { userId, status: 'error', message: `Unknown action: ${String(exhaustive)}` };
      }
    }
  }

  /**
   * The operator record for ONE user this run actually changed.
   *
   * Called only from a branch that has already mutated the row, so a skipped
   * row (already blocked, nothing resolved) and a failed row leave nothing
   * behind: the log records what was DONE. What was attempted is in the
   * response body and in the run's summary event.
   */
  private async recordOperatorRow(
    action: string,
    input: BulkUserOperationInputInterface,
    batchId: string,
    user: { readonly id: string; readonly telegramId: bigint | null },
    /**
     * Extra metadata for actions whose single-user counterpart carries more
     * than the subject id — `user.profile.updated` and its `changes` array.
     * Spread LAST would let a caller overwrite `userId` or `source` and break
     * the one query this whole block exists to answer, so it is spread FIRST
     * and the fixed keys win.
     */
    extraMetadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: buildAdminAuditLogData({
        action,
        actorId: input.currentAdmin.id,
        requestMetadata: input.requestMetadata,
        metadata: {
          ...extraMetadata,
          requestId: input.requestMetadata.requestId,
          source: BULK_AUDIT_SOURCE,
          batchId,
          userId: user.id,
          telegramId: user.telegramId?.toString() ?? null,
        },
      }),
    });
  }
}

function emptyResult(action: BulkUserAction, startedAt: Date): BulkUserOperationResultInterface {
  return {
    action,
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    items: [],
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
}
