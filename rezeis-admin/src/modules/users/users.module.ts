import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalUserModule } from '../internal-user/internal-user.module';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AdminUsersService } from './services/admin-users.service';

/**
 * Registers the first admin users module.
 */
@Module({
  imports: [AuthModule, InternalUserModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class UsersModule {}
