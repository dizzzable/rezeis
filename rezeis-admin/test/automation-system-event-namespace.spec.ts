import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { AutomationTriggerKind } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { AutomationEventBridgeService } from '../src/modules/automations/automation-event-bridge.service';
import { isCustomEventType } from '../src/modules/automations/custom-event-type';
import type { RealtimeEventInterface } from '../src/modules/realtime/interfaces/realtime-event.interface';
import {
  createAutomationHarness,
  messagesOf,
  ruleBody,
  type AutomationHarness,
} from './helpers/automation-http-harness';

/**
 * `system_event` emits only the rule's own events
 * ═══════════════════════════════════════════════
 *
 * The action took any `type`. A MANUAL rule emitting `payment.completed` put a
 * forged payment on the bus everything trusts: other operators' enabled rules
 * with privileged actions fired on it, and quests, e-mails, pushes and webhooks
 * with them. Now a rule may emit `automation.custom` — the action's default,
 * already registered — or a type under `automation.custom.`; anything else is
 * refused at save and at switch-on, and at run for a rule saved before, with a
 * named code and nothing emitted. Rules listening to custom types keep working.
 */

const RULE_ADMIN = ['automations:view', 'automations:create', 'automations:edit', 'automations:run'];
const REFUSAL =
  'Action 1 (system_event): a rule may emit only its own events: "automation.custom", or a type that starts with "automation.custom."';

let harness: AutomationHarness;

before(async () => {
  harness = await createAutomationHarness([{ id: 'author', role: 'ADMIN', permissions: RULE_ADMIN }]);
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.db.rules.clear();
  harness.db.executions.length = 0;
  harness.emitted.length = 0;
});

const emits = (params: Record<string, unknown>) => ruleBody({ actions: [{ type: 'system_event', params }] });

describe('the namespace', () => {
  it('holds no event of the panel’s own but the action’s registered default', () => {
    const real = Object.values(EVENT_TYPES) as string[];
    assert.ok(real.length > 50, 'EVENT_TYPES was not read');
    assert.deepStrictEqual(real.filter((type) => isCustomEventType(type)), [EVENT_TYPES.AUTOMATION_CUSTOM]);
  });
});

describe('at save and at switch-on', () => {
  for (const type of [
    'payment.completed',
    'user.registered',
    'fraud.signal_opened',
    'automation.telegram_notify',
    'automation.customer',
    'custom.vip_paid',
    'AUTOMATION.CUSTOM.X',
    'automation.custom.',
    'automation.custom..x',
    `automation.custom.${'a'.repeat(120)}`,
  ]) {
    it(`refuses a rule that emits "${type.slice(0, 40)}", and saves nothing`, async () => {
      const response = await harness.as('author').post('/rules', emits({ type }));
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.deepStrictEqual(messagesOf(response.body), [REFUSAL]);
      assert.equal(harness.db.rules.size, 0);
    });
  }

  it('saves a rule that emits its own: the default, and names under it', async () => {
    for (const params of [{}, { type: 'automation.custom' }, { type: 'automation.custom.vip_paid' }, { type: 'automation.custom.vip-paid.v2' }]) {
      const response = await harness.as('author').post('/rules', emits(params));
      assert.equal(response.status, 201, `${JSON.stringify(params)}: ${JSON.stringify(response.body)}`);
    }
  });

  it('refuses to switch on a rule saved before that emits a real event, and leaves it off', async () => {
    const rule = harness.seedRule({ isEnabled: false, actions: [{ type: 'system_event', params: { type: 'payment.completed' } }] });
    const response = await harness.as('author').patch(`/rules/${rule.id}/toggle`, { isEnabled: true });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepStrictEqual(messagesOf(response.body), [REFUSAL]);
    assert.equal(harness.db.rules.get(rule.id)?.isEnabled, false);
  });
});

describe('at run', () => {
  it('refuses a rule saved before that emits a real event, with a named code, and emits nothing', async () => {
    const rule = harness.seedRule({ actions: [{ type: 'system_event', params: { type: 'payment.completed', message: 'paid' } }] });

    const response = await harness.as('author').post(`/rules/${rule.id}/run`, { triggerData: {} });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const [result] = response.body.actionResults as Array<{ status: string; code?: string; details?: unknown }>;
    assert.equal(result?.status, 'failed');
    assert.equal(result?.code, 'system_event_type_refused');
    assert.deepStrictEqual(result?.details, { type: 'payment.completed' });
    assert.deepStrictEqual(harness.emitted, [], 'the forged event reached the bus');
  });

  it('emits a custom event, and a rule listening to custom events fires on it', async () => {
    const emitter = harness.seedRule({ actions: [{ type: 'system_event', params: { type: 'automation.custom.vip_paid' } }] });
    const listener = harness.seedRule({
      isEnabled: true,
      triggerKind: AutomationTriggerKind.REALTIME,
      triggerSpec: 'automation.custom.*',
      actions: [{ type: 'notify_telegram', params: { text: 'a VIP paid' } }],
    });

    const response = await harness.as('author').post(`/rules/${emitter.id}/run`, { triggerData: {} });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.actionResults[0].status, 'success', JSON.stringify(response.body));
    const event = harness.emitted.find((entry) => entry['type'] === 'automation.custom.vip_paid');
    assert.ok(event !== undefined, `nothing was emitted: ${JSON.stringify(harness.emitted)}`);

    // What the bus hands the realtime gateway, through the real bridge.
    const gateway = { broadcast: (_event: RealtimeEventInterface): void => undefined };
    const ran: string[] = [];
    const bridge = new AutomationEventBridgeService(
      { get: () => gateway } as never,
      harness.prisma as never,
      {
        enqueueExecution: async (job: { ruleId: string }) => {
          await harness.executor.executeJob(job as never);
          ran.push(job.ruleId);
        },
      } as never,
    );
    bridge.onModuleInit();
    gateway.broadcast({
      type: String(event['type']),
      category: 'SYSTEM',
      severity: 'INFO',
      message: String(event['message']),
      metadata: event['metadata'] as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    for (let waited = 0; ran.length === 0 && waited < 2_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepStrictEqual(ran, [listener.id]);
  });
});
