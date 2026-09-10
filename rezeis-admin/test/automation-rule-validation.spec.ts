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


describe('a pop-up bound to an event that cannot carry one', () => {
  /**
   * THE QUIETEST FAILURE THIS SUBSYSTEM HAS.
   *
   * A rule whose trigger names an event nothing emits is never selected by the
   * pattern filter. Not refused — never seen. There is no execution row, no
   * error and no log line, and the rule reads "enabled" in the operator's list
   * for ever. Four of the eight ready-made pop-ups shipped in that state, and
   * the only symptom available to anybody was that customers never mentioned
   * seeing them.
   *
   * Save time is the only place this can be said, and these cases are what
   * makes it get said.
   */
  const popup = (triggerSpec: string) =>
    dto({
      triggerKind: AutomationTriggerKind.REALTIME,
      triggerSpec,
      actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
    });

  it('refuses a type that is declared and emitted from nowhere', async () => {
    const { service, created } = buildService();

    await assert.rejects(
      () => service.createRule(popup('subscription.expired'), 'admin-1'),
      /cannot show a pop-up/,
    );
    assert.deepStrictEqual(created, []);
  });

  it('refuses a name that is not an event type at all', async () => {
    // `user.expire_soon` is a KEY of Remnawave's own webhook map. The panel
    // forwards it as `remnawave.user.expire_soon`, so a rule bound to the raw
    // name matches nothing, for ever. Two shipped templates carried it.
    const { service } = buildService();

    await assert.rejects(
      () => service.createRule(popup('user.expire_soon'), 'admin-1'),
      /cannot show a pop-up/,
    );
  });

  it('refuses a pop-up on a schedule, which names nobody', async () => {
    // THE OTHER DOOR TO THE SAME MISTAKE. The check above was gated on
    // REALTIME, and the action picker offers "show a hint" for every trigger
    // kind — so an operator could pick it, switch the trigger to a nightly
    // cron, and save. The cron dispatcher builds `triggerData` as
    // `{ firedAt, spec }`; there is no customer in it and there cannot be,
    // because a schedule is not about anybody. Every 03:00 run then wrote a
    // FAILED execution row.
    const { service, created } = buildService();

    await assert.rejects(
      () =>
        service.createRule(
          dto({
            triggerKind: AutomationTriggerKind.CRON,
            triggerSpec: '0 3 * * *',
            actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
          }),
          'admin-1',
        ),
      /needs somebody to show it to/,
    );
    assert.deepStrictEqual(created, []);
  });

  it('still allows a pop-up on a manual run, where the operator names the person', async () => {
    // Not symmetrical, and deliberately so: a manual run carries the
    // admin-supplied trigger data, and `params.userId` names the target on
    // purpose. That is how an operator sends one pop-up to one customer, and a
    // rule refusing it would take the feature away.
    const { service, created } = buildService();

    await service.createRule(
      dto({
        triggerKind: AutomationTriggerKind.MANUAL,
        triggerSpec: '',
        actions: [{ type: 'show_hint', params: { hintKey: 'tpl-welcome' } }],
      }),
      'admin-1',
    );

    assert.equal(created.length, 1);
  });

  it('names what an operator can use instead', async () => {
    // A refusal an operator cannot act on is a different kind of dead end.
    const { service } = buildService();

    await assert.rejects(
      () => service.createRule(popup('user.expire_soon'), 'admin-1'),
      /remnawave\.user\.expire_soon/,
    );
  });

  it('accepts every event the panel says can carry one', async () => {
    for (const trigger of [
      'user.registered',
      'payment.failed',
      'subscription.trial_granted',
      'remnawave.user.expire_soon',
      'remnawave.user.bandwidth_threshold',
    ]) {
      const { service, created } = buildService();
      await service.createRule(popup(trigger), 'admin-1');
      assert.equal(created.length, 1, `${trigger} was refused`);
    }
  });

  it('accepts a namespace wildcard that covers a capable event', async () => {
    // The runtime matches `ns.*`, and a map will lean on it. The action refuses
    // the events under it that name nobody — loudly, at run time, which is the
    // right place for a choice the operator made on purpose.
    const { service, created } = buildService();

    await service.createRule(popup('remnawave.user.*'), 'admin-1');

    assert.equal(created.length, 1);
  });

  it('leaves rules without a pop-up alone', async () => {
    // The vocabulary stays open for everything else: rules chain by emitting
    // custom types that other rules match on, and that is deliberate.
    const { service, created } = buildService();

    await service.createRule(
      dto({
        triggerKind: AutomationTriggerKind.REALTIME,
        triggerSpec: 'anything.at.all',
        actions: [{ type: 'system_event', params: { type: 'automation.custom' } }],
      }),
      'admin-1',
    );

    assert.equal(created.length, 1);
  });

  it('leaves a scheduled pop-up alone', async () => {
    // A CRON rule carries a cron expression, not an event name, and the
    // audience action is what picks its recipients.
    const { service, created } = buildService();

    await service.createRule(
      dto({
        triggerKind: AutomationTriggerKind.CRON,
        triggerSpec: '0 3 * * *',
        actions: [{ type: 'show_hint_to_audience', params: { hintKey: 'connect' } }],
      }),
      'admin-1',
    );

    assert.equal(created.length, 1);
  });
})
