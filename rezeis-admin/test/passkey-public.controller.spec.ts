import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { PasskeyPublicController } from '../src/modules/oauth/controllers/passkey.controller';
import type { PasskeyService } from '../src/modules/oauth/services/passkey.service';
import { assertRoute, assertRouteHandlers, assertRouteUngated, routeLabel } from './helpers/controller-routes';

const BASE = 'admin/passkey';

/** A request reaching the panel at `panel.example.com` behind a TLS proxy. */
function requestFrom(host: string, proto = 'https'): Request {
  const headers: Record<string, string> = { host, 'x-forwarded-proto': proto };
  return {
    get: (name: string): string | undefined => headers[name.toLowerCase()],
    protocol: proto,
  } as unknown as Request;
}

interface Recorded {
  readonly optionsRpId: string[];
  readonly verifyRpId: string[];
  readonly verifyOrigin: string[];
}

function recordingService(): { service: PasskeyService; recorded: Recorded } {
  const recorded: Recorded = { optionsRpId: [], verifyRpId: [], verifyOrigin: [] };
  const service = {
    generateAuthenticationOptions: async (rpId: string): Promise<Record<string, unknown>> => {
      recorded.optionsRpId.push(rpId);
      return { challenge: 'c' };
    },
    verifyAuthentication: async (
      rpId: string,
      origin: string,
    ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: string }> => {
      recorded.verifyRpId.push(rpId);
      recorded.verifyOrigin.push(origin);
      return { accessToken: 't', tokenType: 'Bearer', expiresIn: '1h' };
    },
  } as unknown as PasskeyService;
  return { service, recorded };
}

/**
 * `PasskeyPublicController` is the unauthenticated half of passkey login: it
 * hands out a WebAuthn challenge and, on the way back, turns a verified
 * assertion into an admin JWT. There is no session to scope it by — the
 * credential id in the response IS the claim of identity — so everything that
 * binds an assertion to THIS panel has to be decided server-side.
 *
 * Both handlers used to accept `rpId` in the request body and prefer it over
 * the request. `expectedRPID` and `expectedOrigin` are the two values WebAuthn
 * verification compares the assertion against; supplying one of them from the
 * body asks the library whether the assertion matches whatever the caller
 * claims it should match, which is true by construction. The tests below pin
 * that the body cannot reach either value.
 *
 * They are behavioural on purpose. Asserting "the parameter is gone" would
 * pass just as well if the handler read `rpId` off `req.body` instead, which is
 * the same defect with different syntax.
 */
describe('PasskeyPublicController login surface', () => {
  it('exposes exactly the two login routes and is deliberately public', () => {
    assertRouteHandlers(PasskeyPublicController, [
      'getAuthenticationOptions',
      'verifyAuthentication',
    ]);

    assert.equal(Reflect.getMetadata(PATH_METADATA, PasskeyPublicController), BASE);
    assert.equal(
      Reflect.getMetadata(IS_PUBLIC_KEY, PasskeyPublicController),
      true,
      'the login half must stay public — its twin PasskeyProtectedController shares this base path',
    );
    assert.equal(
      Reflect.getMetadata(GUARDS_METADATA, PasskeyPublicController),
      undefined,
      'a guard here would demand a session to log in',
    );

    const optionsPath = 'authenticate/options';
    const optionsRoute = `${routeLabel(BASE, RequestMethod.POST, optionsPath)} (issue challenge)`;
    assertRoute(
      PasskeyPublicController.prototype.getAuthenticationOptions,
      { method: RequestMethod.POST, path: optionsPath },
      optionsRoute,
    );
    assertRouteUngated(
      PasskeyPublicController,
      PasskeyPublicController.prototype.getAuthenticationOptions,
      optionsRoute,
    );

    const verifyPath = 'authenticate/verify';
    const verifyRoute = `${routeLabel(BASE, RequestMethod.POST, verifyPath)} (assertion to JWT)`;
    assertRoute(
      PasskeyPublicController.prototype.verifyAuthentication,
      { method: RequestMethod.POST, path: verifyPath },
      verifyRoute,
    );
    assertRouteUngated(
      PasskeyPublicController,
      PasskeyPublicController.prototype.verifyAuthentication,
      verifyRoute,
    );
  });

  it('takes the RP ID from the request when issuing a challenge, never from the caller', async () => {
    const { service, recorded } = recordingService();
    const controller = new PasskeyPublicController(service);

    await controller.getAuthenticationOptions(requestFrom('panel.example.com'));

    assert.deepStrictEqual(recorded.optionsRpId, ['panel.example.com']);
  });

  it('ignores an rpId smuggled in the verify body', async () => {
    const { service, recorded } = recordingService();
    const controller = new PasskeyPublicController(service);

    // Exactly what an attacker-shaped request looks like: a real assertion
    // envelope plus an extra field naming the RP the server should compare
    // against. The cast stands in for JSON arriving over the wire, which
    // carries no notion of an excess property.
    const body = {
      response: { id: 'cred-1' },
      rpId: 'attacker.example',
    } as unknown as { response: Record<string, unknown> };

    await controller.verifyAuthentication(requestFrom('panel.example.com'), body);

    assert.deepStrictEqual(
      recorded.verifyRpId,
      ['panel.example.com'],
      'expectedRPID must come from the request, not the body',
    );
    assert.deepStrictEqual(
      recorded.verifyOrigin,
      ['https://panel.example.com'],
      'expectedOrigin must come from the request, not the body',
    );
  });

  it('derives the origin scheme from the proxy header, so http deployments still verify', async () => {
    const { service, recorded } = recordingService();
    const controller = new PasskeyPublicController(service);

    await controller.verifyAuthentication(requestFrom('panel.internal:8080', 'http'), {
      response: { id: 'cred-1' },
    });

    assert.deepStrictEqual(
      recorded.verifyRpId,
      ['panel.internal'],
      'the RP ID is a domain — the port belongs to the origin and not to it',
    );
    assert.deepStrictEqual(recorded.verifyOrigin, ['http://panel.internal:8080']);
  });
});
