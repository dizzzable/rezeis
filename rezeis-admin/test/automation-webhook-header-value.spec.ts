import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { throwError } from 'rxjs';

import { AutomationActionRegistry } from '../src/modules/automations/actions/action-registry';
import type { AutomationNetworkProbes } from '../src/modules/automations/services/automation-network-probes';
import {
  createAutomationHarness,
  messagesOf,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * A webhook's Authorization header holds only what HTTP can carry
 * ═══════════════════════════════════════════════════════════════
 *
 * `Bearer токен` saved without a word and then failed on every send with
 * Node's raw `Invalid character in header content` — no code, no reason the
 * operator could act on. Now the save checks the header against what Node's
 * HTTP layer accepts (RFC 9110 field-value: VCHAR, obs-text 0x80-0xFF, space
 * and tab), and the send names any header Node refuses with its own code.
 */

const HOOKS = ['automations:view', 'automations:create', 'automations:edit', 'automations:run', 'webhooks:create'];
const REFUSAL =
  'Action 1 (webhook_post): "authorizationHeader" may hold only what an HTTP header can carry: printable ASCII and Latin-1 characters on one line — no line breaks, no Cyrillic';

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'hooks', role: 'ADMIN', permissions: HOOKS }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.posts.length = 0;
});

const hook = (authorizationHeader: string) =>
  ruleBody({ actions: [{ type: 'webhook_post', params: { url: 'https://hooks.example.com/in', authorizationHeader } }] });

describe('at save', () => {
  for (const [what, header] of [
    ['Cyrillic', 'Bearer токен'],
    ['a line break', 'Bearer x\x0d\x0aX-Injected: 1'],
    ['a control character', 'Bearer x\x00y'],
    ['DEL', 'Bearer x\x7fy'],
    ['an emoji', `Bearer ${String.fromCodePoint(0x1f511)}`],
  ] as const) {
    it(`refuses a header with ${what}, naming why, and saves nothing`, async () => {
      const response = await harness.as('hooks').post('/rules', hook(header));
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.deepStrictEqual(messagesOf(response.body), [REFUSAL]);
      assert.equal(harness.db.rules.size, 0);
    });
  }

  it('saves ASCII, a tab, and the Latin-1 letters HTTP allows', async () => {
    for (const header of ['Bearer abc.DEF-123_~+/=', 'Bearer a\x09b', 'Bearer caf\xe9 na\xefve']) {
      const response = await harness.as('hooks').post('/rules', hook(header));
      assert.equal(response.status, 201, `${JSON.stringify(header)}: ${JSON.stringify(response.body)}`);
    }
  });
});

describe('at send', () => {
  it('names a header saved before the check, and sends nothing', async () => {
    const rule = harness.seedRule({
      actions: [{ type: 'webhook_post', params: { url: 'https://hooks.example.com/in', authorizationHeader: 'Bearer токен' } }],
    });

    const response = await harness.as('hooks').post(`/rules/${rule.id}/run`, { triggerData: {} });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const [result] = response.body.actionResults as Array<{ status: string; code?: string; message?: string }>;
    assert.equal(result?.status, 'failed');
    assert.equal(result?.code, 'webhook_header_invalid', JSON.stringify(result));
    assert.ok(!(result?.message ?? '').includes('токен'), 'the header reached the run log');
    assert.deepStrictEqual(harness.posts, [], 'the request went out anyway');
  });

  it('names whatever else Node refuses in a header, never passing its error on raw', async () => {
    const probes: AutomationNetworkProbes = { localAddresses: () => [], serviceHosts: () => [], lookupAll: () => undefined };
    // What axios hands back when Node refuses a header the check above let pass.
    const nodeRefusal = Object.assign(new TypeError('Invalid character in header content ["X-Anything"]'), {
      code: 'ERR_INVALID_CHAR',
    });
    const registry = new AutomationActionRegistry(
      { post: () => throwError(() => Object.assign(new Error('wrapped'), { cause: nodeRefusal })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      probes,
    );

    const result = await registry.execute(
      0,
      { type: 'webhook_post', params: { url: 'https://hooks.example.com/in', authorizationHeader: 'Bearer ok' } },
      { ruleId: 'rule-1', ruleName: 'Hook', trigger: 'manual:admin', triggerData: {} },
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'webhook_header_invalid', JSON.stringify(result));
    assert.ok(!(result.message ?? '').includes('Invalid character'), 'Node’s own words reached the run log');
  });
});
