import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
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
  rbacRoleId: true,
  mustChangePassword: true,
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
  rbacRoleId: true,
  mustChangePassword: true,
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
  /**
   * Optional 6-digit TOTP code (or 10-char recovery code) supplied with
   * the login form when the admin has 2FA enabled. When 2FA is required
   * but this field is empty, `loginAdmin()` rejects the request with a
   * structured `totp_required` payload so the UI can show the prompt.
   */
  readonly totpCode?: string | null;
  readonly requestMetadata: RequestMetadataInterface;
}

interface LoginAdminResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: string;
  readonly admin: CurrentAdminInterface;
}

/**
 * Soft failure indicating 2FA is required for this account. Thrown as
 * `UnauthorizedException` by `loginAdmin()`; the controller maps it to a
 * `401` with `code: 'totp_required'` so the UI shows the TOTP screen.
 */
export class TotpRequiredError extends Error {
  public constructor() {
    super('totp_required');
  }
}

interface ChangeAdminPasswordInput {
  readonly adminId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly requestMetadata: RequestMetadataInterface;
}

interface ChangeAdminPasswordResult {
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
  /**
   * Lazily-resolved 2FA + login-guard handles. We deliberately keep them
   * out of the constructor signature: `TwoFactorModule` imports
   * `AuthModule` for its guards, so a direct dependency would close the
   * graph (AuthModule --> TwoFactorService --> AuthModule). The
   * `ModuleRef.get(..., { strict: false })` lookup is the same trick
   * used by `SystemEventsService` for the realtime gateway.
   */
  private twoFactorServiceCache: import('../../two-factor/services/two-factor.service').TwoFactorService | null = null;
  private loginGuardServiceCache: import('../../two-factor/services/login-guard.service').LoginGuardService | null = null;
  private securityServicesResolved = false;

  public constructor(
    @Inject(authConfig.KEY)
    private readonly authConfiguration: ConfigType<typeof authConfig>,
    private readonly jwtService: JwtService,
    private readonly passwordHashService: PasswordHashService,
    private readonly prismaService: PrismaService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  private resolveSecurityServices(): {
    readonly twoFactor: import('../../two-factor/services/two-factor.service').TwoFactorService | null;
    readonly loginGuard: import('../../two-factor/services/login-guard.service').LoginGuardService | null;
  } {
    if (this.securityServicesResolved) {
      return { twoFactor: this.twoFactorServiceCache, loginGuard: this.loginGuardServiceCache };
    }
    this.securityServicesResolved = true;
    if (!this.moduleRef) {
      return { twoFactor: null, loginGuard: null };
    }
    try {
      // Dynamic require to avoid bundler picking it up at module load time
      // and creating a circular import. Phase 5: TwoFactorModule imports
      // AuthModule for guards, so we cannot import its providers here
      // statically.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { TwoFactorService } = require('../../two-factor/services/two-factor.service');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LoginGuardService } = require('../../two-factor/services/login-guard.service');
      this.twoFactorServiceCache = this.moduleRef.get(TwoFactorService, { strict: false });
      this.loginGuardServiceCache = this.moduleRef.get(LoginGuardService, { strict: false });
    } catch {
      this.twoFactorServiceCache = null;
      this.loginGuardServiceCache = null;
    }
    return { twoFactor: this.twoFactorServiceCache, loginGuard: this.loginGuardServiceCache };
  }

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

    // Phase 5: rate-limit by (login, ip) before consulting the password
    // store. Returning 401 with `rate_limited` reason masks whether the
    // login exists.
    const security = this.resolveSecurityServices();
    if (security.loginGuard) {
      const rateLimited = await security.loginGuard.isRateLimited(
        input.requestMetadata.remoteAddress ?? '',
        normalizedLogin,
      );
      if (rateLimited) {
        await this.recordAuditLog({
          adminUserId: null,
          action: 'admin.login.failed',
          login: normalizedLogin,
          reason: 'rate_limited',
          requestMetadata: input.requestMetadata,
        });
        throw new UnauthorizedException('Too many login attempts. Try again later.');
      }
    }

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
      if (security.loginGuard) {
        await security.loginGuard.recordAttempt({
          loginNormalized: normalizedLogin,
          ipAddress: input.requestMetadata.remoteAddress ?? '',
          success: false,
          reason: 'admin_not_found',
          userAgent: input.requestMetadata.userAgent,
        });
      }
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
      if (security.loginGuard) {
        await security.loginGuard.recordAttempt({
          loginNormalized: adminUser.loginNormalized,
          ipAddress: input.requestMetadata.remoteAddress ?? '',
          success: false,
          reason: 'invalid_password',
          userAgent: input.requestMetadata.userAgent,
        });
      }
      throw new UnauthorizedException('Invalid login or password');
    }

