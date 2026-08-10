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
import { createHash } from 'node:crypto';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../common/services/system-events.service';
import { resolveAddOnRolloutFlags } from '../add-on-entitlements/add-on-rollout.config';
import {
  RemnawaveApiService,
  RemnawaveProfileNotFoundError,
  RemnawaveUpstreamRejectionError,
} from '../remnawave/services/remnawave-api.service';
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
      const outcome = await this.recordFailure(this.prismaService, syncJob, err, leaseStartedAt);
      this.reportFailure(syncJob, err, outcome);
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
            remnawaveUserId: true,
            trafficLimit: true,
            deviceLimit: true,
            internalSquads: true,
            externalSquad: true,
            expiresAt: true,
            planSnapshot: true,
            status: true,
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
  ): Promise<FailureOutcome> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const classification = classifyRecovery(error, syncJob.createdAt);
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
    return { recorded: failed.count === 1, classification };
  }

  private reportFailure(syncJob: SyncJobRecord, err: unknown, outcome: FailureOutcome): void {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const attempt = syncJob.attempts + 1;
    this.logger.error(
      `Sync job ${syncJob.id} failed (attempt ${attempt}): ${errorMessage}`,
    );
    if (!outcome.recorded) return;

    // Only surface a SYSTEM error to the operator for a GENUINE, non-transient
    // FINAL failure. A transient Remnawave outage is retryable and recoverable.
    //
    // Uses the classification that was actually PERSISTED rather than
    // re-deriving it: schema drift flips TRANSIENT→TERMINAL as its grace window
    // expires, and a second call can land on the far side of that boundary. A
    // row written TERMINAL is dropped by the recovery sweep, so a disagreeing
    // alert decision would make the failure both permanent and silent.
    const isFinalAttempt = attempt >= PROFILE_SYNC_MAX_ATTEMPTS;
    if (isFinalAttempt && outcome.classification === 'TERMINAL') {
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
    const panelIdentifier = remnawaveUserIdentifier(subscription);
    if (panelIdentifier === null) return false;

    const projection = await client.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId: subscription.id },
      select: { desiredRevision: true, desiredTrafficLimitBytes: true, desiredDeviceLimit: true },
    });
    if (projection === null) return false;

    const planSnapshot = readRecord(subscription.planSnapshot);
    const setOutcome = await this.remnawaveApiService.strictSetUserLimits(panelIdentifier, {
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

    const readOutcome = await this.remnawaveApiService.strictGetPanelUser(panelIdentifier);
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
        panelIdentifier,
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
    if (remnawaveUserIdentifier(subscription) !== null) {
      // Already provisioned — treat as update instead
      await this.handleUpdate(syncJob);
      return;
    }

    // Generate profile name using the naming service.
    //
    // Clamped ONCE here, so the idempotency lookup below and the CREATE that
    // follows are guaranteed to use the same string. Clamping at either call
    // site alone would look up one name and create another.
    const naming = await this.namingService.generateProfileName(
      subscription.userId,
      subscription.id,
    );
    const panelUsername = clampPanelUsername(naming.username);
    if (panelUsername !== naming.username) {
      this.logger.warn(
        `Generated profile name '${naming.username}' exceeds Remnawave's ${PANEL_USERNAME_MAX_LENGTH}-character limit; using '${panelUsername}' for subscription ${subscription.id}`,
      );
    }
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
    const existing = await this.remnawaveApiService.getPanelUserByUsername(panelUsername);
    if (existing !== null && (existing.id !== null || (typeof existing.uuid === 'string' && existing.uuid.length > 0))) {
      // "A profile answers to this name" is not "this profile is mine" — see
      // `assertPanelProfileOwnership`.
      assertPanelProfileOwnership(panelUsername, existing.description, subscription.userId);
      const deleteScheduled = await this.persistProfileLink(
        subscription.id,
        existing.uuid,
        existing.id,
        existing.subscriptionUrl,
        existing.createdAt,
      );
      if (deleteScheduled) {
        await this.enqueueCompensatingDelete(deleteScheduled);
        this.logger.warn(
          `Subscription ${subscription.id} was deleted while CREATE ran; scheduled deletion of linked profile '${existing.id}'`,
        );
        return;
      }
      this.logger.log(
        `Linked existing Remnawave profile '${existing.id}' (username: ${panelUsername}) to subscription ${subscription.id}`,
      );
      this.events.info(EVENT_TYPES.SUBSCRIPTION_CREATED, 'SUBSCRIPTION', `Remnawave profile linked: ${panelUsername}`, {
        subscriptionId: subscription.id,
        userId: subscription.userId,
        remnawaveId: existing.uuid,
        remnawaveUserId: existing.id,
        remnawaveUsername: panelUsername,
      });
      return;
    }

    // Create user on Remnawave panel
    const panelUser = await this.remnawaveApiService.createPanelUser({
      username: panelUsername,
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
      panelUser.id,
      panelUser.subscriptionUrl,
      panelUser.createdAt,
    );
    if (deleteScheduled) {
      await this.enqueueCompensatingDelete(deleteScheduled);
      this.logger.warn(
        `Subscription ${subscription.id} was deleted while CREATE ran; scheduled deletion of new profile '${panelUser.id}'`,
      );
      return;
    }

    this.logger.log(
      `Created Remnawave profile '${panelUser.id}' (username: ${panelUsername}) for subscription ${subscription.id}`,
    );

    // Emit event
    this.events.info(EVENT_TYPES.SUBSCRIPTION_CREATED, 'SUBSCRIPTION', `Remnawave profile created: ${panelUsername}`, {
      subscriptionId: subscription.id,
      userId: subscription.userId,
      remnawaveId: panelUser.uuid,
      remnawaveUserId: panelUser.id,
      remnawaveUsername: panelUsername,
    });
  }

  private async persistProfileLink(
    subscriptionId: string,
    remnawaveId: string | null,
    remnawaveUserId: number | null,
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
        data: {
          remnawaveId,
          ...(remnawaveUserId !== null ? { remnawaveUserId } : {}),
          configUrl,
        },
      });
      await this.stampMonthRollingAnchor(tx, subscriptionId, panelCreatedAt, current.status);
      if (current.status !== SubscriptionStatus.ACTIVE) {
        const deleteTarget = remnawaveUserId !== null ? String(remnawaveUserId) : remnawaveId;
        const deleteJobId = deleteTarget === null ? null : await this.createDeleteJobIfMissing(tx, subscriptionId, deleteTarget);
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
      const panelIdentifier = remnawaveUserIdentifier(subscription);
      if (panelIdentifier === null) {
        // No panel link to update. This is reachable when a prior re-provision
        // detached a stale id (404) but its follow-up CREATE then failed
        // transiently: the job stays action=UPDATE and retries here. Silently
        // returning would mark the job COMPLETED and strand the ACTIVE
        // subscription with no profile forever. Delegate to CREATE instead —
        // it idempotently reuses a profile by username or provisions a fresh
        // one and re-links, and it is safe when no create is actually needed.
        this.logger.warn(
          `Subscription ${subscription.id} has no remnawaveId during UPDATE; provisioning via CREATE`,
        );
        await this.handleCreate(current);
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

      // Status is a separate panel field. It is intentionally forwarded only
      // for an explicit admin toggle; derived local states such as
      // EXPIRED/LIMITED must not overwrite Remnawave during routine syncs.
      //
      // Even under an explicit toggle the value forwarded is the DB column as
      // it reads NOW, not what the operator submitted — `AutoRenewService`
      // flips rows to EXPIRED every minute, so the column can have moved to a
      // value Remnawave's `enum: ["ACTIVE","DISABLED"]` rejects between the
      // admin write and this job running. `toPanelStatus` returns null for
      // exactly those, and null omits the field.
      const propagateStatus = readBoolean(readRecord(current.payload), 'propagateStatus');
      const panelStatus = propagateStatus ? toPanelStatus(subscription.status) : null;
      if (propagateStatus && panelStatus === null) {
        this.logger.warn(
          `Not propagating status '${subscription.status}' for subscription ${subscription.id}: Remnawave accepts only ACTIVE/DISABLED (expiry is derived from expireAt)`,
        );
      }

      let panelUser: Awaited<ReturnType<RemnawaveApiService['updatePanelUser']>>;
      try {
        panelUser = await this.remnawaveApiService.updatePanelUser(panelIdentifier, {
          telegramId: contacts.telegramId ? Number(contacts.telegramId) : null,
          email: contacts.email,
          description: naming.description,
          ...(panelStatus !== null ? { status: panelStatus } : {}),
          tag,
          expireAt: subscription.expiresAt?.toISOString(),
          trafficLimitBytes: (subscription.trafficLimit ?? 0) * 1024 * 1024 * 1024,
          hwidDeviceLimit: toPanelDeviceLimit(subscription.deviceLimit),
          trafficLimitStrategy,
          activeInternalSquads: subscription.internalSquads,
          externalSquadUuid: subscription.externalSquad,
        });
      } catch (err: unknown) {
        // The linked profile no longer exists on the panel (404). This is the
        // imported-subscription case: `remnawaveId` came from a donor dump but
        // the profile is gone from the currently connected panel, so a PATCH
        // can never land and the job would retry forever. Re-provision: detach
        // the stale id and fall through to CREATE, which idempotently reuses an
        // existing profile by username or creates a fresh one and re-links it.
        if (err instanceof RemnawaveProfileNotFoundError) {
          await this.reprovisionMissingProfile(subscription.id, panelIdentifier);
          const refreshed = await this.loadSyncJob(this.prismaService, syncJob.id);
          if (refreshed === null) {
            const missing = new Error(
              `Profile sync job ${syncJob.id} disappeared during UPDATE re-provision`,
            );
            (missing as Error & { cause?: unknown }).cause = err;
            throw missing;
          }
          this.logger.warn(
            `Remnawave profile for subscription ${subscription.id} was missing (404); re-provisioning via CREATE`,
          );
          await this.handleCreate(refreshed);
          return;
        }
        throw err;
      }

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
        panelIdentifier,
        panelUser?.createdAt,
      );
      if (deleteJobId !== null) {
        await this.enqueueCompensatingDelete(deleteJobId);
      }
      this.logger.log(
        `Updated Remnawave profile '${String(panelIdentifier)}' for subscription ${subscription.id}`,
      );
      return;
    }

    throw new ServiceUnavailableException(
      `Subscription ${current.subscription.id} changed repeatedly during profile UPDATE`,
    );
  }

  /**
   * Detaches a stale `remnawaveId` (and its `configUrl`) from a subscription
   * whose panel profile returned 404, so the subsequent CREATE re-provisions a
   * fresh profile. Fenced on the old id: if a concurrent write already
   * re-linked the row to a different profile, this is a no-op and that link
   * wins (we never clobber a newer link).
   */
  private async reprovisionMissingProfile(
    subscriptionId: string,
    staleRemnawaveId: number | string,
  ): Promise<void> {
    await this.prismaService.subscription.updateMany({
      where:
        typeof staleRemnawaveId === 'number'
          ? { id: subscriptionId, remnawaveUserId: staleRemnawaveId }
          : { id: subscriptionId, remnawaveId: staleRemnawaveId },
      data: { remnawaveId: null, remnawaveUserId: null, configUrl: null },
    });
  }

  private async enqueueCompensatingDelete(syncJobId: string): Promise<void> {
    if (this.profileSyncQueueService === undefined) {
      return;
    }
    await this.profileSyncQueueService.enqueue(syncJobId);
  }

  private async ensureDeleteJobIfDeleted(
    subscriptionId: string,
    targetRemnawaveId: number | string | null,
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
        return this.createDeleteJobIfMissing(tx, subscriptionId, String(targetRemnawaveId));
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
      readTargetRemnawaveId(syncJob.payload) ?? remnawaveUserIdentifier(subscription);
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
        where: { id: subscription.id },
        data: { remnawaveId: null, remnawaveUserId: null, status: SubscriptionStatus.DELETED },
      });
    } else {
      throw new Error(
        `Panel did not confirm deletion of Remnawave profile '${targetRemnawaveId}'`,
      );
    }
  }

  private async handleTrafficReset(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    const panelIdentifier = remnawaveUserIdentifier(subscription);
    if (panelIdentifier === null) {
      return;
    }

    await this.remnawaveApiService.resetPanelUserTraffic(panelIdentifier);
    const deleteJobId = await this.ensureDeleteJobIfDeleted(
      subscription.id,
      panelIdentifier,
    );
    if (deleteJobId !== null) {
      await this.enqueueCompensatingDelete(deleteJobId);
    }
    this.logger.log(
      `Reset traffic for Remnawave profile '${String(panelIdentifier)}'`,
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
    remnawaveUserId: number | null;
    trafficLimit: number | null;
    deviceLimit: number;
    internalSquads: string[];
    externalSquad: string | null;
    expiresAt: Date | null;
    planSnapshot: unknown;
    status: SubscriptionStatus;
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

type RecoveryClassification = 'TRANSIENT' | 'TERMINAL';

/**
 * What `recordFailure` actually committed. `recorded` is false when the lease
 * had already been taken over (another worker won), in which case nothing was
 * written and nothing should be reported.
 */
interface FailureOutcome {
  readonly recorded: boolean;
  readonly classification: RecoveryClassification;
}

/**
 * Prisma codes meaning "the database was momentarily out of reach". These stay
 * retryable however long the outage lasts: the database will come back, and the
 * job still describes work that has not happened yet.
 */
const TRANSIENT_PRISMA_CONNECTIVITY_CODES: ReadonlySet<string> = new Set([
  'P1001', // Can't reach database server
  'P1002', // Database server was reached but timed out
]);

/**
 * Prisma codes meaning "the generated Client names a table/column the database
 * does not have". The SAME code covers two opposite situations:
 *
 *  - **A deploy window.** Migrations are applied by the API container only
 *    (`docker-entrypoint.sh` gates them on `RUID_PROCESS_ROLE` and runs them
 *    before `exec`). The worker runs the same image with an ALREADY regenerated
 *    Client, so for the length of a deploy a write legitimately names a column
 *    the database has not grown yet. The job would succeed a minute later, so
 *    burning it strands a paid subscription at `remnawaveId = null`.
 *  - **Permanent drift.** A migration that was never written, or a column
 *    renamed without one. This never resolves on its own.
 *
 * Neither is distinguishable from the error itself, so they are separated by
 * how long the job has been failing — see `SCHEMA_DRIFT_GRACE_MS`.
 */
const SCHEMA_DRIFT_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P2021', // Table does not exist in the current database
  'P2022', // Column does not exist in the current database
]);

