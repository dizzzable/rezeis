import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { SyncAction, SyncJobStatus } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemEventsService, EVENT_TYPES } from '../../common/services/system-events.service';
import { RemnawaveApiService } from '../remnawave/services/remnawave-api.service';
import { PROFILE_SYNC_QUEUE } from './profile-sync.constants';
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
@Processor(PROFILE_SYNC_QUEUE)
export class ProfileSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ProfileSyncProcessor.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly namingService: RemnawaveProfileNamingService,
    private readonly events: SystemEventsService,
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

    if (syncJob.status === SyncJobStatus.COMPLETED) {
      return;
    }

    // Mark as RUNNING
    await this.prismaService.profileSyncJob.update({
      where: { id: syncJobId },
      data: {
        status: SyncJobStatus.RUNNING,
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

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

      await this.prismaService.profileSyncJob.update({
        where: { id: syncJobId },
        data: { status: SyncJobStatus.COMPLETED, completedAt: new Date() },
      });
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
      await this.prismaService.subscription.update({
        where: { id: subscription.id },
        data: {
          remnawaveId: existing.uuid,
          configUrl: existing.subscriptionUrl,
        },
      });
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

    // Update subscription with Remnawave profile data
    await this.prismaService.subscription.update({
      where: { id: subscription.id },
      data: {
        remnawaveId: panelUser.uuid,
        configUrl: panelUser.subscriptionUrl,
      },
    });

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

  private async handleUpdate(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId === null) {
      this.logger.warn(
        `Cannot update: subscription ${subscription.id} has no remnawaveId`,
      );
      return;
    }

    const contacts = await this.namingService.getContactInfo(subscription.userId);
    const planSnapshot = readRecord(subscription.planSnapshot);
    const tag = readOptionalString(planSnapshot, 'tag');
    const trafficLimitStrategy = readOptionalString(planSnapshot, 'trafficLimitStrategy');

    await this.remnawaveApiService.updatePanelUser(subscription.remnawaveId, {
      telegramId: contacts.telegramId ? Number(contacts.telegramId) : null,
      email: contacts.email,
      tag,
      expireAt: subscription.expiresAt?.toISOString(),
      trafficLimitBytes: (subscription.trafficLimit ?? 0) * 1024 * 1024 * 1024,
      hwidDeviceLimit: toPanelDeviceLimit(subscription.deviceLimit),
      trafficLimitStrategy,
      activeInternalSquads: subscription.internalSquads,
      externalSquadUuid: subscription.externalSquad,
    });

    this.logger.log(
      `Updated Remnawave profile '${subscription.remnawaveId}' for subscription ${subscription.id}`,
    );
  }

  private async handleDelete(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId === null) {
      return;
    }

    const result = await this.remnawaveApiService.deletePanelUser(subscription.remnawaveId);
    if (result.isDeleted) {
      this.logger.log(
        `Deleted Remnawave profile '${subscription.remnawaveId}' for subscription ${subscription.id}`,
      );
      // Detach the now-deleted profile from the local row. The row itself is
      // retained (it carries trial-claim history via `isTrial`); only the panel
      // link is cleared so the row no longer references a non-existent profile
      // and re-provisioning (renewal) starts clean. See
      // `.kiro/specs/trial-aware-profile-cleanup`.
      await this.prismaService.subscription.update({
        where: { id: subscription.id },
        data: { remnawaveId: null },
      });
    } else {
      // Leave `remnawaveId` intact so BullMQ retries and the cron backstop can
      // re-attempt; never mutate to an inconsistent state on failure.
      this.logger.warn(
        `Failed to delete Remnawave profile '${subscription.remnawaveId}' (will retry)`,
      );
    }
  }

  private async handleTrafficReset(syncJob: SyncJobRecord): Promise<void> {
    const subscription = syncJob.subscription;
    if (subscription.remnawaveId === null) {
      return;
    }

    await this.remnawaveApiService.resetPanelUserTraffic(subscription.remnawaveId);
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
