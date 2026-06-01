import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, BadRequestException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, Settings } from '@prisma/client';
import { ConfigType } from '@nestjs/config';

import { paymentsConfig } from '../../../common/config/payments.config';
import {
  PaymentOpsAlertSettingsInterface,
} from '../../../common/interfaces/payment-ops-alert-settings.interface';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  mergePaymentOpsAlertSettings,
  readPaymentOpsAlertSettings,
} from '../../../common/utils/payment-ops-alert-settings.util';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { UpdateBrandingSettingsDto } from '../dto/update-branding-settings.dto';
import { UpdateCustomIconsDto } from '../dto/custom-icons.dto';
import {
  SendPaymentOpsAlertTestDto,
  UpdatePaymentOpsAlertSettingsDto,
} from '../dto/update-payment-ops-alert-settings.dto';
import { UpdatePlatformSettingsDto } from '../dto/update-platform-settings.dto';
import {
  BrandingSettingsInterface,
} from '../interfaces/branding-settings.interface';
import { CustomIconInterface } from '../interfaces/custom-icon.interface';
import { InternalPlatformPolicyInterface } from '../interfaces/internal-platform-policy.interface';
import { PlatformSettingsInterface } from '../interfaces/platform-settings.interface';
import {
  mergeBrandingSettings,
  readBrandingSettings,
} from '../utils/branding-settings.util';
import { readCustomIcons } from '../utils/custom-icons.util';
import { IconUploadService } from './icon-upload.service';

interface UpdatePlatformSettingsInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updatePlatformSettingsDto: UpdatePlatformSettingsDto;
}

interface UpdateNotificationsTogglesInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly userNotifications?: Record<string, unknown>;
  readonly systemNotifications?: Record<string, unknown>;
}

interface UpdateTelegramDeliveryInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly enabled?: boolean;
  readonly chatId?: string | null;
  readonly topicId?: number | null;
  readonly topics?: Record<string, number | null>;
  readonly mirrorUserNotifications?: boolean;
}

interface SendTelegramDeliveryTestInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly note?: string | null;
}

interface UpdatePaymentOpsAlertSettingsInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updatePaymentOpsAlertSettingsDto: UpdatePaymentOpsAlertSettingsDto;
}

interface SendPaymentOpsAlertTestInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly sendPaymentOpsAlertTestDto: SendPaymentOpsAlertTestDto;
}

interface UpdateBrandingSettingsInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updateBrandingSettingsDto: UpdateBrandingSettingsDto;
}

interface UpdateReferralSettingsInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  /**
   * Partial update — any subset of the `referralSettings` JSON. Top-level
   * keys are merged shallow-deep (`pointsExchange`, `inviteLimits` are
   * spread, other keys are replaced wholesale).
   */
  readonly patch: Record<string, unknown>;
}

interface UpdatePartnerSettingsInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  /**
   * Partial update — any subset of the `partnerSettings` JSON. Top-level
   * keys are merged shallow-deep so the SPA can submit one section
   * (e.g. just commissions) without blowing away the rest.
   */
  readonly patch: Record<string, unknown>;
}

interface UpdateCustomIconsInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  /** Full replacement list of the operator's custom icon library. */
  readonly icons: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly color?: string | null;
  }>;
}

interface UpdatePlatformSettingsChanges {
  readonly updatedFields: readonly string[];
  readonly data: Prisma.SettingsUpdateInput;
}

type SettingsClient = Prisma.TransactionClient | PrismaService;

const DEFAULT_INTERNAL_PLATFORM_POLICY: InternalPlatformPolicyInterface = {
  rulesRequired: true,
  rulesLink: null,
  channelRequired: false,
  channelLink: null,
  accessMode: 'PUBLIC',
  inviteModeStartedAt: null,
  defaultCurrency: 'USD',
};

/**
 * Handles singleton platform settings reads and updates.
 */
