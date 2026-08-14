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
  // ORDER IS LOAD-BEARING — same failure as `plans.module.ts`, same fix.
  // `AdminPromocodesStatsController` is mounted on `admin/promocodes/stats`;
  // `AdminPromocodesController` is mounted on `admin/promocodes` and declares
  // `@Get(':promocodeId')`. Nest registers controllers in this array's order and
  // Express answers from the FIRST route registered for a method, so with the
  // CRUD controller first — as it was until 2026-08-14 — every
  // `GET /api/admin/promocodes/stats` was matched by `:promocodeId` with
  // promocodeId="stats" and answered 404, leaving the SPA's promocode
  // statistics tab (`web/src/features/promocodes/promocodes-stats-tab.tsx`)
  // dead for every operator. The specific path goes FIRST.
  //
  // `test/route-shadowing.spec.ts` enumerates every route in the tree and fails
  // if this order is ever inverted again.
  controllers: [
    AdminPromocodesStatsController,
    AdminPromocodesController,
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
