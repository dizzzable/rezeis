import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { AdminPromocodesController } from './controllers/admin-promocodes.controller';
import { AdminPromocodesStatsController } from './controllers/admin-promocodes-stats.controller';
import { InternalPromocodesController } from './controllers/internal-promocodes.controller';
import { PromocodeLifecycleService } from './services/promocode-lifecycle.service';
import { PromocodePortalService } from './services/promocode-portal.service';
import { PromocodeRewardsService } from './services/promocode-rewards.service';
import { PromocodeValidationService } from './services/promocode-validation.service';
import { PromocodesStatsService } from './services/promocodes-stats.service';

/**
 * Promocodes module — donor: altshop `src/services/promocode*.py`.
 *
 * The module exposes:
 *  - admin CRUD + activation history under `/admin/promocodes`
 *  - portal-aware activation under `/internal/promocodes` consumed by ruid
 *
 * The four services map 1:1 to the donor breakdown:
 *  - `validation`  — pure validation of code + user context
 *  - `lifecycle`   — CRUD + transactional activation
 *  - `rewards`     — reward application rules
 *  - `portal`      — branching activation contract for the user-facing edge
 */
@Module({
  imports: [AuthModule, ProfileSyncModule],
  controllers: [
    AdminPromocodesController,
    AdminPromocodesStatsController,
    InternalPromocodesController,
  ],
  providers: [
    PromocodeValidationService,
    PromocodeRewardsService,
    PromocodeLifecycleService,
    PromocodePortalService,
    PromocodesStatsService,
  ],
  exports: [
    PromocodeValidationService,
    PromocodeRewardsService,
    PromocodeLifecycleService,
    PromocodePortalService,
  ],
})
export class PromocodesModule {}
