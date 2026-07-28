import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { SettingsModule } from '../settings/settings.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import {
  AdminTariffConstructorController,
  InternalTariffConstructorController,
} from './tariff-constructor.controller';
import { TariffConstructorService } from './tariff-constructor.service';
import { TariffConstructorCheckoutService } from './tariff-constructor-checkout.service';

@Module({
  imports: [AuthModule, PaymentsModule, SettingsModule, SubscriptionsModule],
  controllers: [AdminTariffConstructorController, InternalTariffConstructorController],
  providers: [TariffConstructorService, TariffConstructorCheckoutService],
  exports: [TariffConstructorService],
})
export class TariffConstructorModule {}