/**
 * How long a job may keep blaming schema drift before we stop believing it is a
 * deploy and let it fail loudly.
 *
 * Deliberately an order of magnitude beyond any deploy this stack performs (the
 * API's own healthcheck gives up after ~2 minutes), because the two failure
 * directions are not symmetric. Declaring a real deploy window TERMINAL too
 * early abandons a paid job permanently: the recovery sweep only re-drives
 * TRANSIENT rows, so nothing brings it back without a human. Declaring
 * permanent drift TRANSIENT a few minutes too long only delays an alert.
 *
 * Measured from `ProfileSyncJob.createdAt`, the one timestamp on the row that
 * survives recovery. `attempts` cannot serve: the 5-minute sweep resets it to 0
 * every time it re-drives a TRANSIENT row, so it never grows past
 * `PROFILE_SYNC_MAX_ATTEMPTS` no matter how long the drift has lasted.
 * `startedAt` is rewritten per lease and `recoveryData` is cleared on claim.
 *
 * Exported so the tests pin behaviour either side of the boundary without
 * re-hardcoding the number.
 */
export const SCHEMA_DRIFT_GRACE_MS = 30 * 60 * 1000;

/** True while `driftAnchor` is recent enough that a deploy is still plausible. */
function isWithinSchemaDriftGrace(driftAnchor: Date | null | undefined): boolean {
  if (!(driftAnchor instanceof Date) || Number.isNaN(driftAnchor.getTime())) return false;
  return Date.now() - driftAnchor.getTime() <= SCHEMA_DRIFT_GRACE_MS;
}

