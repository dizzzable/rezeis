import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { SupportTicketsModule } from '../support-tickets/support-tickets.module';
import { AdminWheelKeyPoolsController } from './controllers/admin-wheel-key-pools.controller';
import { AdminWheelPrizesController } from './controllers/admin-wheel-prizes.controller';
import { WheelKeyPoolService } from './services/wheel-key-pool.service';
import { WheelManualPrizeService } from './services/wheel-manual-prize.service';
import { WheelPrizeReconcilerService } from './services/wheel-prize-reconciler.service';

/**
 * Settling the prizes a machine cannot hand over.
 *
 * Kept apart from `WheelModule` on purpose. That module is a leaf because it
 * is imported wherever the wheel is merely READ — the user card, the cabinet
 * controllers, events — and opening a conversation drags the support stack,
 * Auth, notifications and two queues along behind it. This module may be as
 * heavy as it needs to be, because nothing reads the wheel through it.
 */
@Module({
  imports: [AuthModule, RbacModule, SupportTicketsModule],
  controllers: [AdminWheelPrizesController, AdminWheelKeyPoolsController],
  providers: [WheelManualPrizeService, WheelPrizeReconcilerService, WheelKeyPoolService],
  exports: [WheelManualPrizeService, WheelKeyPoolService],
})
export class WheelPrizesModule {}
