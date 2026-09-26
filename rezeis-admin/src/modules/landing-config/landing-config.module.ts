import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalLandingConfigController } from './controllers/internal-landing-config.controller';

/**
 * LandingConfigModule — RETIRED (0.9.7.71)
 * ────────────────────────────────────────
 * The web landing builder is gone: no admin API, no service, no publish hint.
 * The module stays only to host the one route cabinets up to 0.9.7.53 still
 * read, which now always answers "no landing" (`landing-retired.ts`).
 *
 * `AuthModule` for `InternalAdminAuthGuard` and the `JwtService` it needs.
 * Nothing here touches the database: the landing tables stay, unread.
 */
@Module({
  imports: [AuthModule],
  controllers: [InternalLandingConfigController],
})
export class LandingConfigModule {}
