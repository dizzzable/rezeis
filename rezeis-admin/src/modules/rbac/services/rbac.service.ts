import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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

/**
 * Resources a legacy bare-ADMIN (no assigned RBAC role) is implicitly
 * allowed to touch. Deliberately EXCLUDES money-affecting, destructive and
 * secret-bearing surfaces — `admins`, `rbac_roles`, `add_on_entitlements`,
 * `config_portability`, `backups`, `api_tokens`, `system_logs`,
 * `automations`, `webhooks`, `external_auth`, `auth_providers`,
 * `blocked_ips`. Those require DEV / superadmin or an explicit custom role.
 * Mirrors the day-to-day operator surface (users, subscriptions, payments,
 * support, catalog, growth, appearance) without wildcard escalation.
 */
const LEGACY_ADMIN_ALLOWED_RESOURCES: ReadonlySet<string> = new Set([
  'dashboard',
  'users',
  'subscriptions',
  'payments',
  'payment_gateways',
  'payment_webhooks',
  'support_tickets',
  'analytics',
  'auto_renew',
  'plans',
  'promocodes',
  'broadcasts',
  'add_ons',
  'faq',
  'referrals',
  'referral_settings',
  'partners',
  'partner_settings',
  'withdrawals',
  'quests',
  'settings',
  'bot_config',
  'remnawave',
  'notifications',
  'subpage_config',
  'landing_config',
  'email',
  'appearance',
  'branding',
  'imports',
  'audit',
  'advertising',
  'fraud_signals',
]);

/**
 * Even within allowed resources, these specific high-blast-radius actions
 * stay locked for a legacy bare-ADMIN. `users:export_registration` is a bulk
 * raw PII dump (elevated, S7). `payments:refund` moves real money out to a
 * customer and cannot be undone — a legacy admin inherits every action of an
 * allowed resource, so without this entry the refund button would silently
 * appear for accounts that were never explicitly granted it.
 * `payment_gateways:view_secrets` is the same trap: `payment_gateways` is an
 * allowed resource, so adding the action to the catalog would have handed every
 * pre-RBAC admin the plaintext API keys, signing secrets and RSA private keys
 * of every gateway — the exact exposure that action exists to close.
 */
const LEGACY_ADMIN_DENIED_TOKENS: ReadonlySet<string> = new Set([
  'users:export_registration',
  'payments:refund',
  'payment_gateways:view_secrets',
]);

/**
 * The one role name that means "everything". Held apart from the seed list
 * because `resolvePermissions` grants the whole catalog on seeing it, so the
 * literal must appear in exactly one place and must be compared together with
 * `isSystem` (see `resolvePermissions`).
 */
const SUPERADMIN_ROLE_NAME = 'superadmin';

/**
 * Names the boot seed owns, and therefore names an operator may not create a
 * role under. Every seeded system role is reserved, not just `superadmin`: the
 * seed identifies its rows by NAME, so a custom role squatting on one gets
 * silently promoted to `isSystem` by `seedSystemRoles` on the next boot,
 * keeping whatever permissions it was created with and becoming undeletable.
 *
 * Exported because `ConfigImportService` writes `adminRole` through Prisma
 * directly and must refuse them too — an import that could set
 * `name: 'superadmin'` and `isSystem: true` walks straight past every guard in
 * this file and lands on the `grantedAll` short-circuit below.
 */
