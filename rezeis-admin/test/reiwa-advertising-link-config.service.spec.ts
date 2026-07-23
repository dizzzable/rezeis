import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ReiwaAdvertisingLinkConfigService } from '../src/modules/advertising/services/reiwa-advertising-link-config.service';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ReiwaAdvertisingLinkConfigService', () => {
  it('uses Reiwa public config instead of the admin domain', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          botUsername: 'ReiwaBot',
          webBaseUrl: 'https://reiwa.example/',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const service = new ReiwaAdvertisingLinkConfigService({
      adminReiwaBotUsername: null,
      miniAppShortName: null,
      webBaseUrl: null,
      reiwaApiBaseUrl: 'http://reiwa:5000',
    } as never);

    assert.deepEqual(await service.resolve(), {
      adminReiwaBotUsername: 'ReiwaBot',
      miniAppShortName: null,
      webBaseUrl: 'https://reiwa.example',
    });
  });

  it('does not fabricate an admin-domain link when Reiwa is unavailable', async () => {
    globalThis.fetch = async () => {
      throw new Error('reiwa is offline');
    };

    const service = new ReiwaAdvertisingLinkConfigService({
      adminReiwaBotUsername: null,
      miniAppShortName: null,
      webBaseUrl: null,
      reiwaApiBaseUrl: 'http://reiwa:5000',
    } as never);

    assert.deepEqual(await service.resolve(), {
      adminReiwaBotUsername: null,
      miniAppShortName: null,
      webBaseUrl: null,
    });
  });
});
