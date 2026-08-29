import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutomationActionRegistry } from '../src/modules/automations/actions/action-registry';
import { UserBlockService } from '../src/modules/users/services/user-block.service';

/**
 * The one block that nobody is watching
 * ═════════════════════════════════════
 *
 * Three things in this codebase can set `users.isBlocked`. Two are operator
 * screens and were unified onto `UserBlockService`; this one is an automation
 * rule, and it kept writing the column by hand.
 *
 * What the hand-written version did NOT do is the entire ban: no identity
 * capture, so the customer's Telegram id and e-mail were never listed and they
 * could register again in a minute; no device or IP capture; and — the one that
 * matters most — no sync job and no dropped connections, so the panel profile
 * stayed ACTIVE and the established tunnel kept carrying traffic. The processor
 * re-asserts a blocked owner's status only when something enqueues a job for
 * that subscription, and nothing did.
 *
 * Of the three writers this is the one that runs unattended, at three in the
 * morning, which makes it the last place the flag should have been the whole
 * story.
 */

const CONTEXT = {
  ruleId: 'rule-1',
  ruleName: 'Suspicious traffic',
  trigger: 'fraud.signal',
  triggerData: { userId: 'user-7' },
};

function buildRegistry(blockImpl?: UserBlockService['block']) {
  const blockCalls: Array<{ userId: string; adminId: string | null; reason?: string | null }> = [];
  const events: Array<{ message: string; metadata: Record<string, unknown> }> = [];
  const userUpdates: unknown[] = [];

  const userBlockService = {
    block: async (input: { userId: string; adminId: string | null; reason?: string | null }) => {
      blockCalls.push(input);
      if (blockImpl !== undefined) return blockImpl(input as never);
      return {
        identitiesCaptured: 3,
        devicesCaptured: 1,
        subscriptionsQueued: 2,
        devicesUnreadable: false,
        ipListed: null,
        ipRefusedBecause: null,
        connectionsDropped: true,
      } as never;
    },
  } as unknown as UserBlockService;

  const prismaService = {
    // Present so a hand-written `user.update` would still "work" — the test has
    // to be able to observe the bypass, not crash on it.
    user: {
      update: async (args: unknown) => {
        userUpdates.push(args);
        return {};
      },
    },
  } as never;

  const systemEventsService = {
    warn: (_type: string, _entity: string, message: string, metadata: Record<string, unknown>) => {
      events.push({ message, metadata });
    },
  } as never;

  const registry = new AutomationActionRegistry(
    {} as never,
    prismaService,
    systemEventsService,
    userBlockService,
    { raise: async () => null } as never,
    { starsWebhookSecret: null } as never,
  );
  return { registry, blockCalls, events, userUpdates };
}

describe('the automation block runs the same cascade the operator screens run', () => {
  it('hands the user to UserBlockService instead of writing the flag itself', async () => {
    const { registry, blockCalls, userUpdates } = buildRegistry();

    const result = await registry.execute(
      0,
      { type: 'block_user', params: {} } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'success');
    assert.equal(blockCalls.length, 1);
    assert.equal(blockCalls[0].userId, 'user-7');
    // THE assertion. A bare `user.update({ data: { isBlocked: true } })` here is
    // a ban that lists nothing, queues nothing and drops nothing — the customer
    // stays on the VPN and can register again immediately.
    assert.deepStrictEqual(userUpdates, []);
  });

  it('names the rule as the reason, and no admin, because a rule is not a person', async () => {
    const { registry, blockCalls } = buildRegistry();

    await registry.execute(0, { type: 'block_user', params: {} } as never, CONTEXT as never);

    assert.equal(blockCalls[0].adminId, null);
    assert.match(String(blockCalls[0].reason), /Suspicious traffic/);
  });

  it('reports what the cascade actually managed, so a short block is visible', async () => {
    // An unattended block that fell short must be findable in the event stream,
    // not only in a log line nobody is reading at 03:00.
    const { registry, events } = buildRegistry();

    await registry.execute(0, { type: 'block_user', params: {} } as never, CONTEXT as never);

    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.identitiesCaptured, 3);
    assert.equal(events[0].metadata.subscriptionsQueued, 2);
  });

  it('fails the action when the cascade throws, rather than reporting a block that did not happen', async () => {
    const { registry, events } = buildRegistry(async () => {
      throw new Error('panel unreachable');
    });

    const result = await registry.execute(
      0,
      { type: 'block_user', params: {} } as never,
      CONTEXT as never,
    );

    assert.equal(result.status, 'failed');
    // And no "user blocked" event, which an operator would otherwise read as
    // an enforcement that took effect.
    assert.deepStrictEqual(events, []);
  });

  it('takes the user id from the action params when the trigger carries none', async () => {
    const { registry, blockCalls } = buildRegistry();

    await registry.execute(
      0,
      { type: 'block_user', params: { userId: 'user-explicit' } } as never,
      { ...CONTEXT, triggerData: {} } as never,
    );

    assert.equal(blockCalls[0].userId, 'user-explicit');
  });
});