/**
 * Matches on the STRUCTURED Prisma error code, never on message text — message
 * matching is exactly the weakness this guards against. Follows the
 * `PrismaClientKnownRequestError` idiom used throughout this repo.
 *
 * `driftAnchor` is the job's `createdAt`. Schema-drift codes are retryable only
 * while it is inside `SCHEMA_DRIFT_GRACE_MS`; a missing anchor cannot prove we
 * are in a deploy window, so drift is treated as permanent — the direction that
 * tells an operator rather than the one that goes quiet.
 */
function isRetryablePrismaError(error: unknown, driftAnchor: Date | null | undefined): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (SCHEMA_DRIFT_PRISMA_CODES.has(error.code)) {
      return isWithinSchemaDriftGrace(driftAnchor);
    }
    return TRANSIENT_PRISMA_CONNECTIVITY_CODES.has(error.code);
  }
  // Connectivity failures raised while the pool is opening a connection arrive
  // as an initialization error, which carries its code on `errorCode` rather
  // than `code`. Consulting only the connectivity set here loses nothing:
  // P2021/P2022 are raised by the query engine while executing a statement and
  // always surface as `PrismaClientKnownRequestError`, so they can never reach
  // this branch. (`PrismaClientKnownRequestError` has no `errorCode` property
  // at all, and Prisma only constructs an initialization error with startup
  // codes.) The grace window therefore needs no counterpart here.
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return (
      error.errorCode !== undefined && TRANSIENT_PRISMA_CONNECTIVITY_CODES.has(error.errorCode)
    );
  }
  return false;
}

