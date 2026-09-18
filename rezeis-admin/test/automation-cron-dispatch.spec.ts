import 'reflect-metadata';

import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { AutomationTriggerKind } from '@prisma/client';
import * as cronParser4 from 'cron-parser';

import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';
import {
  AutomationEventBridgeService,
  InvalidCronSpecError,
  loadCronParser,
  nextCronFire,
} from '../src/modules/automations/automation-event-bridge.service';
import { AutomationQueueService, type AutomationJobData } from '../src/modules/automations/automation-queue.service';
import { AUTOMATION_QUEUE } from '../src/modules/automations/automations.constants';
import { AutomationsService } from '../src/modules/automations/automations.service';
import { UpsertAutomationRuleDto } from '../src/modules/automations/dto/upsert-automation-rule.dto';
import { OfflineBullMqQueue } from './helpers/bullmq-offline-queue';

/**
 * WHAT MAY STOP A SCHEDULED RULE WITHOUT A WORD
 * ═════════════════════════════════════════════
 * One thing: a spec cron-parser refuses. The dispatcher's minute tick used to
 * hold the parse AND the enqueue in one `catch {}` labelled "invalid cron spec",
 * so two other failures were silent too, and both are real:
 *
 *   - cron-parser 5, which BullMQ 6 depends on, has no `parseExpression`. The
 *     panel imported cron-parser without declaring it, so upgrading BullMQ would
 *     have switched off EVERY scheduled automation with no line in the log;
 *   - a job Redis refused, or did not take in time: the rule was due, did not
 *     run, and nothing said so.
 *
 * And the editor, which the dispatcher's comment trusted to refuse bad specs on
 * save, refused only what cron-parser words as "Invalid cron expression" — a
 * spec with too many fields. `61 * * * *`, `0 25 * * *`, `abc` were saved and
 * never ran.
 *
 * Everything here runs the real parts: cron-parser 4.9.0 itself, the real
 * `AutomationQueueService` over a queue with BullMQ's own admission check, and
 * a Prisma double that answers `where` and `select` rather than ignoring them.
 */

interface RuleRow {
  readonly id: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly isEnabled: boolean;
  readonly triggerSpec: string;
}

interface LogLine {
  readonly level: 'log' | 'warn' | 'error' | 'debug' | 'verbose';
  readonly message: string;
}

function capture(target: object, logs: LogLine[]): void {
  // The logger is private and readonly; what it says is half of every fix
  // here, so it is observed rather than assumed.
  const at = (level: LogLine['level']) => (message: string) => logs.push({ level, message });
  Object.defineProperty(target, 'logger', {
    value: { log: at('log'), warn: at('warn'), error: at('error'), debug: at('debug'), verbose: at('verbose') },
    configurable: true,
  });
}

/** `automationRule.findMany`, answering `where` by equality and `select` by field, as Prisma does. */
function findManyOver(rows: readonly RuleRow[]) {
  return async (args: { where: Record<string, unknown>; select: Record<string, boolean> }) =>
    rows
      .filter((row) =>
        Object.entries(args.where).every(([field, wanted]) => {
          assert.ok(field in row, `the double cannot answer where.${field}`);
          return (row as unknown as Record<string, unknown>)[field] === wanted;
        }),
      )
      .map((row) =>
        Object.fromEntries(
          Object.entries(args.select)
            .filter(([, picked]) => picked)
            .map(([field]) => [field, (row as unknown as Record<string, unknown>)[field]]),
        ),
      );
}

function buildDispatcher(rows: readonly RuleRow[]) {
  const queue = new OfflineBullMqQueue<AutomationJobData>(AUTOMATION_QUEUE);
  const logs: LogLine[] = [];
  const bridge = new AutomationEventBridgeService(
    {} as never,
    { automationRule: { findMany: findManyOver(rows) } } as never,
    new AutomationQueueService(queue.asQueue()),
  );
  capture(bridge, logs);
  return {
    bridge,
    queue,
    logs,
    /** Rule ids of the jobs BullMQ admitted, in order. */
    ran: () => queue.admitted.map((job) => job.data.ruleId),
    said: (level: LogLine['level']) => logs.filter((line) => line.level === level).map((line) => line.message),
  };
}

const cron = (id: string, triggerSpec: string, isEnabled = true): RuleRow => ({
  id,
  triggerKind: AutomationTriggerKind.CRON,
  isEnabled,
  triggerSpec,
});

/**
 * cron-parser 5's module, by the names its `src/index.ts` exports:
 * `CronExpressionParser` (also the default), `CronFileParser`,
 * `CronExpression`, `CronDate`, `CronFieldCollection`. What it does not export
 * is the point: `parseExpression`.
 */
