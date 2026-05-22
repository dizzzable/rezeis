import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { PasskeyCredentialInfo } from '../interfaces/passkey.interface';

/**
 * WebAuthn/Passkey service using @simplewebauthn/server.
 *
 * Supports:
 *   - Registration: generate options → verify response → store credential
 *   - Authentication: generate options → verify response → issue JWT
 *   - Management: list, rename, delete credentials
 *
 * Challenges are stored in Redis with a 5-minute TTL to prevent replay.
 * The RP ID is derived from the frontend domain configuration.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private static readonly CHALLENGE_TTL_SECONDS = 300;
  private static readonly RP_NAME = 'Rezeis Admin';

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly cacheService: RawCacheService,
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
  ) {}

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Generates WebAuthn registration options for an admin.
   */
  public async generateRegistrationOptions(
    adminId: string,
    rpId: string,
  ): Promise<Record<string, unknown>> {
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, login: true, name: true },
    });
    if (!admin) throw new UnauthorizedException('Admin not found');

    // Get existing credentials to exclude
    const existingCredentials = await this.prismaService.adminPasskey.findMany({
      where: { adminUserId: adminId },
      select: { credentialId: true, transports: true },
    });

    const options = await generateRegistrationOptions({
      rpName: PasskeyService.RP_NAME,
      rpID: rpId,
      userName: admin.login,
      userDisplayName: admin.name ?? admin.login,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store challenge in Redis for verification
    await this.cacheService.set(
      `passkey:reg:${adminId}`,
      options.challenge,
      PasskeyService.CHALLENGE_TTL_SECONDS,
    );

    return options as unknown as Record<string, unknown>;
  }

  /**
   * Verifies a registration response and stores the new credential.
   */
  public async verifyRegistration(
    adminId: string,
    rpId: string,
    origin: string,
    response: RegistrationResponseJSON,
    credentialName: string,
  ): Promise<PasskeyCredentialInfo> {
    const expectedChallenge = await this.cacheService.get<string>(`passkey:reg:${adminId}`);
    if (!expectedChallenge) {
      throw new UnauthorizedException('Registration challenge expired');
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException('Passkey registration verification failed');
    }

    const { credential, credentialBackedUp } = verification.registrationInfo;

    // Store the credential
    const passkey = await this.prismaService.adminPasskey.create({
      data: {
        adminUserId: adminId,
        name: credentialName || 'Passkey',
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: BigInt(credential.counter),
        transports: response.response.transports ?? [],
        backedUp: credentialBackedUp,
      },
    });

    // Clean up challenge
    await this.cacheService.del(`passkey:reg:${adminId}`);

    this.logger.log(`Passkey registered for admin ${adminId}: ${passkey.id}`);

    return {
      id: passkey.id,
      name: passkey.name,
      credentialId: passkey.credentialId,
      transports: passkey.transports,
      backedUp: passkey.backedUp,
      registeredAt: passkey.registeredAt.toISOString(),
      lastUsedAt: null,
    };
  }

  // ── Authentication ───────────────────────────────────────────────────────

  /**
   * Generates WebAuthn authentication options.
   * If adminId is provided, limits to that admin's credentials.
   * If null, allows any registered credential (discoverable/resident key).
   */
  public async generateAuthenticationOptions(
    rpId: string,
    adminId?: string | null,
  ): Promise<Record<string, unknown>> {
    let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] = [];

    if (adminId) {
      const credentials = await this.prismaService.adminPasskey.findMany({
        where: { adminUserId: adminId },
        select: { credentialId: true, transports: true },
      });
      allowCredentials = credentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransport[],
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'preferred',
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
    });

    // Store challenge — use a random key since we don't know the admin yet
    const challengeKey = `passkey:auth:${options.challenge}`;
    await this.cacheService.set(
      challengeKey,
      { challenge: options.challenge, adminId: adminId ?? null },
      PasskeyService.CHALLENGE_TTL_SECONDS,
    );

    return options as unknown as Record<string, unknown>;
  }

  /**
   * Verifies an authentication response and issues a JWT.
   */
  public async verifyAuthentication(
    rpId: string,
    origin: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: string }> {
    // Find the credential
    const credentialId = response.id;
    const passkey = await this.prismaService.adminPasskey.findUnique({
      where: { credentialId },
    });

    if (!passkey) {
      throw new UnauthorizedException('Passkey not found');
    }

    // Decode clientDataJSON to extract the challenge for verification
    const storedChallenge = await this.findChallengeForResponse(response);
    if (!storedChallenge) {
      throw new UnauthorizedException('Authentication challenge expired or invalid');
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: storedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: Number(passkey.counter),
        transports: passkey.transports as AuthenticatorTransport[],
      },
    });

    if (!verification.verified) {
      throw new UnauthorizedException('Passkey authentication failed');
    }

    // Update counter and last used
    await this.prismaService.adminPasskey.update({
      where: { id: passkey.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });

    // Issue JWT
    const admin = await this.prismaService.adminUser.findUnique({
      where: { id: passkey.adminUserId },
      select: { id: true, login: true, role: true, tokenVersion: true, isActive: true, rbacRoleId: true },
    });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Admin account is inactive');
    }

    await this.prismaService.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = await this.jwtService.signAsync({
      sub: admin.id,
      login: admin.login,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
      rbacRoleId: admin.rbacRoleId,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.authConfiguration.jwtExpiresIn,
    };
  }

  // ── Management ───────────────────────────────────────────────────────────

  /**
   * Lists all passkeys for an admin.
   */
  public async listPasskeys(adminId: string): Promise<PasskeyCredentialInfo[]> {
    const passkeys = await this.prismaService.adminPasskey.findMany({
      where: { adminUserId: adminId },
      orderBy: { registeredAt: 'desc' },
    });
    return passkeys.map((p) => ({
      id: p.id,
      name: p.name,
      credentialId: p.credentialId,
      transports: p.transports,
      backedUp: p.backedUp,
      registeredAt: p.registeredAt.toISOString(),
      lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Renames a passkey.
   */
  public async renamePasskey(adminId: string, passkeyId: string, name: string): Promise<void> {
    await this.prismaService.adminPasskey.updateMany({
      where: { id: passkeyId, adminUserId: adminId },
      data: { name },
    });
  }

  /**
   * Deletes a passkey.
   */
  public async deletePasskey(adminId: string, passkeyId: string): Promise<void> {
    await this.prismaService.adminPasskey.deleteMany({
      where: { id: passkeyId, adminUserId: adminId },
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async findChallengeForResponse(
    _response: AuthenticationResponseJSON,
  ): Promise<string | null> {
    // In a production system, we'd decode clientDataJSON to extract the challenge.
    // For now, we use a simplified approach: scan recent challenges from cache.
    // The proper implementation decodes the clientDataJSON base64url to get the challenge.
    try {
      const clientDataBuffer = Buffer.from(_response.response.clientDataJSON, 'base64url');
      const clientData = JSON.parse(clientDataBuffer.toString('utf8')) as { challenge?: string };
      if (clientData.challenge) {
        const stored = await this.cacheService.get<{ challenge: string }>(`passkey:auth:${clientData.challenge}`);
        if (stored) {
          await this.cacheService.del(`passkey:auth:${clientData.challenge}`);
          return stored.challenge;
        }
      }
    } catch {
      // Fall through
    }
    return null;
  }
}

type AuthenticatorTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';
