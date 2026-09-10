import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AutomationTriggerKind } from '@prisma/client';

import { AutomationEventBridgeService } from '../src/modules/automations/automation-event-bridge.service';
import {
  AUTOMATION_CHAIN_DEPTH_KEY,
  AUTOMATION_CHAIN_DEPTH_LIMIT,
  chainDepthMetadata,
  chainDepthOf,
  chainExhausted,
  chainMetadata,
} from '../src/modules/automations/chain-depth';

/**
 * A RULE MUST NOT BE ABLE TO FEED ITSELF FOR EVER.
 *
 * Every emitted event goes back into rule matching — `emit` calls
 * `deliverRealtime`, the only caller of `RealtimeGateway.broadcast`, and the
 * bridge patches that method — and three actions emit. So one rule closes a
 * loop on its own: `triggerSpec: 'automation.*'` with a `system_event` action
 * raising `automation.custom`. Two rules close one with no wildcard at all.
 *
 * Each lap costs a queue job, an execution row, a rule update, an audit write,
 * a Telegram attempt and an outbound webhook. There was no counter anywhere in
 * the module.
 *
 * Chaining is deliberate and documented, so the cure could not be refusing to
 * chain. What is counted is how many automation hops separate an event from a
 * real one: a payment, a registration, a webhook all start at zero and are
 * unaffected; a rule that reaches itself runs out of hops.
 */

describe('counting hops', () => {
  it('reads a real-world event as fresh', () => {
    // Nothing that happened outside the automation engine carries a depth, and
    // that is the case that must never be slowed down or capped.
    assert.equal(chainDepthOf(undefined), 0);
    assert.equal(chainDepthOf({ userId: 'u-1' }), 0);
    assert.equal(chainExhausted({ userId: 'u-1' }), false);
  });

  it('refuses a depth somebody wrote by hand', () => {
    // A negative or fractional value is a payload built by hand. Reading it as
    // "fresh" is the reading that cannot be used to slip past the cap, and
    // clamping the upper end means an absurd number cannot wrap around it
    // either.
    assert.equal(chainDepthOf({ [AUTOMATION_CHAIN_DEPTH_KEY]: -5 }), 0);
    assert.equal(chainDepthOf({ [AUTOMATION_CHAIN_DEPTH_KEY]: 1.5 }), 0);
    assert.equal(chainDepthOf({ [AUTOMATION_CHAIN_DEPTH_KEY]: '3' }), 0);
    assert.equal(
      chainDepthOf({ [AUTOMATION_CHAIN_DEPTH_KEY]: 10_000 }),
      AUTOMATION_CHAIN_DEPTH_LIMIT,
    );
  });

  it('increments once per hop, whatever the action', () => {
    const context = {
      ruleId: 'r-1',
      ruleName: 'Chain',
      trigger: 'event:payment.failed',
      triggerData: { metadata: { userId: 'u-1' } },
    };
    const first = chainMetadata(context);
    assert.equal(first[AUTOMATION_CHAIN_DEPTH_KEY], 1);

    const second = chainMetadata({ ...context, triggerData: { metadata: first } });
    assert.equal(second[AUTOMATION_CHAIN_DEPTH_KEY], 2);
  });

  it('carries the rule that emitted it, so a runaway chain is readable', () => {
    const stamped = chainMetadata({
      ruleId: 'r-1',
      ruleName: 'Chain',
      trigger: 'event:x',
      triggerData: {},
    });
    assert.equal(stamped['ruleId'], 'r-1');
    assert.equal(stamped['ruleName'], 'Chain');
    assert.equal(stamped['trigger'], 'event:x');
  });
});

