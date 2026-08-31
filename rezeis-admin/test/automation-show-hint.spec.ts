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

/**
 * A scheduled rule's context.
 *
 * The audience action refuses an event trigger outright: it picks its own
 * recipients, so bound to a realtime rule it would run a full audience resolve
 * plus up to five hundred sequential raises on EVERY system event. One `*` rule
 * saved while the editor still held its default trigger kind turned a payment
 * burst into thousands of queries.
 */
const CRON_CONTEXT = {
  ruleId: 'rule-2',
  ruleName: 'Nightly nudge',
  trigger: 'cron',
  triggerData: {},
};

function buildRegistry(
  raiseImpl?: (input: Record<string, unknown>) => Promise<unknown>,
  audience?: unknown,
) {
  const raised: Array<Record<string, unknown>> = [];
  const registry = new AutomationActionRegistry(
    {} as never,
    { user: { findUnique: async () => ({ isBlocked: false }), update: async () => ({}) } } as never,
    { warn: () => undefined } as never,
    { block: async () => ({}) } as never,
    {
      raise: async (input: Record<string, unknown>) => {
        raised.push(input);
        return raiseImpl !== undefined ? await raiseImpl(input) : { id: 'del-1' };
      },
    } as never,
    {
      resolve: async () =>
        audience ?? { kind: 'ok', userIds: ['u-1', 'u-2'], truncated: false },
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
      { user: { findUnique: async () => ({ isBlocked: false }), update: async () => ({}) } } as never,
      { warn: () => undefined } as never,
      {
        block: async (input: { userId: string }) => {
          blocked.push(input);
          return { identitiesCaptured: 1, devicesCaptured: 0, subscriptionsQueued: 1 };
        },
      } as never,
      { raise: async () => null } as never,
      { resolve: async () => ({ kind: 'ok', userIds: [], truncated: false }) } as never,
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

describe('the scheduled audience action', () => {
  it('queues the hint for everybody the query named', async () => {
    const { registry, raised } = buildRegistry();

    const result = await registry.execute(
      0,
      {
        type: 'show_hint_to_audience',
        params: { hintKey: 'connect', audience: 'paid-not-connected' },
      } as never,
      CRON_CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.equal(raised.length, 2);
    assert.equal(raised[0].source, 'audience:paid-not-connected');
  });

  it('reports both numbers, because they differ for an ordinary reason', async () => {
    // The hint is once-only, so a daily rule matches the same people again and
    // queues nothing for them. "matched 2, queued 0" is a rule working exactly
    // as intended, and an operator needs to be able to see that.
    const { registry } = buildRegistry(async () => null);

    const result = await registry.execute(
      0,
      {
        type: 'show_hint_to_audience',
        params: { hintKey: 'connect', audience: 'paid-not-connected' },
      } as never,
      CRON_CONTEXT as never,
    );

    assert.match(String(result.message), /0 of 2/);
  });

  it('stands down as a SUCCESS when the signal is blind', async () => {
    // Deliberately not a failure. A failed execution invites a retry, and a
    // retry cannot fix a missing webhook; the message is what tells the
    // operator what to fix.
    const { registry, raised } = buildRegistry(undefined, {
      kind: 'blind',
      reason: 'no account has a first-traffic timestamp',
    });

    const result = await registry.execute(
      0,
      {
        type: 'show_hint_to_audience',
        params: { hintKey: 'connect', audience: 'paid-not-connected' },
      } as never,
      CRON_CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.match(String(result.message), /stood down/);
    assert.deepStrictEqual(raised, [], 'and above all: it hinted nobody');
  });

  it('refuses an audience nobody defined', async () => {
    const { registry, raised } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint_to_audience', params: { hintKey: 'x', audience: 'everybody' } } as never,
      CRON_CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.deepStrictEqual(raised, []);
  });

  it('says so when nobody matched', async () => {
    const { registry } = buildRegistry(undefined, {
      kind: 'ok',
      userIds: [],
      truncated: false,
    });

    const result = await registry.execute(
      0,
      {
        type: 'show_hint_to_audience',
        params: { hintKey: 'connect', audience: 'paid-not-connected' },
      } as never,
      CRON_CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.match(String(result.message), /nobody matched/);
  });
});

describe('the guards this batch added, exercised rather than accommodated', () => {
  /**
   * These two tests exist because the specs above were edited to ACCOMMODATE
   * the guards — the audience tests were moved off an event trigger so they
   * would keep passing, and the prisma stub gained `findUnique` so the block
   * action would not crash. Both changes were necessary and neither one
   * exercises anything: delete both guards and every test above still passes.
   *
   * That is the failure mode this codebase has hit repeatedly — a decision made
   * correctly in the code, with no test that reaches the branch.
   */
  it('refuses the audience action on an event trigger, and does not resolve first', async () => {
    let resolveCalls = 0;
    const registry = new AutomationActionRegistry(
      {} as never,
      { user: { findUnique: async () => ({ isBlocked: false }), update: async () => ({}) } } as never,
      { warn: () => undefined } as never,
      { block: async () => ({}) } as never,
      { raise: async () => ({ id: 'del-1' }) } as never,
      {
        resolve: async () => {
          resolveCalls += 1;
          return { kind: 'ok', userIds: ['u-1'], truncated: false };
        },
      } as never,
      { starsWebhookSecret: null } as never,
    );

    const result = await registry.execute(
      0,
      {
        type: 'show_hint_to_audience',
        params: { hintKey: 'connect', audience: 'paid-not-connected' },
      } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    // The resolve must not have run. The whole point of refusing is that this
    // action picks its own recipients: bound to a realtime rule it would run a
    // full audience query plus up to five hundred sequential raises on EVERY
    // system event, and a `*` pattern turns one payment burst into thousands.
    assert.equal(resolveCalls, 0, 'refused, but only after doing the expensive thing');
    assert.match(String(result.message), /trigger|schedule|event/i);
  });

  it('stands down when the customer is already blocked, which is what ends the loop', async () => {
    let blockCalls = 0;
    const registry = new AutomationActionRegistry(
      {} as never,
      {
        // The state that matters. Blocking emits `user.blocked`; the bridge
        // feeds every emitted event back into rule matching, so a rule keyed on
        // `user.blocked` would block, emit, match and block again for ever.
        // Reading this flag first is the only thing that ends it at lap two.
        user: { findUnique: async () => ({ isBlocked: true }), update: async () => ({}) },
      } as never,
      { warn: () => undefined } as never,
      {
        block: async () => {
          blockCalls += 1;
          return {};
        },
      } as never,
      { raise: async () => ({ id: 'del-1' }) } as never,
      { resolve: async () => ({ kind: 'ok', userIds: [], truncated: false }) } as never,
      { starsWebhookSecret: null } as never,
    );

    const result = await registry.execute(
      0,
      { type: 'block_user', params: {} } as never,
      CONTEXT as never,
    );

    // A SUCCESS, not a failure: the customer is blocked, which is the state the
    // rule wanted. Reporting failure would paint the operator's log red for a
    // rule working exactly as configured.
    assert.equal(result.status, 'success');
    assert.equal(blockCalls, 0, 'blocked again — the feedback loop is still open');
    assert.match(String(result.message), /already blocked/i);
  });
});

describe('the notify action stops claiming a delivery it cannot see', () => {
  /**
   * `warn()` is `void` and fire-and-forget — right for the event bus, which
   * must never fail the caller that raised the event. But the action answered
   * `notify queued` and the rule was graded SUCCEEDED regardless, so an
   * operator whose Telegram notifications were switched off, or who had never
   * ticked this event type, watched their alerting rule report a clean run on
   * every fire while nothing was delivered.
   *
   * A dead alert that looks healthy is worse than one that looks broken.
   */
  function registryWith(delivery: { deliverable: boolean; reason: string | null }) {
    const raised: string[] = [];
    const registry = new AutomationActionRegistry(
      {} as never,
      { user: { findUnique: async () => ({ isBlocked: false }), update: async () => ({}) } } as never,
      {
        describeTelegramDelivery: async () => delivery,
        warn: (_t: string, _c: string, message: string) => {
          raised.push(message);
        },
      } as never,
      { block: async () => ({}) } as never,
      { raise: async () => ({ id: 'del-1' }) } as never,
      { resolve: async () => ({ kind: 'ok', userIds: [], truncated: false }) } as never,
      { starsWebhookSecret: null } as never,
    );
    return { registry, raised };
  }

  it('FAILS when the operator has notifications switched off', async () => {
    const { registry, raised } = registryWith({
      deliverable: false,
      reason: 'Telegram notifications are switched off',
    });

    const result = await registry.execute(
      0,
      { type: 'notify_telegram', params: { text: 'disk is full' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.match(String(result.message), /switched off/i);
    assert.deepStrictEqual(raised, [], 'raised an event it had just called undeliverable');
  });

  it('FAILS when this event type is not ticked', async () => {
    const { registry } = registryWith({
      deliverable: false,
      reason: '"automation.telegram_notify" is not ticked in the Telegram notification settings',
    });

    const result = await registry.execute(
      0,
      { type: 'notify_telegram', params: {} } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.match(String(result.message), /not ticked/i);
  });

  it('raises it when nothing is known to block delivery', async () => {
    const { registry, raised } = registryWith({ deliverable: true, reason: null });

    const result = await registry.execute(
      0,
      { type: 'notify_telegram', params: { text: 'disk is full' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.deepStrictEqual(raised, ['disk is full']);
    // "raised", not "queued" or "sent": what happens after the bus is the
    // notification settings' business, not this action's to claim.
    assert.match(String(result.message), /raised/i);
    assert.doesNotMatch(String(result.message), /sent|delivered/i);
  });
});
