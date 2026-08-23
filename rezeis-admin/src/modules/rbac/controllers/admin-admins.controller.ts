import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, UserRole } from '@prisma/client';
import { Request } from 'express';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import { loginPolicy } from '../../auth/utils/login-policy.util';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { RbacGuard } from '../guards/rbac.guard';
import { RbacService } from '../services/rbac.service';

/**
 * Admin user CRUD endpoints. The `admins` RBAC resource gates each verb.
 *
 * This is the surface operators use to *issue dedicated panel accounts* —
 * create a login, set a temporary password (optionally forcing a change on
 * first sign-in), and bind the account to a custom RBAC role so it sees
 * exactly the sections that role grants.
 *
 * Safety rails:
 *   - Self-targeted destructive ops (deactivate / delete the currently
 *     authenticated admin) are blocked.
 *   - An actor can never change their OWN `role` or `rbacRoleId`. Holding
 *     `admins:edit` used to be indistinguishable from holding everything:
 *     PATCH your own id with `{"role":"DEV"}` and `RbacService.hasPermission`
 *     returns `true` for every question thereafter. `{"rbacRoleId":"<the
 *     superadmin role>"}` was the same move by another name.
 *   - Only a `DEV` may grant, revoke, or otherwise act on `DEV`. That enum
 *     value short-circuits the permission check itself, so it is strictly more
 *     than "holds every catalog entry" and is gated on itself rather than on a
 *     permission set.
 *   - Privilege attenuation, matching `config-import.service.ts`: an actor may
 *     not leave a target holding authority the actor does not itself hold, and
 *     may not act on a target that already holds more than the actor does.
 *     Both directions are needed - the second is what stops an account with
 *     `admins:edit` from resetting a more-privileged admin's password (which
 *     also bumps their `tokenVersion`, ending their sessions) and signing in
 *     as them.
 *   - The protected owner is untouchable by anyone else; see `resolveOwnerId`.
 *   - The *last active admin* can never be deactivated or deleted, so the
 *     panel can't be locked out entirely.
 *   - Every mutation is written to the `AdminAuditLog`.
 */

const ROLE_VALUES = ['DEV', 'ADMIN'] as const;
type AssignableRole = (typeof ROLE_VALUES)[number];

class CreateAdminDto {
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern, {
    message: 'Login may only contain letters, digits, dots, dashes, and underscores',
  })
  public readonly username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public readonly password!: string;

  @IsEnum(ROLE_VALUES)
  public readonly role!: AssignableRole;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  public readonly name?: string;

  /**
   * Optional custom RBAC role to attach. When set, the role's permission
   * matrix fully drives access; when omitted/null the account falls back to
   * the legacy `role`-enum defaults (DEV → all, ADMIN → safe-write set).
   */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  public readonly rbacRoleId?: string | null;

  /** Force a password change on the account's first sign-in. */
  @IsOptional()
  @IsBoolean()
  public readonly mustChangePassword?: boolean;
}

class UpdateAdminDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public readonly password?: string;

  @IsOptional()
  @IsEnum(ROLE_VALUES)
  public readonly role?: AssignableRole;

  @IsOptional()
  @IsBoolean()
  public readonly isActive?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  public readonly name?: string;

  /**
   * Custom RBAC role pointer. Pass a role id to (re)assign, or an empty
   * string / null to detach the custom role and fall back to legacy
   * `role`-enum defaults.
   */
  @IsOptional()
  @IsString()
  @Length(0, 64)
  public readonly rbacRoleId?: string | null;

  /** Toggle the force-password-change flag without rotating the password. */
  @IsOptional()
  @IsBoolean()
  public readonly mustChangePassword?: boolean;
}

