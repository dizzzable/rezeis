import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ImportStatus, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  RemnawaveApiService,
  RemnawavePanelUser,
} from '../../remnawave/services/remnawave-api.service';

export interface RemnawaveImportSummary {
  readonly importRecordId: string;
  readonly fetched: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly subscriptionsCreated: number;
  readonly subscriptionsUpdated: number;
  readonly descriptionWritebacks: number;
  readonly errors: readonly string[];
}

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
}

const REIWA_ID_REGEX = /reiwa_id:\s*([a-z0-9]+)/i;

/**
 * Two-way Remnawave importer/synchronizer.
 *
 * Matching priority (first hit wins):
 *   1. description contains "reiwa_id: {cuid}" → exact match by PK
 *   2. telegramId → unique match
 *   3. email → unique match
 *   4. existing Subscription.remnawaveId → recovers web-only users that
 *      have no Telegram/email but were previously linked through import.
 *      Without this step every re-import would create a fresh duplicate
 *      User row for them since their only handle is `WebAccount.login`,
 *      which Remnawave knows nothing about.
 *   5. No match → create new User (import mode only; sync skips)
 *
 * After matching/creating a User:
 *   - Creates or updates a Subscription with remnawaveId = panelUser.uuid
 *   - Writes back "reiwa_id: {user.id}" into Remnawave description (if missing)
 */
@Injectable()
export class RemnawaveImporterService {
  private readonly logger = new Logger(RemnawaveImporterService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async run(input: RunInput): Promise<RemnawaveImportSummary> {
    let panelUsers: RemnawavePanelUser[];
    try {
      panelUsers = await this.remnawaveApiService.getAllPanelUsers();
    } catch (err) {
      this.logger.error(`getAllPanelUsers failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('REMNAWAVE_INTEGRATION_UNAVAILABLE');
    }

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;
    let descriptionWritebacks = 0;

    for (const panelUser of panelUsers) {
      try {
        const userId = await this.matchOrCreateUser(panelUser, input.mode);
        if (userId === null) {
          skipped += 1;
          continue;
        }

        // Check if this was a creation or update
        const wasCreated = await this.wasJustCreated(userId);
        if (wasCreated) {
          created += 1;
        } else {
          updated += 1;
        }

        // ── Subscription sync ─────────────────────────────────────────────
        const subResult = await this.syncSubscription(userId, panelUser);
        if (subResult === 'created') subscriptionsCreated += 1;
        if (subResult === 'updated') subscriptionsUpdated += 1;

        // ── Write back reiwa_id to Remnawave description ──────────────────
        const wroteBack = await this.writeBackReiwaId(userId, panelUser);
        if (wroteBack) descriptionWritebacks += 1;
      } catch (err) {
        const identifier = panelUser.telegramId ?? panelUser.username ?? panelUser.uuid;
        const message = `${identifier}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`Importer row failed: ${message}`);
      }
    }

    const importRecord = await this.prismaService.importRecord.create({
      data: {
        filename: `remnawave-${input.mode}-${new Date().toISOString()}.json`,
        sourceType: 'remnawave',
        status: errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED,
        recordsTotal: panelUsers.length,
        recordsOk: created + updated,
        recordsFailed: errors.length,
        result: {
          mode: input.mode,
          fetched: panelUsers.length,
          created,
          updated,
          skipped,
          subscriptionsCreated,
          subscriptionsUpdated,
          descriptionWritebacks,
          errors,
        } satisfies Prisma.InputJsonValue,
        errorMessage: errors.length === 0 ? null : errors.slice(0, 5).join('; '),
        createdBy: input.createdBy,
        committedAt: new Date(),
      },
    });

    return {
      importRecordId: importRecord.id,
      fetched: panelUsers.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      descriptionWritebacks,
      errors,
    };
  }

  // ── User matching ─────────────────────────────────────────────────────────

