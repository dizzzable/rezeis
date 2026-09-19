import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';

import {
  AutomationActionRegistry,
  resolveTriggerUserId,
} from '../src/modules/automations/actions/action-registry';
import { HintAudienceService } from '../src/modules/user-hints/services/hint-audience.service';

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

/** A manual run's context: what `runManually` hands the registry. */
const MANUAL_CONTEXT = {
  ruleId: 'rule-1',
  ruleName: 'After a purchase',
  trigger: 'manual:admin-1',
  triggerData: { userId: 'user-9' },
  manual: { adminId: 'admin-1', showAgain: false },
};

interface RegistryOptions {
  /** What `raiseWithOutcome` answers — the show_hint path. Default: queued. */
  readonly outcome?: Record<string, unknown>;
  /** What `raise` answers, per call — the audience loop. Default: a row. */
  readonly raise?: (input: Record<string, unknown>) => Promise<unknown>;
  /** What the audience resolves to. */
  readonly audience?: unknown;
  /** …or what resolving it throws, which a bounded resolve now does on a busy pool. */
  readonly resolveThrows?: unknown;
  /** Run while the audience is being resolved — for spending the mocked clock. */
  readonly onResolve?: () => void;
  /** What `hintStatus` answers. Default: active. */
  readonly hintStatus?: 'missing' | 'inactive' | 'active';
  /** The customer ids `user.findUnique` knows. Default: every id. */
  readonly users?: readonly string[];
}

/**
 * The registry over recording stubs.
 *
 * Every stub RECORDS what it was asked, because several of the cases below
 * are about a call that must not happen — the audience resolved before the
 * hint was checked, a customer looked up on the event path — and a stub that
 * only answers makes "was not asked" and "was asked" the same observation.
 */
function buildRegistry(options: RegistryOptions = {}) {
  const raised: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  const statusAsked: string[] = [];
  const resolved: Array<Record<string, unknown>> = [];
  const userLookups: Array<Record<string, unknown>> = [];
  const registry = new AutomationActionRegistry(
    {} as never,
    {
      user: {
        findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
          userLookups.push(args);
          if (options.users !== undefined && !options.users.includes(args.where.id)) return null;
          // Only what was selected, like the real client.
          return {
            ...(args.select?.id === true ? { id: args.where.id } : {}),
            ...(args.select?.isBlocked === true ? { isBlocked: false } : {}),
          };
        },
        update: async () => ({}),
      },
    } as never,
    { warn: () => undefined } as never,
    { block: async () => ({}) } as never,
    {
      raise: async (input: Record<string, unknown>) => {
        raised.push(input);
        return options.raise !== undefined ? await options.raise(input) : { id: 'del-1' };
      },
      raiseWithOutcome: async (input: Record<string, unknown>) => {
        queued.push(input);
        return options.outcome ?? { kind: 'queued', delivery: { id: 'del-1' } };
      },
      hintStatus: async (hintKey: string) => {
        statusAsked.push(hintKey);
        return options.hintStatus ?? 'active';
      },
    } as never,
    {
      resolve: async (input: Record<string, unknown>) => {
        resolved.push(input);
        options.onResolve?.();
        if (options.resolveThrows !== undefined) throw options.resolveThrows;
        return options.audience ?? { kind: 'ok', userIds: ['u-1', 'u-2'], truncated: false };
      },
    } as never,
    { starsWebhookSecret: null } as never,
  );
  return { registry, raised, queued, statusAsked, resolved, userLookups };
}

