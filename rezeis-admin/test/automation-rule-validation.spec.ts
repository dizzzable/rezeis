import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutomationTriggerKind } from '@prisma/client';

import { AutomationsService } from '../src/modules/automations/automations.service';
import { UpsertAutomationRuleDto } from '../src/modules/automations/dto/upsert-automation-rule.dto';

/**
 * What a rule is allowed to be at SAVE time.
 *
 * There was no coverage here at all, which is how the gap below survived: the
 * audience action refuses at execution time, and a runtime refusal reads like a
 * closed hole right up until you count what the engine already did before
 * reaching it.
 */

function buildService(created: Array<Record<string, unknown>> = []) {
  const prisma = {
    automationRule: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return {
          id: 'rule-1',
          name: 'r',
          description: null,
          isEnabled: true,
          triggerKind: data.triggerKind,
          triggerSpec: data.triggerSpec,
          conditions: null,
          actions: data.actions,
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
  return {
    service: new AutomationsService(prisma as never, {} as never),
    created,
  };
}

function dto(over: Partial<UpsertAutomationRuleDto>): UpsertAutomationRuleDto {
  return {
    name: 'A rule',
    triggerKind: AutomationTriggerKind.CRON,
    triggerSpec: '0 3 * * *',
    actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'connect' } }],
    ...over,
  } as UpsertAutomationRuleDto;
}

describe('an action that picks its own recipients cannot ride an event', () => {
  it('refuses to SAVE the audience action on a realtime rule', async () => {
    // Refusing at execution time stops the queries but not the cost. By then
    // the engine has enqueued a job, inserted an `automation_executions` row
    // and updated the rule — on EVERY system event, in a table nothing sweeps.
    // The editor defaults a new rule to REALTIME, so this is simply what
    // happens if somebody picks the action and presses save.
    const { service, created } = buildService();

    await assert.rejects(
      () =>
        service.createRule(
          dto({
            triggerKind: AutomationTriggerKind.REALTIME,
            triggerSpec: '*',
          }),
          'admin-1',
        ),
      /picks its own recipients/,
    );
    assert.deepStrictEqual(created, [], 'refused, but the row was written anyway');
  });

  it('allows it on a schedule, which is what it is for', async () => {
    const { service, created } = buildService();
    await service.createRule(dto({}), 'admin-1');
    assert.equal(created.length, 1);
  });

  it('leaves every other action free to run on an event', async () => {
    // The restriction is about this one action's fan-out, not about events.
    // Widening it would break the rules this engine mainly exists to run.
    const { service, created } = buildService();
    await service.createRule(
      dto({
        triggerKind: AutomationTriggerKind.REALTIME,
        triggerSpec: 'payment.completed',
        actions: [{ type: 'show_hint', params: { hintKey: 'connect' } }],
      }),
      'admin-1',
    );
    assert.equal(created.length, 1);
  });

  it('still refuses an action nobody defined', async () => {
    const { service } = buildService();
    await assert.rejects(
      () => service.createRule(dto({ actions: [{ type: 'block_users', params: {} }] }), 'admin-1'),
      /Unknown action type/,
    );
  });
});
