import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SystemEventsService } from '../src/common/services/system-events.service';

/**
 * A MISCONFIGURED WEBHOOK IS NOT AN OUTAGE, AND THE LOG MUST NOT TREAT IT AS ONE.
 *
 * `WEBHOOK_URL` is the GENERIC outbound channel — monitoring, automation,
 * analytics. It is not how reiwa is fed: reiwa receives events over `REIWA_URL`,
 * with `/api/v1/webhooks/rezeis` appended in code. Operators nonetheless point
 * `WEBHOOK_URL` at the reiwa domain, because both words are "webhook", and then
 * every POST 404s.
 *
 * The service already recognises that shape and answers it with three sentences
 * of instruction. The problem is WHEN: this dispatcher runs on EVERY system
 * event, the condition is permanent — reiwa does not grow a generic /webhook
 * route between two events — and so the hint repeated per event stops informing
 * and starts burying. The operator ends up with the hint everywhere and the
 * events it was meant to sit beside nowhere.
 *
 * Said once per URL per process. A restart says it again, which is exactly when
 * somebody is reading the log.
 *
 * The second spec is what keeps the first honest: a genuinely external consumer
 * that goes down must keep warning on every failure. Without it, "warns once"
 * would pass just as well against a service that stopped warning at all — and
 * silence about a dead analytics endpoint is the opposite of the fix.
 */

interface Harness {
  readonly service: SystemEventsService;
  readonly warnings: string[];
}

function buildService(urls: readonly string[]): Harness {
  const warnings: string[] = [];

  const prisma = {
    adminAuditLog: { create: async () => ({}) },
    settings: { findFirst: async () => null },
    user: { findMany: async () => [] },
  };

  const webhookConfiguration = {
    enabled: true,
    urls: [...urls],
    secretHeader: null,
  };

  // Every POST fails, the way a 404 from a route that does not exist fails.
  const httpService = {
    post: () => {
      throw new Error('Request failed with status code 404');
    },
  };

  const moduleRef = {
    get: () => {
      throw new Error('not registered');
    },
  };

  const service = new SystemEventsService(
    prisma as never,
    webhookConfiguration as never,
    httpService as never,
    moduleRef as never,
  );

  // The service logs through its own private Logger; swapping it is the only
  // way to read what an operator would see.
  // Only warnings are read; the rest must EXIST or the service throws on its
  // first log line and every spec below fails for the wrong reason.
  const noop = (): void => undefined;
  (service as unknown as { logger: Record<string, unknown> }).logger = {
    warn: (message: string) => {
      warnings.push(message);
    },
    log: noop,
    error: noop,
    debug: noop,
    verbose: noop,
    fatal: noop,
  };

  return { service, warnings };
}

/** Let the fire-and-forget delivery microtasks settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const REIWA_URL = 'https://2get.shop';
const REIWA_WEBHOOK_URL = 'https://2get.shop/api/v1/webhook/rezeis';
const EXTERNAL_URL = 'https://monitoring.example.test/hooks/rezeis';

describe('a webhook pointed at reiwa is reported once, not once per event', () => {
  let previousReiwaUrl: string | undefined;

  beforeEach(() => {
    previousReiwaUrl = process.env['REIWA_URL'];
    process.env['REIWA_URL'] = REIWA_URL;
  });

  afterEach(() => {
    if (previousReiwaUrl === undefined) delete process.env['REIWA_URL'];
    else process.env['REIWA_URL'] = previousReiwaUrl;
  });

  it('says the actionable hint once across many events', async () => {
    const harness = buildService([REIWA_WEBHOOK_URL]);

    for (let i = 0; i < 5; i += 1) {
      harness.service.info(`system.test.${i}`, 'SYSTEM', `event ${i}`);
    }
    await flush();

    assert.equal(
      harness.warnings.length,
      1,
      `expected exactly one warning across five events, got ${harness.warnings.length}`,
    );
    // The hint has to remain ACTIONABLE, not merely present: it names the
    // variable to change, and the variable that actually feeds reiwa.
    assert.ok(harness.warnings[0]?.includes('WEBHOOK_ENABLED=false'));
    assert.ok(harness.warnings[0]?.includes('REIWA_URL'));
  });

  it('still warns on EVERY failure of a real external consumer', async () => {
    // ANTI-VACUITY. A service that simply stopped warning would pass the spec
    // above. An analytics endpoint that goes down is a transient outage, and
    // silence about it is a worse defect than the noise this change removed.
    const harness = buildService([EXTERNAL_URL]);

    for (let i = 0; i < 5; i += 1) {
      harness.service.info(`system.test.${i}`, 'SYSTEM', `event ${i}`);
    }
    await flush();

    assert.equal(
      harness.warnings.length,
      5,
      `expected one warning per failed event, got ${harness.warnings.length}`,
    );
  });

  it('reports each misconfigured URL on its own, not one for the set', async () => {
    // Two operators, two wrong URLs, one process. Suppressing per-process
    // rather than per-URL would tell the operator about the first and leave the
    // second silently failing forever.
    const harness = buildService([REIWA_WEBHOOK_URL, `${REIWA_URL}/api/v1/webhook/other`]);

    for (let i = 0; i < 3; i += 1) {
      harness.service.info(`system.test.${i}`, 'SYSTEM', `event ${i}`);
    }
    await flush();

    assert.equal(harness.warnings.length, 2);
  });
});
