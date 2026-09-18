import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AUTOMATION_ACTION_TYPES } from '../src/modules/automations/automations.constants';
import {
  AUTOMATION_ACTION_PERMISSIONS,
  requiredActionPermissions,
} from '../src/modules/automations/automation-action-permissions';
import { isValidPermission } from '../src/modules/rbac/rbac.resources';
import {
  createAutomationHarness,
  messagesOf,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * A rule runs as the system — so saving one, switching one on, or running one
 * by hand must need what its actions would need on their own screens.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The routes asked for `automations:create` / `edit` / `run` and nothing else.
 * An operator trusted with rules and nothing more could therefore save a rule
 * that blocks an address (an admin's included), posts event data to a URL of
 * their choosing, or bans a customer: three things the panel refuses them on
 * the blocklist, webhooks and customer screens.
 *
 * Everything here goes through HTTP: the real `RbacGuard` and `RbacService`
 * reading each admin's own role, the production `ValidationPipe`, and
 * `AdminSafeExceptionFilter`, which is what decides what the operator reads.
 */

const RULE_ADMIN = ['automations:view', 'automations:create', 'automations:edit', 'automations:delete', 'automations:run'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([
    { id: 'rules-only', role: 'ADMIN', permissions: RULE_ADMIN },
    { id: 'rules-and-blocklist', role: 'ADMIN', permissions: [...RULE_ADMIN, 'blocked_ips:create'] },
    { id: 'rules-and-webhooks', role: 'ADMIN', permissions: [...RULE_ADMIN, 'webhooks:create'] },
    { id: 'rules-and-customers', role: 'ADMIN', permissions: [...RULE_ADMIN, 'users:edit'] },
    { id: 'viewer', role: 'ADMIN', permissions: ['automations:view'] },
    { id: 'dev', role: 'DEV', permissions: [] },
  ]);
});

after(async () => {
  await harness.close();
});

function reset(): void {
  harness.db.rules.clear();
  harness.db.audit.length = 0;
  harness.db.executions.length = 0;
  harness.db.blockedIps.clear();
  harness.userBlocks.length = 0;
  harness.posts.length = 0;
}

const BLOCK_IP = { type: 'block_ip', params: { address: '203.0.113.9' } };
const WEBHOOK = { type: 'webhook_post', params: { url: 'https://hooks.example.com/in' } };
const BLOCK_USER = { type: 'block_user', params: { userId: 'user-5' } };

describe('the map of what each action needs', () => {
  it('is exactly the three manual screens, and nothing for the other four', () => {
    // Literal, not read back from the constant: a test that took its
    // expectation from the map it pins would follow any edit to it.
    assert.deepStrictEqual(AUTOMATION_ACTION_PERMISSIONS, {
      notify_telegram: [],
      webhook_post: [{ resource: 'webhooks', action: 'create' }],
      block_ip: [{ resource: 'blocked_ips', action: 'create' }],
      system_event: [],
      block_user: [{ resource: 'users', action: 'edit' }],
      show_hint: [],
      show_hint_to_audience: [],
    });
  });

  it('covers every action type, with permissions the RBAC catalogue really has', () => {
    assert.deepStrictEqual(Object.keys(AUTOMATION_ACTION_PERMISSIONS).sort(), [...AUTOMATION_ACTION_TYPES].sort());
    const named = Object.values(AUTOMATION_ACTION_PERMISSIONS).flat();
    assert.ok(named.length > 0, 'the map names no permission at all');
    for (const permission of named) {
      assert.ok(isValidPermission(permission.resource, permission.action), `${permission.resource}:${permission.action}`);
    }
  });

  it('reads a stored column of any shape without inventing a requirement', () => {
    assert.deepStrictEqual(requiredActionPermissions(null), []);
    assert.deepStrictEqual(requiredActionPermissions({ 0: BLOCK_IP, length: 1 }), []);
    assert.deepStrictEqual(requiredActionPermissions(['block_ip', 7, null, { type: 'frobnicate' }]), []);
    assert.deepStrictEqual(
      requiredActionPermissions([BLOCK_IP, BLOCK_IP, WEBHOOK]).map((entry) => [entry.token, entry.actionTypes]),
      [
        ['blocked_ips:create', ['block_ip']],
        ['webhooks:create', ['webhook_post']],
      ],
    );
  });
});

describe('saving a rule needs the permission of every action in it', () => {
  it('refuses a block_ip rule to an admin without blocked_ips:create, and names the permission', async () => {
    reset();
    const response = await harness.as('rules-only').post('/rules', ruleBody({ actions: [BLOCK_IP] }));

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Missing permission: blocked_ips:create (needed by the block_ip action)',
    ]);
    assert.equal(harness.db.rules.size, 0, 'refused, but the rule was written anyway');
    assert.equal(harness.db.audit.length, 0, 'a refused save left an audit row');
  });

  it('refuses a webhook_post rule to an admin without webhooks:create', async () => {
    reset();
    const response = await harness.as('rules-only').post('/rules', ruleBody({ actions: [WEBHOOK] }));

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Missing permission: webhooks:create (needed by the webhook_post action)',
    ]);
    assert.equal(harness.db.rules.size, 0);
  });

  it('refuses a block_user rule to an admin without users:edit', async () => {
    reset();
    const response = await harness.as('rules-only').post('/rules', ruleBody({ actions: [BLOCK_USER] }));

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Missing permission: users:edit (needed by the block_user action)',
    ]);
    assert.equal(harness.db.rules.size, 0);
  });

  it('names every missing permission, one sentence each', async () => {
    reset();
    const response = await harness
      .as('rules-and-webhooks')
      .post('/rules', ruleBody({ actions: [BLOCK_USER, WEBHOOK, BLOCK_IP] }));

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Missing permission: users:edit (needed by the block_user action)',
      'Missing permission: blocked_ips:create (needed by the block_ip action)',
    ]);
  });

  it('saves the rule for an admin who holds the permission', async () => {
    reset();
    const response = await harness.as('rules-and-blocklist').post('/rules', ruleBody({ actions: [BLOCK_IP] }));

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(harness.db.rules.size, 1);
  });

  it('asks nothing more of the actions that reproduce no manual screen', async () => {
    reset();
    const plain = await harness.as('rules-only').post(
      '/rules',
      ruleBody({
        actions: [
          { type: 'notify_telegram', params: { text: 'hi' } },
          { type: 'system_event', params: { type: 'automation.custom' } },
          { type: 'show_hint', params: { hintKey: 'welcome' } },
        ],
      }),
    );
    assert.equal(plain.status, 201, JSON.stringify(plain.body));

    const audience = await harness.as('rules-only').post(
      '/rules',
      ruleBody({
        triggerKind: 'CRON',
        triggerSpec: '0 3 * * *',
        actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'connect', audience: 'paid-not-connected' } }],
      }),
    );
    assert.equal(audience.status, 201, JSON.stringify(audience.body));
  });

  it('lets a DEV admin save any action, as the route guard does', async () => {
    reset();
    const response = await harness.as('dev').post('/rules', ruleBody({ actions: [BLOCK_IP, WEBHOOK, BLOCK_USER] }));

    assert.equal(response.status, 201, JSON.stringify(response.body));
  });

  it('still answers the route permission first, through the real guard', async () => {
    reset();
    const response = await harness.as('viewer').post('/rules', ruleBody({ actions: [BLOCK_IP] }));

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), ['Missing permission: automations:create']);
  });
});