function cronParser5(): Record<string, unknown> {
  const notCalledHere = (): never => {
    throw new Error('the cron-parser 5 API is not what the panel calls');
  };
  const CronExpressionParser = { parse: notCalledHere };
  return {
    __esModule: true,
    default: CronExpressionParser,
    CronExpressionParser,
    CronFileParser: { parseFile: notCalledHere, parseFileSync: notCalledHere },
    CronExpression: class CronExpression {},
    CronDate: class CronDate {},
    CronFieldCollection: class CronFieldCollection {},
  };
}

/** Runs `body` with `require('cron-parser')` answering `exports`, as if that were installed. */
async function withCronParserInstalled(exports: unknown, body: () => Promise<void>): Promise<void> {
  const path = require.resolve('cron-parser');
  const installed = require.cache[path];
  const replacement = new Module(path);
  replacement.filename = path;
  replacement.loaded = true;
  replacement.exports = exports;
  require.cache[path] = replacement;
  try {
    await body();
  } finally {
    if (installed === undefined) delete require.cache[path];
    else require.cache[path] = installed;
  }
}

const savedRole = process.env.RUID_PROCESS_ROLE;

beforeEach(() => {
  // The tick runs where schedules run: a worker.
  process.env.RUID_PROCESS_ROLE = 'worker';
  _resetProcessRoleCacheForTests();
});

afterEach(() => {
  if (savedRole === undefined) delete process.env.RUID_PROCESS_ROLE;
  else process.env.RUID_PROCESS_ROLE = savedRole;
  _resetProcessRoleCacheForTests();
});