@Injectable()
export class SettingsService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly iconUploadService: IconUploadService,
    @Optional()
    private readonly httpService?: HttpService,
    @Inject(paymentsConfig.KEY)
    @Optional()
    private readonly paymentConfiguration?: ConfigType<typeof paymentsConfig>,
  ) {}

  /**
   * Returns the singleton platform settings record, creating defaults when missing.
   */
  public async getPlatformSettings(): Promise<PlatformSettingsInterface> {
    const settings: Settings = await this.getOrCreateSettingsRecord(this.prismaService);
    return mapPlatformSettings(settings);
  }

  public async getPaymentOpsAlertSettings(): Promise<PaymentOpsAlertSettingsInterface> {
    const settings = await this.getOrCreateSettingsRecord(this.prismaService);
    return readPaymentOpsAlertSettings(settings.systemNotifications);
  }

  public async updatePaymentOpsAlertSettings(
    input: UpdatePaymentOpsAlertSettingsInput,
  ): Promise<PaymentOpsAlertSettingsInterface> {
    const settings = await this.prismaService.$transaction(
      async (transactionClient: Prisma.TransactionClient): Promise<Settings> => {
        const existingSettings = await this.getOrCreateSettingsRecord(transactionClient);
        const nextSystemNotifications = mergePaymentOpsAlertSettings({
          systemNotifications: existingSettings.systemNotifications,
          patch: input.updatePaymentOpsAlertSettingsDto,
        });
        const nextAlertSettings = readPaymentOpsAlertSettings(nextSystemNotifications);
        validatePaymentOpsAlertSettings(nextAlertSettings);

        const updatedSettings = await transactionClient.settings.update({
          where: { id: existingSettings.id },
          data: {
            systemNotifications: nextSystemNotifications as Prisma.InputJsonValue,
          },
        });
        await transactionClient.adminAuditLog.create({
          data: {
            action: 'settings.paymentOpsAlert.updated',
            ipAddress: input.requestMetadata.remoteAddress,
            userAgent: input.requestMetadata.userAgent,
            metadata: buildAuditMetadata({
              requestId: input.requestMetadata.requestId,
              updatedFields: extractUpdatedPaymentOpsFields(
                input.updatePaymentOpsAlertSettingsDto,
              ),
            }),
            adminUser: { connect: { id: input.currentAdmin.id } },
          },
        });
        return updatedSettings;
      },
    );
    return readPaymentOpsAlertSettings(settings.systemNotifications);
  }

  public async sendPaymentOpsAlertTest(
    input: SendPaymentOpsAlertTestInput,
  ): Promise<void> {
    const settings = await this.getPaymentOpsAlertSettings();
    if (settings.chatId === null) {
      throw new BadRequestException('PAYMENT_OPS_ALERT_CHAT_NOT_CONFIGURED');
    }
    const botToken = this.paymentConfiguration?.botToken ?? null;
    if (botToken === null) {
      throw new ServiceUnavailableException('BOT_TOKEN is not configured');
    }
    if (this.httpService === undefined) {
      throw new ServiceUnavailableException('HTTP client is not configured');
    }
    const message = buildPaymentOpsAlertTestMessage({
      settings,
      note: input.sendPaymentOpsAlertTestDto.note ?? null,
      adminId: input.currentAdmin.id,
    });
    const payload: Record<string, unknown> = {
      chat_id: settings.chatId,
      text: message,
      disable_web_page_preview: true,
    };
    if (settings.threadId !== null) {
      payload.message_thread_id = Number(settings.threadId);
    }
    await firstValueFrom(
      this.httpService.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        payload,
      ),
    );
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'payments.alert.test.sent',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          chatId: settings.chatId,
          threadId: settings.threadId,
        },
        adminUser: { connect: { id: input.currentAdmin.id } },
      } as never,
    });
  }

  /**
   * Returns the internal read-only platform policy payload for the user edge.
   */
  public async getInternalPlatformPolicy(): Promise<InternalPlatformPolicyInterface> {
    const settings: Settings | null = await this.getSettingsRecord(this.prismaService);
    if (settings === null) {
      return DEFAULT_INTERNAL_PLATFORM_POLICY;
    }
    return mapInternalPlatformPolicy(settings);
  }

  /**
   * Returns the current branding payload, falling back to safe defaults when
   * no settings record exists yet (very first install).
   */
  public async getBrandingSettings(): Promise<BrandingSettingsInterface> {
    const settings = await this.getSettingsRecord(this.prismaService);
    return readBrandingSettings(settings?.brandingSettings ?? null);
  }

  /**
   * Applies a partial branding update. Records an audit log entry tracking
   * which branding fields were modified.
   */
  public async updateBrandingSettings(
    input: UpdateBrandingSettingsInput,
  ): Promise<BrandingSettingsInterface> {
    const updatedFields = extractUpdatedBrandingFields(input.updateBrandingSettingsDto);
    if (updatedFields.length === 0) {
      return this.getBrandingSettings();
    }

    const settings = await this.prismaService.$transaction(
      async (transactionClient: Prisma.TransactionClient): Promise<Settings> => {
        const existing = await this.getOrCreateSettingsRecord(transactionClient);
        const merged = mergeBrandingSettings({
          existing: existing.brandingSettings,
          patch: input.updateBrandingSettingsDto,
        });
        const updated = await transactionClient.settings.update({
          where: { id: existing.id },
          data: {
            brandingSettings: merged as Prisma.InputJsonValue,
          },
        });
        await transactionClient.adminAuditLog.create({
          data: {
            action: 'settings.branding.updated',
            ipAddress: input.requestMetadata.remoteAddress,
            userAgent: input.requestMetadata.userAgent,
            metadata: buildAuditMetadata({
              requestId: input.requestMetadata.requestId,
              updatedFields,
            }),
            adminUser: { connect: { id: input.currentAdmin.id } },
          },
        });
        return updated;
      },
    );
    return readBrandingSettings(settings.brandingSettings);
  }

  /**
   * Applies a partial platform settings update and records an audit log entry.
   */
  public async updatePlatformSettings(
    input: UpdatePlatformSettingsInput,
  ): Promise<PlatformSettingsInterface> {
    const updateChanges: UpdatePlatformSettingsChanges = buildSettingsUpdateChanges(
      input.updatePlatformSettingsDto,
    );
    if (updateChanges.updatedFields.length === 0) {
      const settings: Settings = await this.getOrCreateSettingsRecord(this.prismaService);
      return mapPlatformSettings(settings);
    }
    const settings: Settings = await this.prismaService.$transaction(
      async (transactionClient: Prisma.TransactionClient): Promise<Settings> => {
        const existingSettings: Settings = await this.getOrCreateSettingsRecord(transactionClient);
        const updatedSettings: Settings = await transactionClient.settings.update({
          where: { id: existingSettings.id },
          data: updateChanges.data,
        });
        await transactionClient.adminAuditLog.create({
          data: {
            action: 'settings.platform.updated',
            ipAddress: input.requestMetadata.remoteAddress,
            userAgent: input.requestMetadata.userAgent,
            metadata: buildAuditMetadata({
              requestId: input.requestMetadata.requestId,
              updatedFields: updateChanges.updatedFields,
            }),
            adminUser: { connect: { id: input.currentAdmin.id } },
          },
        });
        return updatedSettings;
      },
    );
    return mapPlatformSettings(settings);
  }

  /**
   * Returns a flattened "everything" snapshot used by the React notifications
   * page. It folds the singleton `settings` row into a single JSON object so
   * the frontend can hydrate every panel from one request without making the
   * UI aware of the DB shape.
   */
  public async getOverview(): Promise<{
    readonly userNotifications: Record<string, unknown>;
    readonly systemNotifications: Record<string, unknown>;
    readonly platform: PlatformSettingsInterface;
    readonly branding: BrandingSettingsInterface;
    readonly paymentOpsAlerts: PaymentOpsAlertSettingsInterface;
    readonly multiSubscriptionSettings: Record<string, unknown>;
  }> {
    const settings = await this.getOrCreateSettingsRecord(this.prismaService);
    return {
      userNotifications: readJsonObject(settings.userNotifications),
      systemNotifications: readJsonObject(settings.systemNotifications),
      platform: mapPlatformSettings(settings),
      branding: readBrandingSettings(settings.brandingSettings),
      paymentOpsAlerts: readPaymentOpsAlertSettings(settings.systemNotifications),
      multiSubscriptionSettings: readJsonObject(settings.multiSubscriptionSettings),
    };
  }

  /**
   * Merge-updates the boolean toggles for end-user and/or operator
   * notifications. Either branch may be partially supplied — keys absent
   * from the patch keep their previous values.
   */
  public async updateNotificationToggles(
    input: UpdateNotificationsTogglesInput,
  ): Promise<{
    readonly userNotifications: Record<string, unknown>;
    readonly systemNotifications: Record<string, unknown>;
  }> {
    if (input.userNotifications === undefined && input.systemNotifications === undefined) {
      const current = await this.getOrCreateSettingsRecord(this.prismaService);
      return {
        userNotifications: readJsonObject(current.userNotifications),
        systemNotifications: readJsonObject(current.systemNotifications),
      };
    }
    const settings = await this.prismaService.$transaction(
      async (transactionClient: Prisma.TransactionClient): Promise<Settings> => {
        const existing = await this.getOrCreateSettingsRecord(transactionClient);
        const data: Prisma.SettingsUpdateInput = {};
        const updatedFields: string[] = [];
        if (input.userNotifications !== undefined) {
          const merged = mergeJsonObject(existing.userNotifications, input.userNotifications);
          data.userNotifications = merged as Prisma.InputJsonValue;
          updatedFields.push('userNotifications');
        }
        if (input.systemNotifications !== undefined) {
          const merged = mergeJsonObject(existing.systemNotifications, input.systemNotifications);
          data.systemNotifications = merged as Prisma.InputJsonValue;
          updatedFields.push('systemNotifications');
        }
        const updated = await transactionClient.settings.update({
          where: { id: existing.id },
          data,
        });
        await transactionClient.adminAuditLog.create({
          data: {
            action: 'settings.notifications.updated',
            ipAddress: input.requestMetadata.remoteAddress,
            userAgent: input.requestMetadata.userAgent,
            metadata: buildAuditMetadata({
              requestId: input.requestMetadata.requestId,
              updatedFields,
            }),
            adminUser: { connect: { id: input.currentAdmin.id } },
          },
        });
        return updated;
      },
    );
    return {
      userNotifications: readJsonObject(settings.userNotifications),
      systemNotifications: readJsonObject(settings.systemNotifications),
    };
  }

  /**
   * Updates the Telegram delivery configuration nested under the
   * `systemNotifications.telegram` key. Per-category routing is merge-only —
   * categories not present in the patch retain their existing topic id.
   */
  public async updateTelegramDelivery(
    input: UpdateTelegramDeliveryInput,
  ): Promise<TelegramDeliveryConfig> {
    const settings = await this.prismaService.$transaction(
      async (transactionClient: Prisma.TransactionClient): Promise<Settings> => {
        const existing = await this.getOrCreateSettingsRecord(transactionClient);
        const systemNotifications = readJsonObject(existing.systemNotifications);
        const previousTelegram = readJsonObject(systemNotifications.telegram);
        const previousTopics = readJsonObject(previousTelegram.topics);

        const nextTelegram: Record<string, unknown> = { ...previousTelegram };
        const updatedFields: string[] = [];

        if (input.enabled !== undefined) {
          nextTelegram.enabled = input.enabled;
          updatedFields.push('enabled');
        }
        if (input.chatId !== undefined) {
          nextTelegram.chatId = input.chatId === null || input.chatId === '' ? null : input.chatId;
          updatedFields.push('chatId');
        }
        if (input.topicId !== undefined) {
          nextTelegram.topicId = input.topicId;
          updatedFields.push('topicId');
        }
        if (input.topics !== undefined) {
          const mergedTopics: Record<string, number | null> = {};
          for (const [key, value] of Object.entries(previousTopics)) {
            if (typeof value === 'number') {
              mergedTopics[key] = value;
            }
          }
          for (const [key, value] of Object.entries(input.topics)) {
            mergedTopics[key.toUpperCase()] = value;
          }
          nextTelegram.topics = mergedTopics;
          updatedFields.push('topics');
        }
        if (input.mirrorUserNotifications !== undefined) {
          nextTelegram.mirrorUserNotifications = input.mirrorUserNotifications;
          updatedFields.push('mirrorUserNotifications');
        }

        if (nextTelegram.enabled === true && (nextTelegram.chatId === null || nextTelegram.chatId === undefined)) {
          throw new BadRequestException('TELEGRAM_DELIVERY_CHAT_REQUIRED');
        }

        const updated = await transactionClient.settings.update({
          where: { id: existing.id },
          data: {
            systemNotifications: {
              ...systemNotifications,
              telegram: nextTelegram,
            } as Prisma.InputJsonValue,
          },
        });
        await transactionClient.adminAuditLog.create({
          data: {
            action: 'settings.telegramDelivery.updated',
            ipAddress: input.requestMetadata.remoteAddress,
            userAgent: input.requestMetadata.userAgent,
            metadata: buildAuditMetadata({
              requestId: input.requestMetadata.requestId,
              updatedFields,
            }),
            adminUser: { connect: { id: input.currentAdmin.id } },
          },
        });
        return updated;
      },
    );
    return readTelegramDeliveryConfig(settings.systemNotifications);
  }

  /**
   * Read-only accessor for the Telegram delivery config. Consumed by
   * `UserNotificationsService` to decide whether to mirror user
   * notifications into the operator chat (variant A — one Telegram
   * delivery surface instead of a separate broadcast-channels table).
   */
  public async getTelegramDeliveryConfig(): Promise<TelegramDeliveryConfig> {
    const settings = await this.getOrCreateSettingsRecord(this.prismaService);
    return readTelegramDeliveryConfig(settings.systemNotifications);
  }

  public async sendTelegramDeliveryTest(input: SendTelegramDeliveryTestInput): Promise<void> {
    const config = readTelegramDeliveryConfig(
      (await this.getOrCreateSettingsRecord(this.prismaService)).systemNotifications,
    );
    if (!config.enabled || config.chatId === null) {
      throw new BadRequestException('TELEGRAM_DELIVERY_NOT_CONFIGURED');
    }
    const botToken = this.paymentConfiguration?.botToken ?? null;
    if (botToken === null) {
      throw new ServiceUnavailableException('BOT_TOKEN is not configured');
    }
    if (this.httpService === undefined) {
      throw new ServiceUnavailableException('HTTP client is not configured');
    }
    const note = input.note?.trim() ?? '';
    const lines = [
      'Rezeis admin · test alert',
      `admin_id: ${input.currentAdmin.id}`,
      `chat_id: ${config.chatId}`,
      config.topicId === null ? null : `default_topic: ${config.topicId}`,
      note.length > 0 ? `note: ${note.slice(0, 200)}` : null,
    ].filter((line): line is string => line !== null);
    const payload: Record<string, unknown> = {
      chat_id: config.chatId,
      text: lines.join('\n'),
      disable_web_page_preview: true,
    };
    if (config.topicId !== null) {
      payload.message_thread_id = config.topicId;
    }
    await firstValueFrom(
      this.httpService.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        payload,
      ),
    );
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'settings.telegramDelivery.test.sent',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          chatId: config.chatId,
          topicId: config.topicId,
        },
        adminUser: { connect: { id: input.currentAdmin.id } },
      } as never,
    });
  }

  private async getOrCreateSettingsRecord(settingsClient: SettingsClient): Promise<Settings> {
    const existingSettings: Settings | null = await this.getSettingsRecord(settingsClient);
    if (existingSettings) {
      return existingSettings;
    }
    return settingsClient.settings.create({
      data: {},
    });
  }

  /**
   * Partial-update the `referralSettings` JSON column. Backs the SPA
   * "Settings" tab on the Referrals page. The patch is merged
   * shallow-deep over the existing JSON: top-level keys are replaced,
   * `pointsExchange` and `inviteLimits` are spread one level deeper so
   * a partial sub-object does not blow away unrelated knobs.
   */
  public async updateReferralSettings(
    input: UpdateReferralSettingsInput,
  ): Promise<Record<string, unknown>> {
    return this.prismaService.$transaction(async (tx) => {
      const settings = await this.getOrCreateSettingsRecord(tx);
      const previous = readJsonObject(settings.referralSettings);
      const next = mergeReferralSettings(previous, input.patch);
      await tx.settings.update({
        where: { id: settings.id },
        data: { referralSettings: next as unknown as Prisma.InputJsonValue },
      });
      await tx.adminAuditLog.create({
        data: {
          action: 'settings.referralSettings.update',
          ipAddress: input.requestMetadata.remoteAddress,
          userAgent: input.requestMetadata.userAgent,
          metadata: {
            requestId: input.requestMetadata.requestId,
            patchKeys: Object.keys(input.patch),
          },
          adminUser: { connect: { id: input.currentAdmin.id } },
        } as never,
      });
      return next;
    });
  }

  public async getReferralSettings(): Promise<Record<string, unknown>> {
    const settings = await this.getSettingsRecord(this.prismaService);
    if (!settings) return {};
    return readJsonObject(settings.referralSettings);
  }

  /**
   * Partial-update the `partnerSettings` JSON column. Backs the SPA
   * "Settings" tab on the Partners page. Top-level keys are merged
   * shallow-deep so a subsection patch (e.g. just gateway commissions)
   * does not erase unrelated knobs.
   */
  public async updatePartnerSettings(
    input: UpdatePartnerSettingsInput,
  ): Promise<Record<string, unknown>> {
    return this.prismaService.$transaction(async (tx) => {
      const settings = await this.getOrCreateSettingsRecord(tx);
      const previous = readJsonObject(settings.partnerSettings);
      const next = mergePartnerSettings(previous, input.patch);
      await tx.settings.update({
        where: { id: settings.id },
        data: { partnerSettings: next as unknown as Prisma.InputJsonValue },
      });
      await tx.adminAuditLog.create({
        data: {
          action: 'settings.partnerSettings.update',
          ipAddress: input.requestMetadata.remoteAddress,
          userAgent: input.requestMetadata.userAgent,
          metadata: {
            requestId: input.requestMetadata.requestId,
            patchKeys: Object.keys(input.patch),
          },
          adminUser: { connect: { id: input.currentAdmin.id } },
        } as never,
      });
      return next;
    });
  }

  public async getPartnerSettings(): Promise<Record<string, unknown>> {
    const settings = await this.getSettingsRecord(this.prismaService);
    if (!settings) return {};
    return readJsonObject(settings.partnerSettings);
  }

  // ── Custom icon library ────────────────────────────────────────────────

  /**
   * Returns the operator's custom icon library (normalized + validated).
   */
  public async getCustomIcons(): Promise<CustomIconInterface[]> {
    const settings = await this.getSettingsRecord(this.prismaService);
    return readCustomIcons(settings?.customIcons ?? null);
  }

  /**
   * Replaces the whole custom-icon library with the supplied list. Any icon
   * file that is no longer referenced after the save is deleted from disk so
   * the upload dir doesn't accumulate orphans (best-effort).
   */
  public async updateCustomIcons(
    input: UpdateCustomIconsInput,
  ): Promise<CustomIconInterface[]> {
    const next: CustomIconInterface[] = input.icons.map((icon) => ({
      id: icon.id,
      name: icon.name,
      url: icon.url,
      color: icon.color ?? null,
    }));

    const settings = await this.prismaService.$transaction(async (tx) => {
      const existing = await this.getOrCreateSettingsRecord(tx);
      const previous = readCustomIcons(existing.customIcons);
      const updated = await tx.settings.update({
        where: { id: existing.id },
        data: { customIcons: next as unknown as Prisma.InputJsonValue },
      });
      await tx.adminAuditLog.create({
        data: {
          action: 'settings.customIcons.update',
          ipAddress: input.requestMetadata.remoteAddress,
          userAgent: input.requestMetadata.userAgent,
          metadata: {
            requestId: input.requestMetadata.requestId,
            count: next.length,
          },
          adminUser: { connect: { id: input.currentAdmin.id } },
        } as never,
      });
      return { updated, previous };
    });

    // Reap files for icons removed in this save (outside the txn — disk IO).
    const keptUrls = new Set(next.map((icon) => icon.url));
    const removed = settings.previous.filter((icon) => !keptUrls.has(icon.url));
    await Promise.all(removed.map((icon) => this.iconUploadService.remove(icon.url)));

    return readCustomIcons(settings.updated.customIcons);
  }

  private async getSettingsRecord(settingsClient: SettingsClient): Promise<Settings | null> {
    return settingsClient.settings.findFirst({
      orderBy: { updatedAt: 'asc' },
    });
  }
}

