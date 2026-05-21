import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ImportStatus, Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ImportSummary } from '../interfaces/import-summary.interface';

/**
 * Shape of a 3x-ui client record as exported from the panel's SQLite/PG DB.
 * Matches the `clients` table + `client_traffics` join.
 */
export interface ThreeXuiClient {
  /** Client email — primary identifier in 3x-ui (label, not real email) */
  readonly email: string;
  /** UUID credential (vmess/vless) */
  readonly uuid: string | null;
  /** Trojan/Shadowsocks password */
  readonly password: string | null;
  /** Subscription ID token for sub URL generation */
  readonly subId: string | null;
  /** Telegram user ID (0 = not set) */
  readonly tgId: number;
  /** Traffic limit in bytes (0 = unlimited) */
  readonly totalGb: number;
  /** Max concurrent IPs (0 = unlimited) */
  readonly limitIp: number;
  /** Unix ms expiry timestamp (0 = never) */
  readonly expiryTime: number;
  /** Whether the client is enabled */
  readonly enable: boolean;
  /** Free-form comment */
  readonly comment: string | null;
  /** Traffic reset period in days (0 = no reset) */
  readonly reset: number;
  /** Upload bytes consumed */
  readonly up: number;
  /** Download bytes consumed */
  readonly down: number;
  /** Inbound remark (human-readable name of the inbound) */
  readonly inboundRemark: string | null;
  /** Inbound protocol (vmess, vless, trojan, shadowsocks, etc.) */
  readonly inboundProtocol: string | null;
  /** Subscription URL (if panel provides it) */
  readonly subscriptionUrl: string | null;
}

interface RunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  readonly clients: readonly ThreeXuiClient[];
}

/**
 * Importer for 3x-ui panel data.
 *
 * Expects a JSON array of client records (exported from 3x-ui's
 * `clients` + `client_traffics` tables).
 *
 * Matching priority:
 *   1. tgId > 0 → match by telegramId
 *   2. email looks like a real email → match by email
 *   3. No match → create new User (import mode only)
 *
 * After matching/creating a User:
 *   - Creates or updates a Subscription with planSnapshot.importedFrom = '3xui'
 */
@Injectable()
export class ThreeXuiImporterService {
  private readonly logger = new Logger(ThreeXuiImporterService.name);

  public async run(input: RunInput): Promise<ImportSummary> {
    const { clients, mode, createdBy } = input;

    if (!clients || clients.length === 0) {
      throw new BadRequestException('No client records provided');
    }

    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let subscriptionsCreated = 0;
    let subscriptionsUpdated = 0;

    for (const client of clients) {
      try {
        const userId = await this.matchOrCreateUser(client, mode);
        if (userId === null) {
          skipped += 1;
          continue;
        }

        const wasCreated = await this.wasJustCreated(userId);
        if (wasCreated) {
          created += 1;
        } else {
          updated += 1;
        }

        const subResult = await this.syncSubscription(userId, client);
        if (subResult === 'created') subscriptionsCreated += 1;
        if (subResult === 'updated') subscriptionsUpdated += 1;
      } catch (err) {
        const identifier = client.email || client.subId || 'unknown';
        const message = `${identifier}: ${(err as Error).message}`;
        errors.push(message);
        this.logger.warn(`3x-ui importer row failed: ${message}`);
      }
    }

    const importRecord = await this.prismaService.importRecord.create({
      data: {
        filename: `3xui-${mode}-${new Date().toISOString()}.json`,
        sourceType: '3xui',
        status: errors.length === 0 ? ImportStatus.COMMITTED : ImportStatus.FAILED,
        recordsTotal: clients.length,
        recordsOk: created + updated,
        recordsFailed: errors.length,
        result: {
          mode,
          fetched: clients.length,
          created,
          updated,
          skipped,
          subscriptionsCreated,
          subscriptionsUpdated,
          errors,
        } satisfies Prisma.InputJsonValue,
        errorMessage: errors.length === 0 ? null : errors.slice(0, 5).join('; '),
        createdBy,
        committedAt: new Date(),
      },
    });

    return {
      importRecordId: importRecord.id,
      fetched: clients.length,
      created,
      updated,
      skipped,
      subscriptionsCreated,
      subscriptionsUpdated,
      errors,
    };
  }

  public constructor(private readonly prismaService: PrismaService) {}

