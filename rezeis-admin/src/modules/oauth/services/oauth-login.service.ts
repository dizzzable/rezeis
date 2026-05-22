import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  OAuthLoginResult,
  OAuthUserProfile,
} from '../interfaces/oauth-provider.interface';

/**
 * Handles the OAuth login flow after a provider returns a verified profile.
 *
 * Flow:
 *   1. Provider adapter verifies the OAuth callback and returns OAuthUserProfile
 *   2. This service looks up AdminOAuthLink by (providerType, providerId)
 *   3. If found → issue JWT for the linked admin
 *   4. If not found → check allowedEmails/allowedTelegramIds whitelist
 *   5. If whitelisted → auto-link to matching admin (by email) or reject
 *   6. Audit log the login
 */
@Injectable()
export class OAuthLoginService {
  private readonly logger = new Logger(OAuthLoginService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
  ) {}

  /**
   * Processes a verified OAuth profile and returns a JWT if authorized.
   */
  public async processOAuthLogin(profile: OAuthUserProfile): Promise<OAuthLoginResult> {
    // 1. Check if this provider identity is already linked to an admin
    const existingLink = await this.prismaService.adminOAuthLink.findUnique({
      where: {
        providerType_providerUserId: {
          providerType: profile.providerType,
          providerUserId: profile.providerId,
        },
      },
    });

    if (existingLink) {
      // Update last used timestamp
      await this.prismaService.adminOAuthLink.update({
        where: { id: existingLink.id },
        data: { lastUsedAt: new Date() },
      });
      return this.issueTokenForAdmin(existingLink.adminUserId, false);
    }

    // 2. No existing link — try to auto-link by email
    if (profile.email) {
      const admin = await this.prismaService.adminUser.findUnique({
        where: { email: profile.email },
        select: { id: true, isActive: true },
      });

      if (admin && admin.isActive) {
        // Check whitelist
        await this.validateWhitelist(profile);

        // Create the link
        await this.prismaService.adminOAuthLink.create({
          data: {
            adminUserId: admin.id,
            providerType: profile.providerType,
            providerUserId: profile.providerId,
            providerEmail: profile.email,
            providerName: profile.name,
            profileData: JSON.parse(JSON.stringify(profile.rawProfile)),
          },
        });

        this.logger.log(
          `Auto-linked ${profile.providerType} user ${profile.providerId} to admin ${admin.id}`,
        );

        return this.issueTokenForAdmin(admin.id, true);
      }
    }

    // 3. For Telegram — try to match by telegram ID in the admin's linked data
    if (profile.providerType === AuthProviderType.TELEGRAM) {
      await this.validateWhitelist(profile);
    }

    throw new UnauthorizedException(
      'No admin account is linked to this identity. Ask an administrator to link your account.',
    );
  }

  /**
   * Links an OAuth identity to an existing admin (manual linking from settings).
   */
  public async linkProvider(
    adminUserId: string,
    profile: OAuthUserProfile,
  ): Promise<void> {
    await this.prismaService.adminOAuthLink.upsert({
      where: {
        providerType_providerUserId: {
          providerType: profile.providerType,
          providerUserId: profile.providerId,
        },
      },
      create: {
        adminUserId,
        providerType: profile.providerType,
        providerUserId: profile.providerId,
        providerEmail: profile.email,
        providerName: profile.name,
        profileData: JSON.parse(JSON.stringify(profile.rawProfile)),
      },
      update: {
        adminUserId,
        providerEmail: profile.email,
        providerName: profile.name,
        profileData: JSON.parse(JSON.stringify(profile.rawProfile)),
      },
    });
  }

  /**
   * Unlinks an OAuth identity from an admin.
   */
  public async unlinkProvider(
    adminUserId: string,
    providerType: AuthProviderType,
  ): Promise<void> {
    await this.prismaService.adminOAuthLink.deleteMany({
      where: { adminUserId, providerType },
    });
  }

  /**
   * Returns all linked providers for an admin.
   */
  public async getLinkedProviders(adminUserId: string) {
    return this.prismaService.adminOAuthLink.findMany({
      where: { adminUserId },
      select: {
        id: true,
        providerType: true,
        providerUserId: true,
        providerEmail: true,
        providerName: true,
        linkedAt: true,
        lastUsedAt: true,
      },
    });
  }

  private async issueTokenForAdmin(
    adminId: string,
    isNewLink: boolean,
  ): Promise<OAuthLoginResult> {
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        login: true,
        name: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        rbacRoleId: true,
      },
    });

    if (!admin || !admin.isActive) {
      throw new ForbiddenException('Admin account is inactive');
    }

    // Update last login
    await this.prismaService.adminUser.update({
      where: { id: adminId },
      data: { lastLoginAt: new Date() },
    });

    const payload = {
      sub: admin.id,
      login: admin.login,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
      rbacRoleId: admin.rbacRoleId,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.authConfiguration.jwtExpiresIn,
      admin: {
        id: admin.id,
        login: admin.login,
        name: admin.name,
        role: admin.role,
      },
      isNewLink,
    };
  }

  private async validateWhitelist(profile: OAuthUserProfile): Promise<void> {
    const config = await this.prismaService.authProviderConfig.findUnique({
      where: { type: profile.providerType },
      select: { allowedEmails: true, allowedTelegramIds: true },
    });

    if (!config) {
      throw new UnauthorizedException('Provider is not configured');
    }

    // Check email whitelist (if non-empty)
    if (config.allowedEmails.length > 0 && profile.email) {
      const emailLower = profile.email.toLowerCase();
      const allowed = config.allowedEmails.some(
        (e) => e.toLowerCase() === emailLower,
      );
      if (!allowed) {
        throw new ForbiddenException('Email is not in the allowed list');
      }
    }

    // Check Telegram ID whitelist (if non-empty and provider is Telegram)
    if (
      profile.providerType === AuthProviderType.TELEGRAM &&
      config.allowedTelegramIds.length > 0
    ) {
      const tgId = BigInt(profile.providerId);
      const allowed = config.allowedTelegramIds.some((id) => id === tgId);
      if (!allowed) {
        throw new ForbiddenException('Telegram ID is not in the allowed list');
      }
    }
  }
}
