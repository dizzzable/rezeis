import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';

import { OAuthPublicController } from '../src/modules/oauth/controllers/admin-oauth.controller';
import { GitHubAuthService } from '../src/modules/oauth/services/github-auth.service';
import { OAuthConfigService } from '../src/modules/oauth/services/oauth-config.service';
import { OAuthLoginService } from '../src/modules/oauth/services/oauth-login.service';
import { TelegramAuthService } from '../src/modules/oauth/services/telegram-auth.service';
import { OAuthLoginResult } from '../src/modules/oauth/interfaces/oauth-provider.interface';

/**
 * The GitHub OAuth CSRF check could never pass, so GitHub login was dead and
 * the check protected nothing.
 *
 * `githubCallback()` read `req.cookies?.['oauth_state']`. `req.cookies` is
 * populated by `cookie-parser` — which is not a dependency of this project and
 * is registered nowhere, in `main.ts` or in any middleware. So the value was
 * always `undefined`, the comparison always failed, and every callback answered
 * `403 Invalid OAuth state`. The nonce was minted correctly, written with
 * correct flags, and then compared against nothing.
 *
 * The two halves of this file must stay together, and that is the point of
 * putting them in one file: repairing the cookie ENABLES a login path, and an
 * enabled login path has to demand the second factor from the first day it
 * works. A commit that lands only the cookie half turns a dead endpoint into a
 * live 2FA bypass.
 *
 * No new dependency was added. The value is a hex nonce and the header is one
 * `split(';')` away; `readCookie()` prefers `req.cookies` if some future
 * middleware does populate it, so installing `cookie-parser` later cannot break
 * this route.
 */

const STATE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

interface Captured {
  status: number | null;
  sent: string | null;
  redirectedTo: string | null;
  cleared: Array<{ name: string; options: Record<string, unknown> }>;
  /**
   * Every `res.cookie(...)` the route made, verbatim.
   *
   * The double used to swallow these — `cookie() { return res; }` — so
   * `githubAuthorize` could be given ANY flags, or none, and this file stayed
   * green. Nothing here even called it.
   */
  written: Array<{ name: string; value: string; options: Record<string, unknown> }>;
}

function newCaptured(): Captured {
  return { status: null, sent: null, redirectedTo: null, cleared: [], written: [] };
}

function buildResponse(captured: Captured): Response {
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    send(body: string) {
      captured.sent = body;
      return res;
    },
    redirect(url: string) {
      captured.redirectedTo = url;
    },
    clearCookie(name: string, options: Record<string, unknown>) {
      captured.cleared.push({ name, options });
      return res;
    },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      captured.written.push({ name, value, options });
      return res;
    },
  };
  return res as unknown as Response;
}

function buildRequest(options: {
  readonly cookieHeader?: string;
  readonly parsedCookies?: Record<string, unknown>;
}): Request {
  return {
    headers: options.cookieHeader === undefined ? {} : { cookie: options.cookieHeader },
    cookies: options.parsedCookies,
  } as unknown as Request;
}

function buildController(options: { readonly loginError?: unknown } = {}): {
  controller: OAuthPublicController;
  githubCalls: string[];
  authorizeStates: string[];
} {
  const githubCalls: string[] = [];
  const authorizeStates: string[] = [];
  const githubAuth = {
    handleCallback: async (code: string) => {
      githubCalls.push(code);
      return {
        providerId: 'gh-1',
        providerType: 'GITHUB',
        email: 'operator@example.test',
        name: 'Operator',
        avatarUrl: null,
        rawProfile: {},
      };
    },
    getAuthorizationUrl: async (state: string) => {
      authorizeStates.push(state);
      return `https://github.test/login/oauth/authorize?state=${state}`;
    },
  } as unknown as GitHubAuthService;

  const loginService = {
    processOAuthLogin: async (): Promise<OAuthLoginResult> => {
      if (options.loginError) throw options.loginError;
      return {
        accessToken: 'jwt-token',
        tokenType: 'Bearer',
        expiresIn: '24h',
        admin: { id: 'admin-1', login: 'operator', name: 'Operator', role: 'DEV' },
        isNewLink: false,
      };
    },
  } as unknown as OAuthLoginService;

  const controller = new OAuthPublicController(
    {} as unknown as OAuthConfigService,
    {} as unknown as TelegramAuthService,
    githubAuth,
    loginService,
  );
  return { controller, githubCalls, authorizeStates };
}

