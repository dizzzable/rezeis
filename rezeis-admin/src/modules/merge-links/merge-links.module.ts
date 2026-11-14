import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PlansModule } from '../plans/plans.module';
import { AdminPlanBundlesController } from './controllers/admin-plan-bundles.controller';
import { InternalMergeLinksController } from './controllers/internal-merge-links.controller';
import { MergeLinksService } from './services/merge-links.service';
import { PlanBundlesService } from './services/plan-bundles.service';

/**
 * Plan groupings and the merged links they produce.
 *
 * `MergeLinksService` is exported because `InternalUserModule` is what tells the
 * cabinet which URL a card should offer — the grouping itself knows nothing
 * about who holds which subscription.
 *
 * `PlansModule` supplies `BundleFacePlanService`: the grouping owns a real
 * `Plan` row (the plan it is issued as), and that row is written by the same
 * service the plan editor uses, so both writers cannot grow different ideas of
 * what a bundle's face plan contains.
 */
@Module({
  imports: [AuthModule, PlansModule],
  controllers: [AdminPlanBundlesController, InternalMergeLinksController],
  providers: [PlanBundlesService, MergeLinksService],
  // `PlanBundlesService` is exported for the user card's grant: an operator
  // hands out a merged subscription by naming the bundle.
  exports: [MergeLinksService, PlanBundlesService],
})
export class MergeLinksModule {}
