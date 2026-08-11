import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import {
  buildNodeUsersBandwidthPath,
  NODE_USERS_BANDWIDTH_TOP_LIMIT,
  RemnawaveApiService,
} from '../src/modules/remnawave/services/remnawave-api.service';
import { RemnawaveVersionService } from '../src/modules/remnawave/services/remnawave-version.service';
import { tunablesFromEnv } from './fixtures/anti-fraud-tunables';

/**
 * Wire-shape tests for the two node WRITE requests rezeis sends to the panel.
 *
 * Both are version-sensitive and both were malformed against 2.8.0, the build
 * testers actually run. These tests assert the OUTGOING request — body and
 * query string as the fake transport receives it — rather than a return value,
 * because both defects were invisible from the return value: the restart threw
 * a generic "integration unavailable", and the bandwidth read returned a plain
 * `[]` that reads exactly like a clean panel.
 *
 * The panel fakes below enforce the 2.8.0 contract (400 when a required field
 * is missing) instead of accepting anything, so a request that would fail
 * against a live 2.8.0 panel fails here too.
 */

const NODE_UUID = '3a1f0c9e-6b2d-4f47-9c11-8d5e2b7a4c60';
const GB = 1024 ** 3;

const CONFIG = {
  host: 'remnawave',
  port: 3000,
  token: 'secret',
  webhookSecret: null,
} as const;

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly data: unknown;
}

type PanelHandler = (request: CapturedRequest) => Observable<unknown>;

interface Harness {
  readonly service: RemnawaveApiService;
  readonly requests: CapturedRequest[];
}

function makeService(handler: PanelHandler): Harness {
  const requests: CapturedRequest[] = [];
  const httpService = {
    request: (input: { method: string; url: string; data?: unknown }) => {
      const captured: CapturedRequest = {
        method: input.method,
        url: input.url,
        data: input.data,
      };
      requests.push(captured);
      return handler(captured);
    },
  };
  return {
    service: new RemnawaveApiService(httpService as never, { ...CONFIG }),
    requests,
  };
}

/** An axios-shaped rejection, the way a real 400 reaches `requestJsonWithBody`. */
function httpError(status: number, message: string): Observable<never> {
  return throwError(() =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data: { message, statusCode: status } },
    }),
  );
}

function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1));
}

// ── Defect 1 — POST /api/nodes/{uuid}/actions/restart ────────────────────────

describe('restartNode — the body 2.8.0 and 3.2.1 declare required', () => {
  it('posts forceRestart, exactly once, with no version probe first', async () => {
    const { service, requests } = makeService(() =>
      of({ status: 200, data: { response: { eventSent: true } } }),
    );

    await service.restartNode(NODE_UUID);

    // One call and one only: the field is sent unconditionally, so nothing
    // reads `/api/system/stats/recap` or `/api/system/metadata` to decide.
    // A capability gate added later would break this assertion on purpose.
    assert.deepStrictEqual(
      requests.map((r) => `${r.method.toUpperCase()} ${r.url}`),
      [`POST /api/nodes/${NODE_UUID}/actions/restart`],
    );
    assert.deepStrictEqual(requests[0].data, { forceRestart: true });
  });

  it('succeeds against a 2.8.0 panel that rejects a body without forceRestart', async () => {
    // 2.8.0: `requestBody.required: true`, `required: ["forceRestart"]`.
    const { service } = makeService((request) => {
      const body = request.data as { forceRestart?: unknown } | undefined;
      if (typeof body?.forceRestart !== 'boolean') {
        return httpError(400, 'Validation failed (forceRestart is required)');
      }
      return of({ status: 200, data: { response: { eventSent: true } } });
    });

    // Without the field this is the live defect: a 400 becomes
    // ServiceUnavailableException and the operator is told the integration is
    // down while the panel is healthy.
    await assert.doesNotReject(() => service.restartNode(NODE_UUID));
  });

  it('keeps working on 2.7.4, which binds no body for this endpoint', async () => {
    // 2.7.4 declares no `requestBody`, and `RestartNodeCommand` in the panel's
    // own contract has no `RequestBodySchema` — the body is discarded, so the
    // extra property is as inert as the `{}` this call has always posted.
    const { service, requests } = makeService(() =>
      of({ status: 200, data: { response: { eventSent: true } } }),
    );

    await assert.doesNotReject(() => service.restartNode(NODE_UUID));
    assert.deepStrictEqual(requests[0].data, { forceRestart: true });
  });

  it('accepts the 3.2.1 answer: 202 with no body at all', async () => {
    // 3.2.1 returns 202 "Operation accepted and will be processed in
    // background" with no content, where 2.x returns 200 + `{ eventSent }`.
    // axios leaves an empty body as `''`; this method discards the value.
    const { service, requests } = makeService(() => of({ status: 202, data: '' }));

    await assert.doesNotReject(() => service.restartNode(NODE_UUID));
    assert.deepStrictEqual(requests[0].data, { forceRestart: true });
  });
});

