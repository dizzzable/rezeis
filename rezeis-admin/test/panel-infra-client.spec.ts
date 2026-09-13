import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as contractPanel27 from '@remnawave/contract-panel-2.7';
import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';

import {
  PanelCommandExecutor,
  type PanelTransport,
  type PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';
import { PanelInfraClient } from '../src/modules/remnawave/services/panel-infra.client';
import {
  LEGACY_PANEL_REFUSAL_CODE,
  LegacyPanelRefusal,
} from '../src/modules/remnawave/services/panel-transport';

/**
 * PanelInfraClient, over the real executor, the real table and REAL captured answers
 * ═════════════════════════════════════════════════════════════════════════════════
 * The ANSWERS are a live panel's. `test/fixtures/remnawave/3.3.2/` holds bodies
 * captured from panel 3.3.2, envelope included. The single most important
 * assertion in this file is that a real captured squad answer, MUTATED into a
 * shape panel 3.3's own contract refuses, still comes out the other side as
 * squads. That mutation is not invented — it is the exact field rename that once
 * made `getExternalSquadOptions()` throw `ServiceUnavailableException` on every
 * panel with at least one external squad, and the reason
 * `panel-response-decoders.ts` exists at all.
 *
 * Only the six reads production makes exist: the version probe, nodes, per-user
 * node bandwidth, both squad option lists and the request log. The other twenty
 * methods (system stats, recap, bandwidth, health, metadata, hosts, host
 * reorder, the node actions, full squads and the read-only catalog tabs) were
 * never reached from `src/` and were deleted with the tests that were their only
 * callers. The admin screens that show those reads go through
 * `remnawave-api.service.ts`.
 */

// ─────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly query?: unknown;
}

/** Records what the transport was asked to do, and answers as instructed. */
function stub(answer: PanelTransportResult): {
  calls: RecordedCall[];
  client: PanelInfraClient;
  transport: PanelTransport;
} {
  const calls: RecordedCall[] = [];
  const transport: PanelTransport = {
    send: async (input) => {
      calls.push({ method: input.method, url: input.url, body: input.body, query: input.query });
      return answer;
    },
  };
  return {
    calls,
    transport,
    client: new PanelInfraClient(new PanelCommandExecutor(transport)),
  };
}

function ok(body: unknown): PanelTransportResult {
  return { kind: 'ok', data: body };
}

/** The complete HTTP body of one captured panel-3.3.2 answer. */
function captured(name: 'auth-status' | 'internal-squads' | 'external-squads'): unknown {
  const file = JSON.parse(readFileSync(`test/fixtures/remnawave/3.3.2/${name}.json`, 'utf8')) as {
    body: unknown;
  };
  return file.body;
}