function buildBridge() {
  const enqueued: string[] = [];
  const warnings: string[] = [];
  const prisma = {
    automationRule: {
      findMany: async (args: Record<string, unknown>) => {
        const where = args['where'] as { triggerKind?: AutomationTriggerKind } | undefined;
        return where?.triggerKind === AutomationTriggerKind.REALTIME
          ? [{ id: 'loop', triggerSpec: 'automation.*' }]
          : [];
      },
    },
  };
  const bridge = new AutomationEventBridgeService(
    {} as never,
    prisma as never,
    {
      enqueueExecution: async (input: { ruleId: string }) => {
        enqueued.push(input.ruleId);
      },
    } as never,
  );
  Object.defineProperty(bridge, 'logger', {
    value: {
      warn: (message: string) => warnings.push(message),
      log: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    configurable: true,
  });
  return { bridge, enqueued, warnings };
}

function dispatch(
  bridge: AutomationEventBridgeService,
  metadata: Record<string, unknown>,
): Promise<void> {
  return (
    bridge as unknown as {
      dispatchRealtime: (event: Record<string, unknown>) => Promise<void>;
    }
  ).dispatchRealtime({
    type: 'automation.custom',
    category: 'SYSTEM',
    severity: 'INFO',
    message: 'x',
    metadata,
    timestamp: '2026-09-09T00:00:00.000Z',
  });
}

describe('an event that has already been round the loop', () => {
  it('still fires while it has hops left', async () => {
    // The deliberate case: one rule raises a custom type, a second acts on it.
    // Chaining has to keep working, or the cap is just a ban.
    const { bridge, enqueued } = buildBridge();

    await dispatch(bridge, { [AUTOMATION_CHAIN_DEPTH_KEY]: 1 });

    assert.deepEqual(enqueued, ['loop']);
  });

  it('stops at the limit', async () => {
    const { bridge, enqueued } = buildBridge();

    await dispatch(bridge, { [AUTOMATION_CHAIN_DEPTH_KEY]: AUTOMATION_CHAIN_DEPTH_LIMIT });

    assert.deepEqual(enqueued, [], 'the chain kept running past its limit');
  });

  it('says which event ran out, and why', async () => {
    // A cap that stops in silence turns an infinite loop into a rule that
    // mysteriously stopped working.
    const { bridge, warnings } = buildBridge();

    await dispatch(bridge, { [AUTOMATION_CHAIN_DEPTH_KEY]: AUTOMATION_CHAIN_DEPTH_LIMIT });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /automation\.custom/);
    assert.match(warnings[0], /triggering itself/);
  });

  it('never stops an event that came from the world', async () => {
    const { bridge, enqueued, warnings } = buildBridge();

    await dispatch(bridge, { userId: 'u-1' });

    assert.deepEqual(enqueued, ['loop']);
    assert.deepEqual(warnings, []);
  });
});

