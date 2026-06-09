import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RbacService } from '../../rbac/services/rbac.service';
import {
  ADMIN_NOTIFICATION_CATEGORIES,
  AdminNotificationCategory,
  getCategoryGate,
  isAdminNotificationCategory,
} from '../admin-notification-categories';

interface AdminIdentity {
  readonly id: string;
  readonly role: import('@prisma/client').UserRole;
  readonly rbacRoleId: string | null;
}

export interface AdminCategoryPreference {
  readonly category: AdminNotificationCategory;
  readonly enabled: boolean;
}

/**
 * AdminNotificationPreferencesService
 * ───────────────────────────────────
 * Per-admin per-category opt-in, constrained by RBAC: an admin may only see /
 * tune categories their role permits. Absence of a row ⇒ default enabled.
 */
@Injectable()
export class AdminNotificationPreferencesService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly rbacService: RbacService,
  ) {}

  /** Role-permitted categories with their current enabled state. */
  public async getForAdmin(admin: AdminIdentity): Promise<readonly AdminCategoryPreference[]> {
    const rows = await this.prismaService.adminNotificationPreference.findMany({
      where: { adminId: admin.id },
    });
    const stored = new Map(rows.map((r) => [r.category, r.enabled]));
    const result: AdminCategoryPreference[] = [];
    for (const def of ADMIN_NOTIFICATION_CATEGORIES) {
      const permitted = await this.rbacService.hasPermission(admin, def.resource, def.action);
      if (!permitted) continue;
      result.push({ category: def.category, enabled: stored.get(def.category) ?? true });
    }
    return result;
  }

  /** Update one category, rejecting categories the role does not permit. */
  public async setForAdmin(
    admin: AdminIdentity,
    category: string,
    enabled: boolean,
  ): Promise<void> {
    if (!isAdminNotificationCategory(category)) {
      throw new BadRequestException('Unknown notification category');
    }
    const def = getCategoryGate(category);
    const permitted = await this.rbacService.hasPermission(admin, def.resource, def.action);
    if (!permitted) {
      throw new ForbiddenException('Your role does not permit this notification category');
    }
    await this.prismaService.adminNotificationPreference.upsert({
      where: { adminId_category: { adminId: admin.id, category } },
      create: { adminId: admin.id, category, enabled },
      update: { enabled },
    });
  }

  /**
   * Delivery-time check used by the dispatcher: is the category enabled for
   * this admin? Default `true` when no preference row exists.
   */
  public async isEnabled(adminId: string, category: AdminNotificationCategory): Promise<boolean> {
    const row = await this.prismaService.adminNotificationPreference.findUnique({
      where: { adminId_category: { adminId, category } },
    });
    return row?.enabled ?? true;
  }
}