    // Phase 5: 2FA gate. We re-fetch the totp flag here to keep the
    // primary auth select small. The check is cheap (single column
    // already loaded by the verify-secret path).
    if (security.twoFactor && (await security.twoFactor.isEnabled(adminUser.id))) {
      const code = (input.totpCode ?? '').trim();
      if (code.length === 0) {
        if (security.loginGuard) {
          await security.loginGuard.recordAttempt({
            loginNormalized: adminUser.loginNormalized,
            ipAddress: input.requestMetadata.remoteAddress ?? '',
            success: false,
            reason: 'totp_required',
            userAgent: input.requestMetadata.userAgent,
          });
        }
        // Surface a structured signal: the controller maps this
        // exception's message to a 401 + `code: 'totp_required'`.
        throw new UnauthorizedException('totp_required');
      }
      const totpOk = await security.twoFactor.verifyForLogin(adminUser.id, code);
      if (!totpOk) {
        await this.recordAuditLog({
          adminUserId: adminUser.id,
          action: 'admin.login.failed',
          login: adminUser.loginNormalized,
          email: adminUser.email,
          reason: 'totp_invalid',
          requestMetadata: input.requestMetadata,
        });
        if (security.loginGuard) {
          await security.loginGuard.recordAttempt({
            loginNormalized: adminUser.loginNormalized,
            ipAddress: input.requestMetadata.remoteAddress ?? '',
            success: false,
            reason: 'totp_invalid',
            userAgent: input.requestMetadata.userAgent,
          });
        }
        throw new UnauthorizedException('Invalid verification code');
      }
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
    if (security.loginGuard) {
      await security.loginGuard.recordAttempt({
        loginNormalized: loggedInAdmin.loginNormalized,
        ipAddress: input.requestMetadata.remoteAddress ?? '',
        success: true,
        reason: null,
        userAgent: input.requestMetadata.userAgent,
      });
    }
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

  /**
   * Rotates the admin password. Bumps `tokenVersion` so any outstanding
   * JWT (other browser tabs, leaked tokens) is invalidated, then issues
   * a fresh token tied to the new version.
   *
   * Used by both the regular "change password" UI and the force-password
   * -change screen shown after a temporary password reset.
   */
  public async changePassword(input: ChangeAdminPasswordInput): Promise<ChangeAdminPasswordResult> {
    const adminUser: AdminUserAuthRecord | null = await this.prismaService.adminUser.findUnique({
      where: { id: input.adminId },
      select: adminUserAuthSelect,
    });
    if (!adminUser) {
      throw new UnauthorizedException('Admin not found');
    }
    if (!adminUser.isActive) {
      throw new ForbiddenException('Admin user is inactive');
    }
    const isCurrentValid: boolean = await this.passwordHashService.verifyPassword({
      plainTextPassword: input.currentPassword,
      passwordHash: adminUser.passwordHash,
    });
    if (!isCurrentValid) {
      await this.recordAuditLog({
        adminUserId: adminUser.id,
        action: 'admin.password.change_rejected',
        login: adminUser.loginNormalized,
        email: adminUser.email,
        reason: 'invalid_current_password',
        requestMetadata: input.requestMetadata,
      });
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException('New password must differ from the current one');
    }
    const newPasswordHash: string = await this.passwordHashService.hashPassword({
      plainTextPassword: input.newPassword,
    });
    const updated: AdminUserProfileRecord = await this.prismaService.$transaction(
      async (transactionClient): Promise<AdminUserProfileRecord> => {
        const updatedAdmin = await transactionClient.adminUser.update({
          where: { id: adminUser.id },
          data: {
            passwordHash: newPasswordHash,
            tokenVersion: { increment: 1 },
            mustChangePassword: false,
            passwordChangedAt: new Date(),
          },
          select: adminUserProfileSelect,
        });
        await transactionClient.adminAuditLog.create({
          data: buildAuditLogData({
            adminUserId: updatedAdmin.id,
            action: 'admin.password.changed',
            login: updatedAdmin.loginNormalized,
            email: updatedAdmin.email,
            requestMetadata: input.requestMetadata,
          }),
        });
        return updatedAdmin;
      },
    );
    const accessToken: string = await this.jwtService.signAsync(
      buildAdminJwtPayload(updated),
    );
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.authConfiguration.jwtExpiresIn,
      admin: mapCurrentAdmin(updated),
    };
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
    rbacRoleId: adminUser.rbacRoleId,
  };
}

function buildAuditLogData(input: CreateAuditLogInput): Prisma.AdminAuditLogCreateInput {
  return {
    action: input.action,
    ipAddress: input.requestMetadata.remoteAddress,
    userAgent: input.requestMetadata.userAgent,
    metadata: buildAuditMetadata(input),
    ...(input.adminUserId ? { adminUser: { connect: { id: input.adminUserId } } } : {}),
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
    rbacRoleId: adminUser.rbacRoleId,
    mustChangePassword: adminUser.mustChangePassword,
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
