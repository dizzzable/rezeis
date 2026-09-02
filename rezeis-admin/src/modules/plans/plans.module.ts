import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PointsModule } from '../points/points.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { PlanSnapshotSyncService } from '../subscriptions/services/plan-snapshot-sync.service';
import { AdminPlansController } from './controllers/admin-plans.controller';
import { AdminPlansStatsController } from './controllers/admin-plans-stats.controller';
import { InternalPlanCatalogController } from './controllers/internal-plan-catalog.controller';
import { PlanCatalogService } from './services/plan-catalog.service';
import { PlanSquadPropagationService } from './services/plan-squad-propagation.service';
import { PlansAdminService } from './services/plans-admin.service';
import { PlansAdminValidators } from './services/plans-admin.validators';
import { RetiredPlanSweeperService } from './services/retired-plan-sweeper.service';
import { UnknownSquadAuditService } from './services/unknown-squad-audit.service';
import { PlansStatsService } from './services/plans-stats.service';
import { PricingService } from './services/pricing.service';

@Module({
  // `ProfileSyncModule` supplies the queue a plan squad edit fans out onto —
  // see `PlanSquadPropagationService`.
  // `PointsModule` supplies `PointsCashbackService` to the catalog: the "+N
  // points" a card shows must be computed by the same function that credits
  // after the payment, not by a second implementation beside it.
  imports: [AuthModule, ProfileSyncModule, RemnawaveModule, PointsModule],
  // ORDER IS LOAD-BEARING. `AdminPlansStatsController` is mounted on
  // `admin/plans/stats`; `AdminPlansController` is mounted on `admin/plans` and
  // declares `@Get(':planId')`. Nest registers controllers in this array's
  // order and Express answers from the FIRST route registered for a method, so
  // with `AdminPlansController` first — as it was until 2026-08-14 — every
  // `GET /api/admin/plans/stats` was matched by `:planId` with planId="stats",
  // looked up a plan that cannot exist (ids are cuids) and answered 404. The
  // stats controller was never reached, so the SPA's plan statistics tab
  // (`web/src/features/plans/plans-stats-tab.tsx`) was broken for every
  // operator while both controllers declared exactly the paths they meant to.
  //
  // The specific path therefore goes FIRST. `AdminPlansController` already
  // hoists `@Patch('reorder')` above `:planId` for the identical reason — this
  // is that same rule, applied across a controller boundary where declaration
  // order inside one file cannot reach.
  //
  // Constraining the param instead (`:planId(c[a-z0-9]+)`) is not an option:
  // Express 5 uses path-to-regexp v8, which dropped inline regex and throws on
  // that syntax at boot. `test/route-shadowing.spec.ts` enumerates every route
  // in the tree and fails if this order is ever inverted again.
  controllers: [AdminPlansStatsController, AdminPlansController, InternalPlanCatalogController],
  providers: [
    PricingService,
    PlanCatalogService,
    PlanSquadPropagationService,
    PlansAdminService,
    PlansAdminValidators,
    PlanSnapshotSyncService,
    PlansStatsService,
    RetiredPlanSweeperService,
    UnknownSquadAuditService,
  ],
  // `PlansAdminService` is exported for ONE consumer: the plan-access toggle on
  // the user card (`AdminUserManagementController`), which used to write
  // `Plan.allowedUserIds` itself — untransacted, unvalidated and unaudited,
  // behind the wrong permission. Both writers of that column now live here.
  exports: [PlanCatalogService, PlansAdminService, PricingService, PlanSnapshotSyncService],
})
export class PlansModule {}
