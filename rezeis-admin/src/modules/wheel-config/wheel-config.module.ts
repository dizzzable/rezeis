import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminWheelConfigController } from './controllers/admin-wheel-config.controller';
import { WheelSectorService } from './services/wheel-sector.service';

/**
 * Building the wheel: sectors, odds and the two switches.
 *
 * Separate from `WheelPrizesModule`, which HANDS OUT what a sector promises
 * — a manual jackpot, a key from a pool. The two are different jobs done by
 * different people: the split here is the same one the permissions make,
 * `wheel:edit` against `wheel:resolve`, so a support operator settling
 * prizes cannot reweight the wheel and whoever tunes the odds need not be
 * able to refuse somebody their prize.
 *
 * Separate from `WheelModule` for the older reason: that one is a leaf,
 * imported wherever the wheel is merely read.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminWheelConfigController],
  providers: [WheelSectorService],
  exports: [WheelSectorService],
})
export class WheelConfigModule {}
