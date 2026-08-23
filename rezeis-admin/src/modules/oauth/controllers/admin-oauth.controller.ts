import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthProviderType } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  AuthProviderConfigInterface,
  OAuthLoginResult,
  PublicProviderInfo,
} from '../interfaces/oauth-provider.interface';
import { CryptoService } from '../services/crypto.service';
import { GitHubAuthService } from '../services/github-auth.service';
import { OAuthConfigService } from '../services/oauth-config.service';
import { OAuthLoginService } from '../services/oauth-login.service';
import { TelegramAuthService } from '../services/telegram-auth.service';
import { Public } from '../../../common/decorators/public.decorator';

/** Name of the short-lived CSRF nonce cookie set by `github/authorize`. */
const OAUTH_STATE_COOKIE = 'oauth_state';
/** Must match the `path` the cookie was written with, or `clearCookie` misses. */
const OAUTH_STATE_COOKIE_PATH = '/api/admin/oauth/github';

// ── Public endpoints (no JWT required) ───────────────────────────────────────

@Controller('admin/oauth')
@Public()
export class OAuthPublicController {
  public constructor(
    private readonly configService: OAuthConfigService,
    private readonly telegramAuth: TelegramAuthService,
    private readonly githubAuth: GitHubAuthService,
    private readonly loginService: OAuthLoginService,
  ) {}

  /**
   * Returns enabled providers for the login page.
   */
  @Get('providers')
  public async getProviders(): Promise<PublicProviderInfo[]> {
    return this.configService.getEnabledProviders();
  }

  /**
   * Telegram Login Widget callback.
   * Receives signed data from the widget and verifies it.
   *
   * `totpCode` is optional and is OURS, not Telegram's. It is lifted out of
   * the body before verification because `verifyTelegramLogin()` recomputes
   * the widget's HMAC over every field except `hash`
   * (`telegram-auth.service.ts:86-105`) — an extra field would make a
   * perfectly good signature mismatch.
   *
   * 10/60 s, matching `PasskeyPublicController` above it — the closest sibling
   * this route has, since both are `@Public()` sign-in paths that end in a
   * signed admin JWT.
   *
   * It had no override, which was the worst instance of the whole defect
   * because this one is unauthenticated. Measured: 700 second-factor guesses
   * from one IP produced `{"401":600,"429":100}` with the first 429 at attempt
   * 601, and 600 of them reached `TwoFactorService.verifyForLogin` — six
   * hundred free TOTP guesses a minute against an account whose owner had
   * switched 2FA on precisely to prevent that. The attacker needed factor one
   * (control of the linked Telegram account) and this route sold them factor
   * two at 600/minute.
   *
   * The per-minute number is only the coarse half. The half that matters is
   * `LoginGuardService`, now called from `OAuthLoginService` so these failures
   * spend the same per-(login, ip) budget a mistyped password spends. That is
   * the control NIST SP 800-63B s5.2.2 is actually asking for — a cap on
   * CONSECUTIVE failures, which no per-minute ceiling can express.
   */
  @Post('telegram/login')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  public async telegramLogin(
    @Body() data: Record<string, string>,
    @Req() request: Request,
  ): Promise<OAuthLoginResult> {
    const { totpCode, ...widgetData } = data;
    const profile = await this.telegramAuth.verifyTelegramLogin(widgetData);
    try {
      return await this.loginService.processOAuthLogin(profile, {
        totpCode: totpCode ?? null,
        requestMetadata: requestMetadata(request),
      });
    } catch (err) {
      // Same mapping as `admin-auth.controller.ts:132-144`, on purpose: one
      // wire contract for "2FA is on, ask for a code" whichever factor came
      // first.
      if (isTotpRequired(err)) throw buildTotpRequiredException();
      throw err;
    }
  }

