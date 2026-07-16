import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { AutoRenewService } from './auto-renew.service';
import { AutoRenewScheduler } from './auto-renew.scheduler';
import { AdminAutoRenewController } from './controllers/admin-auto-renew.controller';
import { InternalWorkerController } from './controllers/internal-worker.controller';

/**
 * Auto-renewal module — expiry warnings, pre-expiry saved-method charges
 * (T-5m, max 3 attempts), then EXPIRED. Scheduler runs every minute;
 * operators can also trigger a cycle from the admin panel.
 */
@Module({
  imports: [AuthModule, NotificationsModule, PaymentsModule],
  controllers: [AdminAutoRenewController, InternalWorkerController],
  providers: [AutoRenewService, AutoRenewScheduler],
  exports: [AutoRenewService, AutoRenewScheduler],
})
export class AutoRenewModule {}