function buildSettingsUpdateChanges(
  updatePlatformSettingsDto: UpdatePlatformSettingsDto,
): UpdatePlatformSettingsChanges {
  const updatedFields: string[] = [];
  const data: Prisma.SettingsUpdateInput = {};
  if (hasOwnField(updatePlatformSettingsDto, 'rulesRequired')) {
    data.rulesRequired = updatePlatformSettingsDto.rulesRequired;
    updatedFields.push('rulesRequired');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'rulesLink')) {
    // `rulesLink` is a non-nullable column (`String @default("")`). The
    // SPA sends `null` to mean "cleared", so coerce null/undefined to "".
    data.rulesLink = updatePlatformSettingsDto.rulesLink ?? '';
    updatedFields.push('rulesLink');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'channelRequired')) {
    data.channelRequired = updatePlatformSettingsDto.channelRequired;
    updatedFields.push('channelRequired');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'channelId')) {
    data.channelId = parseChannelId(updatePlatformSettingsDto.channelId);
    updatedFields.push('channelId');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'channelLink')) {
    // Non-nullable column (`String @default("")`) — same null→"" coercion.
    data.channelLink = updatePlatformSettingsDto.channelLink ?? '';
    updatedFields.push('channelLink');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'accessMode')) {
    data.accessMode = updatePlatformSettingsDto.accessMode;
    updatedFields.push('accessMode');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'inviteModeStartedAt')) {
    data.inviteModeStartedAt = parseInviteModeStartedAt(updatePlatformSettingsDto.inviteModeStartedAt);
    updatedFields.push('inviteModeStartedAt');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'defaultCurrency')) {
    data.defaultCurrency = updatePlatformSettingsDto.defaultCurrency;
    updatedFields.push('defaultCurrency');
  }
  if (hasOwnField(updatePlatformSettingsDto, 'multiSubscriptionSettings')) {
    const incoming = updatePlatformSettingsDto.multiSubscriptionSettings ?? {};
    // Persist only the known, validated keys to the JSON column.
    const next: Record<string, unknown> = {};
    if (incoming.enabled !== undefined) next.enabled = incoming.enabled;
    if (incoming.defaultMaxSubscriptions !== undefined) {
      next.defaultMaxSubscriptions = incoming.defaultMaxSubscriptions;
    }
    data.multiSubscriptionSettings = next as Prisma.InputJsonValue;
    updatedFields.push('multiSubscriptionSettings');
  }
  return {
    updatedFields,
    data,
  };
}

