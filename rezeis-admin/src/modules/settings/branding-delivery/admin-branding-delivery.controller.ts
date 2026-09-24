import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { BrandingDeliveryService, type StoredBrandingDeliveryReport } from './branding-delivery.service';

/** What the branding page reads. */
export interface BrandingDeliveryNotice {
  /**
   * The cabinet's report on the appearance the panel serves NOW: the fields it
   * did not take (empty when it took everything). `null` while it has said
   * nothing about this version — just after a save, or a cabinet older than
   * this release.
   */
  readonly report: StoredBrandingDeliveryReport | null;
}

/**
 * AdminBrandingDeliveryController
 * ═══════════════════════════════
 * `GET /api/admin/settings/branding/delivery` — whether the cabinet took the
 * appearance saved on «WEB Reiwa», and if not, which fields it kept at their
 * previous value. The page asks on open and a few times after each save.
 * Read-only; the same permission as reading the branding itself.
 */
@ApiTags('admin/settings')
@Controller('admin/settings/branding/delivery')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'view')
export class AdminBrandingDeliveryController {
  public constructor(private readonly delivery: BrandingDeliveryService) {}

  @Get()
  @ApiOperation({ summary: 'The cabinet’s report on the appearance saved now: fields it did not take' })
  public async get(): Promise<BrandingDeliveryNotice> {
    return { report: await this.delivery.currentReport() };
  }
}
