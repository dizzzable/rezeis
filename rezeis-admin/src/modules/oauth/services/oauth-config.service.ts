import { Injectable, Logger } from '@nestjs/common';
import { AuthProviderType } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AuthProviderConfigInterface,
  PublicProviderInfo,
} from '../interfaces/oauth-provider.interface';

/**
 * Manages OAuth provider configurations stored in the database.
 * Handles CRUD operations and exposes public provider info for the login page.
 */
@Injectable()
export class OAuthConfigService {
  private readonly logger = new Logger(OAuthConfigService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Returns all provider configs (admin-only — includes sensitive fields).
   */
  public async getAllConfigs(): Promise<AuthProviderConfigInterface[]> {
    const configs = await this.prismaService.authProviderConfig.findMany({
      orderBy: { type: 'asc' },
    });
    return configs.map((c) => ({
      id: c.id,
      type: c.type,
      isEnabled: c.isEnabled,
      displayName: c.displayName,
      clientId: c.clientId,
      frontendDomain: c.frontendDomain,
      backendDomain: c.backendDomain,
      authorizationUrl: c.authorizationUrl,
      tokenUrl: c.tokenUrl,
      realm: c.realm,
      providerDomain: c.providerDomain,
      usePkce: c.usePkce,
      allowedEmails: c.allowedEmails,
      allowedTelegramIds: c.allowedTelegramIds,
    }));
  }

  /**
   * Returns only enabled providers (public — no secrets).
   * Used by the login page to show available OAuth buttons.
   */
  public async getEnabledProviders(): Promise<PublicProviderInfo[]> {
    const configs = await this.prismaService.authProviderConfig.findMany({
      where: { isEnabled: true },
      select: { type: true, displayName: true, isEnabled: true },
    });
    return configs;
  }

  /**
   * Returns a single provider config by type.
   */
  public async getConfig(
    type: AuthProviderType,
  ): Promise<AuthProviderConfigInterface | null> {
    const config = await this.prismaService.authProviderConfig.findUnique({
      where: { type },
    });
    if (!config) return null;
    return {
      id: config.id,
      type: config.type,
      isEnabled: config.isEnabled,
      displayName: config.displayName,
      clientId: config.clientId,
      frontendDomain: config.frontendDomain,
      backendDomain: config.backendDomain,
      authorizationUrl: config.authorizationUrl,
      tokenUrl: config.tokenUrl,
      realm: config.realm,
      providerDomain: config.providerDomain,
      usePkce: config.usePkce,
      allowedEmails: config.allowedEmails,
      allowedTelegramIds: config.allowedTelegramIds,
    };
  }

  /**
   * Updates a provider configuration.
   */
  public async updateConfig(
    type: AuthProviderType,
    data: Partial<{
      isEnabled: boolean;
      displayName: string;
      clientId: string | null;
      clientSecretEnc: string | null;
      frontendDomain: string | null;
      backendDomain: string | null;
      authorizationUrl: string | null;
      tokenUrl: string | null;
      realm: string | null;
      providerDomain: string | null;
      usePkce: boolean;
      allowedEmails: string[];
      allowedTelegramIds: bigint[];
    }>,
  ): Promise<AuthProviderConfigInterface> {
    const updated = await this.prismaService.authProviderConfig.update({
      where: { type },
      data,
    });
    this.logger.log(`Updated auth provider config: ${type} (enabled: ${updated.isEnabled})`);
    return {
      id: updated.id,
      type: updated.type,
      isEnabled: updated.isEnabled,
      displayName: updated.displayName,
      clientId: updated.clientId,
      frontendDomain: updated.frontendDomain,
      backendDomain: updated.backendDomain,
      authorizationUrl: updated.authorizationUrl,
      tokenUrl: updated.tokenUrl,
      realm: updated.realm,
      providerDomain: updated.providerDomain,
      usePkce: updated.usePkce,
      allowedEmails: updated.allowedEmails,
      allowedTelegramIds: updated.allowedTelegramIds,
    };
  }
}
