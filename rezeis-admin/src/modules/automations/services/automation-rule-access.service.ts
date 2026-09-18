import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { RbacService } from '../../rbac/services/rbac.service';
import {
  describeMissingActionPermission,
  requiredActionPermissions,
  type RequiredActionPermission,
} from '../automation-action-permissions';

/** Who is asking, as the RBAC service reads an admin. */
export interface AutomationActorPrincipal {
  readonly id: string;
  readonly role: UserRole;
  readonly rbacRoleId: string | null;
}

/**
 * Whether an admin may put these actions into a rule — save it, switch it on,
 * or run it by hand.
 *
 * ── Asked of the admin, never of the rule's author ───────────────────────────
 *
 * The admin in front of the screen is who is deciding, so they are who is
 * asked. A rule written by somebody who held the permission does not lend it to
 * whoever switches the rule on later: switching on and running by hand are
 * decisions too, and they get the same question as the save.
 *
 * ── Never asked at run time ──────────────────────────────────────────────────
 *
 * A rule fires as the system. Its author's grants are not consulted when an
 * event arrives — a rule whose author later lost a permission keeps running
 * until somebody who holds it, or nobody, touches it again. That is deliberate:
 * a role narrowed on Tuesday must not silently stop every rule its holder ever
 * wrote. Switching a rule OFF and deleting it ask nothing of the actions, so
 * whoever may edit rules can always stop one.
 *
 * ── The same answer as `RbacGuard` ───────────────────────────────────────────
 *
 * `hasPermission`, the method the guard itself calls: DEV passes, a
 * `superadmin` role passes, everyone else is read off their role — one
 * definition of "holds", so this check and the route in front of it cannot
 * disagree about an admin.
 */
@Injectable()
export class AutomationRuleAccessService {
  public constructor(private readonly rbacService: RbacService) {}

  /** The permissions these actions need that this admin does not hold. */
  public async missingFor(
    admin: AutomationActorPrincipal,
    actions: unknown,
  ): Promise<readonly RequiredActionPermission[]> {
    const missing: RequiredActionPermission[] = [];
    for (const entry of requiredActionPermissions(actions)) {
      const held = await this.rbacService.hasPermission(
        { id: admin.id, role: admin.role, rbacRoleId: admin.rbacRoleId ?? null },
        entry.resource,
        entry.action,
      );
      if (!held) missing.push(entry);
    }
    return missing;
  }

  /**
   * Whether this admin may read a `webhook_post` URL whole — path and query,
   * where a receiver's secret usually is. The same test as editing that
   * action: `automations:edit` AND the action's own `webhooks:create`
   * (`RuleReadView` in `automations.service.ts`).
   */
  public async mayReadWebhookUrls(admin: AutomationActorPrincipal): Promise<boolean> {
    const principal = { id: admin.id, role: admin.role, rbacRoleId: admin.rbacRoleId ?? null };
    return (await this.rbacService.hasPermission(principal, 'automations', 'edit'))
      && (await this.rbacService.hasPermission(principal, 'webhooks', 'create'));
  }

  /**
   * Refuses with 403 and one sentence per missing permission.
   *
   * A list rather than one joined sentence: two missing permissions are two
   * separate things for the operator to go and ask for, and the SPA words each
   * one on its own.
   */
  public async assertMayUse(admin: AutomationActorPrincipal, actions: unknown): Promise<void> {
    const missing = await this.missingFor(admin, actions);
    if (missing.length === 0) return;
    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      message: missing.map(describeMissingActionPermission),
    });
  }
}