interface AdminListItem {
  readonly id: string;
  readonly username: string;
  readonly name: string | null;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly rbacRoleId: string | null;
  readonly rbacRoleName: string | null;
  readonly mustChangePassword: boolean;
  readonly twoFactorEnabled: boolean;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const adminProjection = Prisma.validator<Prisma.AdminUserSelect>()({
  id: true,
  login: true,
  name: true,
  role: true,
  isActive: true,
  rbacRoleId: true,
  mustChangePassword: true,
  totpEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  rbacRole: { select: { id: true, displayName: true } },
});

type AdminProjection = Prisma.AdminUserGetPayload<{ select: typeof adminProjection }>;

function toApi(admin: AdminProjection): AdminListItem {
  return {
    id: admin.id,
    username: admin.login,
    name: admin.name,
    role: admin.role,
    isActive: admin.isActive,
    rbacRoleId: admin.rbacRoleId,
    rbacRoleName: admin.rbacRole?.displayName ?? null,
    mustChangePassword: admin.mustChangePassword,
    twoFactorEnabled: admin.totpEnabled,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt.toISOString(),
    updatedAt: admin.updatedAt.toISOString(),
  };
}

@ApiTags('admin/admins')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/admins')
export class AdminAdminsController {
  private readonly logger = new Logger('AdminAdminsController');

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly passwordHashService: PasswordHashService,
    private readonly rbacService: RbacService,
    // @Optional() and trailing so this controller keeps constructing with three
    // arguments, and so a container without the realtime module still boots.
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Lazily-resolved realtime gateway — the same `ModuleRef` escape hatch used at
   * the other two revocation sites (`admin-auth.service.ts`,
   * `passkey.service.ts`) and by `SystemEventsService:685`. Naming the gateway
   * as a constructor dependency would make `RbacModule` import `RealtimeModule`,
   * which imports `AuthModule`, which imports `RbacModule`.
   */
  private realtimeGatewayCache: import('../../realtime/realtime.gateway').RealtimeGateway | null = null;
  private realtimeGatewayResolved = false;

  /**
   * Drops every open admin socket bound to `adminId`.
   *
   * WHY A CACHE INVALIDATION IS NOT ENOUGH. `invalidateCacheForAdmin()` fixes
   * the HTTP side: `RbacGuard` re-reads the permission set on the next request.
   * The socket has no next request. `RealtimeGateway` resolves `allowedTopics`
   * ONCE, in `handleConnection`, and `broadcast()` tests that connect-time
   * snapshot (`realtime.gateway.ts`) — nothing anywhere refreshes it. So a
   * demoted admin's open stream kept delivering PAYMENT / FRAUD / PARTNER events
   * they could no longer open in the panel, at exactly the moment an operator
   * had deliberately demoted them.
   *
   * Best-effort and never rethrown: the durable half of the change has already
   * committed by the time this runs, and an absent realtime module must not turn
   * a completed demotion into a 500.
   */
  private revokeRealtimeSessions(adminId: string, reason: string): void {
    const gateway = this.resolveRealtimeGateway();
    if (!gateway) return;
    try {
      const dropped = gateway.disconnectAdmin(adminId, reason);
      if (dropped > 0) {
        this.logger.log(
          `Realtime sessions revoked for admin ${adminId}: ${dropped} socket(s) (${reason})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Realtime session revocation failed for admin ${adminId}: ${(err as Error).message}`,
      );
    }
  }

  private resolveRealtimeGateway():
    | import('../../realtime/realtime.gateway').RealtimeGateway
    | null {
    if (this.realtimeGatewayResolved) return this.realtimeGatewayCache;
    this.realtimeGatewayResolved = true;
    if (!this.moduleRef) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RealtimeGateway } = require('../../realtime/realtime.gateway');
      this.realtimeGatewayCache = this.moduleRef.get(RealtimeGateway, { strict: false });
    } catch {
      this.realtimeGatewayCache = null;
    }
    if (!this.realtimeGatewayCache) {
      this.logger.warn(
        'RealtimeGateway not available — realtime sessions will not be revoked',
      );
    }
    return this.realtimeGatewayCache;
  }

  @Get()
  @RequirePermission('admins', 'view')
  @ApiOperation({ summary: 'List all admin user accounts' })
  public async list(): Promise<readonly AdminListItem[]> {
    const records = await this.prismaService.adminUser.findMany({
      orderBy: [{ createdAt: 'desc' }],
      select: adminProjection,
    });
    return records.map(toApi);
  }

