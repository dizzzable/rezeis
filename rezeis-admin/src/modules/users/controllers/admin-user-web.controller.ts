/**
 * AdminUserWebController
 * ──────────────────────
 * Operator actions against the user's linked `WebAccount`, surfaced in the
 * admin user-profile panel. Carved out of `admin-user-management.controller.ts`
 * so the privileged surface is obvious at the route level.
 *
 * Endpoints:
 *   POST  /admin/users/:telegramId/web/reset-password   — issue a 24h temp password
 *   PATCH /admin/users/:telegramId/web/login            — change the login (replace)
 *   PATCH /admin/users/:telegramId/telegram-binding     — manually bind a Telegram id
 *
 * Password convention: the reiwa cabinet hashes passwords client-side with
 * SHA-256 before they reach this service, so stored hashes are
 * `scrypt(SHA256(password))`. A temp password issued here MUST therefore be
 * stored as `scrypt(SHA256(temp))` — otherwise the user could never sign in
 * with it. The plain temp password is returned to the operator once.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { parseTelegramId } from '../../../common/utils/postgres-bigint.util';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { BindTelegramIdDto } from '../dto/bind-telegram-id.dto';
import { RenameWebLoginDto } from '../dto/rename-web-login.dto';
import {
  TEMP_PASSWORD_TTL_SECONDS,
  tempPasswordCacheKey,
} from '../utils/temp-password-cache.util';

/** Default lifespan of an admin-issued temporary password. */
const TEMPORARY_PASSWORD_TTL_HOURS = 24;
/** Length of the generated temporary password (alphanumeric, no ambiguous chars). */
const TEMPORARY_PASSWORD_LENGTH = 16;

@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('users', 'view')
export class AdminUserWebController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly passwordHashService: PasswordHashService,
    private readonly cacheService: RawCacheService,
  ) {}

  /**
   * Issues a temporary password for the user's `WebAccount`. The plain
   * text is returned **once** so the operator can hand it over out of
   * band; we never store the plain value.
   *
   * Side effects:
   *   • `passwordHash`               ← scrypt(SHA256(temp))
   *   • `requiresPasswordChange`     ← true (cabinet forces a reset on next login)
   *   • `temporaryPasswordExpiresAt` ← now + TTL
   */
  @Post(':telegramId/web/reset-password')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users', 'edit')
  public async resetWebPassword(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const webAccount = await this.prismaService.webAccount.findFirst({
      where: { userId: user.id },
    });
    if (!webAccount) {
      throw new NotFoundException('User has no linked web account');
    }
    const temporaryPassword = generateTemporaryPassword();
    // The cabinet SHA-256s the password client-side, so we must store the
    // scrypt of that SHA-256 digest — not of the raw temp string.
    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: sha256Hex(temporaryPassword),
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

    // Persist the plaintext temporarily (Redis, 24h TTL) so the operator can
    // re-view it until the user changes their password. Cleared in
    // `WebAuthService.changePassword`. Best-effort: a cache outage just means
    // the operator must re-issue.
    await this.cacheService.set(
      tempPasswordCacheKey(webAccount.id),
      temporaryPassword,
      TEMP_PASSWORD_TTL_SECONDS,
    );

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
   * Returns the currently-active temporary password for the user's web
   * account, if one was issued and is still valid (within TTL and not yet
   * changed by the user). `null` when none is active. Admin-JWT gated; the
   * value is never logged.
   */
  @Get(':telegramId/web/temp-password')
  @HttpCode(HttpStatus.OK)
  public async getTemporaryPassword(
    @Param('telegramId') telegramId: string,
  ): Promise<{ temporaryPassword: string | null; expiresAt: string | null }> {
    const user = await this.findUserByTelegramId(telegramId);
    const webAccount = await this.prismaService.webAccount.findFirst({
      where: { userId: user.id },
    });
    if (!webAccount) {
      throw new NotFoundException('User has no linked web account');
    }
    const expiresAt = webAccount.temporaryPasswordExpiresAt;
    const stillRequired =
      webAccount.requiresPasswordChange &&
      expiresAt !== null &&
      expiresAt.getTime() > Date.now();
    if (!stillRequired) {
      return { temporaryPassword: null, expiresAt: null };
    }
    const cached = await this.cacheService.get<string>(tempPasswordCacheKey(webAccount.id));
    return {
      temporaryPassword: cached,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Renames the user's web login (replace — the old login is removed).
   * Conflicts on `loginNormalized` surface as a 409.
   */
  @Patch(':telegramId/web/login')
  @RequirePermission('users', 'edit')
  public async renameWebLogin(
    @Param('telegramId') telegramId: string,
    @Body() body: RenameWebLoginDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
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

  /**
   * Manually binds (or rebinds) a Telegram id to the user. The Telegram id
   * is globally unique, so attaching one already used by another account
   * surfaces as a 409.
   */
  @Patch(':telegramId/telegram-binding')
  @RequirePermission('users', 'edit')
  public async bindTelegramId(
    @Param('telegramId') telegramId: string,
    @Body() body: BindTelegramIdDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    // `BindTelegramIdDto` already enforces `^\d{1,19}$`, which is why the
    // `try { BigInt(...) } catch` that used to stand here never fired: `BigInt`
    // throws on non-numeric strings, and the DTO admits none. What the DTO does
    // NOT rule out is the top of the 19-digit range — `9999999999999999999` is
    // valid by that pattern and larger than `int8` can hold, so it sailed
    // through to the `findUnique` below and returned `22003 numeric field value
    // out of range`: a 500 on an operator typo. The range check is the guard.
    const nextTelegramId = parseTelegramId(body.telegramId);
    if (nextTelegramId === null) {
      throw new BadRequestException('telegramId is out of range for a Telegram account id');
    }
    if (nextTelegramId <= 0n) {
      throw new BadRequestException('telegramId must be positive');
    }
    // No-op when the user already owns this Telegram id.
    if (user.telegramId !== null && user.telegramId === nextTelegramId) {
      return { telegramId: nextTelegramId.toString(), changed: false };
    }
    // Guard against attaching an id already used by a different account.
    const conflict = await this.prismaService.user.findUnique({
      where: { telegramId: nextTelegramId },
      select: { id: true },
    });
    if (conflict !== null && conflict.id !== user.id) {
      throw new ConflictException('Telegram id is already bound to another user');
    }
    await this.prismaService.user.update({
      where: { id: user.id },
      data: { telegramId: nextTelegramId },
    });
    await this.auditLog(admin, req, 'user.telegram.bound', {
      userId: user.id,
      previousTelegramId: user.telegramId?.toString() ?? null,
      newTelegramId: nextTelegramId.toString(),
    });
    return { telegramId: nextTelegramId.toString(), changed: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * The route param accepts either a numeric Telegram id or a CUID (internal
   * user id); numeric is tried first.
   *
   * Digits that overflow Postgres `int8` have no second branch to fall through
   * to — no row can hold that value, and an all-digit string is not a CUID
   * either — so 404 is the truthful answer. Binding it anyway reached Postgres
   * and came back as `22003 numeric field value out of range`, i.e. a 500.
   */
  private async findUserByTelegramId(telegramId: string) {
    const isNumeric = /^\d+$/.test(telegramId);
    const numericId = isNumeric ? parseTelegramId(telegramId) : null;
    if (isNumeric && numericId === null) throw new NotFoundException('User not found');
    const user = numericId !== null
      ? await this.prismaService.user.findFirst({
          where: { telegramId: numericId },
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

/** SHA-256 hex digest — mirrors the cabinet's client-side password hashing. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