/** Deep clone, so a mutation in one test cannot leak into the next. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('every read issues the path and verb the table names', () => {
  const reads: ReadonlyArray<
    [name: string, call: (client: PanelInfraClient) => Promise<unknown>, method: string, url: string]
  > = [
    ['getNodes', (c) => c.getNodes(), 'get', '/api/nodes/'],
    ['getInternalSquadOptions', (c) => c.getInternalSquadOptions(), 'get', '/api/internal-squads/'],
    ['getExternalSquadOptions', (c) => c.getExternalSquadOptions(), 'get', '/api/external-squads/'],
    [
      'getSubscriptionRequestHistory',
      (c) => c.getSubscriptionRequestHistory(),
      'get',
      '/api/subscription-request-history/',
    ],
    ['readPanelVersion', (c) => c.readPanelVersion(), 'get', '/api/system/metadata'],
  ];

  for (const [name, call, method, url] of reads) {
    it(`${name} issues ${method.toUpperCase()} ${url}`, async () => {
      const { client, calls } = stub({ kind: 'network', detail: 'not the subject of this test' });
      await call(client);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, method);
      // The TRAILING SLASHES are the vendor's own and are what rezeis has
      // always sent. Do not "tidy" them.
      assert.equal(calls[0]?.url, url);
    });
  }

  it('sends the node-users bandwidth window as query and the node list as body', async () => {
    const uuid = '2f1c9a44-0000-4000-8000-000000000001';
    const { client, calls } = stub(
      ok({ response: { categories: [], sparklineData: [], topUsers: [] } }),
    );

    await client.getNodeUsersBandwidth({
      nodeUuids: [uuid],
      start: '2026-08-27',
      end: '2026-08-28',
      topUsersLimit: 25_000,
    });

    // A POST that reads: the node list travels in the body because it is a
    // list, not because anything changes.
    assert.equal(calls[0]?.method, 'post');
    assert.equal(calls[0]?.url, '/api/bandwidth-stats/nodes/users');
    assert.deepStrictEqual(calls[0]?.body, { nodesUuids: [uuid] });
    assert.deepStrictEqual(calls[0]?.query, {
      start: '2026-08-27',
      end: '2026-08-28',
      topUsersLimit: 25_000,
    });
  });

  it('passes the request-log page through as the query', async () => {
    const { client, calls } = stub(ok({ response: { total: 0, records: [] } }));
    await client.getSubscriptionRequestHistory({ start: 0, size: 500 });
    assert.deepStrictEqual(calls[0]?.query, { start: 0, size: 500 });
  });
});

describe('a captured 3.3.2 squad answer flows through untouched', () => {
  it('reads internal squad options out of the real body', async () => {
    const { client } = stub(ok(captured('internal-squads')));

    const outcome = await client.getInternalSquadOptions();

    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.data : null, [
      { uuid: '2f1c9a44-0000-4000-8000-000000000001', name: 'squad-0-populated' },
      { uuid: '2f1c9a44-0000-4000-8000-000000001004', name: 'squad-1-nulled' },
    ]);
  });

  it('reads external squad options out of the real body', async () => {
    const { client } = stub(ok(captured('external-squads')));
    const options = await client.getExternalSquadOptions();
    assert.deepStrictEqual(options.kind === 'ok' ? options.data : null, [
      { uuid: '2f1c9a44-0000-4000-8000-000000000001', name: 'squad-0-populated' },
      { uuid: '2f1c9a44-0000-4000-8000-000000001004', name: 'squad-1-nulled' },
    ]);
  });

  it('reads the squads of a panel whose rows carry tags, as 3.4 does', async () => {
    // Contracts from 3.4.11 on made `tags` REQUIRED on a squad row, and panels
    // 3.2 and 3.3 do not send it. Under the old runtime pin that meant a drift
    // report on every healthy 3.2/3.3 squad read; nothing validates the answer
    // now, and the decoder reads `uuid` and `name` from both shapes.
    const withTags = clone(captured('internal-squads')) as {
      response: { internalSquads: Array<Record<string, unknown>> };
    };
    for (const row of withTags.response.internalSquads) row['tags'] = ['EU'];
    for (const body of [captured('internal-squads'), withTags]) {
      const { client } = stub(ok(body));
      const outcome = await client.getInternalSquadOptions();
      assert.equal(outcome.kind === 'ok' ? outcome.data.length : null, 2);
    }
  });
});

describe('a squad answer the release’s own contract refuses is still read', () => {
  /**
   * The captured body with `responseHeadersAdd` / `responseHeadersRemove`
   * spelled the way the 2.x releases spelled it: `responseHeaders`.
   *
   * This is the outage, reproduced. It ran in the other direction — a client
   * pinned to a 2.x contract meeting a 3.x panel — but the failure is the same
   * one and it is symmetric: a squad row whose header field is spelled for a
   * different era than the schema reading it expects.
   */
  function renamedExternalSquads(): unknown {
    const body = clone(captured('external-squads')) as {
      response: { externalSquads: Array<Record<string, unknown>> };
    };
    for (const row of body.response.externalSquads) {
      row['responseHeaders'] = row['responseHeadersAdd'];
      delete row['responseHeadersAdd'];
      delete row['responseHeadersRemove'];
    }
    return body;
  }

  it('is genuinely refused by panel 3.3’s own contract and accepted by the 2.7 line — not vacuous', () => {
    // Without this the two below would pass against a body no schema objects
    // to, and would be measuring nothing.
    assert.equal(
      contractPanel33.GetExternalSquadsCommand.ResponseSchema.safeParse(renamedExternalSquads()).success,
      false,
    );
    assert.equal(
      contractPanel27.GetExternalSquadsCommand.ResponseSchema.safeParse(renamedExternalSquads()).success,
      true,
    );
  });

  it('still yields every squad option', async () => {
    const { client } = stub(ok(renamedExternalSquads()));

    const outcome = await client.getExternalSquadOptions();

    // The whole point. Not a throw, not an empty list, not a `null`: the
    // squads, because the option read consults nothing but `uuid` and `name`
    // and no panel era has ever spelled those differently.
    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(
      (outcome.kind === 'ok' ? outcome.data : []).map((option) => option.uuid),
      ['2f1c9a44-0000-4000-8000-000000000001', '2f1c9a44-0000-4000-8000-000000001004'],
    );
  });

  it('tolerates a field a later release adds', async () => {
    const body = clone(captured('internal-squads')) as {
      response: { internalSquads: Array<Record<string, unknown>> };
    };
    body.response.internalSquads[0]!['fieldFromALaterRelease'] = { anything: true };
    const { client } = stub(ok(body));

    const outcome = await client.getInternalSquadOptions();
    assert.equal(outcome.kind, 'ok');
    assert.equal((outcome.kind === 'ok' ? outcome.data : []).length, 2);
  });
});

