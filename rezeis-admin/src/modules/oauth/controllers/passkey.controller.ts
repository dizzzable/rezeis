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
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { PasskeyCredentialInfo } from '../interfaces/passkey.interface';
import { PasskeyService } from '../services/passkey.service';
import { Public } from '../../../common/decorators/public.decorator';

/**
 * Passkey (WebAuthn/FIDO2) endpoints.
 *
 * Registration requires JWT (admin must be logged in to add a passkey) AND a
 * fresh factor on top of it — see `PasskeyService.assertFreshFactor`.
 * Authentication is public (passkey replaces password).
 */

// ── Public endpoints (authentication) ────────────────────────────────────────

/**
 * Rate limit, and why it is 10 rather than the login route's 5.
 *
 * `POST /admin/auth/login` is capped at 5/60 s
 * (`admin-auth.controller.ts:116`). These two routes carried no override at
 * all, which left passkey sign-in — a route that mints a full admin JWT with
 * no password — sitting at the global 600/60 s default
 * (`common/throttle/throttle.module.ts:39-44`): 120× looser than the endpoint
 * it stands in for.
 *
 * The budget is declared on the CLASS so both halves share one counter, and it
 * is doubled because one sign-in ATTEMPT spends two requests here —
 * `authenticate/options` then `authenticate/verify` — where the password login
 * spends one. 10 requests therefore buys the same 5 attempts per minute, which
 * is the parity worth having; picking 5 would have quietly made passkey login
 * half as forgiving as the password form for no stated reason.
 *
 * This is the coarse per-IP ceiling only. The account-aware half — counting
 * failures and auto-blocking the IP — is `LoginGuardService`, called from
 * `PasskeyService.verifyAuthentication`.
 */
