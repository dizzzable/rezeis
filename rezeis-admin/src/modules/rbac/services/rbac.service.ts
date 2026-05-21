import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminPermissionInputDto } from '../dto/upsert-admin-role.dto';
import {
  AdminPermissionInterface,
  AdminRoleInterface,
  AdminRoleListItemInterface,
} from '../interfaces/admin-permission.interface';
import {
  RBAC_RESOURCES,
  RbacAction,
  SYSTEM_ROLES,
  getAllPermissions,
  isValidPermission,
} from '../rbac.resources';

const ROLE_INCLUDE = {
  permissions: { select: { resource: true, action: true } },
  _count: { select: { admins: true } },
} as const satisfies Prisma.AdminRoleInclude;

type RoleWithCounts = Prisma.AdminRoleGetPayload<{ include: typeof ROLE_INCLUDE }>;

/**
 * Cache TTL for the per-admin permission set. 60 seconds keeps the
 * permission lookups O(1) for hot endpoints while still picking up role
 * changes within a sensible window. The cache is invalidated explicitly
 * whenever a role mutation lands.
 */
const PERMISSION_CACHE_TTL_MS = 60_000;

interface PermissionCacheEntry {
  readonly fingerprint: string;
  readonly grantedAll: boolean;
  readonly granted: ReadonlySet<string>;
  readonly expiresAt: number;
}

function cacheKey(adminId: string, roleId: string | null, legacyRole: UserRole): string {
  // legacyRole is part of the key so demoting DEV → ADMIN immediately
  // invalidates the cached "wildcard" permissions.
  return `${adminId}|${roleId ?? '-'}|${legacyRole}`;
}

