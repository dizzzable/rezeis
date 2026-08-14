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
import { Public } from '../../../common/decorators/public.decorator';

/**
 * Passkey (WebAuthn/FIDO2) endpoints.
 *
 * Registration requires JWT (admin must be logged in to add a passkey).
 * Authentication is public (passkey replaces password).
 */

// ── Public endpoints (authentication) ────────────────────────────────────────

@Controller('admin/passkey')
@Public()
export class PasskeyPublicController {
  public constructor(private readonly passkeyService: PasskeyService) {}

  /**
   * Generate authentication options (public — used on login page).
   */
  @Post('authenticate/options')
  public async getAuthenticationOptions(@Req() req: Request): Promise<Record<string, unknown>> {
    return this.passkeyService.generateAuthenticationOptions(extractRpId(req));
  }

  /**
   * Verify authentication response and issue JWT.
   */
  @Post('authenticate/verify')
  public async verifyAuthentication(
    @Req() req: Request,
    @Body() body: { response: Record<string, unknown> },
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: string }> {
    const rpId = extractRpId(req);
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
  public async getRegistrationOptions(@Req() req: Request): Promise<Record<string, unknown>> {
    const admin = req.user as { id: string };
    return this.passkeyService.generateRegistrationOptions(admin.id, extractRpId(req));
  }

  /**
   * Verify registration response and store credential.
   */
  @Post('register/verify')
  public async verifyRegistration(
    @Req() req: Request,
    @Body() body: { response: Record<string, unknown>; name?: string },
  ): Promise<PasskeyCredentialInfo> {
    const admin = req.user as { id: string };
    const rpId = extractRpId(req);
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

/**
 * Where the RP ID and origin come from — and, more to the point, where they no
 * longer come from.
 *
 * All four handlers above used to accept `rpId` in the request body and prefer
 * it over the request itself. `expectedRPID` and `expectedOrigin` are the two
 * values WebAuthn verification compares the assertion against
 * (`passkey.service.ts:218-219`); letting the caller supply one of them asks
 * the library "does this assertion match whatever the caller says it should",
 * which is answered yes by construction. That is not a check.
 *
 * The field was never used by anything legitimate: the SPA posts `{}` to
 * `authenticate/options` and `register/options` and omits `rpId` from both
 * verify calls (`web/src/features/auth/oauth-buttons.tsx:65,78`,
 * `web/src/features/two-factor/two-factor-page.tsx:507,545`). Removing it is
 * therefore byte-identical for every real client — every one of them already
 * fell through to the request — and closes the override for everyone else.
 * It matters most on `authenticate/verify`, which is `@Public()` and
 * usernameless: the credential is looked up by the id in the response and a
 * successful verification issues that admin's JWT.
 *
 * What remains, deliberately and with its limit stated: both values are derived
 * from the `Host` header (and `X-Forwarded-Proto` for the scheme). A reverse
 * proxy that forwards an arbitrary `Host` therefore still names them. That is
 * weaker than pinning to the operator's configured domain, and it is not an
 * oversight — pinning would bind verification to a value that may differ from
 * the hostname admins actually reach the panel by, and being wrong there locks
 * every admin out of passkey login at once. The correct fix is to record the
 * RP ID on the credential at registration and verify each assertion against
 * its own row; that needs a column, so it is a decision with a migration
 * attached rather than something to slip into a login path.
 */
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