describe('editing a rule', () => {
  it('refuses an edit that keeps a block_ip action, to an admin without blocked_ips:create', async () => {
    reset();
    const rule = harness.seedRule({ name: 'Blocks', actions: [BLOCK_IP] });

    const response = await harness
      .as('rules-only')
      .put(`/rules/${rule.id}`, ruleBody({ name: 'Renamed', actions: [BLOCK_IP] }));

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Missing permission: blocked_ips:create (needed by the block_ip action)',
    ]);
    assert.equal(harness.db.rules.get(rule.id)?.name, 'Blocks', 'the refused edit was written');
  });

  it('lets the same admin take the action out: removing a power needs no permission', async () => {
    reset();
    const rule = harness.seedRule({ name: 'Blocks', actions: [BLOCK_IP] });

    const response = await harness
      .as('rules-only')
      .put(`/rules/${rule.id}`, ruleBody({ name: 'Notifies', actions: [{ type: 'notify_telegram', params: {} }] }));

    assert.equal(response.status, 200, JSON.stringify(response.body));
    // Compared as JSON, which is what the column stores: the pipe hands the
    // service DTO instances, not plain objects.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.db.rules.get(rule.id)?.actions)), [
      { type: 'notify_telegram', params: {} },
    ]);
  });
});

describe('switching a rule on', () => {
  it('refuses to switch on a webhook rule for an admin without webhooks:create', async () => {
    reset();
    const rule = harness.seedRule({ isEnabled: false, actions: [WEBHOOK] });

    const response = await harness.as('rules-only').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Missing permission: webhooks:create (needed by the webhook_post action)',
    ]);
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false, 'switched on anyway');
  });

  it('switches it off without asking anything of its actions', async () => {
    reset();
    const rule = harness.seedRule({ isEnabled: true, actions: [WEBHOOK, BLOCK_IP, BLOCK_USER] });

    const response = await harness.as('rules-only').patch(`/rules/${rule.id}/toggle`, { isEnabled: false });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false);
  });

  it('switches it on for an admin who holds the permission', async () => {
    reset();
    const rule = harness.seedRule({ isEnabled: false, actions: [WEBHOOK] });

    const response = await harness.as('rules-and-webhooks').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, true);
  });
});