@Controller('admin/passkey')
@Public()
@Throttle({ default: { ttl: 60_000, limit: 10 } })
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
      requestMetadata(req),
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
   *
   * Takes the fresh factor in the body — `code` for a TOTP or recovery code,
   * `password` for the current password — and which of the two is read is
   * decided from the account, not from what the caller chose to send. A 401
   * carrying `code: 'passkey_reauth_required'` and a `factor` field is the
   * PROMPT, not a failure: it is what tells the SPA which field to show.
   *
   * 10/60 s, and on the HANDLER rather than the class.
   *
   * `assertFreshFactor` checks a real credential here — the account's TOTP code
   * or, for an account without 2FA, its password — which makes this the one
   * guessable route on an otherwise administrative controller. It carried no
   * override, so it sat at the global 600/60 s: measured, 600 rejected factors
   * from one IP inside a minute, first 429 at attempt 601. Getting past it
   * enrols an authenticator the attacker holds, which is a permanent takeover
   * that survives a password reset.
   *
   * A class-level budget — the shape the public half of this file uses — would
   * be wrong here: `GET credentials` renders the security page and rename and
   * delete are ordinary management calls, none of which should be spending a
   * brute-force budget.
   *
   * 10 rather than 5 because the prompt above costs a request of its own: the
   * SPA posts the reauth body, and a WebAuthn ceremony the operator cancels or
   * lets time out sends them round again from the top — see the
   * `navigator.credentials.create()` call in `PasskeySection`'s
   * `registerMutation` and the `Registration cancelled` throw beside it
   * (`web/src/features/two-factor/two-factor-page.tsx`). Five would make
   * two abandoned ceremonies a lockout.
   *
   * `register/verify` deliberately keeps the global budget. It guesses nothing:
   * it only accepts a response against a challenge THIS route parked in Redis,
   * so a caller who cannot get past the line above cannot reach it at all.
   */
  @Post('register/options')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  public async getRegistrationOptions(
    @Req() req: Request,
    @Body() body: { code?: string; password?: string } = {},
  ): Promise<Record<string, unknown>> {
    const admin = req.user as { id: string };
    return this.passkeyService.generateRegistrationOptions(
      admin.id,
      extractRpId(req),
      { code: body?.code ?? null, password: body?.password ?? null },
      requestMetadata(req),
    );
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
      requestMetadata(req),
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
   *
   * Returns a replacement `accessToken` when a credential was actually removed:
   * removal bumps `tokenVersion`, which is what ends the sessions the revoked
   * credential minted, and that bump kills the caller's own token too. A client
   * that adopts the new token stays signed in; one that ignores it is signed
   * out on its next request — the safe direction to fail, and never a reason to
   * skip the bump.
   */
  @Delete('credentials/:id')
  public async deletePasskey(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ ok: boolean; accessToken: string | null }> {
    const admin = req.user as { id: string };
    const result = await this.passkeyService.deletePasskey(
      admin.id,
      id,
      requestMetadata(req),
    );
    return { ok: true, accessToken: result.accessToken };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Where the RP ID and origin come from — and, more to the point, where they no
 * longer come from.
 *
 * All four handlers above used to accept `rpId` in the request body and prefer
 * it over the request itself. `expectedRPID` and `expectedOrigin` are the two
 * values WebAuthn verification compares the assertion against — the
 * `verifyAuthenticationResponse` and `verifyRegistrationResponse` calls in
 * `passkey.service.ts` pass both; letting the caller supply one of them asks
 * the library "does this assertion match whatever the caller says it should",
 * which is answered yes by construction. That is not a check.
 *
 * The field was never used by anything legitimate. Every one of the four SPA
 * call sites omits `rpId`, and they are named by SYMBOL because the line
 * numbers this comment used to carry had already rotted:
 *   - `authenticate/options` — posts a literal `{}`
 *     (`web/src/features/auth/oauth-buttons.tsx`, `handlePasskey`);
 *   - `authenticate/verify` — posts only `{ response }` (same function);
 *   - `register/options` — posts only the reauth factor, `{ code }` or
 *     `{ password }` (`web/src/features/two-factor/two-factor-page.tsx`,
 *     `PasskeySection`'s `registerMutation`);
 *   - `register/verify` — posts only `{ response, name }` (same mutation).
 * Removing it is
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
 *
 * That decision was put to the owner on 2026-08-14 and declined: the residual
 * exposure needs an attacker who can already set the `Host` reaching this
 * process — i.e. control of the reverse proxy — and the column plus migration
 * was judged not worth buying that. So this is a settled position, not an
 * unfinished one. Do not "fix" it in passing.
 *
 * What would reopen it: a deployment where more than one hostname legitimately
 * reaches the panel, or a proxy that forwards `Host` unvalidated. Either turns
 * the header from a description of the deployment into an attacker-supplied
 * value, and then the credential has to carry its own RP ID.
 */
const UNKNOWN_REQUEST_METADATA: RequestMetadataInterface = {
  requestId: null,
  remoteAddress: null,
  userAgent: null,
};

/**
 * Request metadata for the audit rows and the fail2ban counter.
 *
 * Delegates to `extractRequestMetadata` rather than re-deriving anything: that
 * util is where the trust-proxy-aware client-IP resolution lives, and deriving
 * it a second time here is the exact mistake its own comment warns about (a
 * spoofable `X-Forwarded-For` bypassing the login counter, or auto-banning a
 * victim's real IP).
 *
 * The guard in front of it is about what this data IS. Every field is
 * telemetry — an audit row's IP and user agent, the key the failure counter
 * groups by — and none of it is authority. A caller holding a request object
 * that does not carry `headers`/`socket` must therefore degrade to "unknown"
 * rather than turn a sign-in into a 500. Nest's `@Req()` always supplies a real
 * Express request, so in production this never trips.
 */
function requestMetadata(req: Request): RequestMetadataInterface {
  const partial = req as Partial<Request>;
  if (partial.headers === undefined || partial.socket === undefined) {
    return UNKNOWN_REQUEST_METADATA;
  }
  return extractRequestMetadata(req);
}

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
