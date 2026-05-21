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
 * signed with the same secret, stored in the `api_tokens` table. Revoking
 * a token = deleting the row. The internal API guard can optionally accept
 * these tokens alongside the static `REZEIS_INTERNAL_API_KEY`.
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