describe('GET admin/oauth/github/callback — the CSRF nonce is actually read', () => {
  it('accepts a callback whose state matches the cookie on the request', async () => {
    const { controller, githubCalls } = buildController();
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      STATE,
      buildRequest({ cookieHeader: `oauth_state=${STATE}` }),
      buildResponse(captured),
    );

    assert.equal(
      captured.status,
      null,
      'a valid callback was refused. `req.cookies` is undefined in this app — ' +
        'nothing populates it — so reading the nonce from there rejects every ' +
        'GitHub login that has ever been attempted.',
    );
    assert.equal(captured.redirectedTo, '/#oauth_token=jwt-token');
    assert.deepStrictEqual(githubCalls, ['gh-code'], 'the code was never exchanged');
    assert.deepStrictEqual(
      captured.cleared.map((entry) => entry.name),
      ['oauth_state'],
      'the single-use nonce was left in the browser',
    );
  });

  it('finds the nonce among other cookies, and ignores a name that merely ends the same way', async () => {
    const { controller } = buildController();
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      STATE,
      buildRequest({
        cookieHeader: `theme=dark; xoauth_state=deadbeef; oauth_state=${STATE}; lang=ru`,
      }),
      buildResponse(captured),
    );

    assert.equal(captured.status, null, 'a real cookie header with neighbours was misparsed');
    assert.equal(captured.redirectedTo, '/#oauth_token=jwt-token');
  });

  it('does not mistake a look-alike cookie for the nonce', async () => {
    const { controller } = buildController();
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      STATE,
      buildRequest({ cookieHeader: `xoauth_state=${STATE}` }),
      buildResponse(captured),
    );

    assert.equal(
      captured.status,
      403,
      'a differently-named cookie satisfied the CSRF check — the name match is ' +
        'a substring test, not an equality test',
    );
  });

  it('still refuses when no cookie was sent', async () => {
    const { controller, githubCalls } = buildController();
    const captured: Captured = newCaptured();

    await controller.githubCallback('gh-code', STATE, buildRequest({}), buildResponse(captured));

    assert.equal(captured.status, 403);
    assert.match(captured.sent ?? '', /CSRF/u);
    assert.deepStrictEqual(githubCalls, [], 'the code was exchanged before the state was checked');
  });

  it('still refuses when the state does not match the cookie', async () => {
    const { controller } = buildController();
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      'attacker-supplied-state',
      buildRequest({ cookieHeader: `oauth_state=${STATE}` }),
      buildResponse(captured),
    );

    assert.equal(captured.status, 403, 'the CSRF check stopped checking');
  });

  it('still refuses when the callback carries no state at all', async () => {
    const { controller } = buildController();
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      '',
      buildRequest({ cookieHeader: `oauth_state=${STATE}` }),
      buildResponse(captured),
    );

    assert.equal(captured.status, 403);
  });

  it('prefers req.cookies when something does populate it', async () => {
    // Forward compatibility, deliberately asserted: if `cookie-parser` (or any
    // equivalent) is installed later, this endpoint must keep working rather
    // than start reading a header the middleware has already consumed.
    const { controller } = buildController();
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      STATE,
      buildRequest({ parsedCookies: { oauth_state: STATE } }),
      buildResponse(captured),
    );

    assert.equal(captured.status, null);
    assert.equal(captured.redirectedTo, '/#oauth_token=jwt-token');
  });
});

describe('GET admin/oauth/github/callback — the path it enables demands 2FA', () => {
  it('refuses to hand out a token when the linked admin has 2FA on', async () => {
    // This leg is a browser redirect back from GitHub: it carries no code and
    // has nowhere to type one. Refusing IS honouring the second factor — an
    // admin who turned 2FA on must not get a 24h session from a provider
    // round-trip alone.
    const { controller } = buildController({
      loginError: new UnauthorizedException('totp_required'),
    });
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      STATE,
      buildRequest({ cookieHeader: `oauth_state=${STATE}` }),
      buildResponse(captured),
    );

    assert.equal(
      captured.redirectedTo,
      '/#oauth_error=totp_required',
      'repairing the cookie turned a permanently-403 endpoint into a working ' +
        'login that skips the second factor — the two changes only make sense ' +
        'together',
    );
    assert.equal(
      /oauth_token/u.test(captured.redirectedTo ?? ''),
      false,
      'a token was handed to the browser anyway',
    );
  });

  it('carries the reason in the fragment, never the query string', async () => {
    // Same rule the success branch follows: a fragment is not sent to the
    // server and does not land in access logs or the Referer header.
    const { controller } = buildController({
      loginError: new UnauthorizedException('totp_required'),
    });
    const captured: Captured = newCaptured();

    await controller.githubCallback(
      'gh-code',
      STATE,
      buildRequest({ cookieHeader: `oauth_state=${STATE}` }),
      buildResponse(captured),
    );

    assert.equal((captured.redirectedTo ?? '').includes('?'), false);
    assert.ok((captured.redirectedTo ?? '').includes('#'));
  });

  it('lets any other authorization failure propagate unchanged', async () => {
    // Only the second-factor pivot is special-cased. "No admin account is
    // linked to this identity" must not be redirected away as if it were a
    // 2FA prompt.
    const { controller } = buildController({
      loginError: new UnauthorizedException('No admin account is linked to this identity.'),
    });
    const captured: Captured = newCaptured();

    await assert.rejects(
      () =>
        controller.githubCallback(
          'gh-code',
          STATE,
          buildRequest({ cookieHeader: `oauth_state=${STATE}` }),
          buildResponse(captured),
        ),
      UnauthorizedException,
    );
    assert.equal(captured.redirectedTo, null);
  });
});

