import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { ReiwaAdvertisingLinkConfigService } from '../src/modules/advertising/services/reiwa-advertising-link-config.service';

/**
 * THE CABINET'S ADDRESS IS ASKED FOR ONCE AT A TIME, AND A FAILED ASK KEEPS THE
 * ADDRESS THE CABINET LAST PUBLISHED.
 *
 * Letters, the guest reply button and payment return pages all get the
 * cabinet's address from this resolver, which asks the cabinet
 * (`/api/v1/public-config`, up to 2.5 s) whenever its cache is cold or has
 * expired. Before this:
 * - every concurrent caller on a cold cache made its own request and waited
 *   for it, a broadcast's letters and a burst of checkouts included;
 * - a failed request replaced the address the cabinet had published with the
 *   .env fallback. On a default install that fallback is nothing, and a payer
 *   is then returned to the panel's `/payments/result`, which is the admin
 *   SPA's «не найдено».
 */

const originalFetch = globalThis.fetch;
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  mock.method(Date, 'now', () => now);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

/** The resolver, with `envAddress` as its .env tail (REIWA_WEB_BASE_URL → MINIAPP_CUSTOM_URL). */
function resolverWith(envAddress: string | null): ReiwaAdvertisingLinkConfigService {
  return new ReiwaAdvertisingLinkConfigService({
    adminReiwaBotUsername: null,
    miniAppShortName: null,
    webBaseUrl: envAddress,
    reiwaApiBaseUrl: 'http://reiwa:5000',
  } as never);
}

/** A cabinet whose answers the test releases by hand, counting every request. */
function cabinet() {
  const waiting: Array<{ answer: (response: Response) => void; refuse: (error: Error) => void }> = [];
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    return new Promise<Response>((answer, refuse) => {
      waiting.push({ answer, refuse });
    });
  }) as typeof fetch;
  return {
    get requests(): number {
      return requests;
    },
    publish(address: string): void {
      for (const request of waiting.splice(0)) {
        request.answer(
          new Response(JSON.stringify({ webBaseUrl: address }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
    },
    answerWith(status: number): void {
      for (const request of waiting.splice(0)) request.answer(new Response('{}', { status }));
    },
    goOffline(): void {
      for (const request of waiting.splice(0)) request.refuse(new Error('reiwa is offline'));
    },
  };
}

describe('the cabinet address resolver', () => {
  it('asks the cabinet once for any number of concurrent callers on a cold cache', async () => {
    const reiwa = cabinet();
    const resolver = resolverWith(null);

    const answers = Promise.all(Array.from({ length: 5 }, () => resolver.resolveCabinetWebBaseUrl()));
    reiwa.publish('https://cab.example.com/');

    assert.deepEqual(await answers, Array(5).fill('https://cab.example.com'));
    assert.equal(reiwa.requests, 1, 'every concurrent caller asked the cabinet itself');
  });

  it('shares a failing request, and does not ask again within the failure window', async () => {
    const reiwa = cabinet();
    const resolver = resolverWith('https://env.example.com');

    const answers = Promise.all(Array.from({ length: 3 }, () => resolver.resolveCabinetWebBaseUrl()));
    reiwa.goOffline();
    assert.deepEqual(await answers, Array(3).fill('https://env.example.com'));
    assert.equal(reiwa.requests, 1, 'every concurrent caller waited for its own failed request');

    now += 5_000;
    const inWindow = resolver.resolveCabinetWebBaseUrl();
    assert.equal(reiwa.requests, 1, 'a caller inside the failure window asked again');
    reiwa.goOffline(); // releases a request that should not exist, so nothing hangs
    assert.equal(await inWindow, 'https://env.example.com');

    // After the window it asks again, and a recovered cabinet is heard.
    now += 10_000;
    const recovered = resolver.resolveCabinetWebBaseUrl();
    reiwa.publish('https://cab.example.com');
    assert.equal(await recovered, 'https://cab.example.com');
    assert.equal(reiwa.requests, 2);
  });

  it('keeps the address the cabinet last published when a later request fails', async () => {
    // .env holds nothing — the default install — so the fallback would be no
    // address at all: no footer link, no guest button, and a payer returned to
    // the panel's 404.
    const reiwa = cabinet();
    const resolver = resolverWith(null);
    const first = resolver.resolveCabinetWebBaseUrl();
    reiwa.publish('https://cab.example.com');
    assert.equal(await first, 'https://cab.example.com');

    now += 61_000; // the published address is due for a refresh
    const offline = resolver.resolveCabinetWebBaseUrl();
    reiwa.goOffline();
    assert.equal(await offline, 'https://cab.example.com');

    now += 61_000;
    const failing = resolver.resolveCabinetWebBaseUrl();
    reiwa.answerWith(503);
    assert.equal(await failing, 'https://cab.example.com');
  });

  it('prefers the address the cabinet last published over a stale one in .env', async () => {
    const reiwa = cabinet();
    const resolver = resolverWith('https://old.example.com');
    const first = resolver.resolveCabinetWebBaseUrl();
    reiwa.publish('https://cab.example.com');
    await first;

    now += 61_000;
    const offline = resolver.resolveCabinetWebBaseUrl();
    reiwa.goOffline();

    assert.equal(await offline, 'https://cab.example.com');
  });
});
