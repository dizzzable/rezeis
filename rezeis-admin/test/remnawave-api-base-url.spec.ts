import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of } from 'rxjs';

import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * Focused coverage for `RemnawaveApiService#getBaseUrl()`.
 *
 * The legacy spec file (`remnawave-api.service.spec.ts`) contains additional
 * cases that depend on methods which no longer exist on the service — those
 * are unrelated to the base-URL resolution and predate the HTTPS-aware
 * change introduced here. Keeping these new tests in a dedicated file lets
 * the targeted coverage compile and run regardless of the legacy file's state.
 */
describe('RemnawaveApiService base URL resolution', () => {
  it('targets the public HTTPS upstream when REMNAWAVE_HOST is a domain', async () => {
    const capturedBaseURLs: Array<string | undefined> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly url: string; readonly baseURL?: string }) => {
          capturedBaseURLs.push(input.baseURL);
          return of({
            data: {
              response: {
                isLoginAllowed: true,
                isRegisterAllowed: false,
                authentication: {
                  passkey: { enabled: false },
                  oauth2: { providers: {} },
                  password: { enabled: true },
                },
                branding: { title: 'Panel', logoUrl: null },
              },
            },
          });
        },
      } as never,
      {
        // Public HTTPS-domain scenario: dotted host, port intentionally null.
        host: 'panel.example.com',
        port: null,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    await service.getStatus();

    assert.deepStrictEqual(capturedBaseURLs, ['https://panel.example.com']);
  });

  it('targets the docker service over plain HTTP when REMNAWAVE_HOST has no dot', async () => {
    const capturedBaseURLs: Array<string | undefined> = [];
    const service = new RemnawaveApiService(
      {
        request: (input: { readonly url: string; readonly baseURL?: string }) => {
          capturedBaseURLs.push(input.baseURL);
          return of({
            data: {
              response: {
                isLoginAllowed: true,
                isRegisterAllowed: false,
                authentication: {
                  passkey: { enabled: false },
                  oauth2: { providers: {} },
                  password: { enabled: true },
                },
                branding: { title: 'Panel', logoUrl: null },
              },
            },
          });
        },
      } as never,
      {
        host: 'remnawave',
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    await service.getStatus();

    assert.deepStrictEqual(capturedBaseURLs, ['http://remnawave:3000']);
  });

  it('reports remnawave as not configured when a docker-style host has no port', async () => {
    const service = new RemnawaveApiService(
      { request: () => of({ data: {} }) } as never,
      {
        host: 'remnawave',
        port: null,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    assert.deepStrictEqual(await service.getStatus(), {
      isConfigured: false,
      isReachable: false,
      isLoginAllowed: null,
      isRegisterAllowed: null,
      authentication: null,
      branding: null,
    });
  });

  it('still treats a missing host as not configured', async () => {
    const service = new RemnawaveApiService(
      { request: () => of({ data: {} }) } as never,
      {
        host: null,
        port: 3000,
        token: 'secret',
        webhookSecret: null,
        caddyToken: null,
        cookie: null,
      },
    );

    assert.deepStrictEqual(await service.getStatus(), {
      isConfigured: false,
      isReachable: false,
      isLoginAllowed: null,
      isRegisterAllowed: null,
      authentication: null,
      branding: null,
    });
  });
});