describe('GET admin/oauth/github/authorize — the nonce cookie is scoped to the callback', () => {
  /**
   * Nothing used to call this route.
   *
   * The whole CSRF story is two halves — `authorize` writes a nonce cookie,
   * `callback` compares it — and only the second half was under test. The
   * cookie could be written to `path: '/'`, without `httpOnly`, with
   * `sameSite: 'none'` and no lifetime, and every test in this file stayed
   * green, because the double's `cookie()` threw the call away.
   *
   * `path` is the attribute with two failure modes rather than one. Too narrow
   * and the browser never sends the cookie back to
   * `/api/admin/oauth/github/callback`, so `storedState` is null and every
   * sign-in answers 403 — exactly the dead endpoint this file was written to
   * fix, reintroduced from the other end. Too broad and a nonce that only the
   * callback needs rides on every request to the whole domain, including the
   * SPA's own asset fetches and any other app sharing it.
   *
   * The set below is the set the route actually writes — five attributes, no
   * `domain`, no `expires`, no `signed` — asserted as a whole so that adding
   * one has to be a decision rather than an accident.
   */
  const EXPECTED_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 300_000,
    path: '/api/admin/oauth/github',
  };

  it('writes exactly one cookie, and writes it with exactly these attributes', async () => {
    const { controller } = buildController();
    const captured = newCaptured();

    await controller.githubAuthorize(buildResponse(captured));

    assert.equal(captured.written.length, 1, 'authorize must write the state nonce, once');
    const cookie = captured.written[0]!;
    assert.equal(cookie.name, 'oauth_state', 'the callback reads `oauth_state` and nothing else');
    assert.deepStrictEqual(
      cookie.options,
      EXPECTED_COOKIE_OPTIONS,
      'the CSRF nonce cookie is no longer written with the attributes the callback depends on',
    );
  });

  it('scopes it to the callback path, so it neither misses nor over-shares', async () => {
    // Called out on its own because both directions are silent failures: a
    // narrower path kills sign-in with a 403 that looks like an attack, a
    // broader one leaks the nonce onto every request to the domain.
    const { controller } = buildController();
    const captured = newCaptured();

    await controller.githubAuthorize(buildResponse(captured));

    assert.equal(
      captured.written[0]?.options.path,
      '/api/admin/oauth/github',
      'the nonce is scoped somewhere other than the route that reads it',
    );
  });

  it('hands GitHub the same nonce it put in the cookie', async () => {
    // Without this the two halves are independent random values and the
    // comparison in the callback can never succeed on a real round trip.
    const { controller, authorizeStates } = buildController();
    const captured = newCaptured();

    await controller.githubAuthorize(buildResponse(captured));

    assert.equal(authorizeStates.length, 1);
    assert.equal(
      captured.written[0]?.value,
      authorizeStates[0],
      'the cookie carries one nonce and GitHub was sent another',
    );
    assert.match(
      captured.written[0]?.value ?? '',
      /^[0-9a-f]{32}$/u,
      'the nonce is not 16 bytes of hex from randomBytes',
    );
    assert.equal(captured.redirectedTo, `https://github.test/login/oauth/authorize?state=${authorizeStates[0]}`);
  });

  it('mints a fresh nonce every time', async () => {
    const { controller } = buildController();
    const first = newCaptured();
    const second = newCaptured();

    await controller.githubAuthorize(buildResponse(first));
    await controller.githubAuthorize(buildResponse(second));

    assert.notEqual(
      first.written[0]?.value,
      second.written[0]?.value,
      'a constant state defeats the whole point: an attacker knows the value to replay',
    );
  });

  it('clears the nonce on the path it was written to, on the happy path', async () => {
    // `clearCookie` matches on name AND path. Clear on a different path and
    // the browser keeps the cookie, so a nonce that was supposed to be spent
    // stays in the jar until it expires.
    const { controller } = buildController();
    const minted = newCaptured();
    await controller.githubAuthorize(buildResponse(minted));
    const state = minted.written[0]!.value;

    const captured = newCaptured();
    await controller.githubCallback(
      'gh-code',
      state,
      buildRequest({ cookieHeader: `oauth_state=${state}` }),
      buildResponse(captured),
    );

    assert.equal(captured.redirectedTo, '/#oauth_token=jwt-token');
    assert.equal(captured.cleared.length, 1);
    assert.equal(captured.cleared[0]?.name, minted.written[0]?.name);
    assert.deepStrictEqual(
      captured.cleared[0]?.options,
      { path: minted.written[0]?.options.path },
      'clearCookie names a different path than the cookie was written with, so it misses',
    );
  });

  it('clears it on the same path when it refuses the callback too', async () => {
    const { controller } = buildController();
    const minted = newCaptured();
    await controller.githubAuthorize(buildResponse(minted));

    const captured = newCaptured();
    await controller.githubCallback(
      'gh-code',
      'attacker-supplied-state',
      buildRequest({ cookieHeader: `oauth_state=${minted.written[0]!.value}` }),
      buildResponse(captured),
    );

    assert.equal(captured.status, 403);
    assert.deepStrictEqual(
      captured.cleared.map((entry) => entry.options),
      [{ path: minted.written[0]?.options.path }],
      'a rejected callback must burn the nonce on the path that holds it',
    );
  });
});