describe('"could not read it" never arrives disguised as "there is none"', () => {
  it('refuses a 2xx body that belongs to a different endpoint', async () => {
    // A real captured panel answer — for `GET /api/auth/status`. Whatever puts
    // it on this route (a proxy, a misrouted rewrite, a rolled-back panel), the
    // one answer that must not come back is an empty node list.
    const { client } = stub(ok(captured('auth-status')));
    const outcome = await client.getNodes();
    assert.equal(outcome.kind, 'unreadable');
  });

  it('refuses a body with no response envelope at all', async () => {
    const { client } = stub(ok('<html>502 Bad Gateway</html>'));
    const outcome = await client.getNodes();
    assert.equal(outcome.kind, 'unreadable');
    assert.match(outcome.kind === 'unreadable' ? outcome.detail : '', /no `response`/);
  });

  it('refuses a subscription-request page whose records array is gone', async () => {
    // The caller is a detector that treats a clean log as evidence. Reporting a
    // changed shape as "nothing happened" would let it accuse nobody, quietly,
    // forever.
    const { client } = stub(ok({ response: { total: 12 } }));
    const outcome = await client.getSubscriptionRequestHistory({ start: 0, size: 50 });
    assert.equal(outcome.kind, 'unreadable');
    assert.match(outcome.kind === 'unreadable' ? outcome.detail : '', /records/);
  });

  it('refuses a bandwidth answer whose topUsers array is gone', async () => {
    const { client } = stub(ok({ response: { categories: [], sparklineData: [] } }));
    const outcome = await client.getNodeUsersBandwidth({
      nodeUuids: ['2f1c9a44-0000-4000-8000-000000000001'],
      start: '2026-08-27',
      end: '2026-08-28',
      topUsersLimit: 25_000,
    });
    assert.equal(outcome.kind, 'unreadable');
    assert.match(outcome.kind === 'unreadable' ? outcome.detail : '', /topUsers/);
  });

  it('refuses an empty squad list the panel did not confirm with total: 0', async () => {
    const { client } = stub(ok({ response: { externalSquads: [] } }));
    assert.equal((await client.getExternalSquadOptions()).kind, 'unreadable');
  });

  it('but believes an empty list the panel DID confirm', async () => {
    // The other side of the same rule, and the one that keeps it honest: an
    // answer of "none" is an answer.
    const { client } = stub(ok({ response: { total: 0, externalSquads: [] } }));
    const outcome = await client.getExternalSquadOptions();
    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.data : null, []);
  });
});

describe('the request log decodes requestAt the way the contract parse did', () => {
  const RECORD = {
    id: 1,
    userId: 4471,
    srrResponseType: 'OK',
    srrRuleName: null,
    requestIp: '203.0.113.7',
    userAgent: 'Happ/1.0',
    requestAt: '2026-09-13T10:00:00.5Z',
  };

  it('hands the detector a Date for a well-formed timestamp and the raw value otherwise', async () => {
    const body = {
      response: { total: 2, records: [RECORD, { ...RECORD, id: 2, requestAt: 'not a timestamp' }] },
    };
    const { client } = stub(ok(body));

    const outcome = await client.getSubscriptionRequestHistory({ start: 0, size: 50 });

    assert.equal(outcome.kind, 'ok');
    const [first, second] = outcome.kind === 'ok' ? outcome.data.records : [];
    assert.ok(first?.requestAt instanceof Date);
    // The detector persists `toISOString()` of it in signal metadata.
    assert.equal((first?.requestAt as Date).toISOString(), '2026-09-13T10:00:00.500Z');
    assert.equal(second?.requestAt, 'not a timestamp');
    // Everything else on the record is the panel's, untouched.
    assert.equal(first?.userAgent, 'Happ/1.0');
    assert.equal(outcome.kind === 'ok' ? outcome.data.total : null, 2);
  });

  it('produces the same instant each era’s contract parse produces', async () => {
    const body = { response: { total: 1, records: [RECORD] } };
    const { client } = stub(ok(clone(body)));
    const outcome = await client.getSubscriptionRequestHistory();
    const ours = (outcome.kind === 'ok' ? outcome.data.records[0]?.requestAt : null) as Date;
    for (const [version, contract] of [
      ['3.2.0', contractPanel321],
      ['3.2.3', contractPanel323],
      ['3.4.2', contractPanel33],
      ['3.4.13', contractPanel343],
      ['3.4.15', contractPanel344],
    ] as const) {
      const parsed = (
        contract.GetSubscriptionRequestHistoryCommand.ResponseSchema as {
          safeParse(value: unknown): { success: boolean; data?: { response: { records: Array<{ requestAt: Date }> } } };
        }
      ).safeParse(body);
      assert.equal(parsed.success, true, `contract ${version} refuses the request-log body`);
      assert.equal(
        ours.toISOString(),
        parsed.data?.response.records[0]?.requestAt.toISOString(),
        `contract ${version}`,
      );
    }
  });
});

