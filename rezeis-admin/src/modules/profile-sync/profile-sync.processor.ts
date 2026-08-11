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
  storedIdentityOf as panelIdentityOf,
  type StoredPanelIdentity,
} from '../remnawave/services/panel-user-address';
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

    // EVERYTHING before the claim is database work too, and it can fail the
    // same way the handler can. Left unguarded it failed DIFFERENTLY: the
    // exception walked straight out of `process`, so `classifyRecovery` never
    // saw it, `recordFailure` never wrote a row, and the job stayed
    // `PENDING, attempts = 0` while BullMQ burned its retries and retained the
    // exhausted job under the same `jobId`. From there `sweepPending` re-adds
    // that id, BullMQ deduplicates it against the retained job, and the row is
    // unreachable FOREVER — it does not recover even once the cause is gone.
    // Checkout keeps answering PROFILE_PENDING (it needs
    // `FAILED` + `TERMINAL` to say otherwise) and no operator alert fires.
    //
    // This is not hypothetical for this patch: `loadSyncJob` selects
    // `remnawavePanelId` / `remnawavePanelUsername`, which migration
    // 20260810120000 adds — so for the length of every deploy window the
    // WORKER's regenerated Client names two columns the database has not grown
    // yet and raises P2022 here, on the one path where the P2022 handling could
    // not reach it.
    let claim: SyncJobClaim | null;
    try {
      claim = await this.claimSyncJob(syncJobId);
    } catch (err: unknown) {
      await this.recordPreClaimFailure(syncJobId, err);
      throw err; // Let BullMQ retry; the sweep re-drives a TRANSIENT row.
    }
    if (claim === null) {
      return;
    }
    const { syncJob, leaseStartedAt } = claim;

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

  /**
   * Reads the job, drops the ones there is nothing to do for, and takes the
   * lease. Returns `null` when this worker must simply stop.
   *
   * Extracted so `process` can put a `catch` around it: every statement in here
   * is a database round-trip, and a failure in any of them used to escape
   * unclassified and unrecorded.
   */
  private async claimSyncJob(syncJobId: string): Promise<SyncJobClaim | null> {
    const syncJob = await this.loadSyncJob(this.prismaService, syncJobId);

    if (syncJob === null) {
      this.logger.warn(`Sync job ${syncJobId} not found — skipping`);
      return null;
    }

    if (syncJob.status === SyncJobStatus.COMPLETED || syncJob.supersededAt != null) {
      return null;
    }

    // A versioned job (carries aggregateKey + desiredRevision) must only push
    // the LATEST desired state. If the authoritative projection has already
    // advanced past this job's revision, this job is stale: supersede it (no
    // upstream write) so an out-of-order older revision can never overwrite a
    // newer one. Non-versioned jobs and the flag-off path are untouched.
    if (await this.supersedeIfStaleRevision(syncJob)) {
      return null;
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
      return null;
    }

    return { syncJob, leaseStartedAt };
  }

  /**
   * Records a failure that happened BEFORE the lease was taken, so the row
   * carries the same classification a post-claim failure would.
   *
   * Deliberately re-reads the job through a projection of columns that predate
   * every migration in flight — the whole reason we are here may be that a
   * newer column does not exist yet, and a recovery write that trips over the
   * same drift would record nothing at all.
   *
   * Best effort by construction: it must never replace the original error, and
   * it never claims the lease (no `RUNNING`), because nothing ran.
   */
  private async recordPreClaimFailure(syncJobId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    this.logger.error(`Sync job ${syncJobId} failed before it could be claimed: ${errorMessage}`);
    try {
      const anchor = await this.prismaService.profileSyncJob.findUnique({
        where: { id: syncJobId },
        select: { createdAt: true, attempts: true, action: true, subscriptionId: true },
      });
      if (anchor === null) return;
      const classification = classifyRecovery(error, anchor.createdAt);
      const attempt = anchor.attempts + 1;
      const recorded = await this.prismaService.profileSyncJob.updateMany({
        where: {
          id: syncJobId,
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.FAILED] },
          supersededAt: null,
        },
        data: {
          status: SyncJobStatus.FAILED,
          attempts: attempt,
          lastError: errorMessage,
          recoveryData: { classification },
        },
      });
      if (recorded.count !== 1) return;
      // Same rule as `reportFailure`: only a genuine, final, non-transient
      // failure is worth waking somebody for. A TRANSIENT row is picked up by
      // the FAILED pass of `sweepAndRecover`, which re-enqueues with `force` and
      // therefore gets past BullMQ's retained-job deduplication.
      if (attempt >= PROFILE_SYNC_MAX_ATTEMPTS && classification === 'TERMINAL') {
        this.events.error(
          EVENT_TYPES.SYSTEM_ERROR,
          'SYSTEM',
          `Profile sync failed: ${errorMessage}`,
          {
            syncJobId,
            action: anchor.action,
            subscriptionId: anchor.subscriptionId,
            attempt,
          },
        );
      }
    } catch (recoveryError: unknown) {
      this.logger.error(
        `Sync job ${syncJobId} failed before the claim AND its failure could not be recorded: ` +
          `${recoveryError instanceof Error ? recoveryError.message : 'Unknown error'}`,
      );
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
            // The two supplementary identity columns. They are what makes a
            // profile created on 2.x still addressable after the operator
            // upgrades to 3.x — the panel's own migration drops the uuid
            // without preserving it, so `remnawaveId` alone becomes a dead
            // string. Selecting them here costs nothing and is the difference
            // between a lazy re-resolve and a permanently unreachable profile.
            remnawavePanelId: true,
            remnawavePanelUsername: true,
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
    if (subscription.remnawaveId === null) return false;

    const projection = await client.subscriptionEffectiveProjection.findUnique({
      where: { subscriptionId: subscription.id },
      select: { desiredRevision: true, desiredTrafficLimitBytes: true, desiredDeviceLimit: true },
    });
    if (projection === null) return false;

    const planSnapshot = readRecord(subscription.planSnapshot);
    const identity = panelIdentityOf(subscription);
    if (identity === null) return false;
    const setOutcome = await this.remnawaveApiService.strictSetUserLimits(identity, {
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

    const readOutcome = await this.remnawaveApiService.strictGetPanelUser(identity);
    if (readOutcome.kind === 'unavailable') {
      throw new ServiceUnavailableException('Remnawave unavailable during desired-state read-back');
    }
    if (readOutcome.kind !== 'ok') {
      throw new Error(`Strict desired-state read-back failed: ${readOutcome.kind}`);
    }

    // Second back-fill channel. The strict read carries the numeric id but no
    // username, and the id is the one that matters — it is what a 3.x path
    // segment is built from; the username is only the last resort when no id
    // was ever recorded.
    await this.backfillPanelIdentity(subscription, {
      panelId: readOutcome.value.panelId,
      username: '',
    });

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
        panelIdentityOf(subscription),
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
    if (existing !== null && typeof existing.uuid === 'string' && existing.uuid.length > 0) {
      // "A profile answers to this name" is not "this profile is mine" — see
      // `assertPanelProfileOwnership`.
      assertPanelProfileOwnership(panelUsername, existing.description, subscription.userId);
      // …and "this profile is this user's" is not "this profile is FREE". The
      // ownership check reads a marker in the panel description, which says
      // whose profile it is and nothing about which of that user's
      // subscriptions already holds it. Adopting one that another live
      // subscription is on puts two rows on one panel profile: they then write
      // each other's limits and expiry through it, and whichever is deleted
      // first takes the other's service down. The database cannot forbid it —
      // `remnawaveId` carries no unique constraint, and migration
      // 20260810160000 records why one cannot safely be added to live data — so
      // it is refused here, where the refusal can name both rows instead of
      // aborting a deploy.
      //
      // Only the ADOPT path needs this. A profile the panel has just minted
      // carries an identity no existing row can be holding.
      //
      // ASKED ABOUT THE PANEL IDENTITY, NOT ABOUT ONE STRING. `existing.uuid` is
      // whatever `parsePanelUserRow` could key this row by: on 2.x the uuid, on
      // 3.x the numeric id rendered as a string, because a 3.x row has no uuid
      // to give. Every subscription provisioned or imported BEFORE the operator
      // upgraded still stores the 2.x uuid in `remnawaveId` — so on a 3.x panel
      // a check that only compares `remnawaveId` compares a decimal against a
      // uuid and can never match. It would be inert for exactly the population
      // this one-build-for-2.7.4-and-3.2.1 patch exists to protect. The two
      // supplementary columns name the same profile the other way round, and
      // the panel username is the key a resolve would land on, so all three are
      // asked at once.
      const holderClaims: Prisma.SubscriptionWhereInput[] = [{ remnawaveId: existing.uuid }];
      if (typeof existing.panelId === 'number' && Number.isSafeInteger(existing.panelId)) {
        holderClaims.push({ remnawavePanelId: existing.panelId });
      }
      if (typeof existing.username === 'string' && existing.username.length > 0) {
        holderClaims.push({ remnawavePanelUsername: existing.username });
      }
      const holder = await this.prismaService.subscription.findFirst({
        where: {
          id: { not: subscription.id },
          status: { not: SubscriptionStatus.DELETED },
          OR: holderClaims,
        },
        select: { id: true, userId: true },
      });
      if (holder !== null) {
        throw new Error(
          `Refusing to link Remnawave profile '${existing.uuid}' to subscription ` +
            `${subscription.id}: subscription ${holder.id} (user ${holder.userId}) is already ` +
            'live on it. Two subscriptions sharing one panel profile overwrite each other and ' +
            "delete each other's service.",
        );
      }
      const deleteScheduled = await this.persistProfileLink(
        subscription.id,
        existing.uuid,
        existing.panelId,
        // The panel's OWN name for the profile, not the one we asked for. The
        // two normally match, but `generateProfileName` builds from an
        // operator-editable prefix and separator, so recomputing it later would
        // produce a name that no longer resolves.
        existing.username,
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
        `Linked existing Remnawave profile '${existing.uuid}' (username: ${panelUsername}) to subscription ${subscription.id}`,
      );
      this.events.info(EVENT_TYPES.SUBSCRIPTION_CREATED, 'SUBSCRIPTION', `Remnawave profile linked: ${panelUsername}`, {
        subscriptionId: subscription.id,
        userId: subscription.userId,
        remnawaveId: existing.uuid,
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
      panelUser.panelId,
      panelUser.username,
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
      `Created Remnawave profile '${panelUser.uuid}' (username: ${panelUsername}) for subscription ${subscription.id}`,
    );

    // Emit event
    this.events.info(EVENT_TYPES.SUBSCRIPTION_CREATED, 'SUBSCRIPTION', `Remnawave profile created: ${panelUsername}`, {
      subscriptionId: subscription.id,
      userId: subscription.userId,
      remnawaveId: panelUser.uuid,
      remnawaveUsername: panelUsername,
    });
  }

  /**
   * Records the panel link, including the two supplementary identity columns.
   *
   * `panelId` and `panelUsername` are recorded on EVERY version, not only on
   * 3.x, and that is the whole point. A 2.x panel already returns the numeric id
   * on every user row, so recording it now is free; recording it only after the
   * operator upgrades would be too late, because the upgrade itself is what
   * destroys the uuid that would let us find the profile again.
   */
  private async persistProfileLink(
    subscriptionId: string,
    remnawaveId: string,
    panelId: number | null,
    panelUsername: string | null,
    configUrl: string | null | undefined,
    panelCreatedAt: string | null | undefined,
  ): Promise<string | null> {
    return this.prismaService.$transaction(async (tx) => {
      // Serialize every writer that is about to link THIS panel identity.
      //
      // The exclusivity check in `handleCreate` reads before a panel round-trip
      // and writes after it, so two CREATE jobs that resolve to the same panel
      // profile both read "nobody holds it" and both write the link — a
      // read-then-write across the widest window in the handler. The database
      // cannot forbid the result (`remnawaveId` carries no unique constraint;
      // migration 20260810160000 records why one cannot safely be added to live
      // data), so the mutual exclusion is taken here instead. The lock is
      // transaction-scoped — released by COMMIT or ROLLBACK, never leaked — and
      // is taken BEFORE the row lock below so two writers of the same identity
      // always queue in the same order.
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`remnawave-profile:${remnawaveId}`})::bigint)
      `);
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

      // …and re-ask the exclusivity question now that the lock is held, because
      // the answer `handleCreate` got predates a network round-trip. Only the
      // two IMMUTABLE identifiers are compared here: a uuid and a numeric panel
      // id name one profile forever, so a match is a proven double-link with no
      // false positive. The panel USERNAME is deliberately not part of this
      // question — it is mutable and re-derivable, so a stale row still carrying
      // the name of a profile that no longer exists would wedge every future
      // provision under that name.
      const conflicts = await tx.$queryRaw<Array<{ conflictId?: string | null }>>(Prisma.sql`
        SELECT "id" AS "conflictId"
        FROM "subscriptions"
        WHERE "id" <> ${subscriptionId}
          AND "status" <> 'DELETED'
          AND (
            "remnawave_id" = ${remnawaveId}
            OR (${panelId}::int IS NOT NULL AND "remnawave_panel_id" = ${panelId}::int)
          )
        LIMIT 1
      `);
      const conflictId = conflicts[0]?.conflictId;
      if (typeof conflictId === 'string' && conflictId.length > 0) {
        throw new Error(
          `Refusing to link Remnawave profile '${remnawaveId}' to subscription ` +
            `${subscriptionId}: subscription ${conflictId} was linked to it first. Two ` +
            'subscriptions sharing one panel profile overwrite each other and delete each ' +
            "other's service.",
        );
      }

      await tx.subscription.update({
        where: { id: subscriptionId },
        // `?? undefined`: a panel that omitted the field must not OVERWRITE a
        // value we already hold with null. Prisma reads `undefined` as "leave
        // this column alone" and `null` as "set it to null", and the two are
        // opposite facts here.
        data: {
          remnawaveId,
          remnawavePanelId: panelId ?? undefined,
          remnawavePanelUsername: panelUsername ?? undefined,
          configUrl,
        },
      });
      await this.stampMonthRollingAnchor(tx, subscriptionId, panelCreatedAt, current.status);
      // ONLY a retired row. This branch compensates for a CREATE that finished
      // after its subscription was deleted — nothing else. It used to fire for
      // every status that is not ACTIVE, which is four of the five: EXPIRED,
      // DISABLED and LIMITED are all LIVE states, and a CREATE legitimately runs
      // in each of them (an EXPIRED row inside its grace window is still
      // renewable and still shown; `AutoRenewService` moves rows there every
      // minute; `handleUpdate` re-provisions through CREATE after a genuine 404;
      // the importer and the bulk plan assignment enqueue CREATE regardless of
      // status). For those the compensating DELETE destroyed the profile that
      // had just been minted AND wrote `status = DELETED` on the way out —
      // turning a reversible admin block, or a subscription with days of grace
      // left, into a permanently unrenewable row. `ensureDeleteJobIfDeleted`
      // asks the same question the correct way; the two now agree.
      if (current.status === SubscriptionStatus.DELETED) {
        // The profile we have just linked, described by everything the panel
        // told us about it a moment ago — the job may outlive the row.
        const deleteJobId = await this.createDeleteJobIfMissing(tx, subscriptionId, {
          remnawaveId,
          panelId,
          panelUsername,
        });
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

      // Non-null by the guard above; `panelIdentityOf` re-checks so the helper
      // stays honest for every caller rather than for this one.
      const updateIdentity = panelIdentityOf(subscription) as StoredPanelIdentity;
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
        panelUser = await this.remnawaveApiService.updatePanelUser(updateIdentity, {
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
          await this.reprovisionMissingProfile(subscription.id, subscription.remnawaveId);
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

      // The panel just told us who this profile is. Record it — this is the
      // read the whole design assumed would fill the supplementary columns, and
      // until it existed they were only ever written when a profile was CREATED
      // or manually re-linked, both of which require `remnawaveId` to be null.
      // Every subscription that already existed therefore kept both columns
      // NULL forever, which is exactly the state that becomes unaddressable the
      // day the operator upgrades the panel to 3.x.
      await this.backfillPanelIdentity(subscription, panelUser);

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
        panelIdentityOf(subscription),
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

  /**
   * Detaches a stale `remnawaveId` (and its `configUrl`) from a subscription
   * whose panel profile returned 404, so the subsequent CREATE re-provisions a
   * fresh profile. Fenced on the old id: if a concurrent write already
   * re-linked the row to a different profile, this is a no-op and that link
   * wins (we never clobber a newer link).
   */
  private async reprovisionMissingProfile(
    subscriptionId: string,
    staleRemnawaveId: string,
  ): Promise<void> {
    await this.prismaService.subscription.updateMany({
      where: { id: subscriptionId, remnawaveId: staleRemnawaveId },
      // The supplementary columns go with the id they describe. A numeric id
      // left behind here would let the follow-up CREATE's first write address
      // the profile the panel just told us does not exist.
      data: {
        remnawaveId: null,
        remnawavePanelId: null,
        remnawavePanelUsername: null,
        configUrl: null,
      },
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
    target: StoredPanelIdentity | null,
    panelCreatedAt?: string | null,
    client: Prisma.TransactionClient | PrismaService = this.prismaService,
  ): Promise<string | null> {
    if (target === null) {
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
        return this.createDeleteJobIfMissing(tx, subscriptionId, target);
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

  /**
   * Fills the supplementary identity columns from a panel row we were reading
   * anyway. The lazy half of "record the numeric id before it is needed".
   *
   * WHY THIS IS NOT OPTIONAL: the only other writers are `persistProfileLink`
   * and the manual link-repair endpoint, and BOTH refuse unless `remnawaveId`
   * is null — they provision, they do not update. Without this call every row
   * that already exists keeps both columns NULL for its whole life, and on the
   * day the panel is upgraded to 3.x `panelUserAddress` answers `impossible`
   * for all of them: DELETE jobs retry forever, the expiry sweep defers
   * forever, device sagas defer forever, and deleting a user leaves their panel
   * profile running. The columns would have been dead weight.
   *
   * Fenced on `remnawaveId` so a re-provision that landed while this job ran is
   * not overwritten with the previous profile's identity, and skipped entirely
   * once there is nothing left to fill — so it costs one UPDATE per
   * subscription, once, not one per job.
   */
  private async backfillPanelIdentity(
    subscription: SyncJobRecord['subscription'],
    panelUser:
      | { readonly panelId?: number | null; readonly username?: string | null }
      | null
      | undefined,
  ): Promise<void> {
    if (panelUser === null || panelUser === undefined) return;
    // Both fields read defensively. `parsePanelUserRow` always produces them,
    // but this value crosses the adapter boundary and a back-fill is the last
    // thing that may take down a job whose panel write already landed.
    const panelId =
      typeof panelUser.panelId === 'number' && Number.isSafeInteger(panelUser.panelId)
        ? panelUser.panelId
        : null;
    const username =
      typeof panelUser.username === 'string' && panelUser.username.length > 0
        ? panelUser.username
        : null;
    const fillId = subscription.remnawavePanelId === null && panelId !== null;
    const fillName = subscription.remnawavePanelUsername === null && username !== null;
    if (!fillId && !fillName) return;

    try {
      await this.prismaService.subscription.updateMany({
        where: { id: subscription.id, remnawaveId: subscription.remnawaveId },
        data: {
          ...(fillId ? { remnawavePanelId: panelId } : {}),
          ...(fillName ? { remnawavePanelUsername: username } : {}),
        },
      });
    } catch (err: unknown) {
      // Best effort, and deliberately not fatal: the panel write this job
      // existed for has already landed. Failing the job here would retry that
      // write, and losing a back-fill costs one more round-trip later — not
      // correctness.
      this.logger.warn(
        `Could not record panel identity for subscription ${subscription.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * The compensating DELETE carries the profile's identity, not just its id
   * string. By the time the job runs the row it came from may have been retired
   * with its identity columns cleared, or relinked to a different profile — so a
   * re-read would find nothing or address the replacement. Same three keys
   * `subscription-deletion.service.ts` writes, read back by
   * {@link readTargetIdentity}.
   */
  private async createDeleteJobIfMissing(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    target: StoredPanelIdentity,
  ): Promise<string | null> {
    const targetRemnawaveId = target.remnawaveId;
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
          targetRemnawavePanelId: target.panelId,
          targetRemnawavePanelUsername: target.panelUsername,
        } as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return deleteJob.id;
  }

  private async handleDelete(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    const fromPayload = readTargetRemnawaveId(syncJob.payload);
    const targetRemnawaveId = fromPayload ?? subscription.remnawaveId;
    if (targetRemnawaveId === null) {
      return;
    }

    // What the JOB recorded wins over what the row holds now: the row may have
    // been re-provisioned onto a different profile since, and `deleteTargetIdentity`
    // would then correctly refuse to lend it any material — leaving the stale
    // string alone and unaddressable on a 3.x panel. A job enqueued before those
    // keys existed carries neither, and falls back to the row exactly as before.
    const recorded = fromPayload === null ? null : readTargetIdentity(syncJob.payload, fromPayload);
    const identity =
      recorded !== null && (recorded.panelId !== null || recorded.panelUsername !== null)
        ? recorded
        : deleteTargetIdentity(subscription, targetRemnawaveId);

    // A DELETE must never run against a subscription that is LIVE on the very
    // profile it targets. Every enqueue path upholds that: the self-service,
    // admin and expired-sweep deletes all go through
    // `SubscriptionDeletionService.deleteSubscription`, which writes
    // `status = DELETED` in the SAME transaction that creates the job, and the
    // compensating deletes fire only from a `status === DELETED` branch. So a
    // row that is not retired and still holds the target means the row moved
    // after the job was written — an admin extension or a renewal landing
    // between the enqueue and the worker. Deleting then takes the profile of a
    // customer who has just paid, and marks their subscription DELETED on the
    // way out.
    //
    // ASKED AS "NOT RETIRED", NOT AS "ACTIVE". EXPIRED, DISABLED and LIMITED are
    // live states too: an EXPIRED row inside its grace window is renewable and
    // still shown, and a DISABLED row is an admin pause somebody expects to
    // undo. Naming only ACTIVE left three doors open into the same loss, and
    // `AutoRenewService` walks rows through EXPIRED every minute.
    if (
      isLiveSubscriptionStatus(subscription.status) &&
      subscription.remnawaveId === targetRemnawaveId
    ) {
      this.logger.warn(
        `Skipping DELETE of Remnawave profile '${targetRemnawaveId}': subscription ` +
          `${subscription.id} is ${subscription.status} on it again — the job predates a renewal`,
      );
      return;
    }

    const collision = await this.panelProfileClaimedByAnother(
      subscription.id,
      identity,
      targetRemnawaveId,
    );
    if (collision !== null) {
      // Refusing is the whole point: this job would otherwise delete a LIVE
      // profile. Thrown rather than skipped so the job is recorded as failed and
      // an operator is told there is an orphan on the panel to clean up by hand.
      throw new Error(
        `Refusing to delete Remnawave profile '${targetRemnawaveId}' for subscription ` +
          `${subscription.id}: panel username '${identity.panelUsername ?? ''}' now belongs to ` +
          `subscription ${collision.id}, which is live on profile ` +
          `'${collision.remnawaveId ?? 'unknown'}'. Resolving by that name would delete the live ` +
          'profile. The stale panel profile must be removed manually.',
      );
    }

    const result = await this.remnawaveApiService.deletePanelUser(identity);
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
        // The two supplementary columns are detached together with the id they
        // describe. Leaving them behind would let a later re-provision inherit
        // the DELETED profile's numeric id and panel username, and the adapter
        // would happily address the corpse.
        data: {
          remnawaveId: null,
          remnawavePanelId: null,
          remnawavePanelUsername: null,
          status: SubscriptionStatus.DELETED,
        },
      });
    } else {
      throw new Error(
        `Panel did not confirm deletion of Remnawave profile '${targetRemnawaveId}'`,
      );
    }
  }

  /**
   * The subscription — other than the doomed one — that is LIVE under the panel
   * username this DELETE may resolve by, or `null` when nobody is.
   *
   * WHY A DELETE NEEDS THIS AND THE OTHER ACTIONS DO NOT: every other job acts
   * on the row it belongs to, so the row itself vouches for the target. A DELETE
   * carries its target in the PAYLOAD and outlives the row — and when the stored
   * identity is a 2.x uuid on an upgraded 3.x panel, the only route back to the
   * profile is `POST /api/users/resolve` BY USERNAME. Panel usernames are
   * DETERMINISTIC — `fitPanelUsername` below documents that determinism as a
   * requirement, because the CREATE path uses the name as its crash-recovery
   * idempotency key — so a profile that was deleted and re-provisioned carries
   * the SAME name as the one this job means to remove. The resolve then answers
   * with the replacement, and the delete lands on a paying customer's live
   * profile.
   *
   * The name is the ONLY mutable key in play, which is why the question is asked
   * about it and not about the resolved profile: a uuid and a numeric id are
   * both immutable and unique on the panel, so neither can come to mean somebody
   * else. Asking here also costs no panel round-trip — the collision is visible
   * in our own rows, before anything is sent.
   */
  private async panelProfileClaimedByAnother(
    subscriptionId: string,
    identity: StoredPanelIdentity,
    targetRemnawaveId: string,
  ): Promise<{ readonly id: string; readonly remnawaveId: string | null } | null> {
    const username = identity.panelUsername;
    if (username === null || username.length === 0) return null;
    const claimants = await this.prismaService.subscription.findMany({
      where: {
        remnawavePanelUsername: username,
        remnawaveId: { not: null },
        status: { not: SubscriptionStatus.DELETED },
      },
      select: { id: true, remnawaveId: true },
      take: 5,
    });
    // EXACTLY ONE row may be excused: the doomed subscription ITSELF, still
    // holding the very identity this job targets.
    //
    // Excusing by identity alone — "anyone holding the target must be the
    // doomed row" — assumes one row can hold a profile, and nothing enforces
    // that: `remnawaveId` has no unique constraint, which is why the CREATE
    // path has to refuse a double-link by hand. When that refusal is bypassed
    // (a second subscription adopts the same profile — see the holder check in
    // `handleCreate`) the adopter holds the target too, was silently read as
    // "the doomed row", and this DELETE removed the panel profile a LIVE, often
    // just-paid subscription was sitting on. Its own row is not even repaired
    // afterwards: the closing `updateMany` fences on the doomed row's id, so
    // the survivor is left pointing at a profile that no longer exists.
    return (
      claimants.find(
        (row) => !(row.id === subscriptionId && row.remnawaveId === targetRemnawaveId),
      ) ?? null
    );
  }

  private async handleTrafficReset(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    const identity = panelIdentityOf(subscription);
    if (identity === null) {
      return;
    }

    await this.remnawaveApiService.resetPanelUserTraffic(identity);
    const deleteJobId = await this.ensureDeleteJobIfDeleted(
      subscription.id,
      identity,
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
    remnawavePanelId: number | null;
    remnawavePanelUsername: string | null;
    trafficLimit: number | null;
    deviceLimit: number;
    internalSquads: string[];
    externalSquad: string | null;
    expiresAt: Date | null;
    planSnapshot: unknown;
    status: SubscriptionStatus;
  };
};

/**
 * The identity for a DELETE, whose target may come from the job payload rather
 * than from the row.
 *
 * The supplementary columns describe whatever profile the row points at NOW. If
 * the payload names a different one — a re-provision has since relinked the
 * subscription — attaching them would let the adapter resolve the CURRENT
 * profile and delete it in place of the stale one. So the extra material is
 * carried only when the two agree; otherwise the stale string travels alone and
 * the adapter is free to refuse.
 */
function deleteTargetIdentity(
  subscription: Pick<
    SyncJobRecord['subscription'],
    'remnawaveId' | 'remnawavePanelId' | 'remnawavePanelUsername'
  >,
  target: string,
): StoredPanelIdentity {
  return target === subscription.remnawaveId
    ? {
        remnawaveId: target,
        panelId: subscription.remnawavePanelId ?? null,
        panelUsername: subscription.remnawavePanelUsername ?? null,
      }
    : { remnawaveId: target, panelId: null, panelUsername: null };
}

/**
 * True while a subscription is still somebody's — i.e. anything but retired.
 *
 * Written as a positive list rather than as `!== DELETED` so a value that is
 * not a status at all (an older job row, a partial `select`, a fixture) reads
 * as "cannot prove this row is live" instead of as "live". The four listed
 * values are all the non-terminal states rezeis has: EXPIRED is renewable
 * inside the grace window, DISABLED is a reversible admin pause, and LIMITED is
 * derived from the traffic counter — none of them mean the customer is gone.
 */
function isLiveSubscriptionStatus(status: SubscriptionStatus | null | undefined): boolean {
  return (
    status === SubscriptionStatus.ACTIVE ||
    status === SubscriptionStatus.EXPIRED ||
    status === SubscriptionStatus.DISABLED ||
    status === SubscriptionStatus.LIMITED
  );
}

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

/** The job plus the lease token that every terminal write must match. */
interface SyncJobClaim {
  readonly syncJob: SyncJobRecord;
  readonly leaseStartedAt: Date;
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
 * The SQLSTATEs that mean the same thing as P2021/P2022 for a RAW query.
 *
 * The typed client turns "no such column" into P2022. A `$queryRaw` never
 * reaches that translation: Prisma reports every raw-query failure as the one
 * code `P2010`, carrying the driver's own SQLSTATE in `meta.code`. This
 * processor runs raw SQL — the `FOR UPDATE` row lock in `persistProfileLink`
 * and its exclusivity probe both name `remnawave_id` / `remnawave_panel_id`
 * explicitly — so a deploy window produces P2010/42703 there while producing
 * P2022 everywhere else, and P2010 matched no set at all: TERMINAL, no grace,
 * and the recovery sweep (which re-drives only TRANSIENT rows) drops it for
 * good.
 *
 * P2010 is NOT widened wholesale, and that is the point. It also covers a
 * genuine constraint violation, a syntax error and a bad cast — permanent
 * defects that must stay TERMINAL so somebody is told. Only the two SQLSTATEs
 * that specifically mean "the object is not there (yet)" are treated as drift,
 * which is exactly the evidence P2021/P2022 carry in their own right.
 */
const SCHEMA_DRIFT_SQLSTATES: ReadonlySet<string> = new Set([
  '42703', // undefined_column
  '42P01', // undefined_table
]);

/** True when a `P2010` raw-query failure is the deploy-window shape. */
function isUndefinedSchemaObject(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) return false;
  const sqlState = (meta as { readonly code?: unknown }).code;
  return typeof sqlState === 'string' && SCHEMA_DRIFT_SQLSTATES.has(sqlState);
}

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
    // The raw-query counterpart of the two codes above, narrowed to the
    // SQLSTATEs that mean the object is missing — see `SCHEMA_DRIFT_SQLSTATES`.
    if (error.code === 'P2010') {
      return isUndefinedSchemaObject(error.meta) && isWithinSchemaDriftGrace(driftAnchor);
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

/**
 * The full identity a DELETE job carries, when whoever enqueued it recorded one.
 *
 * The job OUTLIVES the row it was derived from: by the time it runs, the
 * subscription may have been retired with its identity columns cleared, or
 * re-provisioned onto a different profile. So the identity has to travel WITH
 * the job — a re-read would either find nothing or, worse, address the live
 * replacement. `subscription-deletion.service.ts` writes these two keys beside
 * `targetRemnawaveId`; older jobs already in the queue carry only the string and
 * degrade to it, which is the pre-existing behaviour and still correct on 2.x.
 */
function readTargetIdentity(value: unknown, target: string): StoredPanelIdentity {
  const record = readRecord(value);
  const panelId = record['targetRemnawavePanelId'];
  return {
    remnawaveId: target,
    panelId: typeof panelId === 'number' && Number.isSafeInteger(panelId) ? panelId : null,
    panelUsername: readOptionalString(record, 'targetRemnawavePanelUsername'),
  };
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