function classifyRecovery(
  error: unknown,
  driftAnchor: Date | null | undefined,
): RecoveryClassification {
  // The panel ANSWERED and refused (400/401/403/409/…, or an endpoint it does
  // not serve). Re-sending identical bytes every 5 minutes forever cannot
  // change that answer, and TRANSIENT would mean nobody is ever told: the
  // recovery sweep resets the row to PENDING/attempts=0 indefinitely, the
  // operator alert in `reportFailure` requires TERMINAL, and checkout keeps
  // reporting PROFILE_PENDING instead of PROFILE_SYNC_FAILED. Checked before
  // the `ServiceUnavailableException` arm because this error is an
  // `HttpException` too — the arm order is the classification.
  if (error instanceof RemnawaveUpstreamRejectionError) return 'TERMINAL';
  if (error instanceof ServiceUnavailableException) return 'TRANSIENT';
  if (isRetryablePrismaError(error, driftAnchor)) return 'TRANSIENT';
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

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function readTargetRemnawaveId(value: unknown): string | null {
  return readOptionalString(readRecord(value), 'targetRemnawaveId');
}

function remnawaveUserIdentifier(subscription: { remnawaveUserId?: number | null; remnawaveId: string | null }): number | string | null {
  return subscription.remnawaveUserId ?? subscription.remnawaveId;
}

/**
 * Remnawave declares `username` as `minLength: 3, maxLength: 36` on both 2.7.4
 * and 2.8.0. `RemnawaveProfileNamingService` joins prefix + identifier + suffix
 * with no cap, and a web login may be 64 characters — so with the default
 * config (`rz` + `_` + login + `_sub`) any login of 30+ characters produces a
 * name the panel rejects with 400, forever.
 */
export const PANEL_USERNAME_MIN_LENGTH = 3;
export const PANEL_USERNAME_MAX_LENGTH = 36;

/** Width of the disambiguating digest appended when a name has to be cut. */
const PANEL_USERNAME_DIGEST_LENGTH = 10;

/**
 * Fits a generated profile name inside Remnawave's 3–36 window.
 *
 * Two properties this function MUST keep, in order of how much they cost if
 * broken:
 *
 *  1. **Identity for every name that already fits.** The name is the
 *     crash-recovery idempotency key — `handleCreate` looks the panel profile
 *     up by it (`getPanelUserByUsername`) before creating one. Rewriting a name
 *     that was already legal would make every previously-provisioned profile
 *     unfindable, and the CREATE that follows would collide with the profile
 *     that is still sitting there under the old name.
 *  2. **Determinism.** The same input must map to the same output on every run
 *     and every process, for the same reason.
 *
 * Truncation alone would break a third property — injectivity. Two logins
 * sharing a long prefix would collapse onto ONE panel profile, and because the
 * CREATE path treats "a profile with this username exists" as "this is my
 * profile", customer B would be handed customer A's subscription. So the cut
 * name carries a digest of the WHOLE original: same input → same name, and two
 * different originals share a name only on a 40-bit hash collision. See
 * `assertPanelProfileOwnership` for the second half of that defence.
 */
export function clampPanelUsername(username: string): string {
  if (username.length >= PANEL_USERNAME_MIN_LENGTH && username.length <= PANEL_USERNAME_MAX_LENGTH) {
    return username;
  }
  if (username.length < PANEL_USERNAME_MIN_LENGTH) {
    // Defensive only: the naming service always joins a non-empty prefix,
    // identifier and suffix around two separators, so it cannot emit fewer
    // than five characters. `_` is inside the panel's allowed alphabet.
    return username.padEnd(PANEL_USERNAME_MIN_LENGTH, '_');
  }
  const digest = createHash('sha256')
    .update(username)
    .digest('hex')
    .slice(0, PANEL_USERNAME_DIGEST_LENGTH);
  const head = username.slice(0, PANEL_USERNAME_MAX_LENGTH - PANEL_USERNAME_DIGEST_LENGTH - 1);
  return `${head}_${digest}`;
}

/**
 * `reiwa_id: <id>` — the ownership marker this system writes into every profile
 * description it creates, and the same marker the Remnawave importer
 * (`remnawave-importer.service.ts`) resolves identity by.
 *
 * The character class is deliberately WIDER than the importer's `[a-z0-9]+`:
 * that one only has to detect presence, while this one's capture is compared
 * for equality. An id carrying a `-` or `_` would be captured short, and a
 * short capture reads as "a different owner" — which would refuse to relink a
 * profile that IS ours and turn crash recovery into a permanent failure.
 */
const PANEL_OWNER_MARKER = /reiwa_id:\s*([A-Za-z0-9_-]+)/;

function readPanelOwnerId(description: string | null | undefined): string | null {
  if (typeof description !== 'string') return null;
  const match = PANEL_OWNER_MARKER.exec(description);
  return match === null ? null : match[1];
}

/**
 * Refuses to adopt a panel profile that provably belongs to someone else.
 *
 * `handleCreate` reuses an existing profile found by username so a crash
 * between "created upstream" and "persisted the link" does not leave an orphan.
 * That lookup keys on a name that is no longer guaranteed unique per user once
 * it can be truncated, and the automated path — unlike the manual admin-link
 * path — never checked whose profile it found. Linking customer A's profile to
 * customer B's subscription hands over their traffic, their devices and their
 * config URL.
 *
 * Deliberately only refuses on a PROVEN mismatch. A description with no marker
 * (imported, or edited by an operator) keeps the previous behaviour — it is
 * genuinely indeterminate, and failing those closed would strand every legacy
 * profile. Throwing a plain `Error` classifies TERMINAL, so a real collision
 * pages an operator instead of quietly cross-linking two paying customers.
 */
function assertPanelProfileOwnership(
  panelUsername: string,
  description: string | null | undefined,
  expectedUserId: string,
): void {
  const owner = readPanelOwnerId(description);
  if (owner !== null && owner !== expectedUserId) {
    throw new Error(
      `Remnawave profile '${panelUsername}' is owned by reiwa_id ${owner}, not ${expectedUserId} — refusing to link`,
    );
  }
}

/**
 * Remnawave declares `status` as `enum: ["ACTIVE","DISABLED"]` on `PATCH
 * /api/users` for both 2.7.4 and 2.8.0. rezeis' own column carries three more
 * values, and the sync forwards the column as it reads at PROCESSING time —
 * not the value the operator submitted — while `AutoRenewService` flips rows to
 * EXPIRED every minute. So an admin edit could reach the panel carrying
 * `EXPIRED` and 400 forever.
 *
 * EXPIRED / LIMITED / DELETED therefore propagate NOTHING rather than being
 * translated:
 *  - both are states Remnawave DERIVES itself, EXPIRED from the very `expireAt`
 *    this same PATCH sends and LIMITED from the traffic counter, so there is
 *    nothing for us to assert;
 *  - mapping them onto `DISABLED` would be a write nothing ever undoes —
 *    renewal deliberately does not propagate status
 *    (`payment-reconciliation.service.ts`), so a renewed customer would stay
 *    disabled on the panel;
 *  - DELETED retires the profile through a DELETE job, not a status write.
 */
function toPanelStatus(status: SubscriptionStatus | null | undefined): 'ACTIVE' | 'DISABLED' | null {
  if (status === SubscriptionStatus.ACTIVE) return 'ACTIVE';
  if (status === SubscriptionStatus.DISABLED) return 'DISABLED';
  return null;
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
