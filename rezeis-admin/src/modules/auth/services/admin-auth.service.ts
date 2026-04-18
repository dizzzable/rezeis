import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserRole } from '@prisma/client';

import { authConfig } from '../../../common/config/auth.config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminJwtPayloadInterface } from '../interfaces/admin-jwt-payload.interface';
import { CurrentAdminInterface } from '../interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../interfaces/request-metadata.interface';
import { loginPolicy } from '../utils/login-policy.util';
import { PasswordHashService } from './password-hash.service';

const adminUserProfileSelect = Prisma.validator<Prisma.AdminUserSelect>()({
  id: true,
  login: true,
  loginNormalized: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  tokenVersion: true,
  createdAt: true,
  lastLoginAt: true,
  lastLoginIp: true,
});

const adminUserAuthSelect = Prisma.validator<Prisma.AdminUserSelect>()({
  id: true,
  login: true,
  loginNormalized: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  tokenVersion: true,
  passwordHash: true,
  createdAt: true,
  lastLoginAt: true,
  lastLoginIp: true,
});

type AdminUserProfileRecord = Prisma.AdminUserGetPayload<{
  select: typeof adminUserProfileSelect;
}>;

type AdminUserAuthRecord = Prisma.AdminUserGetPayload<{
  select: typeof adminUserAuthSelect;
}>;

interface BootstrapFirstAdminInput {
  readonly login: string;
  readonly email?: string;
  readonly password: string;
  readonly name?: string;
  readonly requestMetadata: RequestMetadataInterface;
}

interface LoginAdminInput {
  readonly login: string;
  readonly password: string;
  readonly requestMetadata: RequestMetadataInterface;
}

interface LoginAdminResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: string;
  readonly admin: CurrentAdminInterface;
}

interface CreateAuditLogInput {
  readonly adminUserId: string | null;
  readonly action: string;
  readonly login: string;
  readonly requestMetadata: RequestMetadataInterface;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly reason?: string;
}

/**
 * Implements first-dev-admin bootstrap, login, and current-user auth flows.
 */
@Injectable()
export class AdminAuthService {
  public constructor(
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
    private readonly jwtService: JwtService,
    private readonly passwordHashService: PasswordHashService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Creates the first DEV admin account when the table is still empty.
   */
  public async bootstrapFirstAdmin(input: BootstrapFirstAdminInput): Promise<CurrentAdminInterface> {
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new BadRequestException('admin login is invalid');
    }
    const normalizedLogin: string = loginPolicy.normalizeLogin(input.login);
    const normalizedEmail: string | null = normalizeOptionalEmail(input.email);
    const normalizedName: string | null = normalizeName(input.name);
    const createdAdmin: AdminUserProfileRecord = await this.prismaService.$transaction(
      async (transactionClient): Promise<AdminUserProfileRecord> => {
        const existingAdminsCount: number = await transactionClient.adminUser.count();
        if (existingAdminsCount > 0) {
          throw new ConflictException('Bootstrap DEV admin is already created');
        }
        const passwordHash: string = await this.passwordHashService.hashPassword({
          plainTextPassword: input.password,
        });
        const adminUser: AdminUserProfileRecord = await transactionClient.adminUser.create({
          data: {
            login: loginPolicy.sanitizeLogin(input.login),
            loginNormalized: normalizedLogin,
            email: normalizedEmail,
            passwordHash,
            name: normalizedName,
            role: UserRole.DEV,
          },
          select: adminUserProfileSelect,
        });
        await transactionClient.adminAuditLog.create({
          data: buildAuditLogData({
            adminUserId: adminUser.id,
            action: 'admin.bootstrap',
            login: normalizedLogin,
            email: normalizedEmail,
            name: normalizedName,
            requestMetadata: input.requestMetadata,
          }),
        });
        return adminUser;
      },
    );
    return mapCurrentAdmin(createdAdmin);
  }

