import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  GetExternalSquadsCommand,
  GetMetadataCommand,
  RestartNodeCommand,
} from '@remnawave/contract-v34';

import {
  PanelCommandExecutor,
  type PanelDriftReport,
  type PanelTransport,
  type PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';
import { PanelInfraClient } from '../src/modules/remnawave/services/panel-infra.client';
import {
  LEGACY_PANEL_REFUSAL_CODE,
  LegacyPanelRefusal,
} from '../src/modules/remnawave/services/panel-transport';

/**
 * PanelInfraClient, driven by the REAL contract and REAL captured answers
 * ═══════════════════════════════════════════════════════════════════════
 * Two things are deliberately not faked here.
 *
 * The COMMANDS are the vendor's. A spec built on hand-written command objects
 * would prove only that the client agrees with a structural type this
 * repository invented — which is the one thing not worth doubting. The value of
 * taking routes, verbs and schemas from the package is that they are the
 * package's, so the tests have to use the package's.
 *
 * The ANSWERS are a live panel's. `test/fixtures/remnawave/3.3.2/` holds bodies
 * captured from panel 3.3.2, envelope included. The single most important
 * assertion in this file is not a happy path and not an error path: it is that
 * a real captured squad answer, MUTATED into a shape the pinned contract
 * refuses, still comes out the other side as squads. That mutation is not
 * invented — it is the exact field rename that once made
 * `getExternalSquadOptions()` throw `ServiceUnavailableException` on every
 * panel with at least one external squad, and the reason
 * `panel-response-decoders.ts` exists at all.
 */

// ─────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly query?: unknown;
}

