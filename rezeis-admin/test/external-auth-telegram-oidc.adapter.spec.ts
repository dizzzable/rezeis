import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of } from 'rxjs';

import { TelegramOidcAdapter } from '../src/modules/external-auth/services/providers/telegram-oidc.adapter';
import type { OAuthAdapterConfig } from '../src/modules/external-auth/interfaces/oauth-adapter.interface';

function makeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

const config: OAuthAdapterConfig = {
  clientId: 'tg-client',
  clientSecret: 'tg-secret',
  usePkce: true,
  scopes: null,
};

describe('TelegramOidcAdapter', () => {
  it('builds an oauth.telegram.org authorization URL with PKCE', () => {
    const adapter = new TelegramOidcAdapter({} as never);
    const url = adapter.buildAuthorizationUrl(config, {
      state: 'st4te',
      redirectUri: 'https://cab.example/api/v1/auth/ext/telegram/callback',
      codeChallenge: 'chal',
    });
    assert.ok(url.startsWith('https://oauth.telegram.org/auth?'));
    assert.match(url, /client_id=tg-client/);
    assert.match(url, /response_type=code/);
    assert.match(url, /code_challenge=chal/);
    assert.match(url, /code_challenge_method=S256/);
    assert.match(url, /state=st4te/);
  });

  it('exchanges the code and reads identity claims from the id_token (no email)', async () => {
    const idToken = makeIdToken({ sub: 987654321, name: 'Alice', preferred_username: 'alice_tg', picture: 'https://x/y.jpg' });
    const httpService = {
      post: () => of({ data: { id_token: idToken } }),
    };
    const adapter = new TelegramOidcAdapter(httpService as never);
    const profile = await adapter.exchange(config, {
      code: 'auth-code',
      redirectUri: 'https://cab.example/api/v1/auth/ext/telegram/callback',
      codeVerifier: 'verifier',
    });
    assert.equal(profile.provider, 'TELEGRAM');
    assert.equal(profile.providerUserId, '987654321');
    assert.equal(profile.name, 'Alice');
    assert.equal(profile.avatarUrl, 'https://x/y.jpg');
    // Telegram OIDC never provides an email — new users must finish setup.
    assert.equal(profile.email, null);
    assert.equal(profile.emailVerified, false);
  });

  it('rejects a token response without an id_token', async () => {
    const httpService = { post: () => of({ data: {} }) };
    const adapter = new TelegramOidcAdapter(httpService as never);
    await assert.rejects(
      adapter.exchange(config, { code: 'c', redirectUri: 'https://cab/cb' }),
      /id_token/,
    );
  });
});