  /**
   * Match a Remnawave panel user to a local User, or create one.
   * Returns the local User ID, or null if skipped.
   */
  private async matchOrCreateUser(
    panelUser: RemnawavePanelUser,
    mode: 'import' | 'sync',
  ): Promise<string | null> {
    // Priority 1: reiwa_id in description
    const reiwaIdMatch = panelUser.description?.match(REIWA_ID_REGEX);
    if (reiwaIdMatch) {
      const reiwaId = reiwaIdMatch[1];
      const user = await this.prismaService.user.findUnique({
        where: { id: reiwaId },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, panelUser);
        return user.id;
      }
      // reiwa_id in description but user not found locally — fall through
    }

    // Priority 2: telegramId
    if (panelUser.telegramId !== null) {
      const telegramIdBigInt = BigInt(panelUser.telegramId);
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: telegramIdBigInt },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, panelUser);
        return user.id;
      }
    }

    // Priority 3: email
    if (panelUser.email) {
      const user = await this.prismaService.user.findUnique({
        where: { email: panelUser.email },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, panelUser);
        return user.id;
      }
    }

    // Priority 4: existing Subscription that already points to this
    // Remnawave UUID. This catches the realistic case where a user
    // signed up through the web cabinet (no Telegram, no email — only
    // a WebAccount.login) and was previously linked through `import`.
    // Without this priority, every subsequent `import` would create a
    // brand-new User dupe because there's no other way to identify a
    // web-only customer from the panel side.
    const existingSub = await this.prismaService.subscription.findFirst({
      where: { remnawaveId: panelUser.uuid },
      select: { userId: true },
    });
    if (existingSub) {
      await this.updateUserFields(existingSub.userId, panelUser);
      return existingSub.userId;
    }

    // Priority 5: No match — create (import mode only)
    if (mode === 'sync') {
      return null;
    }

    const newUser = await this.prismaService.user.create({
      data: {
        telegramId: panelUser.telegramId !== null ? BigInt(panelUser.telegramId) : null,
        username: panelUser.username || null,
        email: panelUser.email || null,
        name: panelUser.username || panelUser.uuid.slice(0, 8),
      },
    });
    return newUser.id;
  }

  private async updateUserFields(userId: string, panelUser: RemnawavePanelUser): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (panelUser.username) data.username = panelUser.username;
    if (panelUser.email) data.email = panelUser.email;
    if (panelUser.telegramId !== null) data.telegramId = BigInt(panelUser.telegramId);
    if (Object.keys(data).length > 0) {
      await this.prismaService.user.update({ where: { id: userId }, data });
    }
  }

  private async wasJustCreated(userId: string): Promise<boolean> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    if (!user) return false;
    // If created within last 5 seconds, it was just created by us
    return Date.now() - user.createdAt.getTime() < 5000;
  }

  // ── Subscription sync ─────────────────────────────────────────────────────

  /**
   * Create or update a Subscription linked to the Remnawave profile.
   */
  private async syncSubscription(
    userId: string,
    panelUser: RemnawavePanelUser,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // Check if subscription with this remnawaveId already exists
    const existing = await this.prismaService.subscription.findFirst({
      where: { remnawaveId: panelUser.uuid },
      select: { id: true, userId: true },
    });

    const status = this.mapStatus(panelUser.status);
    const trafficLimitGb = panelUser.trafficLimitBytes > 0
      ? Math.round(panelUser.trafficLimitBytes / (1024 * 1024 * 1024))
      : null;
    const expiresAt = panelUser.expireAt ? new Date(panelUser.expireAt) : null;

    const subscriptionData: Prisma.SubscriptionUpdateInput = {
      status,
      trafficLimit: trafficLimitGb,
      deviceLimit: panelUser.hwidDeviceLimit,
      configUrl: panelUser.subscriptionUrl || null,
      expiresAt,
      internalSquads: panelUser.activeInternalSquads?.map((s) => s.uuid) ?? [],
      externalSquad: panelUser.externalSquadUuid ?? null,
      planSnapshot: {
        importedFrom: 'remnawave',
        tag: panelUser.tag,
        trafficLimitStrategy: panelUser.trafficLimitStrategy,
      } satisfies Prisma.InputJsonValue,
    };

    if (existing) {
      // Update existing subscription
      await this.prismaService.subscription.update({
        where: { id: existing.id },
        data: subscriptionData,
      });
      // If subscription belongs to a different user (edge case: user was re-matched)
      if (existing.userId !== userId) {
        await this.prismaService.subscription.update({
          where: { id: existing.id },
          data: { user: { connect: { id: userId } } },
        });
      }
      return 'updated';
    }

    // Create new subscription
    await this.prismaService.subscription.create({
      data: {
        user: { connect: { id: userId } },
        remnawaveId: panelUser.uuid,
        status,
        trafficLimit: trafficLimitGb,
        deviceLimit: panelUser.hwidDeviceLimit,
        configUrl: panelUser.subscriptionUrl || null,
        expiresAt,
        startedAt: new Date(),
        internalSquads: panelUser.activeInternalSquads?.map((s) => s.uuid) ?? [],
        externalSquad: panelUser.externalSquadUuid ?? null,
        planSnapshot: {
          importedFrom: 'remnawave',
          tag: panelUser.tag,
          trafficLimitStrategy: panelUser.trafficLimitStrategy,
        } satisfies Prisma.InputJsonValue,
      },
    });

    // Set as current subscription if user doesn't have one
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { currentSubscriptionId: true },
    });
    if (!user?.currentSubscriptionId) {
      const sub = await this.prismaService.subscription.findFirst({
        where: { userId, remnawaveId: panelUser.uuid },
        select: { id: true },
      });
      if (sub) {
        await this.prismaService.user.update({
          where: { id: userId },
          data: { currentSubscriptionId: sub.id },
        });
      }
    }

    return 'created';
  }

  private mapStatus(remnawaveStatus: string): SubscriptionStatus {
    switch (remnawaveStatus.toUpperCase()) {
      case 'ACTIVE': return SubscriptionStatus.ACTIVE;
      case 'DISABLED': return SubscriptionStatus.DISABLED;
      case 'LIMITED': return SubscriptionStatus.LIMITED;
      case 'EXPIRED': return SubscriptionStatus.EXPIRED;
      case 'DELETED': return SubscriptionStatus.DELETED;
      default: return SubscriptionStatus.ACTIVE;
    }
  }

  // ── Write-back reiwa_id to Remnawave ──────────────────────────────────────

  /**
   * If the Remnawave profile's description doesn't contain reiwa_id,
   * write it back so future syncs can match instantly.
   *
   * Returns:
   *   true  — successfully wrote reiwa_id
   *   false — already had reiwa_id, nothing to do
   *
   * On API failure: throws so the caller can record the error against
   * this row instead of silently swallowing the failure (which is what
   * caused descriptionWritebacks=0 for every import on Remnawave 2.7.x
   * before the contract URL fix).
   */
  private async writeBackReiwaId(
    userId: string,
    panelUser: RemnawavePanelUser,
  ): Promise<boolean> {
    const currentDescription = panelUser.description ?? '';
    if (REIWA_ID_REGEX.test(currentDescription)) {
      // Already has reiwa_id — nothing to do
      return false;
    }

    const newDescription = currentDescription.length > 0
      ? `${currentDescription}\nreiwa_id: ${userId}`
      : `reiwa_id: ${userId}`;

    await this.remnawaveApiService.updatePanelUser(panelUser.uuid, {
      description: newDescription,
    });
    return true;
  }
}
