import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
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
  // `RemnawaveModule` supplies the profile facts an expiry notice prints —
  // the profile name, the used traffic and the bound device count, none of
  // which exist locally. Injected optionally, so a container without it sends
  // the notice with the local facts rather than not sending it.
  imports: [AuthModule, NotificationsModule, PaymentsModule, RemnawaveModule],
  controllers: [AdminAutoRenewController, InternalWorkerController],
  providers: [AutoRenewService, AutoRenewScheduler],
  exports: [AutoRenewService, AutoRenewScheduler],
})
export class AutoRenewModule {}