  /**
   * GitHub OAuth2: redirect to GitHub authorization page.
   */
  @Get('github/authorize')
  public async githubAuthorize(
    @Res() res: Response,
  ): Promise<void> {
    // Generate cryptographically random state for CSRF protection
    const { randomBytes } = await import('node:crypto');
    const state = randomBytes(16).toString('hex');
    // Store state in a short-lived cookie for validation in callback
    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 300_000, // 5 minutes
      path: '/api/admin/oauth/github',
    });
    const url = await this.githubAuth.getAuthorizationUrl(state);
    res.redirect(url);
  }

  /**
   * GitHub OAuth2: callback from GitHub after user authorizes.
   *
   * 30/60 s — and the number is loose on purpose, because this route is NOT a
   * brute-force surface and treating it like one would hurt.
   *
   * It checks no guessable credential. There is no field to put a code in: the
   * browser arrives here from GitHub carrying `code` and `state`, and the 2FA
   * leg below cannot ask for anything, it can only refuse and send the operator
   * back to the sign-in form. The CSRF check is not an oracle either — the
   * caller sets both halves of the comparison, so a mismatch tells an attacker
   * only what they already knew. Nothing here gets closer to an account by
   * being repeated, so the tight limits used on the code-checking routes above
   * would buy exactly nothing.
   *
   * What a 429 would cost, on the other hand, is real. This is a redirect the
   * BROWSER follows, not a call the SPA makes: a refusal is not an error object
   * some `catch` turns into a message, it is the raw throttler body rendered as
   * a page, mid-sign-in, with the application never loaded and no way onward
   * but the back button. That is the worst-shaped failure in this file, and a
   * legitimate operator reaches it in exactly one request per sign-in.
   *
   * So why any override at all: the route makes an OUTBOUND call.
   * `handleCallback(code)` exchanges the code with GitHub, and an attacker can
   * mint themselves state cookies from `github/authorize` all day, so the
   * global 600/60 s let one address drive 600 token exchanges a minute at
   * GitHub's expense and ours. 30 caps that amplification twentyfold while
   * sitting an order of magnitude above anything a human sign-in can produce —
   * thirty sign-ins a minute from one address, which also leaves plenty of head
   * room for a whole office behind one NAT egress.
   *
   * Read the number as "no human can hit this", not as a security budget.
   */
  @Get('github/callback')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  public async githubCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Validate CSRF state.
    //
    // This used to read `req.cookies?.['oauth_state']`. `req.cookies` is
    // populated by `cookie-parser`, which is not a dependency of this project
    // and is registered nowhere — so the value was ALWAYS `undefined`, the
    // comparison below always failed, and every GitHub callback answered 403.
    // GitHub login was dead, and the "CSRF protection" validated nothing
    // because it could not run.
    //
    // `readCookie()` reads the header the endpoint actually receives. No new
    // dependency for one cookie whose value is a hex nonce; it still prefers
    // `req.cookies` when something does populate it, so installing
    // `cookie-parser` later cannot break this route.
    const storedState = readCookie(req, OAUTH_STATE_COOKIE);
    if (!state || !storedState || state !== storedState) {
      res.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_STATE_COOKIE_PATH });
      res.status(403).send('Invalid OAuth state — possible CSRF attack');
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_STATE_COOKIE_PATH });

    const profile = await this.githubAuth.handleCallback(code);
    let result: OAuthLoginResult;
    try {
      result = await this.loginService.processOAuthLogin(profile, {
        requestMetadata: requestMetadata(req),
      });
    } catch (err) {
      if (isTotpRequired(err)) {
        // Fixing the cookie above turns this route from "always 403" into a
        // working login path, so it has to demand the second factor from the
        // day it starts working — the two changes only make sense together.
        //
        // This leg carries no code and has nowhere to type one: it is a
        // browser redirect back from GitHub. Refusing IS honouring 2FA. The
        // reason travels in the fragment (never the query — same rule the
        // success branch below follows, so nothing lands in access logs) so
        // the SPA can say "finish signing in with your password and code"
        // instead of showing a blank screen. Completing the flow from here
        // would need a second-step screen in the SPA; see the fix report.
        res.redirect('/#oauth_error=totp_required');
        return;
      }
      throw err;
    }
    // Use hash fragment — NOT query param — so token is never sent to server/logged
    res.redirect(`/#oauth_token=${result.accessToken}`);
  }
}

// ── Admin-only endpoints (JWT required) ──────────────────────────────────────

@Controller('admin/oauth/config')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class OAuthConfigController {
  public constructor(
    private readonly configService: OAuthConfigService,
    private readonly cryptoService: CryptoService,
  ) {}

  /**
   * Returns all provider configurations (admin view).
   */
  @Get()
  @RequirePermission('auth_providers', 'view')
  public async getAllConfigs(): Promise<AuthProviderConfigInterface[]> {
    return this.configService.getAllConfigs();
  }

  /**
   * Updates a provider configuration.
   */
  @Put(':type')
  @RequirePermission('auth_providers', 'edit')
  public async updateConfig(
    @Param('type') type: AuthProviderType,
    @Body() body: UpdateProviderConfigDto,
  ): Promise<AuthProviderConfigInterface> {
    // Encrypt client secret if provided
    const data: Record<string, unknown> = { ...body };
    if (body.clientSecret !== undefined && body.clientSecret !== null) {
      data['clientSecretEnc'] = this.cryptoService.encrypt(body.clientSecret);
      delete data['clientSecret'];
    } else {
      delete data['clientSecret'];
    }

    return this.configService.updateConfig(type, data as Parameters<typeof this.configService.updateConfig>[1]);
  }
}

