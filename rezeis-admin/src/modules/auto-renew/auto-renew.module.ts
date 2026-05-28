import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutoRenewService } from './auto-renew.service';
import { AutoRenewScheduler } from './auto-renew.scheduler';
import { AdminAutoRenewController } from './controllers/admin-auto-renew.controller';
import { InternalWorkerController } from './controllers/internal-worker.controller';

/**
 * Auto-renewal module — detects expired subscriptions and optionally
 * renews them from partner balance. The scheduler kicks the service every
 * minute; operators can also run a cycle on-demand from the admin panel.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AdminAutoRenewController, InternalWorkerController],
  providers: [AutoRenewService, AutoRenewScheduler],
  exports: [AutoRenewService, AutoRenewScheduler],
})
export class AutoRenewModule {}
