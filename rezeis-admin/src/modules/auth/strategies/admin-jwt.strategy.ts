import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Prisma } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminJwtPayloadInterface } from '../interfaces/admin-jwt-payload.interface';
import { CurrentAdminInterface } from '../interfaces/current-admin.interface';

const strategyAdminSelect = Prisma.validator<Prisma.AdminUserSelect>()({
  id: true,
  login: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  tokenVersion: true,
  createdAt: true,
  lastLoginAt: true,
  lastLoginIp: true,
});

type StrategyAdminRecord = Prisma.AdminUserGetPayload<{
  select: typeof strategyAdminSelect;
}>;

/**
 * Validates admin bearer tokens and resolves the current admin profile.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  public constructor(
    @Inject(authConfig.KEY)
    authConfiguration: ConfigType<typeof authConfig>,
    private readonly prismaService: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfiguration.jwtSecret,
    });
  }

  /**
   * Ensures the token still matches the current admin record.
   */
  public async validate(
    payload: AdminJwtPayloadInterface,
  ): Promise<CurrentAdminInterface> {
    const adminUser: StrategyAdminRecord | null = await this.prismaService.adminUser.findUnique({
      where: { id: payload.sub },
      select: strategyAdminSelect,
    });
    if (!adminUser) {
      throw new UnauthorizedException('Admin user is not found');
    }
    if (!adminUser.isActive) {
      throw new UnauthorizedException('Admin user is inactive');
    }
    if (adminUser.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Admin token is no longer valid');
    }
    return {
      id: adminUser.id,
      login: adminUser.login,
      email: adminUser.email,
      name: adminUser.name,
      role: adminUser.role,
      isActive: adminUser.isActive,
      tokenVersion: adminUser.tokenVersion,
      createdAt: adminUser.createdAt,
      lastLoginAt: adminUser.lastLoginAt,
      lastLoginIp: adminUser.lastLoginIp,
    };
  }
}
