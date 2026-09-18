import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException, ValidationPipe } from '@nestjs/common';

import { AutomationActionRegistry } from '../src/modules/automations/actions/action-registry';
import { AutomationExecutorService } from '../src/modules/automations/automation-executor.service';
import { AutomationsController } from '../src/modules/automations/automations.controller';
import { AutomationsService } from '../src/modules/automations/automations.service';
import { AutomationRuleAccessService } from '../src/modules/automations/services/automation-rule-access.service';

/**
 * «Запустить сейчас», and what a run is graded
 * ═════════════════════════════════════════════
 *
 * An operator applied the ready-made pop-up «Первое появление» and pressed
 * «Запустить сейчас» on its rule. The run failed: the button sent
 * `triggerData: {}`, and a pop-up needs a customer. The other half of the same
 * afternoon was worse — a pop-up the queue declined (switched off, or already
 * delivered to a once-only customer) graded the run SUCCEEDED, so the operator
 * saw green while nothing reached anybody.
 *
 * Everything here runs through the real executor and, where a pop-up is
 * involved, the real action registry. The fakes are the database and the
 * delivery queue, and both RECORD what they were asked: most of these cases
 * are about a call that must or must not happen, and a fake that only answers
 * makes those two the same observation.
 */

interface RuleRow {
  id: string;
  name: string;
  isEnabled: boolean;
  conditions: unknown;
  actions: unknown;
}

interface EngineOptions {
  /** Overrides on the one rule the fake database holds; `null` holds none. */
  readonly rule?: Partial<RuleRow> | null;
  /** What `raiseWithOutcome` answers, per call. Default: queued. */
  readonly outcome?: (input: Record<string, unknown>) => Record<string, unknown>;
  /** The customer ids the fake database knows. */
  readonly users?: readonly string[];
  /** A stand-in registry, for cases about the executor alone. */
  readonly registry?: unknown;
}

const RULE_ID = 'rule-first-appearance';

/** An Express-shaped request, as the route receives it: the caller's address and no headers. */
const REQUEST = { ip: '198.51.100.20', headers: {}, socket: {} } as never;

function buildEngine(options: EngineOptions = {}) {
  const rule: RuleRow | null =
    options.rule === null
      ? null
      : {
          id: RULE_ID,
          name: 'Первое появление',
          isEnabled: true,
          conditions: null,
          actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
          ...options.rule,
        };
  const executions: Array<Record<string, unknown>> = [];
  const ruleUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const userLookups: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  const users = options.users ?? ['user-9'];

  const prisma = {
    automationRule: {
      findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        if (rule === null || args.where.id !== rule.id) return null;
        return args.select === undefined ? rule : { id: rule.id };
      },
    },
    user: {
      findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        userLookups.push(args);
        return users.includes(args.where.id) ? { id: args.where.id } : null;
      },
    },
    // The row «Запустить сейчас» leaves in the admin audit log.
    adminAuditLog: { create: async () => ({}) },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        automationExecution: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            executions.push(data);
            return { id: `execution-${executions.length}`, ...data };
          },
        },
        automationRule: {
          update: async (args: { where: unknown; data: Record<string, unknown> }) => {
            ruleUpdates.push(args);
            return {};
          },
        },
      }),
  };

  const registry =
    options.registry ??
    new AutomationActionRegistry(
      {} as never,
      prisma as never,
      { warn: () => undefined, emit: () => undefined } as never,
      { block: async () => ({}) } as never,
      {
        raiseWithOutcome: async (input: Record<string, unknown>) => {
          queued.push(input);
          return options.outcome !== undefined
            ? options.outcome(input)
            : { kind: 'queued', delivery: { id: `delivery-${queued.length}` } };
        },
      } as never,
      {} as never,
      { starsWebhookSecret: null } as never,
    );
  const executor = new AutomationExecutorService(prisma as never, registry as never);
  const service = new AutomationsService(prisma as never, executor);
  // The real permission check, over an RBAC that grants nothing: a pop-up needs
  // no permission beyond the route's own, so the run below goes through it.
  const access = new AutomationRuleAccessService({ hasPermission: async () => false } as never);
  const controller = new AutomationsController(service, {} as never, access);
  return { executor, controller, executions, ruleUpdates, userLookups, queued };
}

/** A registry that answers the statuses it is given and remembers every context. */
function scriptedRegistry(statuses: ReadonlyArray<'success' | 'failed' | 'skipped'>) {
  const contexts: Array<Record<string, unknown>> = [];
  const registry = {
    execute: async (index: number, action: { type: string }, context: Record<string, unknown>) => {
      contexts.push(context);
      return { index, type: action.type, status: statuses[index], message: `scripted ${statuses[index]}` };
    },
  };
  return { registry, contexts };
}