  @Post()
  @RequirePermission('admins', 'create')
  @ApiOperation({ summary: 'Create a new admin account' })
  public async create(
    @Body() dto: CreateAdminDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminListItem> {
    const sanitizedLogin = loginPolicy.sanitizeLogin(dto.username);
    if (!loginPolicy.isValidLogin(sanitizedLogin)) {
      throw new BadRequestException('Invalid login');
    }
    const normalizedLogin = loginPolicy.normalizeLogin(sanitizedLogin);

    const existing = await this.prismaService.adminUser.findUnique({
      where: { loginNormalized: normalizedLogin },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ConflictException('Admin with this login already exists');
    }

    const rbacRoleId = normalizeRoleId(dto.rbacRoleId);
    if (rbacRoleId !== null) {
      await this.assertRbacRoleExists(rbacRoleId);
    }
    // Same gate as `update`. `POST` was the shorter road to the same place:
    // `role: 'DEV'` was accepted from anyone holding `admins:create`, so an
    // actor who could not escalate itself could mint a DEV and log in as it.
    await this.assertMayGrant(currentAdmin, {
      targetId: null,
      role: dto.role,
      rbacRoleId,
    });

    // ADMIN: `adminUser.create` below. Operator credential, operator cost —
    // this endpoint mints the accounts that hold every permission in the panel.
    const passwordHash = await this.passwordHashService.hashPassword({
      plainTextPassword: dto.password,
      audience: 'admin',
    });

    const created = await this.prismaService.adminUser.create({
      data: {
        login: sanitizedLogin,
        loginNormalized: normalizedLogin,
        passwordHash,
        role: dto.role,
        name: dto.name?.trim() || null,
        isActive: true,
        rbacRoleId,
        mustChangePassword: dto.mustChangePassword ?? false,
        passwordChangedAt: new Date(),
      },
      select: adminProjection,
    });
    await this.audit(currentAdmin, request, 'admin.account.created', created.id, {
      login: created.login,
      role: created.role,
      rbacRoleId,
    });
    return toApi(created);
  }

  @Patch(':adminId')
  @RequirePermission('admins', 'edit')
  @ApiOperation({ summary: 'Update an admin account' })
  public async update(
    @Param('adminId') adminId: string,
    @Body() dto: UpdateAdminDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<AdminListItem> {
    const target = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, role: true, isActive: true, rbacRoleId: true },
    });
    if (target === null) {
      throw new NotFoundException('Admin not found');
    }

    if (dto.isActive === false && currentAdmin.id === adminId) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }
    // Self-escalation, the shortest path there was: `admins:edit` plus your own
    // id plus `{"role":"DEV"}` was superuser, and the only self-targeting guard
    // in this method was the `isActive === false` line directly above.
    // Both authority fields are refused rather than just `role`, because
    // pointing `rbacRoleId` at the `superadmin` role reaches the same place.
    if (currentAdmin.id === adminId
      && (typeof dto.role !== 'undefined' || typeof dto.rbacRoleId !== 'undefined')) {
      throw new ForbiddenException(
        'You cannot change your own role or permissions; ask another administrator',
      );
    }
    await this.assertMayActOn(currentAdmin, target);
    await this.assertMayGrant(currentAdmin, {
      targetId: target.id,
      role: typeof dto.role === 'undefined' ? target.role : dto.role,
      rbacRoleId:
        typeof dto.rbacRoleId === 'undefined'
          ? target.rbacRoleId
          : normalizeRoleId(dto.rbacRoleId),
    });
    // Lockout guard: never let the last active admin be deactivated.
    if (dto.isActive === false && target.isActive) {
      await this.assertNotLastActiveAdmin();
    }

    const data: Prisma.AdminUserUpdateInput = {};

