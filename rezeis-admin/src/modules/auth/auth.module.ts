import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { authConfig } from '../../common/config/auth.config';
import { AuthController } from './auth.controller';
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
          expiresIn: authConfiguration.jwtExpiresIn,
        },
      }),
    }),
  ],
  controllers: [AuthController, InternalAdminController],
  providers: [
    AdminAuthService,
    AdminJwtAuthGuard,
    AdminJwtStrategy,
    InternalAdminAuthGuard,
    InternalAdminService,
    PasswordHashService,
  ],
  exports: [AdminJwtAuthGuard, InternalAdminAuthGuard, PasswordHashService],
})
export class AuthModule {}
