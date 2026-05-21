import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AutoRenewService } from './auto-renew.service';
import { AutoRenewScheduler } from './auto-renew.scheduler';
import { AdminAutoRenewController } from './controllers/admin-auto-renew.controller';

/**
 * Auto-renewal module — detects expired subscriptions and optionally
 * renews them from partner balance. The scheduler kicks the service every
 * minute; operators can also run a cycle on-demand from the admin panel.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminAutoRenewController],
  providers: [AutoRenewService, AutoRenewScheduler],
  exports: [AutoRenewService, AutoRenewScheduler],
})
export class AutoRenewModule {}