// ── Linked accounts management (JWT required) ────────────────────────────────

@Controller('admin/oauth/links')
@UseGuards(AdminJwtAuthGuard)
export class OAuthLinksController {
  public constructor(private readonly loginService: OAuthLoginService) {}

  /**
   * Returns linked OAuth providers for the current admin.
   */
  @Get()
  public async getLinkedProviders(@Req() req: Request) {
    const admin = req.user as { id: string };
    return this.loginService.getLinkedProviders(admin.id);
  }

  /**
   * Unlinks a provider from the current admin.
   */
  @Delete(':type')
  public async unlinkProvider(
    @Req() req: Request,
    @Param('type') type: AuthProviderType,
  ) {
    const admin = req.user as { id: string };
    await this.loginService.unlinkProvider(admin.id, type);
    return { ok: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const UNKNOWN_REQUEST_METADATA: RequestMetadataInterface = {
  requestId: null,
  remoteAddress: null,
  userAgent: null,
};

/**
 * Request metadata for the fail2ban counter, guarded the same way
 * `passkey.controller.ts` guards it — one idiom for one job, and its comment
 * carries the full reasoning.
 *
 * The short version: every field here is telemetry, never authority. It is the
 * key `LoginGuardService` groups failures by and the user agent on the attempt
 * row, and nothing downstream makes a trust decision from it. So a caller
 * holding a request object without `headers`/`socket` must degrade to
 * "unknown" rather than turn a sign-in into a 500 — which is not hypothetical:
 * adding the unguarded call broke seven assertions in
 * `oauth-github-callback-csrf-cookie.spec.ts`, every one of them a hand-built
 * request, and a 500 there would have replaced a working GitHub sign-in with a
 * server error for anyone whose request did not look exactly like Express's.
 *
 * `extractRequestMetadata` is still the only thing that derives the address:
 * it is where the trust-proxy-aware resolution lives, and re-deriving it here
 * is precisely the mistake its own comment warns about — a spoofable
 * `X-Forwarded-For` bypassing the counter, or auto-banning a victim's real IP.
 */
function requestMetadata(request: Request): RequestMetadataInterface {
  const partial = request as Partial<Request>;
  if (partial.headers === undefined || partial.socket === undefined) {
    return UNKNOWN_REQUEST_METADATA;
  }
  return extractRequestMetadata(request);
}

/**
 * Reads one cookie off the request.
 *
 * Prefers `request.cookies` when a parser middleware has populated it, and
 * falls back to the raw `Cookie:` header otherwise — which is the only reason
 * this endpoint works at all, since nothing in this app populates
 * `request.cookies`.
 */
function readCookie(request: Request, name: string): string | null {
  const parsed = (request as { cookies?: Record<string, unknown> }).cookies;
  const fromParser = parsed?.[name];
  if (typeof fromParser === 'string' && fromParser.length > 0) return fromParser;

  const header = request.headers?.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    let value = pair.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      return decodeURIComponent(value);
    } catch {
      // A cookie value that is not valid percent-encoding is returned as sent.
      // The state nonce is hex, so this only ever protects against a stray
      // cookie from elsewhere on the domain crashing the callback.
      return value;
    }
  }
  return null;
}

/**
 * True for the soft "2FA is on, ask for a code" signal thrown by
 * `OAuthLoginService`. The message is the bare string `totp_required`, exactly
 * as `AdminAuthService.loginAdmin()` throws it.
 */
function isTotpRequired(err: unknown): boolean {
  return (
    err instanceof UnauthorizedException &&
    (err.getResponse() as { message?: string }).message === 'totp_required'
  );
}

/**
 * The wire shape the sign-in form understands. `code` must stay spelled
 * `totp_required`: `AdminSafeExceptionFilter` forwards only codes listed in
 * `SAFE_PRODUCT_CODES`, and `sign-in-page.tsx` compares against that literal.
 */
function buildTotpRequiredException(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: 'totp_required',
    message: 'Two-factor authentication required',
  });
}

// ── DTO ──────────────────────────────────────────────────────────────────────

interface UpdateProviderConfigDto {
  isEnabled?: boolean;
  displayName?: string;
  clientId?: string | null;
  clientSecret?: string | null;
  frontendDomain?: string | null;
  backendDomain?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  realm?: string | null;
  providerDomain?: string | null;
  usePkce?: boolean;
  allowedEmails?: string[];
  allowedTelegramIds?: string[];
}