    if (typeof dto.role !== 'undefined') {
      data.role = dto.role;
    }
    if (typeof dto.isActive === 'boolean') {
      data.isActive = dto.isActive;
    }
    if (typeof dto.name !== 'undefined') {
      data.name = dto.name.trim().length > 0 ? dto.name.trim() : null;
    }
    if (typeof dto.mustChangePassword === 'boolean') {
      data.mustChangePassword = dto.mustChangePassword;
    }
    // RBAC role (re)assignment. An empty string / null detaches the role;
    // a non-empty value must reference an existing role.
    if (typeof dto.rbacRoleId !== 'undefined') {
      const rbacRoleId = normalizeRoleId(dto.rbacRoleId);
      if (rbacRoleId !== null) {
        await this.assertRbacRoleExists(rbacRoleId);
        data.rbacRole = { connect: { id: rbacRoleId } };
      } else {
        data.rbacRole = { disconnect: true };
      }
    }
    if (typeof dto.password === 'string' && dto.password.length > 0) {
      // ADMIN: same row as `create` — an operator's password, set by another
      // operator. Not a subscriber credential despite living beside the users
      // screens in the UI.
      data.passwordHash = await this.passwordHashService.hashPassword({
        plainTextPassword: dto.password,
        audience: 'admin',
      });
      data.passwordChangedAt = new Date();
      // Bump tokenVersion to invalidate any active session of this admin.
      data.tokenVersion = { increment: 1 };
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    // Which edits can move what the realtime stream is allowed to carry, decided
    // against the row as it was BEFORE the write. Deliberately narrow: `name` and
    // `mustChangePassword` change nothing `RealtimeGateway.resolveAllowedTopics`
    // reads, so renaming an admin must not kick them off their socket.
    //
    // Fired in BOTH directions, not only on a narrowing. A promotion leaves the
    // connect-time snapshot equally stale — harmlessly, but the admin silently
    // does not receive the categories they were just granted until they happen to
    // reconnect. Telling the two apart would mean resolving the whole permission
    // set before and after and diffing it, and a demotion misfiled as a widening
    // leaves the leak open. A reconnect costs one handshake and re-runs the
    // resolution correctly either way, so the cheap, conservative rule wins.
    const roleChanged = typeof dto.role !== 'undefined' && dto.role !== target.role;
    const rbacRoleChanged =
      typeof dto.rbacRoleId !== 'undefined'
      && normalizeRoleId(dto.rbacRoleId) !== target.rbacRoleId;
    // Deactivation and a password reset are revocations too: `handleConnection`
    // refuses an inactive admin and a stale `tokenVersion`, but only at handshake
    // — an already-open socket survives both.
    const deactivated = dto.isActive === false;
    const passwordReset = typeof data.tokenVersion !== 'undefined';
    const revocationReason: string | null = deactivated
      ? 'admin_deactivated'
      : passwordReset
        ? 'admin_password_reset'
        : roleChanged || rbacRoleChanged
          ? 'admin_role_changed'
          : null;

    const updated = await this.prismaService.adminUser.update({
      where: { id: adminId },
      data,
      select: adminProjection,
    });
    // A role/permission-affecting change must take effect immediately: drop
    // the cached permission set for this admin so the next request re-reads.
    this.rbacService.invalidateCacheForAdmin(adminId);
    // …and drop the socket, which has no next request to re-read on.
    if (revocationReason !== null) {
      this.revokeRealtimeSessions(adminId, revocationReason);
    }
    await this.audit(currentAdmin, request, 'admin.account.updated', adminId, {
      login: updated.login,
      changed: Object.keys(data),
    });
    return toApi(updated);
  }

