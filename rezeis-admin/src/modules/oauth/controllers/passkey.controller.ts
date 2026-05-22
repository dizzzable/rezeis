import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { PasskeyCredentialInfo } from '../interfaces/passkey.interface';
import { PasskeyService } from '../services/passkey.service';

/**
 * Passkey (WebAuthn/FIDO2) endpoints.
 *
 * Registration requires JWT (admin must be logged in to add a passkey).
 * Authentication is public (passkey replaces password).
 */

// ── Public endpoints (authentication) ────────────────────────────────────────

@Controller('admin/passkey')
export class PasskeyPublicController {
  public constructor(private readonly passkeyService: PasskeyService) {}

  /**
   * Generate authentication options (public — used on login page).
   */
  @Post('authenticate/options')
  public async getAuthenticationOptions(
    @Req() req: Request,
    @Body() body: { rpId?: string },
  ): Promise<Record<string, unknown>> {
    const rpId = body.rpId ?? extractRpId(req);
    return this.passkeyService.generateAuthenticationOptions(rpId);
  }

  /**
   * Verify authentication response and issue JWT.
   */
  @Post('authenticate/verify')
  public async verifyAuthentication(
    @Req() req: Request,
    @Body() body: { response: Record<string, unknown>; rpId?: string },
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: string }> {
    const rpId = body.rpId ?? extractRpId(req);
    const origin = extractOrigin(req);
    return this.passkeyService.verifyAuthentication(
      rpId,
      origin,
      body.response as unknown as import('@simplewebauthn/server').AuthenticationResponseJSON,
    );
  }
}

// ── Protected endpoints (registration + management) ──────────────────────────

@Controller('admin/passkey')
@UseGuards(AdminJwtAuthGuard)
export class PasskeyProtectedController {
  public constructor(private readonly passkeyService: PasskeyService) {}

  /**
   * List all passkeys for the current admin.
   */
  @Get('credentials')
  public async listPasskeys(@Req() req: Request): Promise<PasskeyCredentialInfo[]> {
    const admin = req.user as { id: string };
    return this.passkeyService.listPasskeys(admin.id);
  }

  /**
   * Generate registration options.
   */
  @Post('register/options')
  public async getRegistrationOptions(
    @Req() req: Request,
    @Body() body: { rpId?: string },
  ): Promise<Record<string, unknown>> {
    const admin = req.user as { id: string };
    const rpId = body.rpId ?? extractRpId(req);
    return this.passkeyService.generateRegistrationOptions(admin.id, rpId);
  }

  /**
   * Verify registration response and store credential.
   */
  @Post('register/verify')
  public async verifyRegistration(
    @Req() req: Request,
    @Body() body: { response: Record<string, unknown>; name?: string; rpId?: string },
  ): Promise<PasskeyCredentialInfo> {
    const admin = req.user as { id: string };
    const rpId = body.rpId ?? extractRpId(req);
    const origin = extractOrigin(req);
    return this.passkeyService.verifyRegistration(
      admin.id,
      rpId,
      origin,
      body.response as unknown as import('@simplewebauthn/server').RegistrationResponseJSON,
      body.name ?? 'Passkey',
    );
  }

  /**
   * Rename a passkey.
   */
  @Patch('credentials/:id')
  public async renamePasskey(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { name: string },
  ): Promise<{ ok: boolean }> {
    const admin = req.user as { id: string };
    await this.passkeyService.renamePasskey(admin.id, id, body.name);
    return { ok: true };
  }

  /**
   * Delete a passkey.
   */
  @Delete('credentials/:id')
  public async deletePasskey(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ ok: boolean }> {
    const admin = req.user as { id: string };
    await this.passkeyService.deletePasskey(admin.id, id);
    return { ok: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractRpId(req: Request): string {
  const host = req.get('host') ?? 'localhost';
  // Remove port if present
  return host.split(':')[0];
}

function extractOrigin(req: Request): string {
  const proto = req.get('x-forwarded-proto') ?? req.protocol ?? 'https';
  const host = req.get('host') ?? 'localhost';
  return `${proto}://${host}`;
}