/** Records what the transport was asked to do, and answers as instructed. */
function stub(
  answer: PanelTransportResult,
  onDrift?: (report: PanelDriftReport) => void,
): { calls: RecordedCall[]; client: PanelInfraClient; transport: PanelTransport } {
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
    client: new PanelInfraClient(new PanelCommandExecutor(transport, onDrift)),
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

describe('every path and verb is the vendor’s, not a literal written here', () => {
  const reads: ReadonlyArray<
    [
      name: string,
      call: (client: PanelInfraClient) => Promise<unknown>,
      method: string,
      url: string,
    ]
  > = [
    ['getSystemStats', (c) => c.getSystemStats(), 'get', '/api/system/stats'],
    ['getSystemRecap', (c) => c.getSystemRecap(), 'get', '/api/system/stats/recap'],
    ['getBandwidthStats', (c) => c.getBandwidthStats(), 'get', '/api/system/stats/bandwidth'],
    ['getHealth', (c) => c.getHealth(), 'get', '/api/system/health'],
    ['getSystemMetadata', (c) => c.getSystemMetadata(), 'get', '/api/system/metadata'],
    ['getNodes', (c) => c.getNodes(), 'get', '/api/nodes/'],
    ['getHosts', (c) => c.getHosts(), 'get', '/api/hosts/'],
    ['getInternalSquads', (c) => c.getInternalSquads(), 'get', '/api/internal-squads/'],
    ['getExternalSquads', (c) => c.getExternalSquads(), 'get', '/api/external-squads/'],
    ['getConfigProfiles', (c) => c.getConfigProfiles(), 'get', '/api/config-profiles/'],
    ['getSnippets', (c) => c.getSnippets(), 'get', '/api/snippets/'],
    [
      'getSubscriptionTemplates',
      (c) => c.getSubscriptionTemplates(),
      'get',
      '/api/subscription-templates/',
    ],
    [
      'getSubscriptionSettings',
      (c) => c.getSubscriptionSettings(),
      'get',
      '/api/subscription-settings/',
    ],
    [
      'getSubscriptionPageConfigs',
      (c) => c.getSubscriptionPageConfigs(),
      'get',
      '/api/subscription-page-configs/',
    ],
    ['getNodePlugins', (c) => c.getNodePlugins(), 'get', '/api/node-plugins/'],
    ['getInfraProviders', (c) => c.getInfraProviders(), 'get', '/api/infra-billing/providers'],
    [
      'getSubscriptionRequestHistory',
      (c) => c.getSubscriptionRequestHistory(),
      'get',
      '/api/subscription-request-history/',
    ],
  ];

  for (const [name, call, method, url] of reads) {
    it(`${name} issues ${method.toUpperCase()} ${url}`, async () => {
      const { client, calls } = stub({ kind: 'network', detail: 'not the subject of this test' });
      await call(client);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, method);
      // The TRAILING SLASHES are the vendor's own and are the visible payoff of
      // reading `url` off the command: the hand-rolled service sent these paths
      // without one, which works only because of how the panel mounts its
      // router. Do not "tidy" them.
      assert.equal(calls[0]?.url, url);
    });
  }

  const uuid = '2f1c9a44-0000-4000-8000-000000000001';
  const actions: ReadonlyArray<[string, (c: PanelInfraClient) => Promise<unknown>, string]> = [
    ['enableNode', (c) => c.enableNode(uuid), `/api/nodes/${uuid}/actions/enable`],
    ['disableNode', (c) => c.disableNode(uuid), `/api/nodes/${uuid}/actions/disable`],
    ['restartNode', (c) => c.restartNode(uuid), `/api/nodes/${uuid}/actions/restart`],
    [
      'resetNodeTraffic',
      (c) => c.resetNodeTraffic(uuid),
      `/api/nodes/${uuid}/actions/reset-traffic`,
    ],
  ];

  for (const [name, call, url] of actions) {
    it(`${name} builds its path through the contract’s own builder`, async () => {
      const { client, calls } = stub(ok({ response: {} }));
      await call(client);
      assert.equal(calls[0]?.method, 'post');
      assert.equal(calls[0]?.url, url);
    });
  }

  it('sends the node-users bandwidth window as query and the node list as body', async () => {
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
});

describe('restartNode still sends forceRestart, and the contract now says why', () => {
  const uuid = '2f1c9a44-0000-4000-8000-000000000001';

  it('sends { forceRestart: true } unconditionally', async () => {
    const { client, calls } = stub(ok(''));
    await client.restartNode(uuid);
    assert.deepStrictEqual(calls[0]?.body, { forceRestart: true });
  });

  it('would refuse a bodyless restart before the wire — the field IS required', async () => {
    // The counterfactual, and the reason the decision is not a preference. The
    // panel used to answer a bodyless restart with 400, which surfaced as
    // "Remnawave integration is unavailable" from a healthy panel. Now the
    // contract carries the requirement, so the same mistake costs no
    // round-trip and names the field.
    const { transport, calls } = stub(ok({ response: {} }));
    const outcome = await new PanelCommandExecutor(transport).call(RestartNodeCommand, {
      pathParts: [uuid],
      body: {},
    });

    assert.equal(outcome.kind, 'invalid-request');
    assert.match(outcome.kind === 'invalid-request' ? outcome.detail : '', /forceRestart/);
    assert.deepStrictEqual(calls, []);
  });

  it('reads 202-with-no-body as success, because a write has no envelope', async () => {
    // 3.x answers a restart with 202 and nothing at all, and
    // `RestartNodeCommand` declares no ResponseSchema. A client that insisted
    // on unwrapping `response` here would report every successful restart as a
    // failure — and the SPA would tell the operator the node did not restart
    // when it did.
    const { client } = stub(ok(''));
    const outcome = await client.restartNode(uuid);
    assert.equal(outcome.kind, 'ok');
  });

  it('reads an empty reset-traffic answer as success for the same reason', async () => {
    const { client } = stub(ok(''));
    assert.equal((await client.resetNodeTraffic(uuid)).kind, 'ok');
  });
});

describe('a captured 3.3.2 squad answer flows through untouched', () => {
  it('reads internal squad options out of the real body', async () => {
    const drifts: PanelDriftReport[] = [];
    const { client } = stub(ok(captured('internal-squads')), (report) => drifts.push(report));

    const outcome = await client.getInternalSquadOptions();

    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.data : null, [
      { uuid: '2f1c9a44-0000-4000-8000-000000000001', name: 'squad-0-populated' },
      { uuid: '2f1c9a44-0000-4000-8000-000000001004', name: 'squad-1-nulled' },
    ]);
    // Guards the guard: if a genuine answer reported drift, the flag would
    // carry no information and the log would be noise nobody reads.
    assert.equal(outcome.kind === 'ok' ? outcome.drifted : null, false);
    assert.deepStrictEqual(drifts, []);
  });

  it('reads internal squad details out of the same body', async () => {
    const { client } = stub(ok(captured('internal-squads')));
    const outcome = await client.getInternalSquads();

    assert.equal(outcome.kind, 'ok');
    const rows = outcome.kind === 'ok' ? outcome.data : [];
    assert.equal(rows.length, 2);
    // The `info` counters the Squads tab renders — present on a real answer.
    assert.equal(rows[0]?.info.membersCount, 40);
    assert.equal(rows[0]?.info.inboundsCount, 3);
  });

  it('reads external squad options and details out of the real body', async () => {
    const { client: optionsClient } = stub(ok(captured('external-squads')));
    const options = await optionsClient.getExternalSquadOptions();
    assert.deepStrictEqual(options.kind === 'ok' ? options.data : null, [
      { uuid: '2f1c9a44-0000-4000-8000-000000000001', name: 'squad-0-populated' },
      { uuid: '2f1c9a44-0000-4000-8000-000000001004', name: 'squad-1-nulled' },
    ]);

    const { client: detailsClient } = stub(ok(captured('external-squads')));
    const details = await detailsClient.getExternalSquads();
    assert.equal(details.kind === 'ok' ? details.data.length : null, 2);
  });
});

describe('a squad answer the pinned schema refuses is still read', () => {
  /**
   * The captured body with `responseHeadersAdd` / `responseHeadersRemove`
   * spelled the way an earlier panel era spelled it: `responseHeaders`.
   *
   * This is the outage, reproduced. It ran in the other direction — a client
   * pinned to a 2.x contract meeting a 3.x panel — but the failure is the same
   * one and it is symmetric: a squad row whose header field is spelled for a
   * different era than the pinned contract expects.
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

  it('is genuinely rejected by the pinned contract — this test is not vacuous', () => {
    // Without this the two below would pass against a schema that accepts
    // anything, and would be measuring nothing.
    const parsed = GetExternalSquadsCommand.ResponseSchema.safeParse(renamedExternalSquads());
    assert.equal(parsed.success, false);
  });

  it('still yields every squad option, and reports the drift', async () => {
    const drifts: PanelDriftReport[] = [];
    const { client } = stub(ok(renamedExternalSquads()), (report) => drifts.push(report));

    const outcome = await client.getExternalSquadOptions();

    // The whole point. Not a throw, not an empty list, not a `null`: the
    // squads, because the option read consults nothing but `uuid` and `name`
    // and no panel era has ever spelled those differently.
    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(
      (outcome.kind === 'ok' ? outcome.data : []).map((option) => option.uuid),
      ['2f1c9a44-0000-4000-8000-000000000001', '2f1c9a44-0000-4000-8000-000000001004'],
    );
    // Lenient is not silent — an operator can still see the panel moved.
    assert.equal(outcome.kind === 'ok' ? outcome.drifted : null, true);
    assert.deepStrictEqual(
      drifts.map((report) => report.url),
      ['/api/external-squads/'],
    );
  });

  it('still yields the full-shape rows for the Squads tab', async () => {
    const { client } = stub(ok(renamedExternalSquads()));
    const outcome = await client.getExternalSquads();

    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' ? outcome.data.length : null, 2);
    assert.equal(outcome.kind === 'ok' ? outcome.drifted : null, true);
  });

  it('tolerates a field a later panel minor adds', async () => {
    // The other half of the same asymmetry: the fleet runs several minors while
    // the contract is pinned to one, so an ADDED field must not take a tab down
    // any more than a renamed one.
    const body = clone(captured('internal-squads')) as {
      response: { internalSquads: Array<Record<string, unknown>> };
    };
    body.response.internalSquads[0]!['fieldFromALaterMinor'] = { anything: true };
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
    const outcome = await client.getConfigProfiles();
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

  it('believes an empty catalog list without demanding a counter', async () => {
    // Deliberately NOT the squad rule. `total` guards a caller that acts on
    // absence; making seven read-only tabs hinge on a counter they never
    // display would turn one cosmetic wire difference into seven blank screens.
    const { client } = stub(ok({ response: { snippets: [] } }));
    const outcome = await client.getSnippets();
    assert.equal(outcome.kind, 'ok');
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.data : null, []);
  });
});

describe('the version probe survives a panel the pinned contract does not describe', () => {
  it('reads the version off a 2.x metadata body the contract rejects', async () => {
    const legacyBody = { response: { version: '2.7.4' } };
    // Non-vacuous: 3.4.2 declares `version`, `build` AND `git` required here.
    assert.equal(GetMetadataCommand.ResponseSchema.safeParse(legacyBody).success, false);

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

  it('hands the typed metadata read the drift flag rather than a failure', async () => {
    const { client } = stub(ok({ response: { version: '2.7.4' } }));
    const outcome = await client.getSystemMetadata();
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' ? outcome.drifted : null, true);
  });
});

describe('a body we built wrong never leaves the process', () => {
  it('refuses an empty node list the contract declares as minimum one', async () => {
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

  it('numbers host positions from one, and checks the uuids before sending', async () => {
    const { client, calls } = stub(ok({ response: { isUpdated: true } }));
    const first = '2f1c9a44-0000-4000-8000-000000000001';
    const second = '2f1c9a44-0000-4000-8000-000000000002';

    assert.equal((await client.reorderHosts([first, second])).kind, 'ok');
    assert.deepStrictEqual(calls[0]?.body, {
      hosts: [
        { uuid: first, viewPosition: 1 },
        { uuid: second, viewPosition: 2 },
      ],
    });

    const bad = await client.reorderHosts(['not-a-uuid']);
    assert.equal(bad.kind, 'invalid-request');
    // Still one call: the second never went out.
    assert.equal(calls.length, 1);
  });
});

describe('transport failures reach the caller as themselves', () => {
  it('does not turn "no base url or token" into an empty list', async () => {
    const { client } = stub({ kind: 'unconfigured' });
    // The reader this replaces answered `[]` here, which made an unconfigured
    // integration indistinguishable from a panel with no hosts.
    assert.equal((await client.getHosts()).kind, 'unconfigured');
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

  it('does not turn a 500 into "the panel has no snippets"', async () => {
    const { client } = stub({
      kind: 'rejected',
      status: 500,
      code: null,
      detail: 'Internal server error',
      retryAfterMs: null,
    });
    assert.equal((await client.getSnippets()).kind, 'rejected');
  });
});
