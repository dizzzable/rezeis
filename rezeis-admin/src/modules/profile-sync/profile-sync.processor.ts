import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EffectiveProjectionState, Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../common/services/system-events.service';
import { resolveAddOnRolloutFlags } from '../add-on-entitlements/add-on-rollout.config';
import { RemnawaveApiService } from '../remnawave/services/remnawave-api.service';
import { PROFILE_SYNC_CONCURRENCY, PROFILE_SYNC_QUEUE } from './profile-sync.constants';
import { ProfileSyncQueueService } from './profile-sync-queue.service';
import { RemnawaveProfileNamingService } from './remnawave-profile-naming.service';

interface ProfileSyncJobData {
  readonly syncJobId: string;
}

/**
 * BullMQ processor that executes Remnawave profile mutations described by
 * `ProfileSyncJob` rows. Each job:
 *  1. Marks the row as RUNNING
 *  2. Calls the appropriate Remnawave API method
 *  3. Updates the subscription with the returned `remnawaveId` / `configUrl`
 *  4. Marks the row as COMPLETED (or FAILED on error)
 *
 * Donor parity: altshop `src/infrastructure/taskiq/tasks/remnawave.py`.
 */
@Processor(PROFILE_SYNC_QUEUE, { concurrency: PROFILE_SYNC_CONCURRENCY })
export class ProfileSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ProfileSyncProcessor.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly namingService: RemnawaveProfileNamingService,
    private readonly events: SystemEventsService,
    private readonly profileSyncQueueService?: ProfileSyncQueueService,
  ) {
    super();
  }

  public async process(job: Job<ProfileSyncJobData>): Promise<void> {
    const { syncJobId } = job.data;

    const syncJob = await this.prismaService.profileSyncJob.findUnique({
      where: { id: syncJobId },
      include: {
        subscription: {
          select: {
            id: true,
            userId: true,
            remnawaveId: true,
            trafficLimit: true,
            deviceLimit: true,
            internalSquads: true,
            externalSquad: true,
            expiresAt: true,
            planSnapshot: true,
          },
        },
      },
    });

    if (syncJob === null) {
      this.logger.warn(`Sync job ${syncJobId} not found — skipping`);
      return;
    }

    if (syncJob.status === SyncJobStatus.COMPLETED || syncJob.supersededAt != null) {
      return;
    }

    // ── Versioned convergence guard (T-009a, flag-gated) ──────────────────
    // A versioned job (carries aggregateKey + desiredRevision) must only push
    // the LATEST desired state. If the authoritative projection has already
    // advanced past this job's revision, this job is stale: supersede it (no
    // upstream write) so an out-of-order older revision can never overwrite a
    // newer one. Non-versioned jobs and the flag-off path are untouched.
    if (await this.supersedeIfStaleRevision(syncJob)) {
      return;
    }

    // Claim only work that deletion has not superseded since the initial read.
    const claimed = await this.prismaService.profileSyncJob.updateMany({
      where: {
        id: syncJobId,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
        supersededAt: null,
      },
      data: {
        status: SyncJobStatus.RUNNING,
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return;
    }

    try {
      switch (syncJob.action) {
        case SyncAction.CREATE:
          await this.handleCreate(syncJob);
          break;
        case SyncAction.UPDATE:
          await this.handleUpdate(syncJob);
          break;
        case SyncAction.DELETE:
          await this.handleDelete(syncJob);
          break;
        case SyncAction.TRAFFIC_RESET:
          await this.handleTrafficReset(syncJob);
          break;
        default:
          this.logger.warn(`Unknown sync action: ${syncJob.action}`);
      }

      const completed = await this.prismaService.profileSyncJob.updateMany({
        where: {
          id: syncJobId,
          status: SyncJobStatus.RUNNING,
          supersededAt: null,
        },
        data: { status: SyncJobStatus.COMPLETED, completedAt: new Date() },
      });
      if (completed.count !== 1) {
        return;
      }

      // Converge: now that the latest desired revision has been applied,
      // supersede any older-revision, non-terminal versioned sibling jobs for
      // the same aggregate so they never re-push a stale state upstream.
      await this.supersedeOlderSiblings(syncJob);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Sync job ${syncJobId} failed (attempt ${syncJob.attempts + 1}): ${errorMessage}`,
      );
      await this.prismaService.profileSyncJob.update({
        where: { id: syncJobId },
        data: {
          status: SyncJobStatus.FAILED,
          lastError: errorMessage,
        },
      });
      // Emit error event
      this.events.error(EVENT_TYPES.SYSTEM_ERROR, 'SYSTEM', `Profile sync failed: ${errorMessage}`, {
        syncJobId,
        action: syncJob.action,
        subscriptionId: syncJob.subscription.id,
        attempt: syncJob.attempts + 1,
      });
      throw err; // Let BullMQ retry
    }
  }

  /**
   * Versioned desired-state write (T-009/T-010). Returns `true` when it fully
   * handled the update (caller stops). Flag-gated by `projectionSync` and only
   * for versioned jobs (aggregateKey + desiredRevision) with an existing panel
   * profile and projection. Uses the STRICT adapter: absolute limit PATCH →
   * strict read-back → advance `lastAppliedRevision` only on equality (else
   * record drift and throw so BullMQ retries / the sweep re-drives). Transient
   * panel failures throw (retry); returns `false` to fall back to the legacy
   * absolute update otherwise.
   */
  private async tryVersionedDesiredStateWrite(syncJob: SyncJobRecord): Promise<boolean> {
    if (!resolveAddOnRolloutFlags().projectionSync) return false;
    if (syncJob.aggregateKey === null || syncJob.desiredRevision === null) return false;
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId === null) return false;

    const projection = await this.prismaService.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId: subscription.id },
      select: { desiredRevision: true, desiredTrafficLimitBytes: true, desiredDeviceLimit: true },
    });
    if (projection === null) return false;

    const setOutcome = await this.remnawaveApiService.strictSetUserLimits(subscription.remnawaveId, {
      trafficLimitBytes: projection.desiredTrafficLimitBytes,
      hwidDeviceLimit: projection.desiredDeviceLimit,
    });
    if (setOutcome.kind === 'unavailable') {
      throw new Error('Remnawave unavailable during desired-state PATCH');
    }
    if (setOutcome.kind !== 'ok') {
      throw new Error(`Strict desired-state PATCH failed: ${setOutcome.kind}`);
    }

    const readOutcome = await this.remnawaveApiService.strictGetPanelUser(subscription.remnawaveId);
    if (readOutcome.kind === 'unavailable') {
      throw new Error('Remnawave unavailable during desired-state read-back');
    }
    if (readOutcome.kind !== 'ok') {
      throw new Error(`Strict desired-state read-back failed: ${readOutcome.kind}`);
    }

    const bigintEq = (left: bigint | null, right: bigint | null): boolean =>
      left === null ? right === null : right !== null && left === right;
    const matches =
      bigintEq(readOutcome.value.trafficLimitBytes, projection.desiredTrafficLimitBytes) &&
      readOutcome.value.hwidDeviceLimit === projection.desiredDeviceLimit;
    const now = new Date();

    if (matches) {
      // Advance applied revision only for THIS revision (guarded so a concurrent
      // newer projection is never stamped applied by a stale write).
      await this.prismaService.subscriptionEffectiveProjection.updateMany({
        where: { subscriptionId: subscription.id, desiredRevision: projection.desiredRevision },
        data: {
          state: EffectiveProjectionState.APPLIED,
          lastAppliedRevision: projection.desiredRevision,
          lastAppliedAt: now,
          observedTrafficLimitBytes: readOutcome.value.trafficLimitBytes,
          observedDeviceLimit: readOutcome.value.hwidDeviceLimit,
          observedAt: now,
          observedContractVersion: readOutcome.detectedVersion,
          driftClass: null,
        },
      });
      this.logger.log(
        `Applied desired revision ${projection.desiredRevision} for subscription ${subscription.id}`,
      );
      return true;
    }

    await this.prismaService.subscriptionEffectiveProjection.updateMany({
      where: { subscriptionId: subscription.id, desiredRevision: projection.desiredRevision },
      data: {
        state: EffectiveProjectionState.DRIFTED,
        observedTrafficLimitBytes: readOutcome.value.trafficLimitBytes,
        observedDeviceLimit: readOutcome.value.hwidDeviceLimit,
        observedAt: now,
        observedContractVersion: readOutcome.detectedVersion,
        driftClass: 'LIMIT_MISMATCH',
      },
    });
    throw new Error(`Desired-state drift after read-back for subscription ${subscription.id}`);
  }

  /**
   * Versioned-convergence stale check (flag-gated by `projectionSync`).
   *
   * Returns `true` when the job was superseded (caller must stop). A job is
   * stale when it carries a `desiredRevision` for its `aggregateKey` but the
   * authoritative {@link SubscriptionEffectiveProjection} has already advanced
   * past it — applying it would push an out-of-order older desired state.
   * Non-versioned jobs (no aggregateKey/revision) and the flag-off path always
   * return `false` (legacy behavior, no projection read).
   */
  private async supersedeIfStaleRevision(syncJob: SyncJobRecord): Promise<boolean> {
    if (!resolveAddOnRolloutFlags().projectionSync) return false;
    const aggregateKey = syncJob.aggregateKey;
    const jobRevision = syncJob.desiredRevision;
    if (aggregateKey === null || jobRevision === null) return false;

    const projection = await this.prismaService.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId: aggregateKey },
      select: { desiredRevision: true },
    });
    if (projection === null || projection.desiredRevision <= jobRevision) {
      // Not stale by revision — but a queued retirement (DELETE) for the same
      // aggregate takes priority over a CREATE/UPDATE/TRAFFIC_RESET push: the
      // profile is about to be removed, so applying a limit is wrong. DELETE
      // jobs themselves are never blocked here.
      if (syncJob.action !== SyncAction.DELETE && (await this.hasPendingDelete(aggregateKey))) {
        await this.markSuperseded(syncJob.id, 'SUPERSEDED_BY_DELETE');
        return true;
      }
      return false;
    }

    await this.markSuperseded(syncJob.id, 'SUPERSEDED_BY_REVISION');
    this.logger.log(
      `Superseded stale profile-sync job ${syncJob.id} (revision ${jobRevision} < projection ${projection.desiredRevision}) for aggregate ${aggregateKey}`,
    );
    return true;
  }

  /** True when a non-terminal DELETE job exists for the aggregate's subscription. */
  private async hasPendingDelete(subscriptionId: string): Promise<boolean> {
    const pendingDeletes = await this.prismaService.profileSyncJob.findMany({
      where: {
        subscriptionId,
        action: SyncAction.DELETE,
        supersededAt: null,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING, SyncJobStatus.FAILED] },
      },
      select: { id: true },
      take: 1,
    });
    return pendingDeletes.length > 0;
  }

  /** Terminal supersession via `supersededAt` (no dedicated enum value). */
  private async markSuperseded(syncJobId: string, cause: string): Promise<void> {
    await this.prismaService.profileSyncJob.updateMany({
      where: {
        id: syncJobId,
        supersededAt: null,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
      },
      data: {
        supersededAt: new Date(),
        status: SyncJobStatus.COMPLETED,
        cause,
      },
    });
  }

  /**
   * After the latest desired revision is applied, mark every older-revision,
   * non-terminal versioned sibling for the same aggregate as superseded so a
   * queued or previously-failed stale revision never re-pushes upstream. No-op
   * for non-versioned jobs and when the flag is off.
   */
  private async supersedeOlderSiblings(syncJob: SyncJobRecord): Promise<void> {
    if (!resolveAddOnRolloutFlags().projectionSync) return;
    const aggregateKey = syncJob.aggregateKey;
    const jobRevision = syncJob.desiredRevision;
    if (aggregateKey === null || jobRevision === null) return;

    await this.prismaService.profileSyncJob.updateMany({
      where: {
        aggregateKey,
        desiredRevision: { lt: jobRevision },
        supersededAt: null,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
      },
      data: {
        supersededAt: new Date(),
        status: SyncJobStatus.COMPLETED,
        cause: 'SUPERSEDED_BY_REVISION',
      },
    });
  }

  private async handleCreate(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId !== null) {
      // Already provisioned — treat as update instead
      await this.handleUpdate(syncJob);
      return;
    }

    // Generate profile name using the naming service
    const naming = await this.namingService.generateProfileName(
      subscription.userId,
      subscription.id,
    );
    const contacts = await this.namingService.getContactInfo(subscription.userId);

    // Read plan snapshot for squads/limits
    const planSnapshot = readRecord(subscription.planSnapshot);
    const tag = readOptionalString(planSnapshot, 'tag');
    const trafficLimitStrategy = readOptionalString(planSnapshot, 'trafficLimitStrategy');

    // Calculate expiry as ISO string
    const expireAt = subscription.expiresAt?.toISOString() ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Idempotency guard: a prior attempt may have created the panel profile
    // but failed to persist the link (e.g. crash between API call and DB
    // write, or a duplicate-name retry). Reuse the existing profile instead
    // of re-creating it — the panel rejects duplicate usernames with 400.
    const existing = await this.remnawaveApiService.getPanelUserByUsername(naming.username);
    if (existing !== null && typeof existing.uuid === 'string' && existing.uuid.length > 0) {
      const deleteScheduled = await this.persistProfileLink(
        subscription.id,
        existing.uuid,
        existing.subscriptionUrl,
      );
      if (deleteScheduled) {
        await this.enqueueCompensatingDelete(deleteScheduled);
        this.logger.warn(
          `Subscription ${subscription.id} was deleted while CREATE ran; scheduled deletion of linked profile '${existing.uuid}'`,
        );
        return;
      }
      this.logger.log(
        `Linked existing Remnawave profile '${existing.uuid}' (username: ${naming.username}) to subscription ${subscription.id}`,
      );
      this.events.info(EVENT_TYPES.SUBSCRIPTION_CREATED, 'SUBSCRIPTION', `Remnawave profile linked: ${naming.username}`, {
        subscriptionId: subscription.id,
        userId: subscription.userId,
        remnawaveId: existing.uuid,
        remnawaveUsername: naming.username,
      });
      return;
    }

    // Create user on Remnawave panel
    const panelUser = await this.remnawaveApiService.createPanelUser({
      username: naming.username,
      telegramId: contacts.telegramId ? Number(contacts.telegramId) : null,
      email: contacts.email,
      description: naming.description,
      tag,
      expireAt,
      trafficLimitBytes: (subscription.trafficLimit ?? 0) * 1024 * 1024 * 1024, // GB → bytes
      hwidDeviceLimit: toPanelDeviceLimit(subscription.deviceLimit),
      trafficLimitStrategy,
      activeInternalSquads: subscription.internalSquads,
      externalSquadUuid: subscription.externalSquad,
    });

    const deleteScheduled = await this.persistProfileLink(
      subscription.id,
      panelUser.uuid,
      panelUser.subscriptionUrl,
    );
    if (deleteScheduled) {
      await this.enqueueCompensatingDelete(deleteScheduled);
      this.logger.warn(
        `Subscription ${subscription.id} was deleted while CREATE ran; scheduled deletion of new profile '${panelUser.uuid}'`,
      );
      return;
    }

    this.logger.log(
      `Created Remnawave profile '${panelUser.uuid}' (username: ${naming.username}) for subscription ${subscription.id}`,
    );

    // Emit event
    this.events.info(EVENT_TYPES.SUBSCRIPTION_CREATED, 'SUBSCRIPTION', `Remnawave profile created: ${naming.username}`, {
      subscriptionId: subscription.id,
      userId: subscription.userId,
      remnawaveId: panelUser.uuid,
      remnawaveUsername: naming.username,
    });
  }

  private async persistProfileLink(
    subscriptionId: string,
    remnawaveId: string,
    configUrl: string | null | undefined,
  ): Promise<string | null> {
    return this.prismaService.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: SubscriptionStatus }>>(Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "subscriptions"
        WHERE "id" = ${subscriptionId}
        FOR UPDATE
      `);
      const current = rows[0];
      if (current === undefined) {
        throw new Error(`Subscription ${subscriptionId} disappeared during profile CREATE`);
      }

      await tx.subscription.update({
        where: { id: subscriptionId },
        data: { remnawaveId, configUrl },
      });
      if (current.status !== SubscriptionStatus.ACTIVE) {
        const deleteJobId = await this.createDeleteJobIfMissing(tx, subscriptionId, remnawaveId);
        if (deleteJobId !== null) {
          return deleteJobId;
        }
      }

      return null;
    });
  }

  private async handleUpdate(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId === null) {
      this.logger.warn(
        `Cannot update: subscription ${subscription.id} has no remnawaveId`,
      );
      return;
    }

    // Versioned desired-state write (T-009/T-010, flag-gated): reread the
    // projection, PATCH the absolute latest limits via the STRICT adapter,
    // strictly read the user back and advance the applied revision only on
    // equality. Falls back to the legacy absolute update when not applicable.
    if (await this.tryVersionedDesiredStateWrite(syncJob)) {
      return;
    }

    const contacts = await this.namingService.getContactInfo(subscription.userId);
    const planSnapshot = readRecord(subscription.planSnapshot);
    const tag = readOptionalString(planSnapshot, 'tag');
    const trafficLimitStrategy = readOptionalString(planSnapshot, 'trafficLimitStrategy');
    // Rebuild the description so it reflects the user's current identity
    // (login / username / reiwa_id). This keeps the panel profile correct after
    // an account merge re-points the subscription to a different user. The
    // username is intentionally NOT changed (renaming risks 400 duplicate
    // collisions on the panel).
    const naming = await this.namingService.generateProfileName(subscription.userId, subscription.id);

    await this.remnawaveApiService.updatePanelUser(subscription.remnawaveId, {
      telegramId: contacts.telegramId ? Number(contacts.telegramId) : null,
      email: contacts.email,
      description: naming.description,
      tag,
      expireAt: subscription.expiresAt?.toISOString(),
      trafficLimitBytes: (subscription.trafficLimit ?? 0) * 1024 * 1024 * 1024,
      hwidDeviceLimit: toPanelDeviceLimit(subscription.deviceLimit),
      trafficLimitStrategy,
      activeInternalSquads: subscription.internalSquads,
      externalSquadUuid: subscription.externalSquad,
    });

    const deleteJobId = await this.ensureDeleteJobIfDeleted(
      subscription.id,
      subscription.remnawaveId,
    );
    if (deleteJobId !== null) {
      await this.enqueueCompensatingDelete(deleteJobId);
    }
    this.logger.log(
      `Updated Remnawave profile '${subscription.remnawaveId}' for subscription ${subscription.id}`,
    );
  }

  private async enqueueCompensatingDelete(syncJobId: string): Promise<void> {
    if (this.profileSyncQueueService === undefined) {
      return;
    }
    await this.profileSyncQueueService.enqueue(syncJobId);
  }

  private async ensureDeleteJobIfDeleted(
    subscriptionId: string,
    targetRemnawaveId: string | null,
  ): Promise<string | null> {
    if (targetRemnawaveId === null) {
      return null;
    }
    return this.prismaService.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: SubscriptionStatus }>>(Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "subscriptions"
        WHERE "id" = ${subscriptionId}
        FOR UPDATE
      `);
      if (rows[0]?.status === SubscriptionStatus.DELETED) {
        return this.createDeleteJobIfMissing(tx, subscriptionId, targetRemnawaveId);
      }
      return null;
    });
  }

  private async createDeleteJobIfMissing(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    targetRemnawaveId: string,
  ): Promise<string | null> {
    const existingDeletes = await tx.profileSyncJob.findMany({
      where: {
        subscriptionId,
        action: SyncAction.DELETE,
        status: {
          in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING, SyncJobStatus.FAILED],
        },
      },
      select: { id: true, payload: true },
    });
    if (existingDeletes.some((job) => readTargetRemnawaveId(job.payload) === targetRemnawaveId)) {
      return null;
    }
    const deleteJob = await tx.profileSyncJob.create({
      data: {
        subscriptionId,
        action: SyncAction.DELETE,
        status: SyncJobStatus.PENDING,
        payload: {
          source: 'CREATE_COMPLETED_AFTER_DELETE',
          targetRemnawaveId,
        } as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return deleteJob.id;
  }

  private async handleDelete(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    const targetRemnawaveId =
      readTargetRemnawaveId(syncJob.payload) ?? subscription.remnawaveId;
    if (targetRemnawaveId === null) {
      return;
    }

    const result = await this.remnawaveApiService.deletePanelUser(targetRemnawaveId);
    if (result.isDeleted) {
      this.logger.log(
        `Deleted Remnawave profile '${targetRemnawaveId}' for subscription ${subscription.id}`,
      );
      // Fully retire the subscription: mark it DELETED and detach the now-gone
      // panel profile. The row is kept (soft-delete) so trial-claim history via
      // `isTrial` survives — trial counts include DELETED rows, so a user can
      // never re-claim a free trial or exceed a paid-trial limit just because
      // their old subscription was cleaned off. `status = DELETED` removes it
      // from the cabinet/bot (the internal list filters `status != DELETED`)
      // and blocks renewal (renewal filters `status != DELETED`), matching the
      // grace-window contract: EXPIRED stays renewable for `graceDays`, then the
      // sweep cleans it here. Self-service/admin deletes already set DELETED
      // before enqueuing, so this is idempotent for them.
      // See `.kiro/specs/trial-aware-profile-cleanup`.
      await this.prismaService.subscription.updateMany({
        where: { id: subscription.id, remnawaveId: targetRemnawaveId },
        data: { remnawaveId: null, status: SubscriptionStatus.DELETED },
      });
    } else {
      throw new Error(
        `Panel did not confirm deletion of Remnawave profile '${targetRemnawaveId}'`,
      );
    }
  }

  private async handleTrafficReset(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId === null) {
      return;
    }

    await this.remnawaveApiService.resetPanelUserTraffic(subscription.remnawaveId);
    const deleteJobId = await this.ensureDeleteJobIfDeleted(
      subscription.id,
      subscription.remnawaveId,
    );
    if (deleteJobId !== null) {
      await this.enqueueCompensatingDelete(deleteJobId);
    }
    this.logger.log(
      `Reset traffic for Remnawave profile '${subscription.remnawaveId}'`,
    );
  }
}

type SyncJobRecord = NonNullable<
  Awaited<
    ReturnType<PrismaService['profileSyncJob']['findUnique']>
  >
> & {
  subscription: {
    id: string;
    userId: string;
    remnawaveId: string | null;
    trafficLimit: number | null;
    deviceLimit: number;
    internalSquads: string[];
    externalSquad: string | null;
    expiresAt: Date | null;
    planSnapshot: unknown;
  };
};

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const candidate = record[key];
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return null;
}

function readTargetRemnawaveId(value: unknown): string | null {
  return readOptionalString(readRecord(value), 'targetRemnawaveId');
}

/**
 * Maps rezeis' device-limit convention to Remnawave's `hwidDeviceLimit`.
 *
 * In rezeis, `-1` or `null` means "unlimited devices". Remnawave validates
 * `hwidDeviceLimit >= 0` and treats `0` as unlimited, so a `-1`/null limit
 * MUST be sent as `0` — otherwise the panel rejects the create/update with
 * `400 "Device limit must be greater than 0"` and the profile is never
 * provisioned.
 */
function toPanelDeviceLimit(deviceLimit: number | null | undefined): number {
  if (deviceLimit === null || deviceLimit === undefined || deviceLimit < 0) {
    return 0;
  }
  return deviceLimit;
}
