import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { PlansModule } from '../plans/plans.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { InternalUserController } from './controllers/internal-user.controller';
import { InternalUserDevicesController } from './controllers/internal-user-devices.controller';
import { InternalUserService } from './services/internal-user.service';
import { ExactlyOneUserIdentifierValidator } from './validators/exactly-one-user-identifier.validator';

/**
 * Registers the first internal user contract module.
 */
@Module({
  imports: [AuthModule, EmailModule, PlansModule, RemnawaveModule],
  controllers: [InternalUserController, InternalUserDevicesController],
  providers: [InternalUserService, ExactlyOneUserIdentifierValidator],
  exports: [InternalUserService],
})
export class InternalUserModule {}