  /**
   * Authenticates an admin and issues a JWT access token.
   */
  public async loginAdmin(input: LoginAdminInput): Promise<LoginAdminResult> {
    if (!loginPolicy.isValidLogin(input.login)) {
      throw new UnauthorizedException('Invalid login or password');
    }
    const normalizedLogin: string = loginPolicy.normalizeLogin(input.login);
    const adminUser: AdminUserAuthRecord | null = await this.prismaService.adminUser.findUnique({
      where: { loginNormalized: normalizedLogin },
      select: adminUserAuthSelect,
    });
    if (!adminUser) {
      await this.recordAuditLog({
        adminUserId: null,
        action: 'admin.login.failed',
        login: normalizedLogin,
        reason: 'admin_not_found',
        requestMetadata: input.requestMetadata,
      });
      throw new UnauthorizedException('Invalid login or password');
    }
    if (!adminUser.isActive) {
      await this.recordAuditLog({
        adminUserId: adminUser.id,
        action: 'admin.login.failed',
        login: adminUser.loginNormalized,
        email: adminUser.email,
        reason: 'admin_inactive',
        requestMetadata: input.requestMetadata,
      });
      throw new ForbiddenException('Admin user is inactive');
    }
    const isPasswordValid: boolean = await this.passwordHashService.verifyPassword({
      plainTextPassword: input.password,
      passwordHash: adminUser.passwordHash,
    });
    if (!isPasswordValid) {
      await this.recordAuditLog({
        adminUserId: adminUser.id,
        action: 'admin.login.failed',
        login: adminUser.loginNormalized,
        email: adminUser.email,
        reason: 'invalid_password',
        requestMetadata: input.requestMetadata,
      });
      throw new UnauthorizedException('Invalid login or password');
    }
    const loggedInAdmin: AdminUserProfileRecord = await this.prismaService.$transaction(
      async (transactionClient): Promise<AdminUserProfileRecord> => {
        const updatedAdmin: AdminUserProfileRecord = await transactionClient.adminUser.update({
          where: { id: adminUser.id },
          data: {
            lastLoginAt: new Date(),
            lastLoginIp: input.requestMetadata.remoteAddress,
          },
          select: adminUserProfileSelect,
        });
        await transactionClient.adminAuditLog.create({
          data: buildAuditLogData({
            adminUserId: updatedAdmin.id,
            action: 'admin.login.succeeded',
            login: updatedAdmin.loginNormalized,
            email: updatedAdmin.email,
            requestMetadata: input.requestMetadata,
          }),
        });
        return updatedAdmin;
      },
    );
    const accessToken: string = await this.jwtService.signAsync(
      buildAdminJwtPayload(loggedInAdmin),
    );
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.authConfiguration.jwtExpiresIn,
      admin: mapCurrentAdmin(loggedInAdmin),
    };
  }

  /**
   * Returns the authenticated admin profile.
   */
  public getMe(currentAdmin: CurrentAdminInterface): CurrentAdminInterface {
    return currentAdmin;
  }

  private async recordAuditLog(input: CreateAuditLogInput): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: buildAuditLogData(input),
    });
  }
}

function buildAdminJwtPayload(adminUser: AdminUserProfileRecord): AdminJwtPayloadInterface {
  return {
    sub: adminUser.id,
    login: adminUser.login,
    role: adminUser.role,
    tokenVersion: adminUser.tokenVersion,
  };
}

function buildAuditLogData(input: CreateAuditLogInput): Prisma.AdminAuditLogCreateInput {
  return {
    action: input.action,
    ipAddress: input.requestMetadata.remoteAddress,
    userAgent: input.requestMetadata.userAgent,
    metadata: buildAuditMetadata(input),
    adminUser: input.adminUserId ? { connect: { id: input.adminUserId } } : undefined,
  };
}

function buildAuditMetadata(input: CreateAuditLogInput): Prisma.InputJsonObject {
  const baseMetadata: Prisma.InputJsonObject = {
    login: input.login,
    requestId: input.requestMetadata.requestId,
  };
  const emailMetadata: Prisma.InputJsonObject =
    typeof input.email === 'string' ? { email: input.email } : {};
  const nameMetadata: Prisma.InputJsonObject =
    typeof input.name === 'string' ? { name: input.name } : {};
  const reasonMetadata: Prisma.InputJsonObject =
    typeof input.reason === 'string' ? { reason: input.reason } : {};
  return {
    ...baseMetadata,
    ...emailMetadata,
    ...nameMetadata,
    ...reasonMetadata,
  };
}

function mapCurrentAdmin(adminUser: AdminUserProfileRecord): CurrentAdminInterface {
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

function normalizeOptionalEmail(email?: string): string | null {
  if (typeof email !== 'string') {
    return null;
  }
  const normalizedEmail: string = email.trim().toLowerCase();
  return normalizedEmail.length > 0 ? normalizedEmail : null;
}

function normalizeName(name?: string): string | null {
  if (typeof name !== 'string') {
    return null;
  }
  const normalizedName: string = name.trim();
  return normalizedName.length > 0 ? normalizedName : null;
}
