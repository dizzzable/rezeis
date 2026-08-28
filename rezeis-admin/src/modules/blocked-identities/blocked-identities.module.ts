import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminBlockedIdentitiesController } from './controllers/admin-blocked-identities.controller';
import { BlockedIdentityService } from './services/blocked-identity.service';

/**
 * Identity blocklist module.
 *
 * `@Global()` for the same reason `BlockedIpsModule` is: the service is read by
 * enforcement points scattered across registration, sign-in and linking, and
 * threading an import through every one of those modules would make adding the
 * next enforcement point a wiring exercise rather than a one-line check.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AdminBlockedIdentitiesController],
  providers: [BlockedIdentityService],
  exports: [BlockedIdentityService],
})
export class BlockedIdentitiesModule {}