/** `n` pop-up actions, which is all a scripted registry needs to be handed. */
function actions(n: number): unknown[] {
  return Array.from({ length: n }, (_, index) => ({
    type: 'show_hint',
    params: { hintKey: `hint-${index}` },
  }));
}

/** What the bridge enqueues for `user.registered`: the customer is in `metadata`. */
const EVENT_JOB = {
  ruleId: RULE_ID,
  trigger: 'event:user.registered',
  triggerData: { type: 'user.registered', metadata: { userId: 'user-9' } },
};

describe('what a run is graded', () => {
  it('is SKIPPED, and not counted, when every action stood aside', async () => {
    // THE DEFECT: the once-only pop-up had already been queued for this
    // customer, the action said so, and the run went down as SUCCEEDED.
    const engine = buildEngine({ outcome: () => ({ kind: 'already_delivered' }) });

    const result = await engine.executor.executeJob(EVENT_JOB);

    assert.equal(result.status, 'SKIPPED');
    assert.equal(result.actionResults[0]?.code, 'hint_already_delivered');
    assert.equal(engine.executions[0]?.status, 'SKIPPED');
    assert.equal(engine.ruleUpdates[0]?.data.lastRunStatus, 'SKIPPED');
    assert.equal(
      'runCount' in (engine.ruleUpdates[0]?.data ?? {}),
      false,
      'a run that reached nobody was counted as having fired',
    );
    // Not an error: nothing is wrong that a retry would fix.
    assert.equal(result.errorMessage, null);
  });

  it('is SUCCEEDED, and counted, when one action acted and another stood aside', async () => {
    const { registry } = scriptedRegistry(['success', 'skipped']);
    const engine = buildEngine({ registry, rule: { actions: actions(2) } });

    const result = await engine.executor.executeJob(EVENT_JOB);

    assert.equal(result.status, 'SUCCEEDED');
    assert.deepStrictEqual(engine.ruleUpdates[0]?.data.runCount, { increment: 1 });
  });

  it('is FAILED when any action failed, whatever the rest did', async () => {
    const { registry } = scriptedRegistry(['skipped', 'failed']);
    const engine = buildEngine({ registry, rule: { actions: actions(2) } });

    const result = await engine.executor.executeJob(EVENT_JOB);

    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorMessage, '[show_hint] scripted failed');
    assert.deepStrictEqual(engine.ruleUpdates[0]?.data.runCount, { increment: 1 });
  });

  it('is SUCCEEDED for a rule with no actions, because nothing stood aside', async () => {
    // "Every action was skipped" is vacuously true of none; the contract asks
    // for at least one.
    const { registry } = scriptedRegistry([]);
    const engine = buildEngine({ registry, rule: { actions: [] } });

    const result = await engine.executor.executeJob(EVENT_JOB);

    assert.equal(result.status, 'SUCCEEDED');
  });
});

