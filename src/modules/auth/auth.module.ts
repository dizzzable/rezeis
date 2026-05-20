import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { StringValue } from 'ms';

import { authConfig } from '../../common/config/auth.config';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { InternalAdminController } from './controllers/internal-admin.controller';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from './guards/internal-admin-auth.guard';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { AdminAuthService } from './services/admin-auth.service';
import { InternalAdminService } from './services/internal-admin.service';
import { PasswordHashService } from './services/password-hash.service';

/**
 * Registers baseline authentication artifacts for admin endpoints.
 */
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [authConfig.KEY],
      useFactory: (
        authConfiguration: ConfigType<typeof authConfig>,
      ): JwtModuleOptions => ({
        secret: authConfiguration.jwtSecret,
        signOptions: {
          expiresIn: authConfiguration.jwtExpiresIn as StringValue | number,
        },
      }),
    }),
  ],
  controllers: [AdminAuthController, InternalAdminController],
  providers: [
    AdminAuthService,
    AdminJwtAuthGuard,
    AdminJwtStrategy,
    InternalAdminAuthGuard,
    InternalAdminService,
    PasswordHashService,
  ],
  exports: [
    AdminJwtAuthGuard,
    InternalAdminAuthGuard,
    PasswordHashService,
    AdminAuthService,
    // Re-export JwtModule so consumer modules that use
    // `InternalAdminAuthGuard` (which depends on JwtService) get the
    // dependency without re-registering JWT signing config.
    JwtModule,
  ],
})
export class AuthModule {}
