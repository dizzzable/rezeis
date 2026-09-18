import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createAutomationHarness,
  ruleBody,
  type AuditRow,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * Who changed which rule, and when — in the admin audit log
 * ══════════════════════════════════════════════════════════
 *
 * A rule acts as the system: it blocks, posts and bans with every permission
 * there is. Until now nothing recorded who wrote one, switched one on, ran one
 * by hand or deleted one — `createdById` names the author of the first version
 * and nobody after. Every one of those acts now writes a row through the same
 * `admin_audit_log` every other admin action uses: the actor and the request
 * (address, agent) in the row's own columns, the rule's id, name, trigger and
 * action TYPES in its metadata.
 *
 * Never a param: an `authorizationHeader` is a credential, and a webhook URL
 * carries its secret in the path or the query as often as not.
 */

const AUTHOR = [
  'automations:view',
  'automations:create',
  'automations:edit',
  'automations:delete',
  'automations:run',
  'webhooks:create',
  'blocked_ips:create',
];
const FROM = '198.51.100.44';
const SECRETS = ['AUDIT-HEADER-SECRET', 'PATH-SECRET', 'QUERY-SECRET'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'author', role: 'ADMIN', permissions: AUTHOR }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.audit.length = 0;
  harness.db.executions.length = 0;
  harness.db.blockedIps.clear();
});

const SECRET_ACTIONS = [
  {
    type: 'webhook_post',
    params: {
      url: 'https://hooks.example.com/in/PATH-SECRET?token=QUERY-SECRET',
      authorizationHeader: 'Bearer AUDIT-HEADER-SECRET',
    },
  },
  { type: 'notify_telegram', params: { text: 'fired' } },
];

function only(action: string): AuditRow {
  const rows = harness.db.audit.filter((row) => row.action === action);
  assert.equal(rows.length, 1, `${action}: ${JSON.stringify(harness.db.audit.map((row) => row.action))}`);
  return rows[0]!;
}

function assertNoSecrets(): void {
  const written = JSON.stringify(harness.db.audit);
  for (const secret of SECRETS) {
    assert.ok(!written.includes(secret), `${secret} reached the audit log`);
  }
}

async function create(): Promise<string> {
  const response = await harness
    .as('author', FROM)
    .post('/rules', ruleBody({ name: 'Relay', actions: SECRET_ACTIONS }))
    .set('User-Agent', 'audit-spec');
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.id as string;
}

describe('the audit row of every change to a rule', () => {
  it('records a create: who, from where, which rule, which action types — and no secret', async () => {
    const id = await create();
    const row = only('automations.rule_created');

    assert.equal(row.adminUserId, 'author');
    assert.equal(row.ipAddress, FROM);
    assert.equal(row.userAgent, 'audit-spec');
    assert.deepStrictEqual(row.metadata, {
      requestId: null,
      targetType: 'automation_rule',
      targetId: id,
      ruleName: 'Relay',
      isEnabled: false,
      triggerKind: 'MANUAL',
      triggerSpec: '',
      actionTypes: ['webhook_post', 'notify_telegram'],
      webhookHosts: ['hooks.example.com'],
    });
    assertNoSecrets();
  });

  it('records an edit, with what the rule was before it', async () => {
    const id = await create();
    const response = await harness
      .as('author', FROM)
      .put(`/rules/${id}`, ruleBody({ name: 'Relay 2', actions: [{ type: 'block_ip', params: {} }] }));
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const row = only('automations.rule_updated');
    assert.equal(row.adminUserId, 'author');
    assert.equal(row.metadata['targetId'], id);
    assert.equal(row.metadata['ruleName'], 'Relay 2');
    assert.deepStrictEqual(row.metadata['actionTypes'], ['block_ip']);
    assert.deepStrictEqual(row.metadata['previous'], {
      ruleName: 'Relay',
      isEnabled: false,
      triggerKind: 'MANUAL',
      triggerSpec: '',
      actionTypes: ['webhook_post', 'notify_telegram'],
      webhookHosts: ['hooks.example.com'],
    });
    assertNoSecrets();
  });

  it('records switching on and switching off, each with the state it left', async () => {
    const id = await create();
    assert.equal((await harness.as('author', FROM).patch(`/rules/${id}/toggle`, { isEnabled: true })).status, 200);
    assert.equal((await harness.as('author', FROM).patch(`/rules/${id}/toggle`, { isEnabled: false })).status, 200);

    const rows = harness.db.audit.filter((row) => row.action === 'automations.rule_toggled');
    assert.deepStrictEqual(
      rows.map((row) => [row.metadata['isEnabled'], row.metadata['previousIsEnabled'], row.adminUserId]),
      [
        [true, false, 'author'],
        [false, true, 'author'],
      ],
    );
    assert.deepStrictEqual(rows[0]!.metadata['actionTypes'], ['webhook_post', 'notify_telegram']);
    assertNoSecrets();
  });

  it('records a delete, naming the rule that went', async () => {
    const id = await create();
    const response = await harness.as('author', FROM).delete(`/rules/${id}`);
    assert.equal(response.status, 204, JSON.stringify(response.body));

    const row = only('automations.rule_deleted');
    assert.equal(row.adminUserId, 'author');
    assert.equal(row.metadata['targetId'], id);
    assert.equal(row.metadata['ruleName'], 'Relay');
    assert.deepStrictEqual(row.metadata['actionTypes'], ['webhook_post', 'notify_telegram']);
    assert.equal(harness.db.rules.size, 0);
    assertNoSecrets();
  });

  it('records «Запустить сейчас», with the run it started and only the two keys of the body it names', async () => {
    const id = await create();
    const response = await harness.as('author', FROM).post(`/rules/${id}/run`, {
      triggerData: { userId: 'user-3', ip: '203.0.113.7', password: 'BODY-SECRET' },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const row = only('automations.rule_run');
    assert.equal(row.adminUserId, 'author');
    assert.equal(row.ipAddress, FROM);
    assert.equal(row.metadata['targetId'], id);
    assert.equal(row.metadata['ruleName'], 'Relay');
    assert.equal(row.metadata['executionId'], response.body.executionId);
    assert.equal(row.metadata['status'], response.body.status);
    assert.equal(row.metadata['requestedUserId'], 'user-3');
    assert.equal(row.metadata['requestedAddress'], '203.0.113.7');
    assert.deepStrictEqual(row.metadata['actionTypes'], ['webhook_post', 'notify_telegram']);
    assert.ok(!JSON.stringify(harness.db.audit).includes('BODY-SECRET'), 'the run body was copied into the audit log');
    assertNoSecrets();
  });

  it('writes nothing for a change that was refused', async () => {
    const response = await harness
      .as('author', FROM)
      .post('/rules', ruleBody({ conditions: { equals: ['$type', 'x'] } }));
    assert.equal(response.status, 400);
    assert.deepStrictEqual(harness.db.audit, []);
  });
});