/** The keys of a result that names nothing — the shape it had before codes. */
const UNCODED_KEYS = ['index', 'message', 'status', 'type'];

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
    const { registry, queued } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'connect-after-purchase' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.equal(result.code, 'hint_queued');
    assert.deepStrictEqual(result.details, {
      hintKey: 'connect-after-purchase',
      userId: 'user-7',
    });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].userId, 'user-7');
    assert.equal(queued[0].hintKey, 'connect-after-purchase');
  });

  it('records which rule queued it', async () => {
    // The delivery row is the only place an operator can later ask "why did
    // this customer see that", so the rule has to be named in it.
    const { registry, queued } = buildRegistry();

    await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x' } } as never,
      CONTEXT as never,
    );

    assert.equal(queued[0].source, 'rule:rule-1');
  });

  it('fails when the event names no customer', async () => {
    // The one failure an operator can act on: they bound a hint to an event
    // that is about the system rather than about a person.
    const { registry, queued } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x' } } as never,
      { ...CONTEXT, triggerData: { type: 'node.offline', metadata: {} } } as never,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'customer_missing');
    assert.equal('details' in result, false, 'customer_missing names no values');
    assert.match(String(result.message), /names a customer/);
    assert.deepStrictEqual(queued, []);
  });

  it('fails the same way on a manual run that named nobody', async () => {
    // What «Запустить сейчас» used to send for every rule: `triggerData: {}`.
    const { registry, queued, userLookups } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x' } } as never,
      { ...MANUAL_CONTEXT, triggerData: {} } as never,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'customer_missing');
    assert.equal('details' in result, false);
    assert.match(String(result.message), /manual run/);
    assert.deepStrictEqual(queued, []);
    assert.deepStrictEqual(userLookups, [], 'looked up a customer nobody named');
  });

  it('fails when no hint was named', async () => {
    const { registry, queued } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: {} } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'hint_key_missing');
    assert.equal('details' in result, false, 'hint_key_missing names no values');
    assert.deepStrictEqual(queued, []);
  });

  it('is SKIPPED, not green, when this customer already has the once-only hint', async () => {
    // THE DEFECT. The queue declining a hint this customer already has was
    // graded `success` with "(inactive, already delivered, or superseded)", so
    // an operator saw green while nothing reached anybody — and could not tell
    // which of three things had happened, one of which never happens at all.
    const { registry } = buildRegistry({ outcome: { kind: 'already_delivered' } });

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'welcome' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'skipped');
    assert.equal(result.code, 'hint_already_delivered');
    assert.deepStrictEqual(result.details, { hintKey: 'welcome', userId: 'user-7' });
  });

  it('is SKIPPED when the hint is switched off', async () => {
    const { registry } = buildRegistry({ outcome: { kind: 'hint_inactive' } });

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'paused' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'skipped');
    assert.equal(result.code, 'hint_inactive');
    assert.deepStrictEqual(result.details, { hintKey: 'paused' });
  });

  it('FAILS when no hint has this key, because that is always a mistake', async () => {
    const { registry } = buildRegistry({ outcome: { kind: 'hint_missing' } });

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'ghost' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'hint_missing');
    assert.deepStrictEqual(result.details, { hintKey: 'ghost' });
  });

  it('on a manual run, FAILS naming the id when no customer has it', async () => {
    // The id comes from the run body. Without the lookup it reached the insert
    // and failed on a foreign key — a message about a constraint, not about a
    // customer who does not exist.
    const { registry, queued, userLookups } = buildRegistry({ users: ['somebody-else'] });

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x' } } as never,
      { ...MANUAL_CONTEXT, triggerData: { userId: 'ghost-7' } } as never,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'customer_not_found');
    assert.deepStrictEqual(result.details, { userId: 'ghost-7' });
    assert.deepStrictEqual(queued, [], 'queued a hint for a customer who does not exist');
    assert.deepStrictEqual(userLookups, [{ where: { id: 'ghost-7' }, select: { id: true } }]);
  });

  it('on a manual run, goes to the customer the request names, over a pinned one', async () => {
    // A pin on the action silently sending the pop-up to somebody other than
    // the customer the operator just chose is the one answer they could not
    // see coming. Only the chosen customer is known here, so a lookup of the
    // pinned one would fail the run as well.
    const { registry, queued, userLookups } = buildRegistry({ users: ['chosen-4'] });

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x', userId: 'pinned-2' } } as never,
      { ...MANUAL_CONTEXT, triggerData: { userId: 'chosen-4' } } as never,
    );

    assert.equal(result.code, 'hint_queued');
    assert.deepStrictEqual(result.details, { hintKey: 'x', userId: 'chosen-4' });
    assert.equal(queued[0]?.userId, 'chosen-4');
    assert.deepStrictEqual(userLookups, [{ where: { id: 'chosen-4' }, select: { id: true } }]);
  });

  it('on a manual run that names nobody, falls back to the pinned customer', async () => {
    const { registry, queued, userLookups } = buildRegistry({ users: ['pinned-2'] });

    const result = await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x', userId: 'pinned-2' } } as never,
      { ...MANUAL_CONTEXT, triggerData: {} } as never,
    );

    assert.equal(result.code, 'hint_queued');
    assert.equal(queued[0]?.userId, 'pinned-2');
    assert.deepStrictEqual(userLookups, [{ where: { id: 'pinned-2' }, select: { id: true } }]);
  });

  it('on an event, still lets a pinned customer win over the payload', async () => {
    // Unchanged on purpose: on an event the pin is the rule's own decision.
    const { registry, queued } = buildRegistry();

    await registry.execute(
      0,
      { type: 'show_hint', params: { hintKey: 'x', userId: 'pinned-2' } } as never,
      { ...CONTEXT, triggerData: { ...EVENT_PAYLOAD, userId: 'top-level-5' } } as never,
    );

    assert.equal(queued[0]?.userId, 'pinned-2');
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
    // Codes belong to the two pop-up actions. Every other action keeps the
    // result shape it always had, so no reader meets a half-named result.
    assert.deepStrictEqual(Object.keys(result).sort(), UNCODED_KEYS);
  });

  it('keeps a pinned customer on a manual run — only the pop-up follows the request', async () => {
    const blocked: Array<{ userId: string }> = [];
    const registry = new AutomationActionRegistry(
      {} as never,
      { user: { findUnique: async () => ({ isBlocked: false }), update: async () => ({}) } } as never,
      { warn: () => undefined } as never,
      {
        block: async (input: { userId: string }) => {
          blocked.push(input);
          return { identitiesCaptured: 0, devicesCaptured: 0, subscriptionsQueued: 0 };
        },
      } as never,
      {} as never,
      {} as never,
      { starsWebhookSecret: null } as never,
    );

    const result = await registry.execute(
      0,
      { type: 'block_user', params: { userId: 'pinned-2' } } as never,
      { ...MANUAL_CONTEXT, triggerData: { userId: 'chosen-4' } } as never,
    );

    assert.equal(result.status, 'success');
    assert.deepStrictEqual(blocked.map((entry) => entry.userId), ['pinned-2']);
  });
});

