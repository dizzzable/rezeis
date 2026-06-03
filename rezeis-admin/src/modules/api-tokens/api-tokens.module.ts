import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';

import { authConfig } from '../../common/config/auth.config';
import { AuthModule } from '../auth/auth.module';
import { AdminApiTokensController } from './controllers/admin-api-tokens.controller';
import { ApiTokensService } from './services/api-tokens.service';

/**
 * API Tokens module — named bearer tokens for external service integration.
 *
 * Mirrors Remnawave panel's "API токены" feature. Each token is a JWT
 * signed with the same secret as admin sessions; only its fingerprint is
 * stored in the `api_tokens` table. Revoking a token = deleting the row.
 * Verification happens in `InternalAdminAuthGuard`, which is the sole guard protecting
 * `/api/internal/...` routes — the previous static-key based guard
 * (`InternalApiGuard` reading `REZEIS_ADMIN_INTERNAL_API_KEY`) has been
 * fully retired.
 */
@Module({
  imports: [
    AuthModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [authConfig.KEY],
      useFactory: (config: ConfigType<typeof authConfig>): JwtModuleOptions => ({
        secret: config.jwtSecret,
      }),
    }),
  ],
  controllers: [AdminApiTokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
