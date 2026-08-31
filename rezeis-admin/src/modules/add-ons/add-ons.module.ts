import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminAddOnsController } from './controllers/admin-add-ons.controller';
import { AdminAddOnsStatsController } from './controllers/admin-add-ons-stats.controller';
import { InternalAddOnsController } from './controllers/internal-add-ons.controller';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { AddOnEligibilityService } from './services/add-on-eligibility.service';
import { TrafficResetService } from './services/traffic-reset.service';
import { AddOnsService } from './services/add-ons.service';
import { AddOnsStatsService } from './services/add-ons-stats.service';

@Module({
  // `RemnawaveModule` for `PanelUsersClient`, which `TrafficResetService` needs
  // to zero the counter. It is NOT `@Global()`, and the client is injected
  // `@Optional()` — so without this import the service would resolve to
  // `undefined` and every reset would answer "the Remnawave integration is not
  // configured", on an install where it is configured perfectly well. The
  // optionality is there for specs, not to paper over a missing import.
  imports: [AuthModule, RemnawaveModule],
  controllers: [AdminAddOnsController, AdminAddOnsStatsController, InternalAddOnsController],
  providers: [
    AddOnsService,
    AddOnsStatsService,
    AddOnEligibilityService,
    TrafficResetService,
  ],
  exports: [AddOnsService, AddOnEligibilityService, TrafficResetService],
})
export class AddOnsModule {}
