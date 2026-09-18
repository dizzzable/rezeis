import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { HttpService } from '@nestjs/axios';
import axios from 'axios';

import { buildBoundedOutboundHttpOptions } from '../src/common/http/outbound-http-options';
import { AutomationActionRegistry } from '../src/modules/automations/actions/action-registry';
import type { AutomationNetworkProbes } from '../src/modules/automations/services/automation-network-probes';
import {
  createAutomationHarness,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * `webhook_post` must never reach the machine itself or a metadata service
 * ═════════════════════════════════════════════════════════════════════════
 *
 * The action fetched whatever URL the rule held, from inside the panel's
 * network, on every event: a Docker API on the loopback, the cloud metadata
 * address. The policy (`common/net/outbound-url.ts`) refuses exactly those and
 * lets a receiver on a private network or behind a compose service name
 * through. The save check is covered with the other save refusals; this file is
 * about the SEND, where two more things hold:
 *
 *   - the static check runs again, for a rule saved before it existed or
 *     written by an import;
 *   - the name is resolved inside the socket's own lookup, and every address
 *     it answers is judged there — so what is checked is what is dialled, and
 *     a name that answers the loopback for the request has nothing to use.
 */

const HOOKS = ['automations:view', 'automations:run', 'webhooks:create'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'hooks', role: 'ADMIN', permissions: HOOKS }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.executions.length = 0;
  harness.posts.length = 0;
  harness.network.dns.clear();
});

interface ActionResult {
  readonly status: string;
  readonly code?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

async function runWebhook(url: string): Promise<ActionResult> {
  const rule = harness.seedRule({ actions: [{ type: 'webhook_post', params: { url, authorizationHeader: 'Bearer s3cret' } }] });
  const response = await harness.as('hooks').post(`/rules/${rule.id}/run`, { triggerData: {} });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.actionResults[0] as ActionResult;
}

describe('a URL saved before the check existed is refused when it is sent', () => {
  it('refuses the cloud metadata address, and sends nothing', async () => {
    const result = await runWebhook('http://169.254.169.254/latest/meta-data/iam/security-credentials/');

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'webhook_url_refused');
    assert.deepStrictEqual(result.details, { reason: 'internal_address', range: '169.254.0.0/16', kind: 'link_local' });
    assert.deepStrictEqual(harness.posts, [], 'the request went out anyway');
  });

  it('refuses localhost by name, and sends nothing', async () => {
    const result = await runWebhook('http://localhost:2375/containers/json');

    assert.equal(result.code, 'webhook_url_refused');
    assert.deepStrictEqual(result.details, { reason: 'local_name' });
    assert.deepStrictEqual(harness.posts, []);
  });

  it('refuses a metadata service by name, and sends nothing', async () => {
    const result = await runWebhook('http://metadata.google.internal/computeMetadata/v1/');

    assert.equal(result.code, 'webhook_url_refused');
    assert.deepStrictEqual(result.details, { reason: 'metadata_name' });
    assert.deepStrictEqual(harness.posts, []);
  });

  it('sends to a compose service name and to a private address', async () => {
    const byName = await runWebhook('http://n8n:5678/webhook/rezeis');
    assert.equal(byName.status, 'success', JSON.stringify(byName));
    const byAddress = await runWebhook('http://10.0.0.8:8080/in');
    assert.equal(byAddress.status, 'success', JSON.stringify(byAddress));
    assert.deepStrictEqual(
      harness.posts.map((post) => post.url),
      ['http://n8n:5678/webhook/rezeis', 'http://10.0.0.8:8080/in'],
    );
  });
});

