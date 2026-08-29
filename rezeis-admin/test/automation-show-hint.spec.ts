import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AutomationActionRegistry,
  resolveTriggerUserId,
} from '../src/modules/automations/actions/action-registry';

/**
 * Queuing a hint from a rule — and the defect that made every such rule inert
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `AutomationEventBridgeService` builds the trigger payload as
 * `{ type, category, severity, message, metadata, timestamp }`. The customer is
 * named inside `metadata`, never at the top level — `SystemEventsService` knows
 * this and reads `metadata.userId` for its own Telegram cards.
 *
 * `block_user` did not. It read the top level, found nothing on every realtime
 * trigger, and threw. So a rule that fires on `fraud.signal_opened` and blocks
 * whoever it names could never work; the action only did anything when an
 * operator pinned one specific user id into the params, which is not a rule so
 * much as a one-shot.
 *
 * Both actions now share one resolver, and it is the first thing tested here.
 */

const EVENT_PAYLOAD = {
  type: 'payment.completed',
  category: 'PAYMENT',
  severity: 'info',
  message: 'Payment completed',
  // Where the bridge actually puts the customer.
  metadata: { userId: 'user-7', amount: 500 },
  timestamp: '2026-08-29T12:00:00.000Z',
};

const CONTEXT = {
  ruleId: 'rule-1',
  ruleName: 'After a purchase',
  trigger: 'event:payment.completed',
  triggerData: EVENT_PAYLOAD,
};

function buildRegistry(raiseImpl?: (input: Record<string, unknown>) => Promise<unknown>) {
  const raised: Array<Record<string, unknown>> = [];
  const registry = new AutomationActionRegistry(
    {} as never,
    { user: { update: async () => ({}) } } as never,
    { warn: () => undefined } as never,
    { block: async () => ({}) } as never,
    {
      raise: async (input: Record<string, unknown>) => {
        raised.push(input);
        return raiseImpl !== undefined ? await raiseImpl(input) : { id: 'del-1' };
      },
    } as never,
    { starsWebhookSecret: null } as never,
  );
  return { registry, raised };
}

describe('finding the customer a rule is about', () => {
  it('reads metadata.userId, which is where events put it', async () => {
    // THE fix. Without it every realtime rule that names a customer is inert.
    assert.equal(resolveTriggerUserId({}, EVENT_PAYLOAD), 'user-7');
  });

  it('lets an explicit param win over the event', async () => {
    assert.equal(resolveTriggerUserId({ userId: 'pinned' }, EVENT_PAYLOAD), 'pinned');
  });

  it('still reads a top-level id, which a manual trigger may set', async () => {
    assert.equal(resolveTriggerUserId({}, { userId: 'manual-1' }), 'manual-1');
  });

  it('answers null when nothing names a customer', async () => {
    assert.equal(resolveTriggerUserId({}, { type: 'node.offline', metadata: {} }), null);
  });
});

describe('the show_hint action', () => {
  it('queues the hint for the customer the event named', async () => {
    const { registry, raised } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'connect-after-purchase' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.equal(raised.length, 1);
    assert.equal(raised[0].userId, 'user-7');
    assert.equal(raised[0].hintKey, 'connect-after-purchase');
  });

  it('records which rule queued it', async () => {
    // The delivery row is the only place an operator can later ask "why did
    // this customer see that", so the rule has to be named in it.
    const { registry, raised } = buildRegistry();

    await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x' } } as never,
      CONTEXT as never,
    );

    assert.equal(raised[0].source, 'rule:rule-1');
  });

  it('fails when the event names no customer', async () => {
    // The one failure an operator can act on: they bound a hint to an event
    // that is about the system rather than about a person.
    const { registry, raised } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x' } } as never,
      { ...CONTEXT, triggerData: { type: 'node.offline', metadata: {} } } as never,
    );

    assert.equal(result.status, 'failed');
    assert.match(String(result.message), /names a customer/);
    assert.deepStrictEqual(raised, []);
  });

  it('fails when no hint was named', async () => {
    const { registry } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: {} } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
  });

  it('succeeds when the queue declined, and says why it might have', async () => {
    // `raise()` answers null for four ordinary reasons — switched off, already
    // delivered and not repeatable, superseded within its group, or never
    // authored. Only the last is a mistake, and the service logs that one.
    // Failing here would paint the execution log red for a rule behaving
    // exactly as configured.
    const { registry } = buildRegistry(async () => null);

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.match(String(result.message), /not queued/);
  });
});

describe('block_user reads the customer the same way', () => {
  it('finds the id in metadata, which it never could before', async () => {
    const blocked: Array<{ userId: string }> = [];
    const registry = new AutomationActionRegistry(
      {} as never,
      { user: { update: async () => ({}) } } as never,
      { warn: () => undefined } as never,
      {
        block: async (input: { userId: string }) => {
          blocked.push(input);
          return { identitiesCaptured: 1, devicesCaptured: 0, subscriptionsQueued: 1 };
        },
      } as never,
      { raise: async () => null } as never,
      { starsWebhookSecret: null } as never,
    );

    const result = await registry.execute(
      0,
      { type: 'block_user', params: {} } as never,
      { ...CONTEXT, triggerData: { ...EVENT_PAYLOAD, type: 'fraud.signal_opened' } } as never,
    );

    assert.equal(result.status, 'success');
    assert.equal(blocked[0].userId, 'user-7');
  });
});