  @Delete(':adminId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('admins', 'delete')
  @ApiOperation({ summary: 'Delete (revoke) an admin account' })
  public async delete(
    @Param('adminId') adminId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<void> {
    if (currentAdmin.id === adminId) {
      throw new ForbiddenException('You cannot delete your own account');
    }
    const target = await this.prismaService.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, login: true, isActive: true, role: true, rbacRoleId: true },
    });
    if (target === null) {
      throw new NotFoundException('Admin not found');
    }
    await this.assertMayActOn(currentAdmin, target);
    if (target.isActive) {
      await this.assertNotLastActiveAdmin();
    }
    await this.prismaService.adminUser.delete({ where: { id: adminId } });
    this.rbacService.invalidateCacheForAdmin(adminId);
    // The account no longer exists. `handleConnection` would refuse it now
    // (`admin_not_found`), but the socket it opened while it did exist has no
    // handshake left to fail.
    this.revokeRealtimeSessions(adminId, 'admin_deleted');
    await this.audit(currentAdmin, request, 'admin.account.deleted', adminId, {
      login: target.login,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * The protected owner: the earliest-created admin account.
   *
   * DERIVED, NOT STORED - deliberately, because a stored flag would need a
   * schema column and this tree does not take a migration for a security fix.
   * `AdminAuthService.bootstrapFirstAdmin` refuses to run once any admin row
   * exists, so the oldest row IS the account the panel was bootstrapped with,
   * and it is a `DEV` by construction. `createdAt` is written by the database
   * default and is not reachable through any admin API - neither `create` nor
   * `update` above passes it - so the ordering cannot be won by creating an
   * account, and the owner row cannot be deleted out from under the rule
   * because deleting the owner is exactly what the rule forbids.
   *
   * `id` breaks ties so two rows sharing a timestamp still give one answer.
   *
   * What the owner gets is immunity and nothing else: no extra permission, no
   * bypass. So on a panel whose bootstrap admin was already removed before this
   * shipped, the worst case is that the immunity lands on the wrong (oldest
   * surviving) account - a misplaced shield, not a granted privilege.
   */
  private async resolveOwnerId(): Promise<string | null> {
    const owner = await this.prismaService.adminUser.findFirst({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return owner?.id ?? null;
  }

  /**
   * May this actor touch this account at all?
   *
   * Three refusals, in order of how specific they are:
   *
   *   1. The owner is off limits to everyone but the owner.
   *   2. A `DEV` is off limits to everyone but a `DEV`. `UserRole.DEV` is not a
   *      permission set - `RbacService.hasPermission` returns `true` for it
   *      before consulting anything - so it is guarded on itself.
   *   3. A target holding authority the actor does not hold is off limits.
   *      This is the one that closes the password-reset path: `update` can set
   *      `passwordHash` and bump `tokenVersion`, which hands the account to
   *      whoever chose the new password, so "may edit" has to mean "is at
   *      least as privileged as".
   */
  private async assertMayActOn(
    actor: CurrentAdminInterface,
    target: { readonly id: string; readonly role: UserRole; readonly rbacRoleId: string | null },
  ): Promise<void> {
    if (actor.id === target.id) return;

    const ownerId = await this.resolveOwnerId();
    if (ownerId !== null && target.id === ownerId) {
      throw new ForbiddenException('This account is the panel owner and cannot be modified');
    }
    if (target.role === UserRole.DEV && actor.role !== UserRole.DEV) {
      throw new ForbiddenException('Only a DEV administrator can modify a DEV account');
    }

    const actorTokens = await this.actorPermissionTokens(actor);
    const targetTokens = await this.rbacService.getEffectivePermissionTokens(target);
    assertSubset(
      targetTokens,
      actorTokens,
      'You cannot modify an account that holds permissions you do not hold',
    );
  }

  /**
   * May this actor leave an account in this state?
   *
   * `role` and `rbacRoleId` are the state AFTER the requested change, not the
   * delta, because detaching a role is also a grant: an `ADMIN` with no
   * `rbacRoleId` falls back to `LEGACY_ADMIN_ALLOWED_RESOURCES`, which is far
   * wider than most custom roles. Asking what the account would end up holding
   * covers assignment, reassignment and detach with one question.
   */
  private async assertMayGrant(
    actor: CurrentAdminInterface,
    next: {
      readonly targetId: string | null;
      readonly role: UserRole;
      readonly rbacRoleId: string | null;
    },
  ): Promise<void> {
    if (next.role === UserRole.DEV && actor.role !== UserRole.DEV) {
      throw new ForbiddenException('Only a DEV administrator can grant the DEV role');
    }
    const actorTokens = await this.actorPermissionTokens(actor);
    // `targetId` only reaches the permission cache key; on create there is no
    // row yet, and a name that cannot collide with a cuid keeps the miss local.
    const resulting = await this.rbacService.getEffectivePermissionTokens({
      id: next.targetId ?? 'admins-controller:pending-create',
      role: next.role,
      rbacRoleId: next.rbacRoleId,
    });
    assertSubset(
      resulting,
      actorTokens,
      'You cannot grant permissions you do not hold',
    );
  }

  private actorPermissionTokens(actor: CurrentAdminInterface): Promise<ReadonlySet<string>> {
    return this.rbacService.getEffectivePermissionTokens({
      id: actor.id,
      role: actor.role,
      rbacRoleId: actor.rbacRoleId,
    });
  }

  private async assertRbacRoleExists(rbacRoleId: string): Promise<void> {
    const role = await this.prismaService.adminRole.findUnique({
      where: { id: rbacRoleId },
      select: { id: true },
    });
    if (role === null) {
      throw new BadRequestException('Assigned RBAC role does not exist');
    }
  }

  /**
   * Guards against locking everyone out: refuse the operation when the
   * target is the only remaining active admin account.
   */
  private async assertNotLastActiveAdmin(): Promise<void> {
    const activeCount = await this.prismaService.adminUser.count({ where: { isActive: true } });
    if (activeCount <= 1) {
      throw new ForbiddenException('Cannot remove the last active admin account');
    }
  }

  private async audit(
    actor: CurrentAdminInterface,
    request: Request,
    action: string,
    targetAdminId: string,
    extra: Prisma.InputJsonObject,
  ): Promise<void> {
    const metadata = extractRequestMetadata(request);
    await this.prismaService.adminAuditLog.create({
      data: {
        action,
        ipAddress: metadata.remoteAddress,
        userAgent: metadata.userAgent,
        metadata: {
          requestId: metadata.requestId,
          targetAdminId,
          actorLogin: actor.login,
          ...extra,
        },
        ...(actor.id ? { adminUser: { connect: { id: actor.id } } } : {}),
      },
    });
  }
}

/**
 * Refuses when `subject` is not contained in `allowed`, naming what was over
 * the line. Same subset rule and same `resource:action` spelling as
 * `config-import.service.ts` enforces on the import path.
 */
function assertSubset(
  subject: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  message: string,
): void {
  const excess = [...subject].filter((token) => !allowed.has(token)).sort();
  if (excess.length > 0) {
    throw new ForbiddenException(`${message}: ${excess.join(', ')}`);
  }
}

/** Normalises an optional role-id input: trims, treats '' as detach (null). */
function normalizeRoleId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
