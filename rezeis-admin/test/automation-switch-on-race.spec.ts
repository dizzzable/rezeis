import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createAutomationHarness,
  messagesOf,
  type AutomationHarness,
  type RuleRow,
} from './helpers/automation-http-harness';

/**
 * Switching a rule on switches on only what was checked
 * ════════════════════════════════════════════════════
 *
 * The switch checks the rule it read — the permission of every action, the
 * whole save validation — and then wrote `isEnabled = true` onto whatever the
 * row held by then. Another admin's save landing between the two was switched
 * on by a check that never saw it: an admin without `webhooks:create` could
 * switch on a webhook added a moment earlier. The write is now conditional on
 * the row being the one read (`updatedAt`); on a mismatch nothing is written
 * and the answer is 409.
 *
 * The interleave is forced: the double hands the switch its copy of the row
 * and then, before the switch writes, applies what the other admin saved.
 */

const SWITCHER = ['automations:view', 'automations:edit'];

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'switcher', role: 'ADMIN', permissions: SWITCHER }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.audit.length = 0;
  harness.db.afterNextRuleRead = null;
});

/** Another admin's save, landing right after the switch has read the rule. */
function anotherAdminAddsAWebhook(row: RuleRow): void {
  row.actions = [
    { type: 'notify_telegram', params: { text: 'fired' } },
    { type: 'webhook_post', params: { url: 'https://collector.example.net/grab' } },
  ];
  row.updatedAt = new Date(row.updatedAt.getTime() + 1_000);
}

describe('a rule that changes while it is being switched on', () => {
  it('is refused with 409, stays off, and nothing is recorded as switched', async () => {
    const rule = harness.seedRule({ isEnabled: false, actions: [{ type: 'notify_telegram', params: { text: 'fired' } }] });
    harness.db.afterNextRuleRead = anotherAdminAddsAWebhook;

    const response = await harness.as('switcher').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.deepStrictEqual(messagesOf(response.body), [
      'The rule changed while it was being switched on — reload it and try again',
    ]);
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false, 'the webhook nobody checked was switched on');
    assert.deepStrictEqual(harness.db.audit.filter((row) => row.action === 'automations.rule_toggled'), []);
  });

  it('is switched on when nothing changed in between', async () => {
    const rule = harness.seedRule({ isEnabled: false, actions: [{ type: 'notify_telegram', params: { text: 'fired' } }] });

    const response = await harness.as('switcher').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, true);
  });

  it('is switched off whatever happened to it in between: stopping a rule asks nothing', async () => {
    const rule = harness.seedRule({ isEnabled: true, actions: [{ type: 'notify_telegram', params: { text: 'fired' } }] });
    harness.db.afterNextRuleRead = anotherAdminAddsAWebhook;

    const response = await harness.as('switcher').patch(`/rules/${rule.id}/toggle`, { isEnabled: false });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false);
  });
});
