import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AddOnEntitlementsModule } from '../../add-on-entitlements/add-on-entitlements.module';
import { AuthModule } from '../../auth/auth.module';
import { ProfileSyncModule } from '../../profile-sync/profile-sync.module';
import { AdminPlanMigrationsController } from './controllers/admin-plan-migrations.controller';
import { PLAN_MIGRATION_QUEUE } from './plan-migration.constants';
import { PlanMigrationMoveService } from './plan-migration-move.service';
import { PlanMigrationProcessor } from './plan-migration.processor';
import { PlanMigrationQueryService } from './plan-migration-query.service';
import { PlanMigrationRunnerService } from './plan-migration-runner.service';

/**
 * Moving subscriptions off a plan before it is deleted (spec 15.09.2026).
 *
 * Imported by `PlansModule` and by nothing else. A module of its own because
 * its dependencies are not the plan catalogue's: the durable-term and
 * projection services (`AddOnEntitlementsModule`, which imports nothing from
 * plans, so there is no cycle), the profile-sync queue, and a BullMQ queue of
 * its own.
 */
@Module({
  imports: [
    AuthModule,
    AddOnEntitlementsModule,
    ProfileSyncModule,
    BullModule.registerQueue({ name: PLAN_MIGRATION_QUEUE }),
  ],
  controllers: [AdminPlanMigrationsController],
  providers: [
    PlanMigrationQueryService,
    PlanMigrationMoveService,
    PlanMigrationRunnerService,
    PlanMigrationProcessor,
  ],
})
export class PlanMigrationsModule {}
