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

    // Same throwing behaviour as the authentication path — see the note there.
    // Registration is the supervised half (the admin already holds a session),
    // so the failure is recoverable, but it used to be a 500 as well.
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Passkey registration rejected for admin ${adminId} (rpId=${rpId}, origin=${origin}): ${reason}`,
      );
      throw new UnauthorizedException('Passkey registration verification failed');
    }

    if (!verification.verified || !verification.registrationInfo) {
      this.logger.warn(
        `Passkey registration unverified for admin ${adminId} (rpId=${rpId}, origin=${origin})`,
      );
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

    // `verifyAuthenticationResponse` THROWS on an rpId/origin mismatch rather
    // than returning `verified: false` — so without this catch the commonest
    // real failure (a passkey registered while reaching the panel by a
    // different hostname than the one being used now) surfaced as a 500 with
    // nothing in the log. The two values it compared are precisely the ones an
    // operator cannot see from the browser, so they are recorded here; the
    // response stays generic on purpose, since this route is public and must
    // not narrate why a login attempt failed.
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Passkey authentication rejected for credential ${credentialId} ` +
          `(rpId=${rpId}, origin=${origin}): ${reason}`,
      );
      throw new UnauthorizedException('Passkey authentication failed');
    }

    if (!verification.verified) {
      this.logger.warn(
        `Passkey authentication unverified for credential ${credentialId} ` +
          `(rpId=${rpId}, origin=${origin})`,
      );
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

  /**
   * Decodes the challenge from the response's clientDataJSON, looks it up in
   * Redis (where the matching auth-options call placed it), and returns it
   * for verification. Single-use — the entry is deleted on lookup.
   */
  private async findChallengeForResponse(
    response: AuthenticationResponseJSON,
  ): Promise<string | null> {
    try {
      const clientDataBuffer = Buffer.from(response.response.clientDataJSON, 'base64url');
      const clientData = JSON.parse(clientDataBuffer.toString('utf8')) as { challenge?: string };
      if (clientData.challenge) {
        const stored = await this.cacheService.get<{ challenge: string }>(
          `passkey:auth:${clientData.challenge}`,
        );
        if (stored) {
          await this.cacheService.del(`passkey:auth:${clientData.challenge}`);
          return stored.challenge;
        }
      }
    } catch {
      // clientDataJSON unparseable or cache miss — fall through to null
    }
    return null;
  }
}

type AuthenticatorTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';