describe('the version probe survives a panel of any era', () => {
  it('reads the version off a 2.x metadata body that panel 3.3’s contract refuses', async () => {
    const legacyBody = { response: { version: '2.7.4' } };
    // Non-vacuous: every 3.x contract declares `version`, `build` AND `git`.
    assert.equal(contractPanel33.GetMetadataCommand.ResponseSchema.safeParse(legacyBody).success, false);

    const transport: PanelTransport = { send: async () => ok(legacyBody) };
    const probe = PanelInfraClient.forVersionProbe(transport);

    // If this returned null the refusal would treat a 2.x panel as 3.x and let
    // fourteen call sites collect 400s the sync layer files as terminal.
    assert.equal(await probe.readPanelVersion(), '2.7.4');
  });

  it('answers null — "could not tell" — when the endpoint is absent', async () => {
    const transport: PanelTransport = {
      send: async () => ({
        kind: 'rejected',
        status: 404,
        code: null,
        detail: null,
        retryAfterMs: null,
      }),
    };
    // `null` must not read as "old". An unknown version proceeds as 3.x,
    // because a refusal keyed on unknown fires exactly when the panel is
    // already struggling and the sync layer retries it forever.
    assert.equal(await PanelInfraClient.forVersionProbe(transport).readPanelVersion(), null);
  });

  it('is why the probe takes the bare transport: behind the refusal it deadlocks', async () => {
    // The circularity, made concrete. `LegacyPanelRefusal` asks for the panel
    // major before letting anything out; the probe is what produces that
    // answer. Built on the refusal, the probe against a 2.x panel is refused —
    // so the version can never be learned, and nothing ever unblocks.
    const bare: PanelTransport = { send: async () => ok({ response: { version: '2.7.4' } }) };
    const refused = new LegacyPanelRefusal(bare, async () => 2);

    assert.equal(await PanelInfraClient.forVersionProbe(refused).readPanelVersion(), null);
    // Whereas the factory's intended wiring reaches the panel.
    assert.equal(await PanelInfraClient.forVersionProbe(bare).readPanelVersion(), '2.7.4');
  });
});

describe('a body we built wrong never leaves the process', () => {
  it('refuses an empty node list the table declares as minimum one', async () => {
    // The old reader sent this and collected a 400, which it then reported as
    // `null` — "the panel did not answer" — for a request the panel was right
    // to refuse.
    const { client, calls } = stub(ok({ response: {} }));
    const outcome = await client.getNodeUsersBandwidth({
      nodeUuids: [],
      start: '2026-08-27',
      end: '2026-08-28',
      topUsersLimit: 25_000,
    });

    assert.equal(outcome.kind, 'invalid-request');
    assert.deepStrictEqual(calls, []);
  });
});

describe('transport failures reach the caller as themselves', () => {
  it('does not turn "no base url or token" into an empty list', async () => {
    const { client } = stub({ kind: 'unconfigured' });
    // The reader this replaces answered `[]` here, which made an unconfigured
    // integration indistinguishable from a panel with no nodes.
    assert.equal((await client.getNodes()).kind, 'unconfigured');
  });

  it('passes the 2.x refusal through with its code intact', async () => {
    const bare: PanelTransport = { send: async () => ok({ response: [] }) };
    const client = new PanelInfraClient(
      new PanelCommandExecutor(new LegacyPanelRefusal(bare, async () => 2)),
    );

    const outcome = await client.getNodes();
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' ? outcome.code : null, LEGACY_PANEL_REFUSAL_CODE);
  });

  it('does not turn a 500 into "the panel has no squads"', async () => {
    const { client } = stub({
      kind: 'rejected',
      status: 500,
      code: null,
      detail: 'Internal server error',
      retryAfterMs: null,
    });
    assert.equal((await client.getInternalSquadOptions()).kind, 'rejected');
  });
});
