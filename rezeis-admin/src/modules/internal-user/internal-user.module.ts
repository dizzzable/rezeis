import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { PaymentsModule } from '../payments/payments.module';
import { PlansModule } from '../plans/plans.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SettingsModule } from '../settings/settings.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { InternalUserController } from './controllers/internal-user.controller';
import { InternalUserDevicesController } from './controllers/internal-user-devices.controller';
import { InternalUserPaymentMethodsController } from './controllers/internal-user-payment-methods.controller';
import { InternalUserEdgeService } from './services/internal-user-edge.service';
import { InternalUserService } from './services/internal-user.service';
import { ExactlyOneUserIdentifierValidator } from './validators/exactly-one-user-identifier.validator';

/**
 * Registers the first internal user contract module.
 */
@Module({
  imports: [
    AuthModule,
    EmailModule,
    PaymentsModule,
    PlansModule,
    RemnawaveModule,
    SettingsModule,
    SubscriptionsModule,
  ],
  controllers: [
    InternalUserController,
    InternalUserDevicesController,
    InternalUserPaymentMethodsController,
  ],
  providers: [
    InternalUserService,
    InternalUserEdgeService,
    ExactlyOneUserIdentifierValidator,
  ],
  exports: [InternalUserService, InternalUserEdgeService],
})
export class InternalUserModule {}
