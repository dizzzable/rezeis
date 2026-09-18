import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createAutomationHarness,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * A webhook URL, whole, only for a reader who may edit the action
 * ═══════════════════════════════════════════════════════════════
 *
 * A `webhook_post` URL usually carries its receiver's secret in the path or the
 * query — Slack, Zapier and RequestBin key a receiver there — and every rule
 * read handed it to anyone holding `automations:view`, while the audit rows
 * already stored only the host for exactly that reason. Now the full URL goes
 * only to a reader who may edit the action (`automations:edit` AND
 * `webhooks:create`); everyone else reads its origin and a marker. Checked in
 * the list and in the rule, through the real guard and routes.
 */

const HOOK_URL = 'https://hooks.example.com/services/T0/B0/PATH-SECRET?token=QUERY-SECRET';
const MASKED = { url: 'https://hooks.example.com/…', urlHidden: true };

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([
    { id: 'viewer', role: 'ADMIN', permissions: ['automations:view'] },
    { id: 'editor', role: 'ADMIN', permissions: ['automations:view', 'automations:edit', 'webhooks:create'] },
    { id: 'editor-without-webhooks', role: 'ADMIN', permissions: ['automations:view', 'automations:edit'] },
    { id: 'webhooks-without-edit', role: 'ADMIN', permissions: ['automations:view', 'automations:create', 'webhooks:create'] },
    { id: 'dev', role: 'DEV', permissions: [] },
  ]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
});

function seed() {
  return harness.seedRule({
    name: 'Relay',
    isEnabled: true,
    actions: [
      { type: 'notify_telegram', params: { text: 'fired' } },
      { type: 'webhook_post', params: { url: HOOK_URL } },
    ],
  });
}

/** The webhook action's params, as the list and as the rule answer them to `adminId`. */
async function seen(adminId: string, ruleId: string): Promise<{ list: unknown; one: unknown; raw: string }> {
  const list = await harness.as(adminId).get('/rules');
  const one = await harness.as(adminId).get(`/rules/${ruleId}`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const fromList = (list.body as Array<{ id: string; actions: Array<{ params: unknown }> }>).find((rule) => rule.id === ruleId);
  return {
    list: fromList?.actions[1]?.params,
    one: (one.body as { actions: Array<{ params: unknown }> }).actions[1]?.params,
    raw: JSON.stringify([list.body, one.body]),
  };
}

describe('who reads a webhook URL whole', () => {
  it('shows it whole, in the list and in the rule, to a reader who may edit the action', async () => {
    const rule = seed();
    for (const adminId of ['editor', 'dev']) {
      const view = await seen(adminId, rule.id);
      assert.deepStrictEqual(view.list, { url: HOOK_URL }, adminId);
      assert.deepStrictEqual(view.one, { url: HOOK_URL }, adminId);
    }
  });

  it('shows only its origin, in the list and in the rule, to anyone else — nothing of the path or the query', async () => {
    const rule = seed();
    for (const adminId of ['viewer', 'editor-without-webhooks', 'webhooks-without-edit']) {
      const view = await seen(adminId, rule.id);
      assert.deepStrictEqual(view.list, MASKED, adminId);
      assert.deepStrictEqual(view.one, MASKED, adminId);
      assert.ok(!view.raw.includes('PATH-SECRET') && !view.raw.includes('QUERY-SECRET'), `${adminId} read the secret`);
    }
  });

  it('answers a save and a switch in the view of whoever made them', async () => {
    const created = await harness.as('webhooks-without-edit').post(
      '/rules',
      ruleBody({ actions: [{ type: 'webhook_post', params: { url: HOOK_URL } }] }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepStrictEqual(created.body.actions[0].params, MASKED);

    const rule = seed();
    const off = await harness.as('editor-without-webhooks').patch(`/rules/${rule.id}/toggle`, { isEnabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.deepStrictEqual(off.body.actions[1].params, MASKED);

    const on = await harness.as('editor').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepStrictEqual(on.body.actions[1].params, { url: HOOK_URL });
  });

  it('leaves nothing of a stored value that is not a URL at all', async () => {
    const rule = harness.seedRule({ actions: [{ type: 'webhook_post', params: { url: 'not a url PATH-SECRET' } }] });
    const view = await seen('viewer', rule.id);
    assert.deepStrictEqual((await harness.as('viewer').get(`/rules/${rule.id}`)).body.actions[0].params, {
      url: '…',
      urlHidden: true,
    });
    assert.ok(!view.raw.includes('PATH-SECRET'));
  });
});