  // ── User matching ─────────────────────────────────────────────────────────

  private async matchOrCreateUser(
    client: ThreeXuiClient,
    mode: 'import' | 'sync',
  ): Promise<string | null> {
    // Priority 1: Telegram ID
    if (client.tgId > 0) {
      const user = await this.prismaService.user.findUnique({
        where: { telegramId: BigInt(client.tgId) },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, client);
        return user.id;
      }
    }

    // Priority 2: email (only if it looks like a real email)
    if (client.email && this.isRealEmail(client.email)) {
      const user = await this.prismaService.user.findUnique({
        where: { email: client.email },
        select: { id: true },
      });
      if (user) {
        await this.updateUserFields(user.id, client);
        return user.id;
      }
    }

    // Priority 3: No match — create (import mode only)
    if (mode === 'sync') {
      return null;
    }

    const newUser = await this.prismaService.user.create({
      data: {
        telegramId: client.tgId > 0 ? BigInt(client.tgId) : null,
        email: this.isRealEmail(client.email) ? client.email : null,
        name: client.comment || client.email || `3xui-${client.subId?.slice(0, 8) ?? 'user'}`,
      },
    });
    return newUser.id;
  }

  private async updateUserFields(userId: string, client: ThreeXuiClient): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (client.tgId > 0) data.telegramId = BigInt(client.tgId);
    if (client.comment) data.name = client.comment;
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
    return Date.now() - user.createdAt.getTime() < 5000;
  }

  // ── Subscription sync ─────────────────────────────────────────────────────

  private async syncSubscription(
    userId: string,
    client: ThreeXuiClient,
  ): Promise<'created' | 'updated' | 'skipped'> {
    // Use subId as the unique identifier for the subscription from 3x-ui
    const externalId = client.subId || client.uuid || client.email;
    if (!externalId) return 'skipped';

    // Look for existing subscription imported from 3x-ui with matching configUrl or planSnapshot
    const existing = await this.prismaService.subscription.findFirst({
      where: {
        userId,
        planSnapshot: { path: ['importedFrom'], equals: '3xui' },
        configUrl: client.subscriptionUrl || undefined,
      },
      select: { id: true },
    });

    const status = this.mapStatus(client);
    const trafficLimitGb = client.totalGb > 0
      ? Math.round(client.totalGb / (1024 * 1024 * 1024))
      : null;
    const expiresAt = client.expiryTime > 0
      ? new Date(client.expiryTime)
      : null;

    const planSnapshot: Prisma.InputJsonValue = {
      importedFrom: '3xui',
      email: client.email,
      subId: client.subId,
      uuid: client.uuid,
      inboundRemark: client.inboundRemark,
      inboundProtocol: client.inboundProtocol,
      trafficResetDays: client.reset,
    };

    if (existing) {
      await this.prismaService.subscription.update({
        where: { id: existing.id },
        data: {
          status,
          trafficLimit: trafficLimitGb,
          deviceLimit: client.limitIp,
          configUrl: client.subscriptionUrl || null,
          expiresAt,
          planSnapshot,
        },
      });
      return 'updated';
    }

    const sub = await this.prismaService.subscription.create({
      data: {
        user: { connect: { id: userId } },
        status,
        trafficLimit: trafficLimitGb,
        deviceLimit: client.limitIp,
        configUrl: client.subscriptionUrl || null,
        expiresAt,
        startedAt: new Date(),
        planSnapshot,
      },
    });

    // Set as current subscription if user doesn't have one
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { currentSubscriptionId: true },
    });
    if (!user?.currentSubscriptionId) {
      await this.prismaService.user.update({
        where: { id: userId },
        data: { currentSubscriptionId: sub.id },
      });
    }

    return 'created';
  }

  private mapStatus(client: ThreeXuiClient): SubscriptionStatus {
    if (!client.enable) return SubscriptionStatus.DISABLED;
    if (client.expiryTime > 0 && client.expiryTime < Date.now()) {
      return SubscriptionStatus.EXPIRED;
    }
    if (client.totalGb > 0 && (client.up + client.down) >= client.totalGb) {
      return SubscriptionStatus.LIMITED;
    }
    return SubscriptionStatus.ACTIVE;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private isRealEmail(value: string | null | undefined): value is string {
    if (!value) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
}
