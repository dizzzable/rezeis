import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutomationExecutorService } from '../src/modules/automations/automation-executor.service';
import { AutomationsService } from '../src/modules/automations/automations.service';

/**
 * Only a LIST of actions runs
 * ═══════════════════════════
 *
 * `actions` is a JSON column. A config import writes a plain object there as
 * readily as a list — its merge drops a list of objects, and keeps an object —
 * and the executor walked `.length` and indexes. So an object shaped like a list
 * RAN, past every check that reads the column as a list: the permission check
 * on the import, the one on switching a rule on, the one on running it by hand.
 */

const ARRAY_LIKE = { 0: { type: 'block_ip', params: { address: '203.0.113.9' } }, length: 1 };

function build(actions: unknown) {
  const executed: unknown[] = [];
  const executions: Array<Record<string, unknown>> = [];
  const rule = {
    id: 'rule-1',
    name: 'Imported',
    description: null,
    isEnabled: true,
    triggerKind: 'REALTIME',
    triggerSpec: '*',
    conditions: null,
    actions,
    createdById: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    runCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    automationRule: { findUnique: async () => rule },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        automationExecution: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            executions.push(data);
            return { id: 'execution-1', ...data };
          },
        },
        automationRule: { update: async () => ({}) },
      }),
  };
  const registry = {
    execute: async (index: number, action: { type: string }) => {
      executed.push(action);
      return { index, type: action.type, status: 'success' as const };
    },
  };
  const executor = new AutomationExecutorService(prisma as never, registry as never);
  return { executor, service: new AutomationsService(prisma as never, executor), executed, executions };
}

const JOB = { ruleId: 'rule-1', trigger: 'event:payment.failed', triggerData: {} };

describe('an actions column that is not a list', () => {
  it('runs none of it, and fails the run so that it is seen', async () => {
    const { executor, executed, executions } = build(ARRAY_LIKE);

    const result = await executor.executeJob(JOB);

    assert.deepStrictEqual(executed, [], 'an object shaped like a list was executed');
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorMessage, "the rule's actions are not a list, so none of them ran");
    assert.equal(executions.length, 1);
  });

  it('reads back as no actions, so the editor can still open the rule', async () => {
    const { service } = build(ARRAY_LIKE);
    assert.deepStrictEqual((await service.getRule('rule-1')).actions, []);
  });

  it('still runs a list (control)', async () => {
    const { executor, executed } = build([{ type: 'notify_telegram', params: {} }]);

    const result = await executor.executeJob(JOB);

    assert.equal(executed.length, 1);
    assert.equal(result.status, 'SUCCEEDED');
  });
});
