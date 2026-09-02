import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PointsModule } from '../points/points.module';
import { WheelModule } from '../wheel/wheel.module';
import { WheelPrizesModule } from '../wheel-prizes/wheel-prizes.module';
import { InternalWheelController } from './controllers/internal-wheel.controller';
import { WheelCabinetService } from './services/wheel-cabinet.service';

/**
 * The wheel for the person spinning it, consumed by reiwa.
 *
 * This is the module that composes the two halves the wheel was deliberately
 * split into: `WheelModule` spins (and stays a leaf, so it can be imported
 * anywhere), `WheelPrizesModule` opens the conversation for a prize a human
 * has to hand over. Doing that composition HERE, at the edge, is what let the
 * spin stay free of the support stack.
 */
@Module({
  imports: [AuthModule, PointsModule, WheelModule, WheelPrizesModule],
  controllers: [InternalWheelController],
  providers: [WheelCabinetService],
  exports: [WheelCabinetService],
})
export class WheelCabinetModule {}
