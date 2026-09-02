import { Module } from '@nestjs/common';

import { PointsModule } from '../points/points.module';
import { RewardGrantService } from './reward-grant.service';

/**
 * The one place a reward is given, shared by everything that gives one.
 *
 * Imported by quests today and by the wheel next. It pulls in `PointsModule`
 * for the wallet and nothing else: the service writes into the transaction its
 * caller hands it, so it needs no Prisma of its own and no stack behind it.
 */
@Module({
  imports: [PointsModule],
  providers: [RewardGrantService],
  exports: [RewardGrantService],
})
export class RewardsModule {}
