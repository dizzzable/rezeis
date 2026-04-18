import { Injectable } from '@nestjs/common';
import { Prisma, Settings } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { UpdatePlatformSettingsDto } from '../dto/update-platform-settings.dto';
import { InternalPlatformPolicyInterface } from '../interfaces/internal-platform-policy.interface';
import { PlatformSettingsInterface } from '../interfaces/platform-settings.interface';

interface UpdatePlatformSettingsInput {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
  readonly updatePlatformSettingsDto: UpdatePlatformSettingsDto;
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
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Returns the singleton platform settings record, creating defaults when missing.
   */
  public async getPlatformSettings(): Promise<PlatformSettingsInterface> {
    const settings: Settings = await this.getOrCreateSettingsRecord(this.prismaService);
    return mapPlatformSettings(settings);
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

  private async getOrCreateSettingsRecord(settingsClient: SettingsClient): Promise<Settings> {
    const existingSettings: Settings | null = await this.getSettingsRecord(settingsClient);
    if (existingSettings) {
      return existingSettings;
    }
    return settingsClient.settings.create({
      data: {},
    });
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
    data.rulesLink = updatePlatformSettingsDto.rulesLink ?? null;
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
    data.channelLink = updatePlatformSettingsDto.channelLink ?? null;
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
