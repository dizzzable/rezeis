import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  EffectiveProjectionState,
  Prisma,
  SubscriptionStatus,
  SubscriptionTermStatus,
  SyncAction,
  SyncJobStatus,
  TrafficLimitStrategy,
} from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../common/services/system-events.service';
import { resolveAddOnRolloutFlags } from '../add-on-entitlements/add-on-rollout.config';
import { RemnawaveApiService } from '../remnawave/services/remnawave-api.service';
import {
  PROFILE_SYNC_CONCURRENCY,
  PROFILE_SYNC_MAX_ATTEMPTS,
  PROFILE_SYNC_QUEUE,
} from './profile-sync.constants';
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

    const syncJob = await this.loadSyncJob(this.prismaService, syncJobId);

    if (syncJob === null) {
      this.logger.warn(`Sync job ${syncJobId} not found — skipping`);
      return;
    }

    if (syncJob.status === SyncJobStatus.COMPLETED || syncJob.supersededAt != null) {
      return;
    }


    // A versioned job (carries aggregateKey + desiredRevision) must only push
    // the LATEST desired state. If the authoritative projection has already
    // advanced past this job's revision, this job is stale: supersede it (no
    // upstream write) so an out-of-order older revision can never overwrite a
    // newer one. Non-versioned jobs and the flag-off path are untouched.
    if (await this.supersedeIfStaleRevision(syncJob)) {
      return;
    }

    // The timestamp is the lease token. Every terminal write must match it so
    // a stale worker cannot complete/fail a replacement lease after reclaim.
    const leaseStartedAt = new Date();
    const claimed = await this.prismaService.profileSyncJob.updateMany({
      where: {
        id: syncJobId,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
        supersededAt: null,
      },
      data: {
        status: SyncJobStatus.RUNNING,
        startedAt: leaseStartedAt,
        attempts: { increment: 1 },
        lastError: null,
        recoveryData: {},
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
          startedAt: leaseStartedAt,
        },
        data: {
          status: SyncJobStatus.COMPLETED,
          completedAt: new Date(),
          recoveryData: {},
        },
      });
      if (completed.count !== 1) {
        return;
      }

      // Converge: now that the latest desired revision has been applied,
      // supersede any older-revision, non-terminal versioned sibling jobs for
      // the same aggregate so they never re-push a stale state upstream.
      await this.supersedeOlderSiblings(syncJob);
    } catch (err: unknown) {
      const recorded = await this.recordFailure(this.prismaService, syncJob, err, leaseStartedAt);
      this.reportFailure(syncJob, err, recorded);
      throw err; // Let BullMQ retry
    }
  }

  private async loadSyncJob(
    client: Prisma.TransactionClient | PrismaService,
    syncJobId: string,
  ): Promise<SyncJobRecord | null> {
    return client.profileSyncJob.findUnique({
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
    }) as Promise<SyncJobRecord | null>;
  }
  private async recordFailure(
    client: Prisma.TransactionClient | PrismaService,
    syncJob: SyncJobRecord,
    error: unknown,
    leaseStartedAt: Date,
  ): Promise<boolean> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const classification = classifyRecovery(error);
    const failed = await client.profileSyncJob.updateMany({
      where: {
        id: syncJob.id,
        status: SyncJobStatus.RUNNING,
        supersededAt: null,
        startedAt: leaseStartedAt,
      },
      data: {
        status: SyncJobStatus.FAILED,
        lastError: errorMessage,
        recoveryData: { classification },
      },
    });
    return failed.count === 1;
  }

  private reportFailure(syncJob: SyncJobRecord, err: unknown, recorded: boolean): void {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const attempt = syncJob.attempts + 1;
    this.logger.error(
      `Sync job ${syncJob.id} failed (attempt ${attempt}): ${errorMessage}`,
    );
    if (!recorded) return;

    // Only surface a SYSTEM error to the operator for a GENUINE, non-transient
    // FINAL failure. A transient Remnawave outage is retryable and recoverable.
    const isFinalAttempt = attempt >= PROFILE_SYNC_MAX_ATTEMPTS;
    const isTransient = classifyRecovery(err) === 'TRANSIENT';
    if (isFinalAttempt && !isTransient) {
      this.events.error(EVENT_TYPES.SYSTEM_ERROR, 'SYSTEM', `Profile sync failed: ${errorMessage}`, {
        syncJobId: syncJob.id,
        action: syncJob.action,
        subscriptionId: syncJob.subscription.id,
        attempt,
      });
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
  private async tryVersionedDesiredStateWrite(
    syncJob: SyncJobRecord,
    client: Prisma.TransactionClient | PrismaService = this.prismaService,
  ): Promise<boolean> {
    if (!resolveAddOnRolloutFlags().projectionSync) return false;
    if (syncJob.aggregateKey === null || syncJob.desiredRevision === null) return false;
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId === null) return false;

    const projection = await client.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId: subscription.id },
      select: { desiredRevision: true, desiredTrafficLimitBytes: true, desiredDeviceLimit: true },
    });
    if (projection === null) return false;

    const planSnapshot = readRecord(subscription.planSnapshot);
    const setOutcome = await this.remnawaveApiService.strictSetUserLimits(subscription.remnawaveId, {
      trafficLimitBytes: projection.desiredTrafficLimitBytes,
      hwidDeviceLimit: projection.desiredDeviceLimit,
      tag: readOptionalString(planSnapshot, 'tag'),
      trafficLimitStrategy: readOptionalString(planSnapshot, 'trafficLimitStrategy'),
      activeInternalSquads: subscription.internalSquads,
      externalSquadUuid: subscription.externalSquad,
    });
    if (setOutcome.kind === 'unavailable') {
      throw new ServiceUnavailableException('Remnawave unavailable during desired-state PATCH');
    }
    if (setOutcome.kind !== 'ok') {
      throw new Error(`Strict desired-state PATCH failed: ${setOutcome.kind}`);
    }

    const readOutcome = await this.remnawaveApiService.strictGetPanelUser(subscription.remnawaveId);
    if (readOutcome.kind === 'unavailable') {
      throw new ServiceUnavailableException('Remnawave unavailable during desired-state read-back');
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
      await client.subscriptionEffectiveProjection.updateMany({
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
      const deleteJobId = await this.ensureDeleteJobIfDeleted(
        subscription.id,
        subscription.remnawaveId,
        readOutcome.value.createdAt,
        client,
      );
      if (deleteJobId !== null) {
        await this.enqueueCompensatingDelete(deleteJobId);
      }
      this.logger.log(
        `Applied desired revision ${projection.desiredRevision} for subscription ${subscription.id}`,
      );
      return true;
    }

    await client.subscriptionEffectiveProjection.updateMany({
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
  private async supersedeIfStaleRevision(
    syncJob: SyncJobRecord,
    client: Prisma.TransactionClient | PrismaService = this.prismaService,
  ): Promise<boolean> {
    if (!resolveAddOnRolloutFlags().projectionSync) return false;
    const aggregateKey = syncJob.aggregateKey;
    const jobRevision = syncJob.desiredRevision;
    if (aggregateKey === null || jobRevision === null) return false;

    const projection = await client.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId: aggregateKey },
      select: { desiredRevision: true },
    });
    if (projection === null || projection.desiredRevision <= jobRevision) {
      // Not stale by revision — but a queued retirement (DELETE) for the same
      // aggregate takes priority over a CREATE/UPDATE/TRAFFIC_RESET push: the
      // profile is about to be removed, so applying a limit is wrong. DELETE
      // jobs themselves are never blocked here.
      if (syncJob.action !== SyncAction.DELETE && (await this.hasPendingDelete(aggregateKey, client))) {
        await this.markSuperseded(syncJob.id, 'SUPERSEDED_BY_DELETE', client);
        return true;
      }
      return false;
    }

    await this.markSuperseded(syncJob.id, 'SUPERSEDED_BY_REVISION', client);
    this.logger.log(
      `Superseded stale profile-sync job ${syncJob.id} (revision ${jobRevision} < projection ${projection.desiredRevision}) for aggregate ${aggregateKey}`,
    );
    return true;
  }

  /** True when a non-terminal DELETE job exists for the aggregate's subscription. */
  private async hasPendingDelete(
    subscriptionId: string,
    client: Prisma.TransactionClient | PrismaService = this.prismaService,
  ): Promise<boolean> {
    const pendingDeletes = await client.profileSyncJob.findMany({
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
  private async markSuperseded(
    syncJobId: string,
    cause: string,
    client: Prisma.TransactionClient | PrismaService = this.prismaService,
  ): Promise<void> {
    await client.profileSyncJob.updateMany({
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
  private async supersedeOlderSiblings(
    syncJob: SyncJobRecord,
    client: Prisma.TransactionClient | PrismaService = this.prismaService,
  ): Promise<void> {
    if (!resolveAddOnRolloutFlags().projectionSync) return;
    const aggregateKey = syncJob.aggregateKey;
    const jobRevision = syncJob.desiredRevision;
    if (aggregateKey === null || jobRevision === null) return;

    await client.profileSyncJob.updateMany({
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
        existing.createdAt,
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
      panelUser.createdAt,
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
    panelCreatedAt: string | null | undefined,
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
      await this.stampMonthRollingAnchor(tx, subscriptionId, panelCreatedAt, current.status);
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
    let current = (await this.loadSyncJob(this.prismaService, syncJob.id)) ?? syncJob;

    // Versioned desired-state write (T-009/T-010, flag-gated) already rereads
    // the current projection and verifies a strict panel read-back.
    if (await this.tryVersionedDesiredStateWrite(current)) {
      return;
    }

    // Legacy absolute updates are external calls and must stay outside any DB
    // transaction. Converge after an out-of-order call by rereading the live
    // subscription after every write; if the desired state changed while the
    // request was in flight, immediately push the latest absolute state again.
    // A bounded loop fails retryably under continuous churn instead of holding
    // a database lock across HTTP or silently leaving stale panel state.
    for (let convergenceAttempt = 0; convergenceAttempt < 3; convergenceAttempt += 1) {
      const subscription = current.subscription;
      if (subscription.remnawaveId === null) {
        this.logger.warn(
          `Cannot update: subscription ${subscription.id} has no remnawaveId`,
        );
        return;
      }

      const desiredFingerprint = profileUpdateFingerprint(subscription);
      const contacts = await this.namingService.getContactInfo(subscription.userId);
      const planSnapshot = readRecord(subscription.planSnapshot);
      const tag = readOptionalString(planSnapshot, 'tag');
      const trafficLimitStrategy = readOptionalString(planSnapshot, 'trafficLimitStrategy');
      const naming = await this.namingService.generateProfileName(
        subscription.userId,
        subscription.id,
      );

      const panelUser = await this.remnawaveApiService.updatePanelUser(subscription.remnawaveId, {
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

      const latest = await this.loadSyncJob(this.prismaService, syncJob.id);
      if (latest === null) {
        throw new Error(`Profile sync job ${syncJob.id} disappeared during UPDATE`);
      }
      if (profileUpdateFingerprint(latest.subscription) !== desiredFingerprint) {
        current = latest;
        continue;
      }

      const deleteJobId = await this.ensureDeleteJobIfDeleted(
        subscription.id,
        subscription.remnawaveId,
        panelUser?.createdAt,
      );
      if (deleteJobId !== null) {
        await this.enqueueCompensatingDelete(deleteJobId);
      }
      this.logger.log(
        `Updated Remnawave profile '${subscription.remnawaveId}' for subscription ${subscription.id}`,
      );
      return;
    }

    throw new ServiceUnavailableException(
      `Subscription ${current.subscription.id} changed repeatedly during profile UPDATE`,
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
    panelCreatedAt?: string | null,
    client: Prisma.TransactionClient | PrismaService = this.prismaService,
  ): Promise<string | null> {
    if (targetRemnawaveId === null) {
      return null;
    }
    return client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: SubscriptionStatus }>>(Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "subscriptions"
        WHERE "id" = ${subscriptionId}
        FOR UPDATE
      `);
      if (rows[0]?.status === SubscriptionStatus.DELETED) {
        return this.createDeleteJobIfMissing(tx, subscriptionId, targetRemnawaveId);
      }
      await this.stampMonthRollingAnchor(
        tx,
        subscriptionId,
        panelCreatedAt,
        rows[0]?.status,
      );
      return null;
    });
  }

  private async stampMonthRollingAnchor(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    panelCreatedAt: string | null | undefined,
    subscriptionStatus: SubscriptionStatus | undefined,
  ): Promise<void> {
    if (subscriptionStatus !== SubscriptionStatus.ACTIVE || typeof panelCreatedAt !== 'string') {
      return;
    }
    const parsed = Date.parse(panelCreatedAt);
    if (!Number.isFinite(parsed)) return;

    await tx.subscriptionTerm.updateMany({
      where: {
        subscriptionId,
        status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
        trafficResetStrategy: TrafficLimitStrategy.MONTH_ROLLING,
      },
      data: { resetAnchorAt: new Date(parsed) },
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

function profileUpdateFingerprint(subscription: SyncJobRecord['subscription']): string {
  const planSnapshot = readRecord(subscription.planSnapshot);
  return JSON.stringify({
    userId: subscription.userId,
    remnawaveId: subscription.remnawaveId,
    trafficLimit: subscription.trafficLimit,
    deviceLimit: subscription.deviceLimit,
    internalSquads: subscription.internalSquads,
    externalSquad: subscription.externalSquad,
    expiresAt: subscription.expiresAt?.toISOString() ?? null,
    tag: readOptionalString(planSnapshot, 'tag'),
    trafficLimitStrategy: readOptionalString(planSnapshot, 'trafficLimitStrategy'),
  });
}

function classifyRecovery(error: unknown): 'TRANSIENT' | 'TERMINAL' {
  if (error instanceof ServiceUnavailableException) return 'TRANSIENT';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return /timeout|temporar|econn|429|502|503|504|unavailable/.test(message)
    ? 'TRANSIENT'
    : 'TERMINAL';
}

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