function permissionToToken(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/**
 * Core RBAC service.
 *
 * - Resolves and caches per-admin permission sets.
 * - Provides CRUD for custom roles and (resource × action) grants.
 * - Bootstraps system roles (`superadmin`, `operator`, `support`,
 *   `finance`) on startup and keeps `superadmin` in sync with the
 *   declarative resource catalog.
 */
@Injectable()
export class RbacService implements OnModuleInit {
  private readonly logger = new Logger(RbacService.name);

  /** adminId → cached permission set. Volatile, single-process. */
  private readonly permissionCache = new Map<string, PermissionCacheEntry>();

  public constructor(private readonly prismaService: PrismaService) {}

  // ── Module lifecycle ───────────────────────────────────────────────────

  public async onModuleInit(): Promise<void> {
    try {
      await this.seedSystemRoles();
    } catch (err) {
      // Fail soft: a missing DB on cold start should not block app boot.
      // The next role-mutation request will retry the seed transparently
      // because `seedSystemRoles` is idempotent.
      this.logger.warn(`System role seed skipped: ${(err as Error).message}`);
    }
  }

  // ── Public read API ────────────────────────────────────────────────────

  public async listRoles(): Promise<readonly AdminRoleListItemInterface[]> {
    const rows = await this.prismaService.adminRole.findMany({
      include: ROLE_INCLUDE,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      isSystem: r.isSystem,
      permissionsCount: r.permissions.length,
      assignedAdminCount: r._count.admins,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  public async getRoleById(id: string): Promise<AdminRoleInterface> {
    const role = await this.prismaService.adminRole.findUnique({
      where: { id },
      include: ROLE_INCLUDE,
    });
    if (!role) throw new NotFoundException('Role not found');
    return mapRole(role);
  }

  public listResources(): Readonly<Record<string, readonly RbacAction[]>> {
    return RBAC_RESOURCES;
  }

  // ── Public write API ───────────────────────────────────────────────────

  public async createRole(input: {
    readonly name: string;
    readonly displayName: string;
    readonly description: string | null;
    readonly permissions: readonly AdminPermissionInputDto[];
  }): Promise<AdminRoleInterface> {
    this.assertPermissionsValid(input.permissions);
    const created = await this.prismaService.$transaction(async (tx) => {
      const existing = await tx.adminRole.findUnique({ where: { name: input.name } });
      if (existing) {
        throw new BadRequestException(`Role with name "${input.name}" already exists`);
      }
      const role = await tx.adminRole.create({
        data: {
          name: input.name,
          displayName: input.displayName,
          description: input.description,
          isSystem: false,
        },
      });
      if (input.permissions.length > 0) {
        await tx.adminPermission.createMany({
          data: input.permissions.map((p) => ({
            roleId: role.id,
            resource: p.resource,
            action: p.action,
          })),
          skipDuplicates: true,
        });
      }
      return tx.adminRole.findUniqueOrThrow({
        where: { id: role.id },
        include: ROLE_INCLUDE,
      });
    });
    this.invalidateAllCache();
    return mapRole(created);
  }

  public async updateRole(
    id: string,
    input: {
      readonly displayName: string;
      readonly description: string | null;
      readonly permissions: readonly AdminPermissionInputDto[];
    },
  ): Promise<AdminRoleInterface> {
    this.assertPermissionsValid(input.permissions);
    const updated = await this.prismaService.$transaction(async (tx) => {
      const existing = await tx.adminRole.findUnique({
        where: { id },
        select: { id: true, isSystem: true, name: true },
      });
      if (!existing) throw new NotFoundException('Role not found');
      // System roles can have their display metadata edited but their
      // permission matrix is immutable through the API. The only
      // exception is `superadmin`, which always owns everything and is
      // re-synced on startup.
      if (existing.isSystem) {
        const allowedSystemEdit =
          input.displayName !== '' || input.description !== undefined;
        if (!allowedSystemEdit) {
          throw new ForbiddenException('System roles cannot be modified');
        }
        await tx.adminRole.update({
          where: { id },
          data: {
            displayName: input.displayName,
            description: input.description,
          },
        });
      } else {
        await tx.adminRole.update({
          where: { id },
          data: {
            displayName: input.displayName,
            description: input.description,
          },
        });
        await tx.adminPermission.deleteMany({ where: { roleId: id } });
        if (input.permissions.length > 0) {
          await tx.adminPermission.createMany({
            data: input.permissions.map((p) => ({
              roleId: id,
              resource: p.resource,
              action: p.action,
            })),
            skipDuplicates: true,
          });
        }
      }
      return tx.adminRole.findUniqueOrThrow({
        where: { id },
        include: ROLE_INCLUDE,
      });
    });
    this.invalidateAllCache();
    return mapRole(updated);
  }

  public async deleteRole(id: string): Promise<void> {
    const role = await this.prismaService.adminRole.findUnique({
      where: { id },
      select: { id: true, isSystem: true, _count: { select: { admins: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new ForbiddenException('System roles cannot be deleted');
    if (role._count.admins > 0) {
      throw new BadRequestException('Cannot delete role assigned to one or more admins');
    }
    await this.prismaService.adminRole.delete({ where: { id } });
    this.invalidateAllCache();
  }

  // ── Permission resolution (used by the guard) ──────────────────────────

  /**
   * Returns whether the admin has the requested permission. Legacy DEV
   * admins always pass — they predate RBAC. Admins without an attached
   * `rbacRoleId` fall back to the legacy enum-derived behaviour: ADMIN
   * gets every `view` action plus generic edits (mirrors the pre-RBAC
   * behaviour so adding RBAC does not regress existing accounts).
   */
  public async hasPermission(
    admin: { readonly id: string; readonly role: UserRole; readonly rbacRoleId: string | null },
    resource: string,
    action: string,
  ): Promise<boolean> {
    if (admin.role === UserRole.DEV) return true;
    const entry = await this.resolvePermissions(admin);
    if (entry.grantedAll) return true;
    return entry.granted.has(permissionToToken(resource, action));
  }

  /**
   * Returns the flat list of granted permissions for an admin. Used by
   * the `/admin/auth/me` endpoint so the frontend can render the right
   * navigation entries.
   */
  public async getEffectivePermissions(admin: {
    readonly id: string;
    readonly role: UserRole;
    readonly rbacRoleId: string | null;
  }): Promise<readonly AdminPermissionInterface[]> {
    if (admin.role === UserRole.DEV) {
      return getAllPermissions().map((p) => ({ resource: p.resource, action: p.action }));
    }
    const entry = await this.resolvePermissions(admin);
    if (entry.grantedAll) {
      return getAllPermissions().map((p) => ({ resource: p.resource, action: p.action }));
    }
    return Array.from(entry.granted).map((token) => {
      const sep = token.indexOf(':');
      return {
        resource: token.slice(0, sep),
        action: token.slice(sep + 1) as RbacAction,
      };
    });
  }

  public invalidateCacheForAdmin(adminId: string): void {
    for (const key of this.permissionCache.keys()) {
      if (key.startsWith(`${adminId}|`)) {
        this.permissionCache.delete(key);
      }
    }
  }

  public invalidateAllCache(): void {
    this.permissionCache.clear();
  }

  // ── System role bootstrap ──────────────────────────────────────────────

  /**
   * Idempotently creates system roles and ensures `superadmin` covers the
   * full resource catalog. Safe to call on every boot.
   */
  public async seedSystemRoles(): Promise<void> {
    for (const seed of SYSTEM_ROLES) {
      const permissions =
        seed.name === 'superadmin'
          ? getAllPermissions().map((p) => ({ resource: p.resource, action: p.action as RbacAction }))
          : seed.permissions;

      await this.prismaService.$transaction(async (tx) => {
        const existing = await tx.adminRole.findUnique({
          where: { name: seed.name },
          select: { id: true, isSystem: true },
        });
        let roleId: string;
        if (!existing) {
          const created = await tx.adminRole.create({
            data: {
              name: seed.name,
              displayName: seed.displayName,
              description: seed.description,
              isSystem: true,
            },
          });
          roleId = created.id;
        } else {
          roleId = existing.id;
          if (!existing.isSystem) {
            // Operator-created role with a colliding name — promote it
            // to system to make the seed deterministic. We deliberately
            // do NOT touch its permissions in this branch.
            await tx.adminRole.update({
              where: { id: roleId },
              data: { isSystem: true, displayName: seed.displayName, description: seed.description },
            });
            return;
          }
        }
        // Ensure every seed permission exists. We never delete existing
        // permissions on system roles to avoid clobbering operator
        // adjustments to non-superadmin system roles.
        if (permissions.length === 0) return;
        await tx.adminPermission.createMany({
          data: permissions.map((p) => ({
            roleId,
            resource: p.resource,
            action: p.action,
          })),
          skipDuplicates: true,
        });
      });
    }
    this.invalidateAllCache();
    this.logger.log('RBAC system roles synced');
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async resolvePermissions(admin: {
    readonly id: string;
    readonly role: UserRole;
    readonly rbacRoleId: string | null;
  }): Promise<PermissionCacheEntry> {
    const key = cacheKey(admin.id, admin.rbacRoleId, admin.role);
    const cached = this.permissionCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached;

    const granted = new Set<string>();
    let grantedAll = false;

    if (admin.rbacRoleId) {
      const role = await this.prismaService.adminRole.findUnique({
        where: { id: admin.rbacRoleId },
        select: { name: true, permissions: { select: { resource: true, action: true } } },
      });
      if (role) {
        if (role.name === 'superadmin') grantedAll = true;
        for (const p of role.permissions) {
          granted.add(permissionToToken(p.resource, p.action));
        }
      }
    } else if (admin.role === UserRole.ADMIN) {
      // Legacy fallback for accounts that pre-date RBAC: grant every
      // `view` and generic `edit/create/delete` so the panel keeps
      // working until the operator assigns a real role.
      for (const [resource, actions] of Object.entries(RBAC_RESOURCES)) {
        for (const action of actions) {
          granted.add(permissionToToken(resource, action));
        }
      }
      // Sensitive surfaces stay locked behind explicit DEV/superadmin.
      for (const action of RBAC_RESOURCES.rbac_roles) {
        granted.delete(permissionToToken('rbac_roles', action));
      }
      for (const action of RBAC_RESOURCES.admins) {
        granted.delete(permissionToToken('admins', action));
      }
    }

    const entry: PermissionCacheEntry = {
      fingerprint: key,
      grantedAll,
      granted,
      expiresAt: now + PERMISSION_CACHE_TTL_MS,
    };
    this.permissionCache.set(key, entry);
    return entry;
  }

  private assertPermissionsValid(permissions: readonly AdminPermissionInputDto[]): void {
    const seen = new Set<string>();
    for (const p of permissions) {
      const token = permissionToToken(p.resource, p.action);
      if (seen.has(token)) {
        throw new BadRequestException(`Duplicate permission: ${token}`);
      }
      seen.add(token);
      if (!isValidPermission(p.resource, p.action)) {
        throw new BadRequestException(`Unknown permission: ${token}`);
      }
    }
  }
}

function mapRole(role: RoleWithCounts): AdminRoleInterface {
  return {
    id: role.id,
    name: role.name,
    displayName: role.displayName,
    description: role.description,
    isSystem: role.isSystem,
    permissions: role.permissions.map((p) => ({
      resource: p.resource,
      action: p.action as RbacAction,
    })),
    assignedAdminCount: role._count.admins,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}
