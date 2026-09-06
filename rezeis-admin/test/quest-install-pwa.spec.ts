import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuestType } from '@prisma/client';

import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import { QuestEventListenerService } from '../src/modules/quests/services/quest-event-listener.service';
import { QuestDetectionReconcilerService } from '../src/modules/quests/services/quest-detection-reconciler.service';
import { EVENT_TYPES } from '../src/common/services/system-events.service';

/**
 * The "install the app" quest.
 *
 * Installation is invisible to a web page on every platform, and on iOS there
 * is no install prompt to hook at all — so nothing the CLIENT can say is worth
 * anything here. What the cabinet does report, once per session, is the
 * surface it is running on, and the server stamps `User.pwaInstalledAt` the
 * first time that surface is an installed app.
 *
 * That stamp is the whole detection. These cases pin the three links in the
 * chain from it to a claimable quest:
 *
 *  1. the conditional write fires the milestone event EXACTLY once,
 *  2. the event completes the quest,
 *  3. the ten-minute reconciler reaches everybody the event could not — the
 *     users who installed before the operator created the quest.
 */

interface Emitted {
  readonly type: string;
  readonly metadata?: Record<string, unknown>;
}

function buildEdge(opts: { stampCount: number }) {
  const events: Emitted[] = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const prisma = {
    user: {
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push({ where: {}, data: args.data });
        return { id: 'u-1' };
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: opts.stampCount };
      },
    },
  };
  const systemEvents = {
    info: (type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
      events.push({ type, metadata });
    },
  };
  const service = new InternalUserEdgeService(
    prisma as never,
    {} as never,
    {} as never,
    systemEvents as never,
    {} as never,
  );
  return { service, events, updates };
}

describe('the first open from an installed app', () => {
  it('raises the milestone event when the stamp actually lands', async () => {
    const { service, events } = buildEdge({ stampCount: 1 });
    await service.recordSurfaceSeen('42', { surface: 'pwa', formFactor: 'mobile', os: 'ios' });

    const milestone = events.filter((e) => e.type === EVENT_TYPES.USER_PWA_INSTALLED);
    assert.equal(milestone.length, 1);
    assert.equal(milestone[0].metadata?.userId, 'u-1');
  });

  it('stays silent on every later open', async () => {
    // THE case. The surface report fires once per cabinet SESSION, so a
    // customer produces one of these a day for years. A count of zero means
    // the column was already set — reading the column back instead of using
    // the write's own count would race the customer's other open tabs.
    const { service, events } = buildEdge({ stampCount: 0 });
    await service.recordSurfaceSeen('42', { surface: 'pwa', formFactor: 'mobile', os: 'ios' });

    assert.equal(events.filter((e) => e.type === EVENT_TYPES.USER_PWA_INSTALLED).length, 0);
  });

  it('does not fire for a browser or a Telegram surface', async () => {
    for (const surface of ['browser', 'tma']) {
      const { service, events, updates } = buildEdge({ stampCount: 1 });
      await service.recordSurfaceSeen('42', { surface, formFactor: 'mobile', os: 'ios' });
      assert.equal(
        events.filter((e) => e.type === EVENT_TYPES.USER_PWA_INSTALLED).length,
        0,
        surface,
      );
      // And nothing attempted the stamp either.
      assert.equal(updates.length, 1, surface);
    }
  });

  it('guards the stamp on the column still being empty', async () => {
    const { service, updates } = buildEdge({ stampCount: 1 });
    await service.recordSurfaceSeen('42', { surface: 'pwa', formFactor: 'mobile', os: 'ios' });
    const stamp = updates[1];
    assert.equal(stamp.where.pwaInstalledAt, null);
    assert.ok(stamp.data.pwaInstalledAt instanceof Date);
  });
});

describe('the quest listener', () => {
  function buildListener() {
    const completed: Array<{ type: QuestType; userId: string }> = [];
    let hook: ((event: unknown) => Promise<void>) | null = null;
    const systemEvents = {
      registerHook: (fn: (event: unknown) => Promise<void>) => {
        hook = fn;
      },
    };
    const progress = {
      markCompleted: async (type: QuestType, userId: string) => {
        completed.push({ type, userId });
      },
      advanceInvite: async () => undefined,
    };
    const service = new QuestEventListenerService(systemEvents as never, progress as never);
    service.onModuleInit();
    return { fire: (event: unknown) => hook!(event), completed };
  }

  it('completes an INSTALL_PWA quest from the milestone event', async () => {
    const { fire, completed } = buildListener();
    await fire({
      type: EVENT_TYPES.USER_PWA_INSTALLED,
      metadata: { userId: 'u-1' },
      timestamp: '2026-09-06T10:00:00.000Z',
    });
    assert.deepEqual(completed, [{ type: QuestType.INSTALL_PWA, userId: 'u-1' }]);
  });

  it('ignores a milestone event carrying no user', async () => {
    const { fire, completed } = buildListener();
    await fire({ type: EVENT_TYPES.USER_PWA_INSTALLED, metadata: {}, timestamp: 'x' });
    assert.equal(completed.length, 0);
  });
});

describe('the catch-up reconciler', () => {
  function buildReconciler(questType: QuestType) {
    const queries: Array<Record<string, unknown>> = [];
    const completed: string[] = [];
    const quest = {
      id: 'q-1',
      type: questType,
      enabled: true,
      startAt: null,
      endAt: null,
      maxCompletionsGlobal: null,
      issuedCount: 0,
    };
    const prisma = {
      quest: { findMany: async () => [quest] },
      user: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          queries.push(args.where);
          return [{ id: 'u-1' }, { id: 'u-2' }];
        },
      },
      referral: { findMany: async () => [] },
    };
    const progress = {
      completeForUser: async (_quest: unknown, userId: string) => {
        completed.push(userId);
      },
      advanceInvite: async () => undefined,
    };
    const service = new QuestDetectionReconcilerService(prisma as never, progress as never);
    return { service, queries, completed };
  }

  it('reaches users who installed before the quest existed', async () => {
    // The event never fired for them — it fires on the FIRST open from the
    // installed app, and theirs was months ago. Without this branch the quest
    // is unearnable for exactly the customers who already did the thing.
    const { service, queries, completed } = buildReconciler(QuestType.INSTALL_PWA);
    await service['backfillQuest'](
      { id: 'q-1', type: QuestType.INSTALL_PWA } as never,
    );
    assert.deepEqual(completed, ['u-1', 'u-2']);
    assert.deepEqual(queries[0].pwaInstalledAt, { not: null });
  });

  it('only looks at users with no completion for that quest yet', async () => {
    const { service, queries } = buildReconciler(QuestType.INSTALL_PWA);
    await service['backfillQuest']({ id: 'q-1', type: QuestType.INSTALL_PWA } as never);
    assert.deepEqual(queries[0].questCompletions, { none: { questId: 'q-1' } });
  });
});
