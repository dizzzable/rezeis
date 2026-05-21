/**
 * AdminUserWebController
 * ──────────────────────
 * DEV-only operations against the user's linked `WebAccount`. Carved
 * out of `admin-user-management.controller.ts` so the privileged
 * surface is obvious at the route level.
 *
 * Donor parity: altshop's `WebCabinetAdminService` (subset) — we do
 * NOT implement the cross-Telegram rebind flow because in our model
 * `WebAccount` is 1:1 with a `User`, identified by reiwa-id. There is
 * nothing to "rebind to a different telegramId" in this architecture.
 *
 * Endpoints:
 *   POST  /admin/users/:telegramId/web/reset-password
 *   PATCH /admin/users/:telegramId/web/login
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { Request } from 'express';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { RenameWebLoginDto } from '../dto/rename-web-login.dto';

/** Default lifespan of an admin-issued temporary password. */
const TEMPORARY_PASSWORD_TTL_HOURS = 24;
/** Length of the generated temporary password (alphanumeric, no ambiguous chars). */
const TEMPORARY_PASSWORD_LENGTH = 16;

@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard)
export class AdminUserWebController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly passwordHashService: PasswordHashService,
  ) {}

  /**
   * Issues a temporary password for the user's `WebAccount`. The plain
   * text is returned **once** so the operator can hand it over out of
   * band; we never store it.
   *
   * Side effects:
   *   • `passwordHash`               ← scrypt(temp)
   *   • `requiresPasswordChange`     ← true
   *   • `temporaryPasswordExpiresAt` ← now + TTL
   *
   * Donor parity: `EmailRecoveryService.issue_temporary_password_for_dev`.
   */
  @Post(':telegramId/web/reset-password')
  @HttpCode(HttpStatus.OK)
  public async resetWebPassword(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    this.assertDev(admin);
    const user = await this.findUserByTelegramId(telegramId);
    const webAccount = await this.prismaService.webAccount.findFirst({
      where: { userId: user.id },
    });
    if (!webAccount) {
      throw new NotFoundException('User has no linked web account');
    }
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: temporaryPassword,
    });
    const expiresAt = new Date(Date.now() + TEMPORARY_PASSWORD_TTL_HOURS * 60 * 60 * 1000);

    await this.prismaService.webAccount.update({
      where: { id: webAccount.id },
      data: {
        passwordHash,
        requiresPasswordChange: true,
        temporaryPasswordExpiresAt: expiresAt,
      },
    });

    await this.auditLog(admin, req, 'user.web.password.reset', {
      userId: user.id,
      webAccountId: webAccount.id,
      expiresAt: expiresAt.toISOString(),
    });

    return {
      temporaryPassword,
      expiresAt: expiresAt.toISOString(),
      requiresPasswordChange: true,
      login: webAccount.login,
    };
  }

  /**
   * Renames the user's web login. Conflicts on `loginNormalized` surface
   * as a 409 so the operator knows the new name is taken.
   *
   * Donor parity: `WebCabinetAdminService.rename_web_login`.
   */
  @Patch(':telegramId/web/login')
  public async renameWebLogin(
    @Param('telegramId') telegramId: string,
    @Body() body: RenameWebLoginDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    this.assertDev(admin);
    if (!loginPolicy.isValidLogin(body.login)) {
      throw new BadRequestException('Invalid login format');
    }
    const user = await this.findUserByTelegramId(telegramId);
    const webAccount = await this.prismaService.webAccount.findFirst({
      where: { userId: user.id },
    });
    if (!webAccount) {
      throw new NotFoundException('User has no linked web account');
    }
    const sanitizedLogin = loginPolicy.sanitizeLogin(body.login);
    const normalizedLogin = loginPolicy.normalizeLogin(body.login);
    try {
      const updated = await this.prismaService.webAccount.update({
        where: { id: webAccount.id },
        data: {
          login: sanitizedLogin,
          loginNormalized: normalizedLogin,
        },
      });
      await this.auditLog(admin, req, 'user.web.login.renamed', {
        userId: user.id,
        webAccountId: webAccount.id,
        previousLogin: webAccount.login,
        newLogin: sanitizedLogin,
      });
      return {
        login: updated.login,
        previousLogin: webAccount.login,
      };
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError
        && err.code === 'P2002'
      ) {
        throw new ConflictException('Login is already taken');
      }
      throw err;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private assertDev(admin: CurrentAdminInterface): void {
    if (admin.role !== UserRole.DEV) {
      throw new ForbiddenException('DEV role required');
    }
  }

  private async findUserByTelegramId(telegramId: string) {
    const isNumeric = /^\d+$/.test(telegramId);
    const user = isNumeric
      ? await this.prismaService.user.findFirst({
          where: { telegramId: BigInt(telegramId) },
        })
      : await this.prismaService.user.findUnique({
          where: { id: telegramId },
        });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async auditLog(
    admin: CurrentAdminInterface,
    req: Request,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog.create({
      data: {
        action,
        ipAddress: rm.remoteAddress,
        userAgent: rm.userAgent,
        metadata: { requestId: rm.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });
  }
}

/**
 * Generates a cryptographically-secure temporary password.
 *
 * Uses an unambiguous alphanumeric alphabet (no `0/O`, `1/l/I`) so the
 * value is safe to read out loud or paste from chat without confusion.
 */
function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(TEMPORARY_PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