describe('the scheduled audience action', () => {
  const AUDIENCE_ACTION = {
    type: 'show_hint_to_audience',
    params: { hintKey: 'connect', audience: 'paid-not-connected' },
  };

  it('queues the hint for everybody the query named', async () => {
    const { registry, raised } = buildRegistry();

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'success');
    assert.equal(result.code, 'audience_queued');
    assert.deepStrictEqual(result.details, {
      hintKey: 'connect',
      audience: 'paid-not-connected',
      queued: 2,
      matched: 2,
      capped: false,
    });
    assert.equal(raised.length, 2);
    assert.equal(raised[0].source, 'audience:paid-not-connected');
  });

  it('names every number apart, so none can stand in for another', async () => {
    // Three matched, two queued, and the run hit the cap — three different
    // values, so a detail that copies its neighbour cannot pass.
    const { registry } = buildRegistry({
      audience: { kind: 'ok', userIds: ['u-1', 'u-2', 'u-3'], truncated: true },
      raise: async (input) => (input.userId === 'u-2' ? null : { id: `del-${String(input.userId)}` }),
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.code, 'audience_queued');
    assert.deepStrictEqual(result.details, {
      hintKey: 'connect',
      audience: 'paid-not-connected',
      queued: 2,
      matched: 3,
      capped: true,
    });
    assert.match(String(result.message), /2 of 3 matched \(capped\)/);
  });

  it('reports both numbers, because they differ for an ordinary reason', async () => {
    // The hint is once-only, so a daily rule matches the same people again and
    // queues nothing for them. "matched 2, queued 0" is a rule working exactly
    // as intended, and an operator needs to be able to see that.
    const { registry } = buildRegistry({ raise: async () => null });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.match(String(result.message), /0 of 2/);
    assert.equal(result.details?.queued, 0);
    assert.equal(result.details?.matched, 2);
  });

  it('stands down as a SUCCESS when the signal is blind', async () => {
    // Deliberately not a failure. A failed execution invites a retry, and a
    // retry cannot fix a missing webhook; the message is what tells the
    // operator what to fix.
    const { registry, raised } = buildRegistry({
      audience: { kind: 'blind', reason: 'no account has a first-traffic timestamp' },
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'success');
    assert.equal(result.code, 'audience_blind');
    // `cause` is what the panel words; the reason stays for the log.
    assert.deepStrictEqual(result.details, {
      reason: 'no account has a first-traffic timestamp',
      cause: 'signal_blind',
    });
    assert.match(String(result.message), /stood down/);
    assert.deepStrictEqual(raised, [], 'and above all: it hinted nobody');
  });

  it('stands down as the same SUCCESS on webhooks alone — through the real audience service', async () => {
    // `webhooks_only`: a read made before the customer connected stays
    // "verified not connected" until a webhook that may never come. The
    // audience answers `blind`, and the run is the green stand-down the panel
    // words from `cause` — whose copy is true of both states.
    const audiences = new HintAudienceService({
      health: async () => ({ state: 'webhooks_only' }),
      userIds: async () => assert.fail('the audience was resolved on webhooks alone'),
    } as never);
    const outcome = await audiences.resolve({ audience: 'paid-not-connected', now: new Date('2026-09-19T12:00:00.000Z') });
    const { registry, raised } = buildRegistry({ audience: outcome });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'success');
    assert.equal(result.code, 'audience_blind');
    assert.equal(result.details?.cause, 'signal_blind');
    assert.match(String(result.details?.reason), /webhooks alone do not say it/);
    assert.deepStrictEqual(raised, []);
  });

  it('FAILS, naming the cause, when the audience is too large for a pop-up', async () => {
    // Unlike a blind signal, the operator has something to do here — narrow
    // the window or send a broadcast — so the run is red.
    const reason = 'more than 20000 people are verified as not connected — too many for a pop-up';
    const { registry, raised } = buildRegistry({
      audience: { kind: 'refused', cause: 'too_large', reason, limit: 20_000 },
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'audience_blind');
    assert.deepStrictEqual(result.details, {
      audience: 'paid-not-connected',
      cause: 'too_large',
      reason,
      limit: 20_000,
    });
    assert.match(String(result.message), /hinted nobody/);
    assert.deepStrictEqual(raised, []);
  });

  it('FAILS, naming the cause, when the database stopped the cohort at its timeout', async () => {
    const reason = 'working out the audience took longer than 10s and the database stopped it';
    const { registry, raised } = buildRegistry({
      audience: { kind: 'refused', cause: 'timeout', reason, limit: null },
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'audience_blind');
    assert.deepStrictEqual(result.details, {
      audience: 'paid-not-connected',
      cause: 'timeout',
      reason,
      limit: null,
    });
    assert.deepStrictEqual(raised, []);
  });

  it('runs each of the two new audiences, asking the service for exactly that one', async () => {
    for (const audience of ['purchase-not-connected', 'trial-not-connected']) {
      const { registry, raised, resolved } = buildRegistry();

      const result = await registry.execute(
        0,
        { type: 'show_hint_to_audience', params: { hintKey: 'connect', audience } } as never,
        CRON_CONTEXT as never,
      );

      assert.equal(result.status, 'success', audience);
      assert.equal(result.code, 'audience_queued', audience);
      assert.equal(resolved[0]?.audience, audience);
      assert.equal(raised[0]?.source, `audience:${audience}`);
    }
  });

  it('refuses an audience nobody defined, with a message and no code', async () => {
    const { registry, raised } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint_to_audience', params: { hintKey: 'x', audience: 'everybody' } } as never,
      CRON_CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.deepStrictEqual(Object.keys(result).sort(), UNCODED_KEYS);
    assert.deepStrictEqual(raised, []);
  });

  it('refuses a backwards window with a message and no code', async () => {
    const { registry, raised } = buildRegistry({
      audience: {
        kind: 'blind',
        reason: 'the window is empty: afterHours (72) must be less than beforeHours (24)',
      },
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'failed');
    assert.deepStrictEqual(Object.keys(result).sort(), UNCODED_KEYS);
    assert.match(String(result.message), /window is empty/);
    assert.deepStrictEqual(raised, []);
  });

  it('says so when nobody matched', async () => {
    const { registry } = buildRegistry({ audience: { kind: 'ok', userIds: [], truncated: false } });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'success');
    assert.equal(result.code, 'audience_empty');
    assert.deepStrictEqual(result.details, { audience: 'paid-not-connected' });
    assert.match(String(result.message), /nobody matched/);
  });

  it('keeps going past a customer whose raise throws, and fails the run with the counts', async () => {
    // One customer deleted after the audience was resolved used to end the run
    // right there: the counts were thrown away, and everybody after that
    // customer went without the hint.
    const { registry, raised } = buildRegistry({
      audience: { kind: 'ok', userIds: ['u-1', 'u-2', 'u-3'], truncated: false },
      raise: async (input) => {
        if (input.userId === 'u-2') {
          throw new Error('Foreign key constraint violated: `user_hint_deliveries_user_id_fkey`');
        }
        return { id: `del-${String(input.userId)}` };
      },
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'audience_partial');
    assert.deepStrictEqual(result.details, {
      hintKey: 'connect',
      audience: 'paid-not-connected',
      matched: 3,
      queued: 2,
      failed: 1,
      notAttempted: 0,
      stoppedEarly: false,
      stoppedBy: null,
      capped: false,
    });
    assert.deepStrictEqual(raised.map((input) => input.userId), ['u-1', 'u-2', 'u-3']);
    assert.match(String(result.message), /1 could not be queued/);
    // THE DRIVER’S OWN SENTENCE STAYS OUT of a 200 body, the operator’s screen
    // and `automation_executions.error_message` — the one path the safe
    // exception filter never sees. It names hosts, ports and constraints.
    assert.doesNotMatch(
      String(result.message),
      /Foreign key|constraint|fkey|user_hint_deliveries/i,
      `the driver sentence reached the operator: ${String(result.message)}`,
    );
    assert.equal(
      Object.values(result.details ?? {}).some((value) => typeof value === 'string' && /constraint/i.test(value)),
      false,
    );
  });

  it('stops after three failed raises in a row, and counts the customers it never tried', async () => {
    // Three in a row are the database, not three customers. Grinding on would
    // make every remaining customer wait out the raise's connection budget to
    // fail the same way.
    const { registry, raised } = buildRegistry({
      audience: { kind: 'ok', userIds: ['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6'], truncated: true },
      raise: async (input) => {
        if (['u-2', 'u-3', 'u-4'].includes(String(input.userId))) {
          throw new Error('Transaction API error: Unable to start a transaction in the given time.');
        }
        return { id: `del-${String(input.userId)}` };
      },
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'audience_partial');
    assert.deepStrictEqual(result.details, {
      hintKey: 'connect',
      audience: 'paid-not-connected',
      matched: 6,
      queued: 1,
      failed: 3,
      notAttempted: 2,
      stoppedEarly: true,
      stoppedBy: 'failures',
      capped: true,
    });
    assert.deepStrictEqual(
      raised.map((input) => input.userId),
      ['u-1', 'u-2', 'u-3', 'u-4'],
      'went on raising after three failures in a row',
    );
    assert.match(String(result.message), /stopped after 3 failures in a row, leaving 2 not attempted/);
  });

  it('lets a raise that works break a run of failures', async () => {
    // Two failures, a success, two failures, a success: never three in a row.
    const { registry, raised } = buildRegistry({
      audience: { kind: 'ok', userIds: ['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6'], truncated: false },
      raise: async (input) => {
        if (['u-1', 'u-2', 'u-4', 'u-5'].includes(String(input.userId))) throw new Error('connection reset');
        return { id: `del-${String(input.userId)}` };
      },
    });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.code, 'audience_partial');
    assert.deepStrictEqual(result.details, {
      hintKey: 'connect',
      audience: 'paid-not-connected',
      matched: 6,
      queued: 2,
      failed: 4,
      notAttempted: 0,
      stoppedEarly: false,
      stoppedBy: null,
      capped: false,
    });
    assert.equal(raised.length, 6);
  });

  it('fails a run whose audience could not be worked out, without repeating the database', async () => {
    // Bounding the resolve turned a hang into a throw — an improvement that
    // opens a door: an UNNAMED throw becomes the result's `message` verbatim,
    // and that message travels in a 200 body and into
    // `automation_executions.error_message`, neither of which passes through
    // `AdminSafeExceptionFilter`. So the pool sentence stops here.
    const warnings: string[] = [];
    const warn = mock.method(Logger.prototype, 'warn', (...args: unknown[]) => {
      warnings.push(String(args[0]));
    });
    try {
      const { registry, raised } = buildRegistry({
        resolveThrows: new Error(
          'Timed out fetching a new connection from the connection pool (limit: 5)',
        ),
      });

      const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

      assert.equal(result.status, 'failed');
      assert.equal(result.code, undefined, 'named a failure that never attempted anything');
      assert.deepStrictEqual(raised, [], 'raised somebody anyway');
      assert.match(
        String(result.message),
        /could not work out who to hint for audience "paid-not-connected"/,
      );
      assert.doesNotMatch(
        String(result.message),
        /connection pool|Timed out|connection limit/i,
        `the driver sentence reached the operator: ${String(result.message)}`,
      );
      assert.equal(
        warnings.some((line) => line.includes('connection pool') && line.includes('paid-not-connected')),
        true,
        `the reason left no panel log line: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warn.mock.restore();
    }
  });

  it('spends that budget on working out the audience as well as on raising', async () => {
    // Bounding the cohort resolve put a SECOND 30 s wait inside a run. While
    // the clock started at the loop, a resolve that took most of a minute
    // still handed the loop a fresh 60 s: 30 s for the hint-status read plus
    // 30 s resolving plus 60 s of loop is 120 s, which is exactly what the
    // route allows (`LONG_TIMEOUT_PATTERNS`) — so the operator would be
    // answered 408, untranslatably, by the very run this budget exists to end
    // politely with counts.
    mock.timers.enable({ apis: ['Date'] });
    try {
      const { registry, raised } = buildRegistry({
        audience: { kind: 'ok', userIds: ['u-1', 'u-2', 'u-3', 'u-4'], truncated: false },
        // A pool busy enough that the cohort alone took fifty of the sixty.
        onResolve: () => mock.timers.tick(50_000),
        raise: async (input) => {
          mock.timers.tick(6_000);
          return { id: `del-${String(input.userId)}` };
        },
      });

      const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

      // 50 s resolving; the first raise runs from there to 56 s, the second to
      // 62 s, and the check before a third finds the budget already spent.
      assert.equal(result.status, 'failed');
      assert.equal(result.code, 'audience_partial');
      assert.deepStrictEqual(result.details, {
        hintKey: 'connect',
        audience: 'paid-not-connected',
        matched: 4,
        queued: 2,
        failed: 0,
        notAttempted: 2,
        stoppedEarly: true,
        stoppedBy: 'time',
        capped: false,
      });
      assert.deepStrictEqual(
        raised.map((input) => input.userId),
        ['u-1', 'u-2'],
        'the loop took a fresh sixty seconds of its own',
      );
      assert.match(String(result.message), /stopped after 60 seconds, leaving 2 not attempted/);
    } finally {
      mock.timers.reset();
    }
  });

  it('stops on its wall-clock budget even when every raise works', async () => {
    // Nothing fails here, so the failure streak never fires. Each raise takes
    // 25 seconds of the mocked clock — a busy pool handing out connections
    // slowly — and five hundred of those would outlast the 120 s a manual run
    // has while the loop kept queueing behind the operator.
    mock.timers.enable({ apis: ['Date'] });
    try {
      const { registry, raised } = buildRegistry({
        audience: { kind: 'ok', userIds: ['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6'], truncated: false },
        raise: async (input) => {
          mock.timers.tick(25_000);
          return { id: `del-${String(input.userId)}` };
        },
      });

      const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

      assert.equal(result.status, 'failed');
      assert.equal(result.code, 'audience_partial');
      assert.deepStrictEqual(result.details, {
        hintKey: 'connect',
        audience: 'paid-not-connected',
        matched: 6,
        queued: 3,
        failed: 0,
        notAttempted: 3,
        stoppedEarly: true,
        stoppedBy: 'time',
        capped: false,
      });
      assert.deepStrictEqual(
        raised.map((input) => input.userId),
        ['u-1', 'u-2', 'u-3'],
        'went on raising past the budget',
      );
      assert.match(String(result.message), /stopped after 60 seconds, leaving 3 not attempted/);
    } finally {
      mock.timers.reset();
    }
  });

  it('keeps the reason for each failure in the panel log', async () => {
    // The detail the message must not carry still has to exist somewhere an
    // operator with the log can read, with the customer it belongs to.
    const warnings: string[] = [];
    const warn = mock.method(Logger.prototype, 'warn', (...args: unknown[]) => {
      warnings.push(String(args[0]));
    });
    try {
      const { registry } = buildRegistry({
        audience: { kind: 'ok', userIds: ['u-1'], truncated: false },
        raise: async () => { throw new Error('Foreign key constraint violated: `user_hint_deliveries_user_id_fkey`'); },
      });

      await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

      assert.equal(
        warnings.some((line) => line.includes('u-1') && line.includes('Foreign key constraint violated')),
        true,
        `the failure left no line naming the customer and the reason: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warn.mock.restore();
    }
  });

  it('FAILS with hint_key_missing when the action names no hint', async () => {
    const { registry, resolved, statusAsked, raised } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint_to_audience', params: { audience: 'paid-not-connected' } } as never,
      CRON_CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'hint_key_missing');
    assert.equal('details' in result, false, 'hint_key_missing names no values');
    assert.deepStrictEqual(statusAsked, []);
    assert.equal(resolved.length, 0);
    assert.deepStrictEqual(raised, []);
  });

  it('still refuses an event trigger first, even when the hint is missing too', async () => {
    const { registry, statusAsked } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'show_hint_to_audience', params: { audience: 'paid-not-connected' } } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    assert.match(String(result.message), /not on an event trigger/);
    assert.deepStrictEqual(Object.keys(result).sort(), UNCODED_KEYS);
    assert.deepStrictEqual(statusAsked, []);
  });

  it('FAILS on a hint nobody authored, before resolving anybody', async () => {
    // Otherwise the whole cohort is queried and every raise is a no-op, and the
    // run reports "queued 0 of 500" — which reads like a quiet night.
    const { registry, resolved, raised, statusAsked } = buildRegistry({ hintStatus: 'missing' });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'hint_missing');
    assert.deepStrictEqual(result.details, { hintKey: 'connect' });
    assert.deepStrictEqual(statusAsked, ['connect']);
    assert.equal(resolved.length, 0, 'resolved the audience for a hint that does not exist');
    assert.deepStrictEqual(raised, []);
  });

  it('is SKIPPED on a switched-off hint, before resolving anybody', async () => {
    const { registry, resolved, raised, statusAsked } = buildRegistry({ hintStatus: 'inactive' });

    const result = await registry.execute(0, AUDIENCE_ACTION as never, CRON_CONTEXT as never);

    assert.equal(result.status, 'skipped');
    assert.equal(result.code, 'hint_inactive');
    assert.deepStrictEqual(result.details, { hintKey: 'connect' });
    assert.deepStrictEqual(statusAsked, ['connect']);
    assert.equal(resolved.length, 0, 'resolved the audience for a hint that is switched off');
    assert.deepStrictEqual(raised, []);
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
    const statusAsked: string[] = [];
    const registry = new AutomationActionRegistry(
      {} as never,
      { user: { findUnique: async () => ({ isBlocked: false }), update: async () => ({}) } } as never,
      { warn: () => undefined } as never,
      { block: async () => ({}) } as never,
      {
        raise: async () => ({ id: 'del-1' }),
        hintStatus: async (hintKey: string) => {
          statusAsked.push(hintKey);
          return 'active';
        },
      } as never,
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
    // Nor the hint check, which is a read of its own: this guard stays FIRST.
    assert.deepStrictEqual(statusAsked, [], 'read the hint before refusing the event');
    assert.match(String(result.message), /trigger|schedule|event/i);
    // A validation refusal: a message, and no code.
    assert.deepStrictEqual(Object.keys(result).sort(), UNCODED_KEYS);
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
