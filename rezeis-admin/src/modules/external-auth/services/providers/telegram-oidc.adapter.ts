import { HttpService } from '@nestjs/axios';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ExternalAuthProvider } from '@prisma/client';
import { firstValueFrom } from 'rxjs';

import { ExternalUserProfile } from '../../interfaces/external-auth.interface';
import {
  AuthorizeUrlInput,
  ExchangeInput,
  OAuthAdapterConfig,
  OAuthProviderAdapter,
} from '../../interfaces/oauth-adapter.interface';

// Telegram's OAuth 2.0 / OpenID Connect endpoints (discovery:
// https://oauth.telegram.org/.well-known/openid-configuration). Unlike the
// classic Login Widget (bot token + HMAC + /setdomain), this is a standard
// authorization-code provider configured with a Client ID + Secret from
// @BotFather. There is NO userinfo endpoint — the claims live in the id_token.
const AUTH_URL = 'https://oauth.telegram.org/auth';
const TOKEN_URL = 'https://oauth.telegram.org/token';
const DEFAULT_SCOPES = 'openid profile';

interface TelegramTokenResponse {
  readonly id_token?: string;
  readonly access_token?: string;
}

interface TelegramIdTokenClaims {
  readonly sub?: string | number;
  /**
   * The REAL Telegram user id (returned with the `profile` scope). This — NOT
   * `sub` (an opaque OIDC subject that is not a Telegram id) — is what matches
   * the same user's bot / Login-Widget account. See
   * https://core.telegram.org/bots/telegram-login (User Data Structure).
   */
  readonly id?: string | number;
  readonly preferred_username?: string;
  readonly name?: string;
  readonly picture?: string;
}

/**
 * Telegram OIDC adapter (provider identity stays `TELEGRAM` so widget/OIDC
 * links share the same Telegram user id). Telegram returns no email, so a new
 * user always lands on finish-setup — identical to the widget path.
 */
@Injectable()
export class TelegramOidcAdapter implements OAuthProviderAdapter {
  public readonly provider = ExternalAuthProvider.TELEGRAM;

  public constructor(private readonly httpService: HttpService) {}

  public buildAuthorizationUrl(config: OAuthAdapterConfig, input: AuthorizeUrlInput): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: config.scopes ?? DEFAULT_SCOPES,
      state: input.state,
    });
    if (config.usePkce && input.codeChallenge) {
      params.set('code_challenge', input.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }
    return `${AUTH_URL}?${params.toString()}`;
  }

  public async exchange(config: OAuthAdapterConfig, input: ExchangeInput): Promise<ExternalUserProfile> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    // Only attach the PKCE verifier when the config actually enabled PKCE (so
    // a `code_challenge` was sent on the authorize step). reiwa always mints a
    // verifier, but sending it without a prior challenge makes the OIDC token
    // endpoint reject the exchange (→ opaque 500). Keep PKCE all-or-nothing.
    if (config.usePkce && input.codeVerifier) form.set('code_verifier', input.codeVerifier);

    const tokenResp = await firstValueFrom(
      this.httpService.post<TelegramTokenResponse>(TOKEN_URL, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    const idToken = tokenResp.data.id_token;
    if (!idToken) throw new UnauthorizedException('Telegram token exchange returned no id_token');

    // The id_token is a JWT obtained over a direct, TLS-protected back channel
    // authenticated with our client_secret, so decoding the payload (without a
    // separate JWKS signature check) is trustworthy — the same trust model as
    // reading a provider userinfo response. We only read identity claims.
    const claims = decodeJwtClaims(idToken);
    // Identity = the real Telegram user id from the `id` claim (profile scope),
    // so an OIDC login resolves to the SAME account as this user's bot / Login
    // Widget sessions. `sub` is an opaque OIDC subject (not a Telegram id) — use
    // it only as a last-resort fallback when `id` is absent (openid-only scope).
    const telegramUserId =
      claims.id !== undefined && claims.id !== null ? String(claims.id) : null;
    const sub = claims.sub !== undefined && claims.sub !== null ? String(claims.sub) : null;
    const providerUserId = telegramUserId ?? sub;
    if (!providerUserId) throw new UnauthorizedException('Telegram id_token missing id/sub claim');

    return {
      provider: this.provider,
      providerUserId,
      email: null,
      emailVerified: false,
      name: claims.name ?? claims.preferred_username ?? null,
      avatarUrl: claims.picture ?? null,
      rawProfile: { sub, id: telegramUserId, preferred_username: claims.preferred_username, name: claims.name },
    };
  }
}

/** Decodes a JWT's payload segment (base64url) into its claims object. */
function decodeJwtClaims(jwt: string): TelegramIdTokenClaims {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new UnauthorizedException('Telegram id_token is malformed');
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new UnauthorizedException('Telegram id_token payload is not an object');
    }
    return parsed as TelegramIdTokenClaims;
  } catch {
    throw new UnauthorizedException('Telegram id_token payload could not be decoded');
  }
}
