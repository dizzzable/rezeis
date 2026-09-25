import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Global, Module, type OnModuleDestroy } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PlanSquadPropagationService } from '../src/modules/plans/services/plan-squad-propagation.service';
import { PlansAdminService } from '../src/modules/plans/services/plans-admin.service';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';
import { PlanSnapshotSyncService } from '../src/modules/subscriptions/services/plan-snapshot-sync.service';

/**
 * A STOP WAITS FOR THE RESET-RULE FOLLOW WHILE THE DATABASE IS STILL THERE
 * (review R4).
 *
 * A plan edit that changes «Сброс трафика» commits, then walks the plan's
 * subscribers in the background, each in a short transaction of its own
 * (`PlansAdminService.followResetRuleAfterCommit`). The stop's wait for that
 * walk sat in `onApplicationShutdown`, which Nest runs after EVERY module's
 * `onModuleDestroy` — `PrismaService`'s disconnect among them. It now sits in
 * the service's own `onModuleDestroy`: Nest destroys the plans module before
 * the global one that owns the database, so the step in progress commits, the
 * walk stops between two subscribers, and only then does the database go.
 *
 * The real Nest lifecycle, over a stand-in `PrismaService` in a global module
 * — as `PrismaModule` is — whose step is held open until the stop has begun.
 */

const events: string[] = [];
let releaseStep: () => void = () => undefined;
const stepHeld = new Promise<void>((resolve) => {
  releaseStep = resolve;
});

class DatabaseStandIn implements OnModuleDestroy {
  public readonly settings = { findFirst: async () => null };

  public async $transaction(): Promise<{ termsUpdated: number; syncJobIds: string[] }> {
    events.push('step: begins');
    await stepHeld;
    events.push('step: commits');
    return { termsUpdated: 1, syncJobIds: [] };
  }

  public async onModuleDestroy(): Promise<void> {
    events.push('database: disconnected');
  }
}

@Global()
@Module({ providers: [{ provide: PrismaService, useClass: DatabaseStandIn }], exports: [PrismaService] })
class DatabaseModule {}

@Module({
  providers: [
    PlansAdminService,
    { provide: RemnawaveApiService, useValue: {} },
    { provide: PlanSnapshotSyncService, useValue: {} },
    { provide: PlansAdminValidators, useValue: {} },
    { provide: PlanSquadPropagationService, useValue: {} },
  ],
})
class PlansModuleStandIn {}

describe('PlansAdminService — a stop and the reset-rule follow', () => {
  it('lets the subscriber in progress commit, starts no other, and only then lets the database go', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule, PlansModuleStandIn] }).compile();
    await moduleRef.init();
    const plansAdmin = moduleRef.get(PlansAdminService);

    // What an edit's commit hands over: three subscribers of the term model to follow.
    (plansAdmin as unknown as { followResetRuleAfterCommit(planId: string, snapshots: unknown): void }).followResetRuleAfterCommit(
      'plan-1',
      { updated: 3, strategyChanged: 3, followSubscriptionIds: ['sub-a', 'sub-b', 'sub-c'], syncJobIds: [] },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['step: begins'], 'fixture: the first subscriber\'s step is open');

    // The stop begins while that step is open; the step then commits.
    const closing = moduleRef.close();
    setTimeout(releaseStep, 50);
    await closing;

    assert.deepEqual(events, ['step: begins', 'step: commits', 'database: disconnected']);
  });
});
