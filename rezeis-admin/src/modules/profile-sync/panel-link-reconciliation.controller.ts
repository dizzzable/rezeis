import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../rbac/guards/rbac.guard';
import { PanelLinkCheckService } from './panel-link-check.service';
import type { ExtraProfilesResponse, UnlinkedSubscriptionsResponse } from './panel-link-check.types';

/**
 * AdminPanelLinkCheckController
 * ─────────────────────────────
 * What the automatic panel-link check could not prove, for «Подписки» →
 * «Инструменты».
 *
 * THERE IS NO RUN BUTTON ANY MORE (owner's decision, 24.09.2026). The route
 * `POST /admin/profile-sync/panel-link-reconciliation` and the card «Починка
 * привязки к панели» that called it are gone: the same walk runs by itself
 * (`PanelLinkCheckService` — at worker boot, after every backup import, daily,
 * and an hour after a pass that could not finish). What is left for a person
 * is to READ what it could not prove and to link those rows one at a time with
 * «Привязать профиль» (`PATCH /admin/users/subscriptions/:id/remnawave-link`),
 * which checks the proof itself.
 *
 * SAME PERMISSION AS THE BUTTON HAD (`subscriptions:edit`): these lists exist
 * to be acted on with the single-row link, which asks for exactly that.
 */
@Controller('admin/profile-sync/panel-links')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('subscriptions', 'edit')
export class AdminPanelLinkCheckController {
  public constructor(private readonly check: PanelLinkCheckService) {}

  /** «Подписки без привязки к Remnawave»: the rows now without a proven link, each with the check's reason. */
  @Get('unlinked')
  public async listUnlinked(): Promise<UnlinkedSubscriptionsResponse> {
    return this.check.listUnlinked();
  }

  /** «Лишние профили в Remnawave»: the last per-customer comparison, re-checked against the database. */
  @Get('extra-profiles')
  public async listExtraProfiles(): Promise<ExtraProfilesResponse> {
    return this.check.listExtraProfiles();
  }
}
