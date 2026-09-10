import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutomationTriggerKind } from '@prisma/client';

import { AutomationEventBridgeService } from '../src/modules/automations/automation-event-bridge.service';
import { AUTOMATION_RULES_PER_EVENT_LIMIT } from '../src/modules/automations/automations.constants';

/**
 * THE CAP IS ON RULES THAT MATCH, NOT ON ROWS THAT WERE LOADED.
 *
 * `AUTOMATION_RULES_PER_EVENT_LIMIT` was a `take` on the query that fetches
 * enabled realtime rules. Applied before the pattern filter and with no
 * `orderBy`, it meant an install with more than 64 enabled realtime rules had
 * the database return an arbitrary 64 and every rule outside that slice stopped
 * firing — for events it matched perfectly.
 *
 * Nothing about that was visible. A rule the pattern filter never sees produces
 * no execution row, no error and no log line; it reads "enabled" in the
 * operator's list indefinitely. And the slice was not stable, because the
 * executor writes to `automation_rules` on every run and a rewritten tuple can
 * move in the heap — so which rules were dead reshuffled as other rules fired.
 *
 * A pop-up template library and a trigger map are exactly what push an install
 * past sixty-four rules, which is why this is pinned before either is built.
 */

interface Enqueued {
  readonly ruleId: string;
}

function buildBridge(rules: ReadonlyArray<{ id: string; triggerSpec: string; enabled?: boolean }>) {
  const enqueued: Enqueued[] = [];
  const warnings: string[] = [];
  let lastFindManyArgs: Record<string, unknown> | null = null;

  const prisma = {
    automationRule: {
      findMany: async (args: Record<string, unknown>) => {
        lastFindManyArgs = args;
        const where = args['where'] as { triggerKind?: AutomationTriggerKind } | undefined;
        if (where?.triggerKind !== AutomationTriggerKind.REALTIME) return [];
        // The fake honours `take` so a reintroduced one is visible here rather
        // than merely absent from the arguments.
        const rows = rules
          .filter((rule) => rule.enabled !== false)
          .map((rule) => ({ id: rule.id, triggerSpec: rule.triggerSpec }));
        const take = args['take'];
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      },
    },
  };

  const bridge = new AutomationEventBridgeService(
    {} as never,
    prisma as never,
    {
      enqueueExecution: async (input: { ruleId: string }) => {
        enqueued.push({ ruleId: input.ruleId });
      },
    } as never,
  );

  // The logger is private and readonly; the warning is half the fix, so it is
  // observed rather than assumed.
  Object.defineProperty(bridge, 'logger', {
    value: {
      warn: (message: string) => warnings.push(message),
      log: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    configurable: true,
  });

  return { bridge, enqueued, warnings, findManyArgs: () => lastFindManyArgs };
}

function dispatch(bridge: AutomationEventBridgeService, type: string): Promise<void> {
  return (
    bridge as unknown as {
      dispatchRealtime: (event: Record<string, unknown>) => Promise<void>;
    }
  ).dispatchRealtime({
    type,
    category: 'PAYMENT',
    severity: 'INFO',
    message: 'x',
    metadata: { userId: 'u-1' },
    timestamp: '2026-09-09T00:00:00.000Z',
  });
}

/** More rules than the cap, all but one of them wanting a DIFFERENT event. */
function crowd(total: number, matching: number) {
  return Array.from({ length: total }, (_, index) => ({
    id: `rule-${index}`,
    triggerSpec: index < matching ? 'payment.failed' : `unrelated.event_${index}`,
  }));
}

describe('an install with more enabled rules than the cap', () => {
  it('still fires the one rule that matches', async () => {
    // THE DEFECT, in one case. 200 enabled rules, one of them bound to this
    // event and created last. Under a `take` it is outside the loaded slice and
    // never runs; the operator sees a rule that is enabled and has never fired.
    const rules = [
      ...Array.from({ length: 200 }, (_, index) => ({
        id: `noise-${index}`,
        triggerSpec: `unrelated.event_${index}`,
      })),
      { id: 'the-one', triggerSpec: 'payment.failed' },
    ];
    const { bridge, enqueued } = buildBridge(rules);

    await dispatch(bridge, 'payment.failed');

    assert.deepEqual(
      enqueued.map((job) => job.ruleId),
      ['the-one'],
    );
  });

  it('loads without a take, so the filter sees every rule', async () => {
    const { bridge, findManyArgs } = buildBridge(crowd(10, 1));

    await dispatch(bridge, 'payment.failed');

    const args = findManyArgs();
    assert.ok(args, 'the rules were never queried');
    assert.equal(args['take'], undefined, 'a take would truncate before the pattern filter');
  });

  it('reads the rules in a TOTAL order', async () => {
    // If the cap is ever reached, the same rules have to win each time, or the
    // symptom is intermittent — the harder bug to see, and the one this cap
    // exists to replace.
    //
    // `createdAt` alone does not give that. The column is `Timestamptz(3)`, so
    // rules saved in the same millisecond — applying a template library of
    // eight does exactly that — tie, and Postgres promises nothing about the
    // order of tied rows. The `id` key is what makes the order total.
    const { bridge, findManyArgs } = buildBridge(crowd(10, 1));

    await dispatch(bridge, 'payment.failed');

    assert.deepEqual(findManyArgs()?.['orderBy'], [{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('when more rules match one event than the cap allows', () => {
  const OVER = AUTOMATION_RULES_PER_EVENT_LIMIT + 5;

  it('runs exactly the cap', async () => {
    const { bridge, enqueued } = buildBridge(crowd(OVER, OVER));

    await dispatch(bridge, 'payment.failed');

    assert.equal(enqueued.length, AUTOMATION_RULES_PER_EVENT_LIMIT);
  });

  it('says so, with the number and the event', async () => {
    // The whole point. A cap that truncates in silence is indistinguishable
    // from a rule that was never written.
    const { bridge, warnings } = buildBridge(crowd(OVER, OVER));

    await dispatch(bridge, 'payment.failed');

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /payment\.failed/);
    assert.match(warnings[0], new RegExp(String(OVER)));
    assert.match(warnings[0], /5/);
  });

  it('names the rules that lost, not just how many', async () => {
    // A skipped rule produces no execution row and goes on reading "enabled" in
    // the operator's list, so this log line is the only place it is named at
    // all. An operator told "skipping 5" and not WHICH five has learned nothing
    // they can act on.
    const { bridge, warnings } = buildBridge(crowd(OVER, OVER));

    await dispatch(bridge, 'payment.failed');

    assert.match(warnings[0], /Skipped: /);
    // The last rule by creation order is certainly over the cap.
    assert.ok(
      warnings[0].includes(`rule-${OVER - 1}`),
      `the warning does not name the skipped rules: ${warnings[0]}`,
    );
  });

  it('says nothing when the cap is not reached', async () => {
    const { bridge, warnings } = buildBridge(crowd(10, 3));

    await dispatch(bridge, 'payment.failed');

    assert.deepEqual(warnings, []);
  });
});

describe('the pattern filter itself', () => {
  it('matches a namespace wildcard, which a template map will lean on', async () => {
    const { bridge, enqueued } = buildBridge([
      { id: 'wild', triggerSpec: 'remnawave.user.*' },
      { id: 'exact', triggerSpec: 'remnawave.user.expire_soon' },
      { id: 'other', triggerSpec: 'payment.*' },
    ]);

    await dispatch(bridge, 'remnawave.user.expire_soon');

    assert.deepEqual(enqueued.map((job) => job.ruleId).sort(), ['exact', 'wild']);
  });
});