describe('the switch governs automatic firing only', () => {
  it('runs a switched-off rule when an operator runs it by hand', async () => {
    // A rule made from a template starts switched off. Trying it on one
    // customer first is exactly what an operator should do, and it answered
    // "rule disabled".
    const engine = buildEngine({ rule: { isEnabled: false } });

    const result = await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
    });

    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.errorMessage, null);
    assert.equal(engine.queued.length, 1, 'the pop-up was not queued');
  });

  it('still stands a switched-off rule down when an event fires it', async () => {
    const engine = buildEngine({ rule: { isEnabled: false } });

    const result = await engine.executor.executeJob(EVENT_JOB);

    assert.equal(result.status, 'SKIPPED');
    assert.equal(result.errorMessage, 'rule disabled');
    assert.deepStrictEqual(engine.queued, [], 'a switched-off rule fired on an event');
  });

  it('still lets conditions stop a manual run', async () => {
    const engine = buildEngine({
      rule: { isEnabled: false, conditions: { '==': ['$userId', 'someone-else'] } },
    });

    const result = await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
    });

    assert.equal(result.status, 'SKIPPED');
    assert.equal(result.errorMessage, 'conditions did not match');
    assert.deepStrictEqual(engine.queued, []);
  });

  it('runs a rule saved with `{}` conditions, which the SPA shows as having none', async () => {
    // It was SKIPPED "conditions did not match" on every run, automatic and
    // manual alike, while the map and the run dialog said it had no conditions.
    const automatic = buildEngine({ rule: { conditions: {} } });
    const byHand = buildEngine({ rule: { conditions: {} } });

    const fired = await automatic.executor.executeJob(EVENT_JOB);
    const ran = await byHand.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
    });

    assert.equal(fired.status, 'SUCCEEDED', `an event run answered ${fired.errorMessage ?? ''}`);
    assert.equal(ran.status, 'SUCCEEDED', `a manual run answered ${ran.errorMessage ?? ''}`);
    assert.equal(automatic.queued.length, 1);
    assert.equal(byHand.queued.length, 1);
  });

  it('runs a manual run whose conditions match', async () => {
    // The control for the case above, so "conditions stop it" cannot be
    // passing because manual runs stopped altogether.
    const engine = buildEngine({ rule: { conditions: { '==': ['$userId', 'user-9'] } } });

    const result = await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
    });

    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(engine.queued.length, 1);
  });

  it('still refuses a manual run of a rule that does not exist', async () => {
    const engine = buildEngine({ rule: null });

    await assert.rejects(
      () => engine.executor.runManually({ ruleId: 'nope', adminId: 'admin-1', triggerData: {} }),
      NotFoundException,
    );
    assert.deepStrictEqual(engine.executions, []);
  });

  it('still records nothing for a queued job whose rule was deleted', async () => {
    const engine = buildEngine({ rule: null });

    const result = await engine.executor.executeJob({ ...EVENT_JOB, ruleId: 'deleted' });

    assert.deepStrictEqual(result, {
      executionId: '',
      status: 'SKIPPED',
      actionResults: [],
      errorMessage: 'rule no longer exists',
    });
    assert.deepStrictEqual(engine.executions, []);
  });
});

describe('the manual marker', () => {
  it('is on the context of a manual run, and on no other', async () => {
    const manual = scriptedRegistry(['success']);
    await buildEngine({ registry: manual.registry, rule: { actions: actions(1) } }).executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
      showAgain: true,
    });
    const automatic = scriptedRegistry(['success']);
    await buildEngine({ registry: automatic.registry, rule: { actions: actions(1) } }).executor.executeJob({
      ...EVENT_JOB,
      // A payload shaped to look like the marker. It is a payload.
      triggerData: { ...EVENT_JOB.triggerData, manual: { adminId: 'x', showAgain: true } },
    });

    assert.deepStrictEqual(manual.contexts[0]?.manual, { adminId: 'admin-1', showAgain: true });
    assert.equal('manual' in (automatic.contexts[0] ?? {}), false, 'an automatic run carried the marker');
  });
});

describe('showAgain reaches the queue from a manual run only', () => {
  it('reaches it when the operator asked', async () => {
    const engine = buildEngine();

    await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
      showAgain: true,
    });

    assert.equal(engine.queued[0]?.showAgain, true);
  });

  it('does not when the operator did not ask', async () => {
    const engine = buildEngine();

    await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
    });

    assert.equal(engine.queued[0]?.showAgain, false);
  });

  it('cannot be smuggled into a manual run through triggerData', async () => {
    const engine = buildEngine();

    await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9', showAgain: true },
    });

    assert.equal(engine.queued.length, 1);
    assert.equal(engine.queued[0]?.showAgain, false);
  });

  it('cannot be smuggled into an automatic run through the event payload', async () => {
    // Whoever shapes an event — or `POST /api/internal/events` — shapes this.
    const engine = buildEngine();

    await engine.executor.executeJob({
      ...EVENT_JOB,
      triggerData: { ...EVENT_JOB.triggerData, showAgain: true },
    });

    assert.equal(engine.queued.length, 1);
    assert.equal(engine.queued[0]?.showAgain, false);
  });
});

describe('where a queued pop-up says it came from', () => {
  it('names the rule on an automatic run', async () => {
    const engine = buildEngine();

    await engine.executor.executeJob(EVENT_JOB);

    assert.equal(engine.queued[0]?.source, `rule:${RULE_ID}`);
  });

  it('names the rule and the hand on a manual run', async () => {
    const engine = buildEngine();

    await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'user-9' },
    });

    assert.equal(engine.queued[0]?.source, `rule:${RULE_ID}:manual`);
  });
});