describe('how a permitted request is sent', () => {
  it('follows no redirect, uses no environment proxy, and goes through agents that judge every address', async () => {
    const result = await runWebhook('https://hooks.example.test/in/T0KEN-IN-PATH?key=secret');

    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.message, 'POST to hooks.example.test', 'the run log must not carry the path or query');
    assert.equal(harness.posts.length, 1);
    const config = harness.posts[0]!.config;
    assert.equal(config['maxRedirects'], 0);
    assert.equal(config['proxy'], false);

    const lookup = (config['httpsAgent'] as { options: { lookup: LookupFn } }).options.lookup;
    assert.equal(typeof lookup, 'function', 'the https agent carries no guarded lookup');
    assert.equal(
      lookup,
      (config['httpAgent'] as { options: { lookup: LookupFn } }).options.lookup,
      'the two agents judge addresses differently',
    );

    harness.network.dns.set('public.example.test', ['93.184.215.14']);
    harness.network.dns.set('n8n', ['172.18.0.7']);
    harness.network.dns.set('lan.example.test', ['192.168.1.20', 'fd12:3456::1']);
    harness.network.dns.set('loopback.example.test', ['127.0.0.1']);
    harness.network.dns.set('mixed.example.test', ['93.184.215.14', '127.0.0.1']);
    harness.network.dns.set('mapped.example.test', ['::ffff:169.254.169.254']);
    harness.network.dns.set('imds6.example.test', ['fd00:ec2::254']);

    assert.deepStrictEqual(await ask(lookup, 'public.example.test', {}), { address: '93.184.215.14', family: 4 });
    assert.deepStrictEqual(await ask(lookup, 'public.example.test', { all: true }), {
      address: [{ address: '93.184.215.14', family: 4 }],
      family: undefined,
    });
    // A compose service and a LAN host are what a receiver beside the panel
    // resolves to, and they are let through.
    assert.deepStrictEqual(await ask(lookup, 'n8n', {}), { address: '172.18.0.7', family: 4 });
    assert.deepStrictEqual(await ask(lookup, 'lan.example.test', { all: true }), {
      address: [
        { address: '192.168.1.20', family: 4 },
        { address: 'fd12:3456::1', family: 6 },
      ],
      family: undefined,
    });
    for (const host of ['loopback.example.test', 'mixed.example.test', 'mapped.example.test', 'imds6.example.test']) {
      const answer = await ask(lookup, host, { all: true });
      assert.ok(answer.error instanceof Error, `${host} was handed to the socket`);
      assert.equal(answer.error.name, 'OutboundAddressRefusedError', host);
    }
  });
});

type LookupFn = (
  hostname: string,
  options: Record<string, unknown>,
  callback: (error: Error | null, address?: unknown, family?: number) => void,
) => void;

function ask(
  lookup: LookupFn,
  hostname: string,
  options: Record<string, unknown>,
): Promise<{ error?: Error; address?: unknown; family?: number }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => {
      resolve(error !== null ? { error } : { address, family });
    });
  });
}

describe('through the real HTTP client, against a real socket', () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  before(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function registryResolving(answers: Record<string, string[]>, asked: string[]): AutomationActionRegistry {
    const probes: AutomationNetworkProbes = {
      localAddresses: () => [],
      serviceHosts: () => [],
      lookupAll: (hostname, _options, callback) => {
        asked.push(hostname);
        const addresses = answers[hostname];
        if (addresses === undefined) {
          callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
          return;
        }
        callback(null, addresses.map((address): LookupAddress => ({ address, family: 4 })));
      },
    };
    return new AutomationActionRegistry(
      new HttpService(axios.create(buildBoundedOutboundHttpOptions())),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      probes,
    );
  }

  it('reaches the stand-in server at all — the control that makes "no request" mean something', async () => {
    const before = hits;
    const response = await axios.post(`http://127.0.0.1:${port}/control`, {}, { proxy: false });
    assert.equal(response.status, 200);
    assert.equal(hits, before + 1);
  });

  it('refuses at the moment of connecting a name that resolves to the loopback, and the server hears nothing', async () => {
    const asked: string[] = [];
    const registry = registryResolving({ 'rebind.example.test': ['127.0.0.1'] }, asked);
    const before = hits;

    const result = await registry.execute(
      0,
      { type: 'webhook_post', params: { url: `http://rebind.example.test:${port}/hook` } },
      { ruleId: 'rule-1', ruleName: 'Hook', trigger: 'manual:admin', triggerData: {} },
    );

    assert.deepStrictEqual(asked, ['rebind.example.test'], 'the socket did not ask the guarded lookup');
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.code, 'webhook_address_refused', JSON.stringify(result));
    assert.deepStrictEqual(result.details, {
      host: 'rebind.example.test',
      address: '127.0.0.1',
      range: '127.0.0.0/8',
      kind: 'loopback',
    });
    assert.equal(hits, before, 'the request reached the loopback server');
  });
});