export const RESERVED_ROLE_NAMES: ReadonlySet<string> = new Set(SYSTEM_ROLES.map((r) => r.name));

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

  public constructor(
    private readonly prismaService: PrismaService,
    // @Optional() and trailing so `new RbacService(prisma)` keeps working and a
    // container without the realtime module still boots.
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Lazily-resolved realtime gateway — the same `ModuleRef` escape hatch used at
   * every other revocation site (`admin-auth.service.ts`, `passkey.service.ts`,
   * `admin-admins.controller.ts`) and by `SystemEventsService:685`.
   */
  private realtimeGatewayCache:
    | import('../../realtime/realtime.gateway').RealtimeGateway
    | null = null;
  private realtimeGatewayResolved = false;

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

  /**
   * Drops the realtime stream of every admin bound to `roleId`.
   *
   * WHY THE HOLDERS HAVE TO BE LOOKED UP. A role row does not name them: the
   * binding is `AdminUser.rbacRoleId` — the `rbacRoleId` column and the
   * `rbacRole` relation on `model AdminUser` in `prisma/schema.prisma`, a plain
   * one-to-many whose back-relation is `admins AdminUser[]` on `AdminRole`;
   * there is no join table — so the holder list only exists as a query. And
   * `rbacRoleId` is genuinely the ONLY binding to a stored matrix:
   * `resolvePermissions` reads a DB role when `rbacRoleId` is set, and
   * otherwise falls back to `LEGACY_ADMIN_ALLOWED_RESOURCES` for a bare
   * `ADMIN` — a compile-time constant this method cannot change — while `DEV`
   * short-circuits inside `hasPermission` before any lookup. So one query
   * covers the whole surface.
   *
   * Ordering is load-bearing: this runs AFTER the transaction commits and AFTER
   * `invalidateAllCache()`. Dropping sockets any earlier would have the clients
   * re-resolve against the OLD matrix — the same bug, one reconnect later.
   */
  private async revokeRoleHolders(roleId: string, reason: string): Promise<void> {
    // Resolved first so a runtime with no gateway does not pay for the query.
    const gateway = this.resolveRealtimeGateway();
    if (!gateway) return;
    try {
      const holders = await this.prismaService.adminUser.findMany({
        where: { rbacRoleId: roleId },
        select: { id: true },
      });
      if (holders.length === 0) return;
      const dropped = gateway.disconnectAdmins(
        holders.map((holder) => holder.id),
        reason,
      );
      if (dropped > 0) {
        this.logger.log(
          `Realtime sessions revoked for role ${roleId}: ${dropped} socket(s) across `
            + `${holders.length} holder(s) (${reason})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Realtime session revocation failed for role ${roleId}: ${(err as Error).message}`,
      );
    }
  }

  // ── Module lifecycle ───────────────────────────────────────────────────

  public async onModuleInit(): Promise<void> {
    try {
      await this.seedSystemRoles();
    } catch (err) {
      // Fail soft: a missing DB on cold start should not block app boot.
      //
      // NOTHING RETRIES THIS. The comment that stood here promised the next
      // role-mutation request would re-run the seed because it is idempotent;
      // idempotent it is, but `seedSystemRoles` has exactly two callers - this
      // one and `POST /admin/rbac/roles/sync-system` - and no mutation path
      // touches it. So after a failed boot seed the system roles stay missing
      // until someone presses that button or restarts the process. That
      // mattered while `superadmin` was resolved by name alone: the missing
      // seed row freed the name for `createRole` to hand out.
      // `RESERVED_ROLE_NAMES` and the `isSystem` qualification in
      // `resolvePermissions` now close that window instead of leaning on a
      // retry that does not exist.
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
    /**
     * Flat `resource:action` tokens the ACTING admin effectively holds.
     * Required, not optional: a caller that forgot to pass it would otherwise
     * get an unattenuated role editor back, which is the hole this parameter
     * exists to close.
     */
    readonly actorPermissions: ReadonlySet<string>;
  }): Promise<AdminRoleInterface> {
    this.assertPermissionsValid(input.permissions);
    this.assertNameNotReserved(input.name);
    this.assertGrantsWithinActor(input.permissions, input.actorPermissions);
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
      /** See `createRole` - the acting admin's effective grant set. */
      readonly actorPermissions: ReadonlySet<string>;
    },
  ): Promise<AdminRoleInterface> {
    this.assertPermissionsValid(input.permissions);
    this.assertGrantsWithinActor(input.permissions, input.actorPermissions);
    const { updated, before } = await this.prismaService.$transaction(async (tx) => {
      const existing = await tx.adminRole.findUnique({
        where: { id },
        // `permissions` is read here, inside the transaction and before the
        // rewrite, purely so the matrix can be compared afterwards. It is the
        // only way to tell a real narrowing from a display-name edit, and the
        // difference matters more here than anywhere else: see below.
        select: {
          id: true,
          isSystem: true,
          name: true,
          permissions: { select: { resource: true, action: true } },
        },
      });
      if (!existing) throw new NotFoundException('Role not found');
      // System roles can have their display metadata edited but their
      // permission matrix is immutable through the API. The only
      // exception is `superadmin`, which always owns everything and is
      // re-synced on startup.
      if (existing.isSystem) {
        // No conditional here any more. The one that stood in its place read
        // `input.displayName !== '' || input.description !== undefined` and
        // could not be false: `displayName` is a required `@Length(2, 64)`
        // field on `UpdateAdminRoleDto`, so the left disjunct is always true
        // and the `ForbiddenException` under it was unreachable. Deleting it
        // changes no behaviour and stops the file claiming a check it never
        // performed - display metadata has always been editable on a system
        // role, and only the permission matrix is immutable.
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
      return {
        updated: await tx.adminRole.findUniqueOrThrow({
          where: { id },
          include: ROLE_INCLUDE,
        }),
        before: new Set(
          existing.permissions.map((p) => permissionToToken(p.resource, p.action)),
        ),
      };
    });
    this.invalidateAllCache();

    // The realtime half. `invalidateAllCache()` above repairs the HTTP side —
    // `RbacGuard` re-reads on the next request — but `RealtimeGateway` resolves
    // `allowedTopics` once, at connect, and `broadcast()` tests that snapshot.
    // Nothing refreshes it, and nothing here touches an `admin_user` row, so
    // before this call one role edit could leave EVERY holder of that role
    // over-subscribed with no record that it had happened.
    //
    // Fired only on a NARROWING — a token the role used to hold and no longer
    // does. This is deliberately not the both-directions rule used for a single
    // admin's role change in `admin-admins.controller.ts`, and the difference is
    // not inconsistency, it is that both premises changed:
    //
    //   COST. A drop is not the cheap reconnect it looks like. `deny()` closes
    //   with 4003 and the SPA turns 4003 into `forceEndAdminSession` — a hard
    //   redirect to `/sign-in` (see `disconnectAdmin`). At this site the blast
    //   radius is every holder of the role, so a widening would buy "a topic
    //   arrives sooner" at the price of signing out everyone holding it.
    //
    //   PRECISION. There the two permission sets had to be resolved indirectly
    //   from two role bindings, and a demotion misfiled as a widening would have
    //   left the leak open. Here the two matrices ARE the input and the output:
    //   the comparison is exact, free, and cannot silently answer "widening"
    //   about a narrowing.
    //
    // Any removed token counts, not only the `*:view` ones that map to a realtime
    // topic. Consulting `REALTIME_TOPIC_PERMISSION` here would be more precise and
    // would couple this service to the realtime module's topic table — and would
    // then under-fire, silently, the day that table grows a mapping. Over-firing
    // on a deliberate, infrequent act that takes permissions away is the safe side.
    const after = new Set(
      updated.permissions.map((p) => permissionToToken(p.resource, p.action)),
    );
    const narrowed = [...before].some((token) => !after.has(token));
    if (narrowed) {
      await this.revokeRoleHolders(id, 'role_permissions_narrowed');
    }
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
        seed.name === SUPERADMIN_ROLE_NAME
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
        select: {
          name: true,
          isSystem: true,
          permissions: { select: { resource: true, action: true } },
        },
      });
      if (role) {
        // `isSystem` as well as the name. On the name alone this was a wildcard
        // handed out by string comparison: `createRole` accepted the literal
        // `superadmin` and wrote `isSystem: false`, so the only thing between
        // an operator and a self-made all-permissions role was the unique-name
        // collision with the boot seed - and the boot seed fails soft (see
        // `onModuleInit`) with nothing retrying it.
        if (role.isSystem && role.name === SUPERADMIN_ROLE_NAME) grantedAll = true;
        for (const p of role.permissions) {
          granted.add(permissionToToken(p.resource, p.action));
        }
      }
    } else if (admin.role === UserRole.ADMIN) {
      // Legacy fallback for accounts that pre-date RBAC (no rbacRoleId — the
      // UI's "No role" option). Grant only an EXPLICIT allowlist of safe
      // (resource, action) pairs so the panel keeps working, rather than
      // "everything minus a few deletes". The previous grant-all-then-subtract
      // logic implicitly handed a bare ADMIN money-affecting, destructive and
      // secret-bearing surfaces (add_on_entitlements, config_portability:export
      // which contains webhook secrets, backups, api_tokens, system_logs,
      // automations, webhooks, …) — effectively near-superadmin. Those
      // resources are simply absent from the allowlist below; they now require
      // DEV / superadmin or an explicit custom role.
      for (const [resource, actions] of Object.entries(RBAC_RESOURCES)) {
        if (!LEGACY_ADMIN_ALLOWED_RESOURCES.has(resource)) continue;
        for (const action of actions) {
          if (LEGACY_ADMIN_DENIED_TOKENS.has(permissionToToken(resource, action))) {
            continue;
          }
          granted.add(permissionToToken(resource, action));
        }
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

  /**
   * The admin's effective grants as flat `resource:action` tokens.
   *
   * The same shape `config-import.service.ts` takes as `importerPermissions`,
   * and for the same reason: every privilege-attenuation check in this codebase
   * asks one question - is what is being granted a subset of what the actor
   * already holds - and it should ask it against one representation. DEV and
   * `superadmin` resolve to the full catalog, so both pass every such check.
   */
  public async getEffectivePermissionTokens(admin: {
    readonly id: string;
    readonly role: UserRole;
    readonly rbacRoleId: string | null;
  }): Promise<ReadonlySet<string>> {
    const effective = await this.getEffectivePermissions(admin);
    return new Set(effective.map((p) => permissionToToken(p.resource, p.action)));
  }

  /**
   * What assigning this role to an admin would actually grant them, as flat
   * tokens. `null` when the role does not exist.
   *
   * Reads the `superadmin` wildcard the same way `resolvePermissions` does
   * rather than counting the role's stored permission rows: those two answers
   * differ whenever the seed has not run, and the caller that matters here -
   * may this actor hand this role to somebody - has to be told the LARGER of
   * the two, or a half-seeded `superadmin` reads as a small role.
   */
  public async getRoleGrantTokens(roleId: string): Promise<ReadonlySet<string> | null> {
    const role = await this.prismaService.adminRole.findUnique({
      where: { id: roleId },
      select: {
        name: true,
        isSystem: true,
        permissions: { select: { resource: true, action: true } },
      },
    });
    if (!role) return null;
    if (role.isSystem && role.name === SUPERADMIN_ROLE_NAME) {
      return new Set(getAllPermissions().map((p) => permissionToToken(p.resource, p.action)));
    }
    return new Set(role.permissions.map((p) => permissionToToken(p.resource, p.action)));
  }

  /**
   * Refuses to write a grant the actor does not itself hold.
   *
   * Without this, `rbac_roles:edit` was `admins:edit` was superadmin: an admin
   * opens the role editor on their own custom (non-system) role, ticks
   * `admins:edit`, saves, then PATCHes their own account to `role: DEV`. Every
   * step passed its own validation - the permissions were all real catalog
   * entries, the role was theirs to edit - and nothing anywhere asked whether
   * the actor was allowed to hand out what they were handing out.
   *
   * Semantics deliberately match `config-import.service.ts`, which already
   * enforces exactly this on the import path: same `resource:action` token,
   * same subset rule, same full-catalog answer for DEV / `superadmin`. The one
   * difference is the response - import silently skips a row it may not write
   * because it is processing a whole payload, while the role editor refuses the
   * request, since an operator who ticked a box needs to be told the box did
   * not take rather than find out later on the permissions screen.
   */
  private assertGrantsWithinActor(
    permissions: readonly AdminPermissionInputDto[],
    actorPermissions: ReadonlySet<string>,
  ): void {
    const missing = permissions
      .map((p) => permissionToToken(p.resource, p.action))
      .filter((token) => !actorPermissions.has(token))
      .sort();
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Cannot grant permissions you do not hold: ${[...new Set(missing)].join(', ')}`,
      );
    }
  }

  /** Reserved names belong to the seed; see `RESERVED_ROLE_NAMES`. */
  private assertNameNotReserved(name: string): void {
    if (RESERVED_ROLE_NAMES.has(name)) {
      throw new BadRequestException(`Role name "${name}" is reserved for a system role`);
    }
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