// ── Defect 2 — POST /api/bandwidth-stats/nodes/users ─────────────────────────

describe('getNodeUsersBandwidth — the query 2.8.0 declares required', () => {
  it('builds a path carrying topUsersLimit alongside the UTC date range', () => {
    assert.equal(
      buildNodeUsersBandwidthPath(new Date('2026-07-18T00:30:00.000Z')),
      '/api/bandwidth-stats/nodes/users?start=2026-07-17&end=2026-07-18' +
        `&topUsersLimit=${NODE_USERS_BANDWIDTH_TOP_LIMIT}`,
    );
  });

  it('puts topUsersLimit on the wire, not just in the helper', async () => {
    // The helper being right proves nothing on its own — the service could
    // still build its own path. Assert what the transport actually received.
    const { service, requests } = makeService(() =>
      of({ status: 200, data: { response: { topUsers: [] } } }),
    );

    await service.getNodeUsersBandwidth([NODE_UUID]);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'post');
    assert.ok(requests[0].url.startsWith('/api/bandwidth-stats/nodes/users?'));
    const query = queryOf(requests[0].url);
    assert.equal(query.get('topUsersLimit'), String(NODE_USERS_BANDWIDTH_TOP_LIMIT));
    assert.match(query.get('start') ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.match(query.get('end') ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.deepStrictEqual(requests[0].data, { nodesUuids: [NODE_UUID] });
  });

  it('asks for enough rows that the cohort baseline is the population', () => {
    // The detector takes its median from the returned rows. The panel returns
    // the TOP N, so N has to cover the light tail, not just the heavy head —
    // 3.2.1's default of 100 does not, on any panel worth policing.
    assert.ok(
      NODE_USERS_BANDWIDTH_TOP_LIMIT >= 25_000,
      'limit must exceed the 500x50 whole-panel ceiling used elsewhere',
    );
  });

  it('separates "the panel refused" (null) from "the panel is clean" ([])', async () => {
    const refused = makeService(() => httpError(400, 'topUsersLimit is required'));
    assert.equal(await refused.service.getNodeUsersBandwidth([NODE_UUID]), null);

    const clean = makeService(() => of({ status: 200, data: { response: { topUsers: [] } } }));
    assert.deepStrictEqual(await clean.service.getNodeUsersBandwidth([NODE_UUID]), []);
  });
});

// ── Defect 2 — the detector that has been reporting zero offenders ───────────

interface PanelUser {
  readonly username: string;
  readonly total: number;
}

/**
 * A 2.8.0-shaped panel: it serves `/api/nodes`, requires `topUsersLimit` on
 * the bandwidth endpoint, and — like the real one — honours that limit by
 * returning only the top N rows.
 */
function makeDetectors(population: readonly PanelUser[]): {
  readonly detectors: RemnawaveDetectors;
  readonly bandwidthCalls: number[];
} {
  const bandwidthCalls: number[] = [];
  const { service } = makeService((request) => {
    if (request.url === '/api/nodes') {
      return of({
        status: 200,
        data: { response: [{ uuid: NODE_UUID, name: 'de-1', isConnected: true, isDisabled: false }] },
      });
    }
    const limit = queryOf(request.url).get('topUsersLimit');
    if (limit === null) {
      // 2.8.0 marks it `required: true` in query.
      return httpError(400, 'topUsersLimit is required');
    }
    bandwidthCalls.push(Number(limit));
    const topUsers = [...population]
      .sort((a, b) => b.total - a.total)
      .slice(0, Number(limit));
    return of({ status: 200, data: { response: { topUsers } } });
  });

  const versionService = {
    getCapabilities: () => Promise.resolve({ bandwidthNodesUsers: true }),
  } as unknown as RemnawaveVersionService;

  return {
    detectors: new RemnawaveDetectors({} as unknown as PrismaService, service, versionService, tunablesFromEnv()),
    bandwidthCalls,
  };
}

describe('detectPerUserNodeTrafficAbuse — against a 2.8.0-shaped panel', () => {
  const originalWarn = Logger.prototype.warn;

  afterEach(() => {
    Logger.prototype.warn = originalWarn;
  });

  it('measures the offender against the population median, not a head slice', async () => {
    // 500 light users at 2 GB are the real baseline; 60 heavy users at 300 GB
    // crowd the head of the ranking; one offender at 900 GB.
    //
    // The detector takes `median` from whatever rows come back, so the row
    // count decides what its configured 4x multiplier is measured against.
    // Truncated to 3.2.1's default 100 the cohort would be offender + 99 heavy
    // and the median would be 300 GB — the offender's own magnitude, which is
    // the failure mode the limit exists to prevent. Read whole, the median is
    // the light tail's 2 GB and the offender clears it by two orders of
    // magnitude. Asserting the reported `medianBytes` pins that directly: any
    // limit that truncates this population changes this number.
    const population: PanelUser[] = [
      { username: 'offender', total: 900 * GB },
      ...Array.from({ length: 60 }, (_, i) => ({ username: `heavy-${i}`, total: 300 * GB })),
      ...Array.from({ length: 500 }, (_, i) => ({ username: `light-${i}`, total: 2 * GB })),
    ];
    const { detectors, bandwidthCalls } = makeDetectors(population);

    const candidates = await detectors.detectPerUserNodeTrafficAbuse(
      new Date('2026-08-05T12:00:00.000Z'),
    );

    assert.deepStrictEqual(bandwidthCalls, [NODE_USERS_BANDWIDTH_TOP_LIMIT]);
    const offender = candidates.find(
      (c) => c.metadata?.['remnawaveUsername'] === 'offender',
    );
    assert.ok(offender !== undefined, 'the 900 GB outlier must be flagged');
    assert.equal(offender.code, 'NODE_TRAFFIC_USER_ABUSE');
    assert.equal(offender.metadata?.['totalBytes'], 900 * GB);
    assert.equal(offender.metadata?.['medianBytes'], 2 * GB);
  });

  it('says so once when the panel refuses, instead of looking like a clean panel', async () => {
    const warnings: string[] = [];
    Logger.prototype.warn = function patched(message: unknown): void {
      warnings.push(String(message));
    } as typeof Logger.prototype.warn;

    // A panel that answers `/api/nodes` but refuses the bandwidth read — the
    // exact production state since 2.8 shipped.
    const { service } = makeService((request) => {
      if (request.url === '/api/nodes') {
        return of({
          status: 200,
          data: {
            response: [{ uuid: NODE_UUID, name: 'de-1', isConnected: true, isDisabled: false }],
          },
        });
      }
      return httpError(400, 'Validation failed');
    });
    const detectors = new RemnawaveDetectors(
      {} as unknown as PrismaService,
      service,
      { getCapabilities: () => Promise.resolve({ bandwidthNodesUsers: true }) } as unknown as
        RemnawaveVersionService,
      tunablesFromEnv(),
    );

    const now = new Date('2026-08-05T12:00:00.000Z');
    assert.deepStrictEqual(await detectors.detectPerUserNodeTrafficAbuse(now), []);
    assert.deepStrictEqual(await detectors.detectPerUserNodeTrafficAbuse(now), []);
    assert.deepStrictEqual(await detectors.detectPerUserNodeTrafficAbuse(now), []);

    // Visible, but once — three runs of a five-minute cron must not be three
    // copies of the same line.
    const blind = warnings.filter((w) => w.includes('BLIND'));
    assert.equal(blind.length, 1);
    assert.match(blind[0], /report zero offenders/);
  });
});
