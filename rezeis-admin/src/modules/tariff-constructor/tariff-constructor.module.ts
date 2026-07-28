import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import {
  AdminTariffConstructorController,
  InternalTariffConstructorController,
} from './tariff-constructor.controller';
import { TariffConstructorService } from './tariff-constructor.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminTariffConstructorController, InternalTariffConstructorController],
  providers: [TariffConstructorService],
  exports: [TariffConstructorService],
})
export class TariffConstructorModule {}