function buildAuditMetadata(input: {
  readonly requestId: string | null;
  readonly updatedFields: readonly string[];
}): Prisma.InputJsonObject {
  return {
    requestId: input.requestId,
    updatedFields: [...input.updatedFields],
  };
}

function mapPlatformSettings(settings: Settings): PlatformSettingsInterface {
  return {
    rulesRequired: settings.rulesRequired,
    rulesLink: settings.rulesLink,
    channelRequired: settings.channelRequired,
    channelId: settings.channelId === null ? null : settings.channelId.toString(),
    channelLink: settings.channelLink,
    accessMode: settings.accessMode,
    inviteModeStartedAt:
      settings.inviteModeStartedAt === null ? null : settings.inviteModeStartedAt.toISOString(),
    defaultCurrency: settings.defaultCurrency,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

function mapInternalPlatformPolicy(settings: Settings): InternalPlatformPolicyInterface {
  return {
    rulesRequired: settings.rulesRequired,
    rulesLink: settings.rulesLink,
    channelRequired: settings.channelRequired,
    channelLink: settings.channelLink,
    accessMode: settings.accessMode,
    inviteModeStartedAt:
      settings.inviteModeStartedAt === null ? null : settings.inviteModeStartedAt.toISOString(),
    defaultCurrency: settings.defaultCurrency,
  };
}

function hasOwnField<T extends object>(target: T, propertyName: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(target, propertyName);
}

function parseChannelId(channelId: string | null | undefined): bigint | null {
  if (channelId === null || channelId === undefined) {
    return null;
  }
  return BigInt(channelId);
}

function parseInviteModeStartedAt(inviteModeStartedAt: string | null | undefined): Date | null {
  if (inviteModeStartedAt === null || inviteModeStartedAt === undefined) {
    return null;
  }
  return new Date(inviteModeStartedAt);
}

function validatePaymentOpsAlertSettings(
  settings: PaymentOpsAlertSettingsInterface,
): void {
  if (settings.enabled && settings.chatId === null) {
    throw new BadRequestException('PAYMENT_OPS_ALERT_CHAT_REQUIRED');
  }
}

function extractUpdatedPaymentOpsFields(
  dto: UpdatePaymentOpsAlertSettingsDto,
): readonly string[] {
  const fields: string[] = [];
  if (hasOwnField(dto, 'enabled')) {
    fields.push('enabled');
  }
  if (hasOwnField(dto, 'chatId')) {
    fields.push('chatId');
  }
  if (hasOwnField(dto, 'threadId')) {
    fields.push('threadId');
  }
  if (hasOwnField(dto, 'hashtag')) {
    fields.push('hashtag');
  }
  return fields;
}

function extractUpdatedBrandingFields(
  dto: UpdateBrandingSettingsDto,
): readonly string[] {
  const fields: Array<keyof UpdateBrandingSettingsDto> = [
    'brandName',
    'logoUrl',
    'primary',
    'primaryFg',
    'bgPrimary',
    'bgSecondary',
    'cardGradient',
    'cardPattern',
    'cardLogo',
    'cardLogoUrl',
    'cardEffect',
    'cardEffectProps',
    'cardEffectOpacity',
    'cardEffectsByIndex',
    'bgEffect',
    'iconColorMode',
    'iconColors',
    'borderRadius',
    'fontFamily',
  ];
  return fields.filter((field) => hasOwnField(dto, field)).map((f) => String(f));
}

function buildPaymentOpsAlertTestMessage(input: {
  readonly settings: PaymentOpsAlertSettingsInterface;
  readonly note: string | null;
  readonly adminId: string;
}): string {
  const note = input.note?.trim();
  const lines = [
    input.settings.hashtag ?? '#payments_ops',
    '#payments_ops',
    '#event_test_alert',
    'kind:payment_ops_test',
    `admin_id:${input.adminId}`,
    `chat_id:${input.settings.chatId ?? 'unknown'}`,
    input.settings.threadId === null ? null : `thread_id:${input.settings.threadId}`,
    note && note.length > 0 ? `note:${note.replace(/\s+/g, ' ').slice(0, 200)}` : null,
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}


// ── Helpers exposed for the notifications routes ────────────────────────────

export interface TelegramDeliveryConfig {
  readonly enabled: boolean;
  readonly chatId: string | null;
  readonly topicId: number | null;
  readonly topics: Record<string, number | null>;
  /**
   * Mirror user-facing notifications into the operator chat. When true,
   * `UserNotificationsService` posts a copy of every user notification
   * to `chatId` (routed to the `USER` topic when set). Default false —
   * the operator chat stays a system-events firehose unless opted in.
   */
  readonly mirrorUserNotifications: boolean;
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object') return {};
  if (Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function mergeJsonObject(
  existing: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = readJsonObject(existing);
  return { ...base, ...patch };
}

function readTelegramDeliveryConfig(systemNotifications: unknown): TelegramDeliveryConfig {
  const obj = readJsonObject(systemNotifications);
  const tg = readJsonObject(obj.telegram);
  const topics = readJsonObject(tg.topics);
  const normalisedTopics: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(topics)) {
    normalisedTopics[key.toUpperCase()] =
      typeof value === 'number' ? value : value === null ? null : null;
  }
  return {
    enabled: tg.enabled === true,
    chatId: typeof tg.chatId === 'string' && tg.chatId.length > 0 ? tg.chatId : null,
    topicId: typeof tg.topicId === 'number' ? tg.topicId : null,
    topics: normalisedTopics,
    mirrorUserNotifications: tg.mirrorUserNotifications === true,
  };
}

/**
 * Shallow-deep merge of a `referralSettings` patch over the existing JSON.
 * Top-level keys are replaced; the two known nested objects
 * (`pointsExchange` and `inviteLimits`) are spread one level deeper so
 * the SPA can submit a partial sub-section without erasing unrelated knobs.
 */
function mergeReferralSettings(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if ((key === 'pointsExchange' || key === 'inviteLimits') && isPlainObject(value)) {
      next[key] = { ...readJsonObject(previous[key]), ...value };
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Shallow-deep merge of a `partnerSettings` patch over the existing JSON.
 * Top-level keys are replaced; the known nested objects (`levels`,
 * `gatewayCommissions`, `withdrawals`) are spread one level deeper so
 * the SPA can submit a single section without erasing the rest.
 */
function mergePartnerSettings(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (
      (key === 'levels' || key === 'gatewayCommissions' || key === 'withdrawals') &&
      isPlainObject(value)
    ) {
      next[key] = { ...readJsonObject(previous[key]), ...value };
    } else {
      next[key] = value;
    }
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