describe('a chain that leaves through a delivery queue', () => {
  /**
   * THE HOLE THE COUNTER HAD, AND THE ONLY ONE THAT RAN AWAY.
   *
   * The guard counts hops on the event's own metadata, and that is airtight for
   * as long as the event stays on the bus. It does not: `notify_telegram` —
   * the most ordinary action there is — sends the event through a relay queue,
   * and when the cabinet is unreachable the job exhausts its attempts and emits
   * `reiwa.relay_undelivered`. That event was built from scratch, at depth
   * zero.
   *
   * So the natural rule "tell me on Telegram when the relay breaks" never
   * terminated: each generation of four capped laps queued four more relay
   * jobs, each of which re-seeded the chain at zero about 105 seconds later.
   * `isRelayLoopGuardedEvent` exists for exactly this loop and misses it,
   * because the automation hop launders the event into a different type on the
   * way past.
   *
   * These read the source rather than run the processor: BullMQ's `Job`,
   * Prisma and the bot notifier would all have to be stood up to observe one
   * metadata key. The property is that the count is carried at both ends, and
   * both ends are legible.
   */
  const RELAY = readFileSync(
    join(__dirname, '..', 'src', 'modules', 'notifications', 'reiwa-relay.processor.ts'),
    'utf8',
  );
  const EVENTS = readFileSync(
    join(__dirname, '..', 'src', 'common', 'services', 'system-events.service.ts'),
    'utf8',
  );

  /**
   * The text of one call, from its opening paren to the matching close.
   *
   * These are source scans, and they were scans that did not look at the
   * ARGUMENT — which is exactly where both halves of this were broken and not
   * noticed. `chainDepthMetadata(` as a substring is satisfied by
   * `chainDepthMetadata(metadata)` in a method whose whole point is to pass
   * `sourceMetadata`, and by a dead `void chainDepthMetadata(metadata);`
   * anywhere below the offset a slice started at.
   */
  function callAt(source: string, openParen: number): string {
    let depth = 0;
    for (let index = openParen; index < source.length; index += 1) {
      const character = source[index];
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(openParen, index + 1);
      }
    }
    return source.slice(openParen);
  }

  it('puts the SOURCE event\'s count on the job, not the job\'s own metadata', () => {
    // Both names are in scope at the enqueue. `metadata` there is the relay
    // payload — `eventId`, `text`, `parseMode` — which never carries a depth,
    // so passing it drops the hop count on every relay and the loop guard
    // resets once per generation. That is the runaway this file's header is
    // about, and the previous assertion stopped reading at the open paren.
    const at = EVENTS.indexOf('await queue.enqueue(relayEvent,');
    assert.ok(at >= 0, 'the relay enqueue is gone');
    const call = callAt(EVENTS, EVENTS.indexOf('(', at));

    assert.match(call, /chainDepthMetadata\(\s*sourceMetadata\s*\)/);
  });

  it('spreads it into the event it emits on the way back', () => {
    // Bounded to the method, and asserting the SPREAD rather than the token:
    // a dead `void chainDepthMetadata(metadata);` left anywhere below satisfied
    // the old slice-to-end-of-file check while the emitted event carried no
    // depth at all.
    const start = RELAY.indexOf('private recordUndelivered(');
    assert.ok(start >= 0, 'recordUndelivered is gone');
    const body = RELAY.slice(start, RELAY.indexOf('\n  }', start));

    const emitAt = body.indexOf('this.systemEventsService.warn(');
    assert.ok(emitAt >= 0, 'recordUndelivered no longer emits');
    const emit = callAt(body, body.indexOf('(', emitAt));

    assert.match(emit, /\.\.\.chainDepthMetadata\(\s*metadata\s*\)/);
  });

  it('hands every relay caller the source event to carry it from', () => {
    // Four call sites — two dev, two operator-channel. One of them forgetting
    // is one path on which the guard still resets, and the forgotten one would
    // be the quiet one.
    //
    // Each call is read WHOLE and checked for its own last argument. Counting
    // two independent patterns file-wide, as this did, cannot tell which call
    // is missing it — or notice a fifth call that neither pattern matches.
    const calls: string[] = [];
    for (const match of EVENTS.matchAll(/this\.relaySystemEvent\(/g)) {
      calls.push(callAt(EVENTS, match.index + match[0].length - 1));
    }

    assert.ok(calls.length >= 4, `found ${calls.length} relay calls`);
    const unstamped = calls.filter((call) => !/,\s*event\.metadata\s*\)$/.test(call.trim()));
    assert.deepEqual(
      unstamped.map((call) => call.slice(0, 60)),
      [],
      'a relay call does not pass the source event, so the chain resets through it',
    );
  });

  it('neither increases nor resets the count in transit', () => {
    // A queue hop is not an automation hop: the same chain is travelling, so
    // `chainDepthMetadata` copies while `chainMetadata` adds one. Getting this
    // backwards would cap a legitimate two-rule chain at its first relay.
    assert.deepEqual(chainDepthMetadata({ [AUTOMATION_CHAIN_DEPTH_KEY]: 2 }), {
      [AUTOMATION_CHAIN_DEPTH_KEY]: 2,
    });
    // Nothing to carry stays nothing, so it can be spread unconditionally onto
    // a job for an event that never touched an automation.
    assert.deepEqual(chainDepthMetadata({}), {});
    assert.deepEqual(chainDepthMetadata(undefined), {});
  });
});
