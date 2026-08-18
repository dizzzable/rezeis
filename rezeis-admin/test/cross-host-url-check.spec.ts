import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

import { warnOnUnreachableCrossHostUrls } from '../src/common/runtime/cross-host-url-check';

/**
 * The whole value of this warning is that it stays silent on a correct
 * single-host install. A warning that cries wolf gets ignored, and an ignored
 * warning is worse than none — so the silence cases are the ones under test.
 */
describe('cross-host-url-check', () => {
  const WATCHED = [
    'NODE_ENV',
    'REIWA_URL',
    'WEBHOOK_SECRET_HEADER',
    'REZEIS_SUBPAGE_URL',
    'REZEIS_SUBPAGE_WEBHOOK_SECRET',
  ] as const;

  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of WATCHED) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = 'production';
    // A conforming secret, so the relay counts as switched on.
    process.env.WEBHOOK_SECRET_HEADER = 'a'.repeat(64);
  });

  afterEach(() => {
    for (const key of WATCHED) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  function recordingLogger(): { logger: Logger; warnings: string[] } {
    const warnings: string[] = [];
    const logger = new Logger('test');
    (logger as unknown as { warn: (message: string) => void }).warn = (message) => {
      warnings.push(message);
    };
    return { logger, warnings };
  }

  /** Every attempt fires on the next timer tick, so a test never waits 5 minutes. */
  const immediate = [0, 0, 0];

  const nxdomain = (_host: string, cb: (e: NodeJS.ErrnoException | null) => void): void => {
    const error: NodeJS.ErrnoException = new Error('getaddrinfo ENOTFOUND');
    error.code = 'ENOTFOUND';
    setImmediate(() => cb(error));
  };
  const resolves = (_host: string, cb: (e: NodeJS.ErrnoException | null) => void): void => {
    setImmediate(() => cb(null));
  };
  const transient = (_host: string, cb: (e: NodeJS.ErrnoException | null) => void): void => {
    const error: NodeJS.ErrnoException = new Error('getaddrinfo EAI_AGAIN');
    error.code = 'EAI_AGAIN';
    setImmediate(() => cb(error));
  };

  /**
   * Lets the three chained probe attempts run to completion. Real elapsed time,
   * not event-loop turns: `setTimeout(fn, 0)` is clamped to 1ms, so draining
   * `setImmediate` never advances it. Three attempts cost ~3ms; 60ms is ample.
   */
  /**
   * Waiting for the probe chain, not for a fixed 60ms.
   *
   * `scheduleProbe` walks `delaysMs` as a chain of `setTimeout` callbacks, each
   * resolving a name through a stub that answers on `setImmediate`. Three
   * attempts is therefore at least six macrotask hops, and a flat 60ms wall
   * clock only covers that on an idle machine — under the full suite, with a
   * few hundred node processes competing, the chain regularly had not reached
   * its last attempt when the assertion ran. That produced exactly two failures
   * in `npm test` and none in isolation, which reads like a broken feature and
   * is a broken wait.
   *
   * The silence cases keep a fixed wait because there is nothing to poll for —
   * but a fixed wait is inherently weak there: it passes if the chain has
   * merely not started yet, so the number wants to be comfortably longer than
   * the chain, not merely long enough on a good day.
   */
  const settleUntilWarned = async (warnings: readonly string[]): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (warnings.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
  };

  const settle = (): Promise<void> =>
    new Promise((done) => {
      setTimeout(done, 300);
    });

  it('stays silent on a correct single-host install (the docker name resolves)', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(logger, { lookup: resolves, delaysMs: immediate });
    await settle();

    assert.deepEqual(warnings, []);
  });

  it('warns about the REIWA_URL default when it does not resolve (split VPS)', async () => {
    const { logger, warnings } = recordingLogger();

    // Not set at all — which is exactly the dangerous case, because the schema
    // default and every consumer fallback land on http://reiwa:5000 anyway.
    warnOnUnreachableCrossHostUrls(logger, { lookup: nxdomain, delaysMs: immediate });
    await settleUntilWarned(warnings);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('REIWA_URL'));
    assert.ok(warnings[0].includes('reiwa'));
  });

  it('stays silent on a transient resolver failure rather than blaming the config', async () => {
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(logger, { lookup: transient, delaysMs: immediate });
    await settle();

    assert.deepEqual(warnings, []);
  });

  it('stays silent for a real domain, which is what a correct split VPS sets', async () => {
    process.env.REIWA_URL = 'https://app.example.com';
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(logger, { lookup: nxdomain, delaysMs: immediate });
    await settle();

    // Even with DNS failing outright: a domain that is merely down is a
    // different problem with a different fix, and this check must not claim it.
    assert.deepEqual(warnings, []);
  });

  it('stays silent for a loopback URL', async () => {
    process.env.REIWA_URL = 'http://127.0.0.1:5000';
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(logger, { lookup: nxdomain, delaysMs: immediate });
    await settle();

    assert.deepEqual(warnings, []);
  });

  it('stays silent outside production', async () => {
    process.env.NODE_ENV = 'development';
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(logger, { lookup: nxdomain, delaysMs: immediate });
    await settle();

    assert.deepEqual(warnings, []);
  });

  it('stays silent when the relay is switched off (no WEBHOOK_SECRET_HEADER)', async () => {
    delete process.env.WEBHOOK_SECRET_HEADER;
    const { logger, warnings } = recordingLogger();

    warnOnUnreachableCrossHostUrls(logger, { lookup: nxdomain, delaysMs: immediate });
    await settle();

    assert.deepEqual(warnings, []);
  });

  it('also covers REZEIS_SUBPAGE_URL, but only when its push is switched on', async () => {
    process.env.REIWA_URL = 'https://app.example.com';
    process.env.REZEIS_SUBPAGE_URL = 'http://rezeis-subpage:3010';

    const off = recordingLogger();
    warnOnUnreachableCrossHostUrls(off.logger, { lookup: nxdomain, delaysMs: immediate });
    await settle();
    assert.deepEqual(off.warnings, [], 'no subpage secret → the push is disabled → nothing to warn about');

    process.env.REZEIS_SUBPAGE_WEBHOOK_SECRET = 'b'.repeat(32);
    const on = recordingLogger();
    warnOnUnreachableCrossHostUrls(on.logger, { lookup: nxdomain, delaysMs: immediate });
    await settleUntilWarned(on.warnings);

    assert.equal(on.warnings.length, 1);
    assert.ok(on.warnings[0].includes('REZEIS_SUBPAGE_URL'));
  });
});
