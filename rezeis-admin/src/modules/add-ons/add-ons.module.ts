import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminAddOnsController } from './controllers/admin-add-ons.controller';
import { AdminAddOnsStatsController } from './controllers/admin-add-ons-stats.controller';
import { InternalAddOnsController } from './controllers/internal-add-ons.controller';
import { AddOnsService } from './services/add-ons.service';
import { AddOnsStatsService } from './services/add-ons-stats.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminAddOnsController, AdminAddOnsStatsController, InternalAddOnsController],
  providers: [AddOnsService, AddOnsStatsService],
  exports: [AddOnsService],
})
export class AddOnsModule {}
