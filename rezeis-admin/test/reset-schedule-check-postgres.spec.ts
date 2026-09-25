import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { EVENT_PRESENTATION } from '../src/common/services/system-events.service';
import { ResetScheduleCheckService } from '../src/modules/add-on-entitlements/services/reset-schedule-check.service';
import { AddOnSwitchesService } from '../src/modules/add-on-entitlements/switches/add-on-switches.service';
import { readResetObservations } from '../src/modules/add-on-entitlements/switches/reset-schedule-check';
import {
  type RemnawaveProfileFacts,
  stampRemnawaveProfileFacts,
} from '../src/modules/remnawave/utils/remnawave-profile-facts.util';
import { removeDurableFixtures } from './helpers/durable-rows-cleanup';

/**
 * THE DAILY RESET-SCHEDULE CHECK, END TO END ON POSTGRESQL
 * ════════════════════════════════════════════════════════
 * The worker's check reads a couple of profiles per strategy (a fake
 * Remnawave here, stamping exactly as the real read does), judges the resets
 * observed in the window against «Часовой пояс Remnawave», and raises one card;
 * the page's view judges the same observations against the zone as stored.
 *
 * Every instant here is in 2031, so no other spec's rows sit in the window the
 * check looks at. Runs only with TEST_DATABASE_URL; listed in ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `s4drift-${process.pid}-${Date.now()}`;

const NOW = new Date('2031-05-10T10:00:00.000Z');
/** Where a Remnawave running at UTC−3 puts its DAY run: 00:05 local. */
const RUN_AT_UTC_MINUS_3 = new Date('2031-05-10T03:05:00.013Z');

let prisma: PrismaService;
const users: string[] = [];

