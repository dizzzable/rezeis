import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { FxRateService } from './fx-rate.service';

/**
 * Reporting exchange rates. Exported so any module that has to express mixed
 * currencies as one number depends on a single converter instead of inventing
 * its own arithmetic.
 */
@Module({
  imports: [HttpModule], // PrismaModule is global
  providers: [FxRateService],
  exports: [FxRateService],
})
export class FxModule {}