describe('the CRON dispatcher', () => {
  it('runs every rule that is due, and skips a spec cron-parser refuses, naming it once', async () => {
    const { bridge, ran, said } = buildDispatcher([
      cron('every-minute', '* * * * *'),
      cron('minute-61', '61 * * * *'),
      cron('also-every-minute', '*/1 * * * *'),
      cron('switched-off', '* * * * *', false),
      { id: 'an-event-rule', triggerKind: AutomationTriggerKind.REALTIME, isEnabled: true, triggerSpec: 'payment.*' },
    ]);

    await bridge.tickCronRules();
    await bridge.tickCronRules();

    assert.deepStrictEqual(
      ran(),
      ['every-minute', 'also-every-minute', 'every-minute', 'also-every-minute'],
      'a refused spec skips its own rule, not the rules after it',
    );
    const warnings = said('warn');
    assert.equal(warnings.length, 1, `said once per process, not every minute: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0] ?? '', /minute-61/);
    assert.match(warnings[0] ?? '', /Constraint error, got value 61 expected range 0-59/);
    assert.deepStrictEqual(said('error'), [], 'a refused spec is the one failure that is not an error');
  });

  it('says which rule did not run when the queue refuses its job', async () => {
    const { bridge, queue, ran, said } = buildDispatcher([cron('nightly-digest', '* * * * *'), cron('cleanup', '* * * * *')]);
    queue.goDown();

    await bridge.tickCronRules();

    assert.deepStrictEqual(ran(), []);
    const errors = said('error');
    assert.equal(errors.length, 2, `one line per rule that did not run: ${JSON.stringify(errors)}`);
    assert.match(errors[0] ?? '', /CRON rule nightly-digest was due at \S+ and was not queued, so it did not run/);
    assert.match(errors[0] ?? '', /Connection is closed/, 'with the reason BullMQ gave');
    assert.match(errors[1] ?? '', /CRON rule cleanup /);
  });

  it('says every rule it stopped when the installed cron-parser has no parseExpression', async () => {
    const { bridge, ran, said } = buildDispatcher([cron('nightly-digest', '0 3 * * *'), cron('every-minute', '* * * * *')]);

    await withCronParserInstalled(cronParser5(), () => bridge.tickCronRules());

    assert.deepStrictEqual(ran(), [], 'nothing can be evaluated');
    const errors = said('error');
    assert.equal(errors.length, 1, JSON.stringify(said('error')));
    assert.match(errors[0] ?? '', /No CRON rule ran this minute \(nightly-digest, every-minute\)/);
    assert.match(errors[0] ?? '', /has no parseExpression/);
    assert.deepStrictEqual(said('warn'), [], 'not mistaken for two invalid specs');
  });

  it('reports a cron-parser failure that is not about the spec, instead of skipping the rule as invalid', async () => {
    // cron-parser 4's own module, with a regression inside `parseExpression`:
    // the kind of throw a changed library produces — a TypeError, not the plain
    // `Error` cron-parser uses for a faulty expression.
    const { bridge, ran, said } = buildDispatcher([cron('every-minute', '* * * * *')]);
    const regressed = {
      ...cronParser4,
      parseExpression: (): never => {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      },
    };

    await withCronParserInstalled(regressed, () => bridge.tickCronRules());

    assert.deepStrictEqual(ran(), []);
    assert.deepStrictEqual(said('warn'), [], 'not read as the operator’s mistake');
    const errors = said('error');
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0] ?? '', /CRON rule every-minute \("\* \* \* \* \*"\) could not be evaluated and did not run: Cannot read properties/);
  });
});

describe('reading a spec', () => {
  it('answers with cron-parser 4.9.0’s next fire, counting one due at the very instant', () => {
    const parser = loadCronParser();
    const minute = new Date('2026-09-18T10:07:00.000Z');
    assert.equal(nextCronFire(parser, '* * * * *', minute).toISOString(), '2026-09-18T10:07:00.000Z');
    assert.equal(nextCronFire(parser, '0 3 * * *', minute).toISOString(), '2026-09-19T03:00:00.000Z');
    assert.equal(nextCronFire(parser, '@weekly', minute).toISOString(), '2026-09-20T00:00:00.000Z');
  });

  it('calls a spec invalid exactly when cron-parser refuses the spec', () => {
    const parser = loadCronParser();
    const minute = new Date('2026-09-18T10:07:00.000Z');
    for (const [spec, reason] of [
      ['61 * * * *', 'Constraint error, got value 61 expected range 0-59'],
      ['0 25 * * *', 'Constraint error, got value 25 expected range 0-23'],
      ['abc', 'Validation error, cannot resolve alias "abc"'],
      ['L * * * *', 'Invalid characters, got value: L'],
      ['0 0 31 2 *', 'Invalid explicit day of month definition'],
      ['*/0 * * * *', 'Constraint error, cannot repeat at every 0 time.'],
      ['* * * * * * *', 'Invalid cron expression'],
    ] as const) {
      assert.throws(
        () => nextCronFire(parser, spec, minute),
        (err: unknown) => err instanceof InvalidCronSpecError && err.message === reason,
        spec,
      );
    }
  });
});

describe('the rule editor', () => {
  function buildEditor() {
    const saved: Array<Record<string, unknown>> = [];
    const logs: LogLine[] = [];
    const prisma = {
      automationRule: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          saved.push(data);
          return {
            id: `rule-${saved.length}`,
            name: data.name,
            description: null,
            isEnabled: true,
            triggerKind: data.triggerKind,
            triggerSpec: data.triggerSpec,
            conditions: null,
            actions: data.actions,
            createdById: null,
            runCount: 0,
            lastRunAt: null,
            lastRunStatus: null,
            lastRunMessage: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
    };
    const service = new AutomationsService(prisma as never, {} as never);
    capture(service, logs);
    const save = (triggerSpec: string) =>
      service.createRule(
        {
          name: 'Nightly',
          triggerKind: AutomationTriggerKind.CRON,
          triggerSpec,
          actions: [{ type: 'webhook_post', params: { url: 'https://example.com/hook' } }],
        } as UpsertAutomationRuleDto,
        'admin-1',
      );
    return { save, saved, logs };
  }

  it('refuses every spec cron-parser refuses, not only one with too many fields', async () => {
    const { save, saved } = buildEditor();
    for (const spec of ['61 * * * *', '0 25 * * *', 'abc', 'L * * * *', '0 0 31 2 *', '* * * * * * *']) {
      await assert.rejects(
        () => save(spec),
        (err: unknown) =>
          err instanceof BadRequestException && err.message.startsWith(`Invalid cron expression: ${spec} (`),
        spec,
      );
    }
    assert.deepStrictEqual(saved, [], 'refused, but written anyway');
  });

  it('saves a spec the dispatcher can run', async () => {
    const { save, saved, logs } = buildEditor();
    for (const spec of ['0 3 * * *', '*/5 * * * *', '@daily', '0 9 * * 1-5']) await save(spec);
    assert.deepStrictEqual(
      saved.map((row) => row.triggerSpec),
      ['0 3 * * *', '*/5 * * * *', '@daily', '0 9 * * 1-5'],
    );
    assert.deepStrictEqual(logs, []);
  });

  it('still saves when cron-parser cannot be used, as it always did, but no longer silently', async () => {
    const { save, saved, logs } = buildEditor();

    await withCronParserInstalled(cronParser5(), async () => {
      await save('0 3 * * *');
    });

    assert.equal(saved.length, 1);
    assert.equal(logs.length, 1, JSON.stringify(logs));
    assert.equal(logs[0]?.level, 'error');
    assert.match(logs[0]?.message ?? '', /Could not check the cron expression "0 3 \* \* \*": .*has no parseExpression/);
  });
});