describe('running a rule by hand', () => {
  it('refuses a block_ip rule to an admin without blocked_ips:create, and runs nothing', async () => {
    reset();
    const rule = harness.seedRule({ actions: [BLOCK_IP] });

    const response = await harness.as('rules-only').post(`/rules/${rule.id}/run`, { triggerData: {} });

    assert.equal(response.status, 403);
    assert.deepStrictEqual(messagesOf(response.body), [
      'Missing permission: blocked_ips:create (needed by the block_ip action)',
    ]);
    assert.equal(harness.db.executions.length, 0, 'a refused run was recorded');
    assert.equal(harness.db.blockedIps.size, 0, 'a refused run blocked the address');
    assert.equal(harness.db.audit.length, 0, 'a refused run left an audit row');
  });

  it('refuses a block_user rule to an admin without users:edit, and blocks nobody', async () => {
    reset();
    const rule = harness.seedRule({ actions: [BLOCK_USER] });

    const response = await harness.as('rules-only').post(`/rules/${rule.id}/run`, { triggerData: {} });

    assert.equal(response.status, 403);
    assert.deepStrictEqual(harness.userBlocks, []);
  });

  it('runs it for an admin who holds the permission', async () => {
    reset();
    const rule = harness.seedRule({ actions: [BLOCK_IP] });

    const response = await harness.as('rules-and-blocklist').post(`/rules/${rule.id}/run`, { triggerData: {} });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'SUCCEEDED', JSON.stringify(response.body));
    assert.deepStrictEqual([...harness.db.blockedIps.keys()], ['203.0.113.9']);
  });
});

describe('the catalogue the editor reads', () => {
  it('serves the map the routes enforce', async () => {
    const response = await harness.as('viewer').get('/catalog');

    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body.actionPermissions.block_ip, [{ resource: 'blocked_ips', action: 'create' }]);
    assert.deepStrictEqual(response.body.actionPermissions.webhook_post, [{ resource: 'webhooks', action: 'create' }]);
    assert.deepStrictEqual(response.body.actionPermissions.block_user, [{ resource: 'users', action: 'edit' }]);
    assert.deepStrictEqual(response.body.actionPermissions.notify_telegram, []);
    assert.deepStrictEqual(Object.keys(response.body.actionPermissions).sort(), [...AUTOMATION_ACTION_TYPES].sort());
  });
});