run('the daily reset-schedule check — PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    if (prisma === undefined) return;
    await removeDurableFixtures(prisma, users);
    await prisma.$disconnect();
  });

  async function daySubscription(tag: string, patch: { status?: SubscriptionStatus } = {}): Promise<string> {
    const userId = `${prefix}-${tag}`;
    await prisma.user.create({ data: { id: userId, referralCode: userId, name: userId } });
    users.push(userId);
    const id = `${userId}-sub`;
    await prisma.subscription.create({
      data: {
        id,
        userId,
        status: patch.status ?? SubscriptionStatus.ACTIVE,
        remnawaveId: String(880_000 + users.length),
        planSnapshot: { trafficLimitStrategy: 'DAY' },
      },
    });
    return id;
  }

  it('warns when Remnawave\'s runs land three hours off the configured zone, and clears on the right zone', async () => {
    // The run reset both DAY profiles with its one instant; whichever the check
    // samples, it reads that instant.
    const runA = await daySubscription('run-a');
    const runB = await daySubscription('run-b');
    const manual = await daySubscription('manual');
    await stampRemnawaveProfileFacts(prisma, [runA, runB], { createdAt: null, lastTrafficResetAt: RUN_AT_UTC_MINUS_3 });
    // A manual reset later in the day: any second, says nothing about the schedule.
    await stampRemnawaveProfileFacts(prisma, [manual], {
      createdAt: null,
      lastTrafficResetAt: new Date('2031-05-10T08:41:27.456Z'),
    });

    const reads: string[] = [];
    const cards: Array<{ metadata: Record<string, unknown> }> = [];
    const check = new ResetScheduleCheckService(
      prisma,
      {
        refreshProfileFacts: async (subscriptionId: string) => {
          reads.push(subscriptionId);
          if (subscriptionId !== runA && subscriptionId !== runB) return null;
          const facts: RemnawaveProfileFacts = { createdAt: null, lastTrafficResetAt: RUN_AT_UTC_MINUS_3 };
          await stampRemnawaveProfileFacts(prisma, [subscriptionId], facts);
          return facts;
        },
      } as never,
      {
        warn: (_type: string, _category: string, _message: string, metadata: Record<string, unknown>) => {
          cards.push({ metadata });
        },
      } as never,
    );

    const verdict = await check.runCheck(NOW);

    assert.ok(reads.length > 0, 'live DAY profiles were read');
    assert.equal(verdict.status, 'mismatch');
    assert.equal(verdict.timeZone, 'UTC');
    assert.deepEqual(verdict.mismatches, [
      {
        strategy: 'DAY',
        observedAt: RUN_AT_UTC_MINUS_3.toISOString(),
        expectedAt: '2031-05-10T00:05:00.000Z',
        impliedUtcOffsetMinutes: -180,
      },
    ]);
    assert.equal(cards.length, 1, 'one card per check');
    assert.equal(cards[0]!.metadata['reason'], 'remnawave_reset_schedule_drift');
    assert.match(String(cards[0]!.metadata['why']), /прошёл в 03:05 UTC/);
    assert.match(String(cards[0]!.metadata['why']), /UTC−03:00/);
    assert.match(String(cards[0]!.metadata['nextSteps']), /Часовой пояс Remnawave/);
    const variant = EVENT_PRESENTATION['system.error']!.variants!.find((candidate) => candidate.when(cards[0]!.metadata));
    assert.equal(variant?.title, 'Сбросы трафика в Remnawave расходятся с расписанием');

    // The page, judging the same observations against the zone as stored.
    const pageWith = (zone: string | undefined) =>
      new AddOnSwitchesService(prisma, {
        getStoredAddOnSettings: async () => (zone === undefined ? {} : { remnawaveTimeZone: zone }),
      } as never).view(NOW);
    const asIs = await pageWith(undefined);
    assert.equal(asIs.resetScheduleCheck?.status, 'mismatch');
    assert.equal(asIs.resetScheduleCheck?.mismatches[0]?.observedAt, RUN_AT_UTC_MINUS_3.toISOString());
    const corrected = await pageWith('America/Sao_Paulo');
    assert.equal(corrected.resetScheduleCheck?.status, 'ok', 'the right zone clears the warning at once');
    assert.equal(corrected.resetScheduleCheck?.timeZone, 'America/Sao_Paulo');
  });

  it('reads only live, non-deleted observations of the window, with the strategy the panel pushes', async () => {
    const deleted = await daySubscription('deleted', { status: SubscriptionStatus.DELETED });
    await stampRemnawaveProfileFacts(prisma, [deleted], {
      createdAt: null,
      lastTrafficResetAt: new Date('2031-05-10T06:05:00.010Z'),
    });
    const { observations, resetScoped } = await readResetObservations(prisma, NOW);
    assert.equal(resetScoped, true);
    const mine = observations.filter((row) => row.observedAt.getUTCFullYear() === 2031);
    assert.ok(mine.length >= 2, 'the stamped resets of this file are read');
    assert.ok(mine.every((row) => row.strategy === 'DAY'));
    assert.ok(
      !mine.some((row) => row.observedAt.toISOString() === '2031-05-10T06:05:00.010Z'),
      'a DELETED subscription is no evidence',
    );
    // Outside the window: a day and a half back, and nothing after `now`.
    const later = await readResetObservations(prisma, new Date('2031-05-12T10:00:00.000Z'));
    assert.equal(later.observations.filter((row) => row.observedAt.getUTCFullYear() === 2031).length, 0);
  });

  it('leaves the panel\'s own resets out — a renewal, the operator\'s «Сбросить», «Обнулить трафик» (R3a-03)', async () => {
    const own = { strategy: 'DAY' as const };
    const renewed = await daySubscription('own-renewal');
    const operator = await daySubscription('own-operator');
    const paidReset = await daySubscription('own-paid-reset');
    const remnawaveUi = await daySubscription('remnawave-ui');
    // Each in the shape of a run, a second or so after a whole minute.
    const at = {
      renewed: new Date('2031-05-10T02:20:01.734Z'),
      operator: new Date('2031-05-10T05:35:00.900Z'),
      paidReset: new Date('2031-05-10T06:50:01.100Z'),
      remnawaveUi: new Date('2031-05-10T07:20:00.450Z'),
    };
    for (const [subscriptionId, resetAt] of [
      [renewed, at.renewed],
      [operator, at.operator],
      [paidReset, at.paidReset],
      [remnawaveUi, at.remnawaveUi],
    ] as const) {
      await stampRemnawaveProfileFacts(prisma, [subscriptionId], { createdAt: null, lastTrafficResetAt: resetAt });
    }
    // The records the panel leaves of its own resets.
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: renewed,
        action: 'UPDATE',
        status: 'COMPLETED',
        payload: { source: 'PAYMENT', resetTraffic: true },
        createdAt: new Date(at.renewed.getTime() - 1_700),
        startedAt: new Date(at.renewed.getTime() - 1_200),
        completedAt: new Date(at.renewed.getTime() + 600),
      },
    });
    await prisma.profileSyncJob.create({
      data: {
        subscriptionId: operator,
        action: 'TRAFFIC_RESET',
        status: 'COMPLETED',
        cause: 'OPERATOR_TRAFFIC_RESET',
        payload: { source: 'OPERATOR_TRAFFIC_RESET' },
        createdAt: new Date(at.operator.getTime() + 300),
        startedAt: new Date(at.operator.getTime() + 300),
        completedAt: new Date(at.operator.getTime() + 300),
      },
    });
    await prisma.subscriptionTrafficReset.create({
      data: { subscriptionId: paidReset, performedAt: new Date(at.paidReset.getTime() + 900) },
    });

    const { observations } = await readResetObservations(prisma, NOW);

    const seen = new Set(observations.map((row) => row.observedAt.toISOString()));
    assert.equal(seen.has(at.renewed.toISOString()), false, 'a renewal of ours says nothing about the schedule');
    assert.equal(seen.has(at.operator.toISOString()), false, 'nor the operator\'s «Сбросить»');
    assert.equal(seen.has(at.paidReset.toISOString()), false, 'nor a paid «Обнулить трафик»');
    const ui = observations.find((row) => row.observedAt.toISOString() === at.remnawaveUi.toISOString());
    assert.ok(ui !== undefined, 'a reset the panel has no record of is still read');
    assert.equal(ui.strategy, own.strategy);
    assert.ok((ui.strategyProfiles ?? 0) >= 4, `how many profiles carry the strategy (${ui.strategyProfiles})`);
  });
});