describe('a customer nobody has', () => {
  it('fails a manual run by name, before anything is queued', async () => {
    const engine = buildEngine({ users: ['user-9'] });

    const result = await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: { userId: 'ghost-3' },
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.actionResults[0]?.status, 'failed');
    assert.equal(result.actionResults[0]?.code, 'customer_not_found');
    assert.deepStrictEqual(result.actionResults[0]?.details, { userId: 'ghost-3' });
    assert.deepStrictEqual(engine.queued, []);
    assert.deepStrictEqual(engine.userLookups, [{ where: { id: 'ghost-3' }, select: { id: true } }]);
  });

  it('is not looked up on an event, which names a customer the panel just acted on', async () => {
    // The event path gains no query. Even for an id the fake does not know,
    // the pop-up goes straight to the queue — which is what it did before.
    const engine = buildEngine({ users: [] });

    const result = await engine.executor.executeJob(EVENT_JOB);

    assert.deepStrictEqual(engine.userLookups, [], 'the event path looked the customer up');
    assert.equal(engine.queued.length, 1);
    assert.equal(result.actionResults[0]?.code, 'hint_queued');
  });

  it('answers customer_missing to a manual run that named nobody', async () => {
    // What the button used to send.
    const engine = buildEngine();

    const result = await engine.executor.runManually({
      ruleId: RULE_ID,
      adminId: 'admin-1',
      triggerData: {},
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.actionResults[0]?.code, 'customer_missing');
    assert.deepStrictEqual(engine.userLookups, []);
  });
});

describe('POST /admin/automations/rules/:id/run', () => {
  /** The production pipe, byte for byte — see `src/main.ts`. */
  const PRODUCTION_PIPE = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });

  /** The body metatype the route declares — the pipe validates against THIS. */
  function runBodyType(): unknown {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      AutomationsController.prototype,
      'runRule',
    ) as unknown[];
    assert.notEqual(paramTypes[1], Object, 'a body typed Object makes the pipe skip the route');
    return paramTypes[1];
  }

  async function throughPipe(body: unknown): Promise<Record<string, unknown>> {
    return (await PRODUCTION_PIPE.transform(body, {
      type: 'body',
      metatype: runBodyType() as never,
    })) as Record<string, unknown>;
  }

  it('accepts showAgain as a boolean, and no showAgain at all', async () => {
    assert.equal((await throughPipe({ triggerData: { userId: 'user-9' }, showAgain: true })).showAgain, true);
    assert.equal((await throughPipe({ showAgain: false })).showAgain, false);
    assert.equal((await throughPipe({ triggerData: { userId: 'user-9' } })).showAgain, undefined);
  });

  it('refuses a showAgain that is not a boolean', async () => {
    // A form-encoded body arrives as strings, and "false" is truthy. (`null`
    // is not in the list: `@IsOptional()` lets it through by design, and it
    // reads as "no" all the way down.)
    for (const showAgain of ['true', 'false', 1, 0, {}]) {
      await assert.rejects(
        () => throughPipe({ triggerData: { userId: 'user-9' }, showAgain }),
        (error: unknown) => {
          const response = (error as { getResponse?: () => unknown }).getResponse?.() as
            | { message?: string[] }
            | undefined;
          assert.ok(
            (response?.message ?? []).some((message) => message.includes('showAgain')),
            `showAgain=${JSON.stringify(showAgain)} was refused for some other reason: ` +
              JSON.stringify(response?.message),
          );
          return true;
        },
        `showAgain=${JSON.stringify(showAgain)} was accepted`,
      );
    }
  });

  it('carries showAgain from the body to the queue', async () => {
    // Body → pipe → controller → service → executor → registry → queue, with
    // nothing in between stubbed out.
    const engine = buildEngine({ rule: { isEnabled: false } });
    const dto = await throughPipe({ triggerData: { userId: 'user-9' }, showAgain: true });

    const response = await engine.controller.runRule(RULE_ID, dto as never, { id: 'admin-1' } as never, REQUEST);

    assert.equal(response.status, 'SUCCEEDED');
    assert.equal(response.actionResults[0]?.code, 'hint_queued');
    assert.deepStrictEqual(response.actionResults[0]?.details, {
      hintKey: 'tpl-welcome',
      userId: 'user-9',
    });
    assert.equal(engine.queued.length, 1);
    assert.equal(engine.queued[0]?.showAgain, true, 'showAgain was lost on the way down');
    assert.equal(engine.queued[0]?.source, `rule:${RULE_ID}:manual`);
    assert.equal(engine.executions[0]?.trigger, 'manual:admin-1');
  });

  it('leaves showAgain off when the body does not set it', async () => {
    const engine = buildEngine();
    const dto = await throughPipe({ triggerData: { userId: 'user-9', showAgain: true } });

    await engine.controller.runRule(RULE_ID, dto as never, { id: 'admin-1' } as never, REQUEST);

    assert.equal(engine.queued[0]?.showAgain, false);
  });
});
