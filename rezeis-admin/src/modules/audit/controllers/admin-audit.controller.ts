import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { ListAdminAuditEventsQueryDto } from '../dto/list-admin-audit-events-query.dto';
import { ListAuditEventsV2QueryDto } from '../dto/list-audit-events.dto';
import { AdminAuditEventInterface } from '../interfaces/admin-audit-event.interface';
import {
  AuditEventListV2Result,
  AuditFacetsInterface,
} from '../interfaces/audit-event-v2.interface';
import { AuditService } from '../services/audit.service';

/**
 * Two contracts live side-by-side here:
 *   - Legacy `/admin/audit/events` for older callers (kept for back-compat).
 *   - `/admin/audit` (+ `/admin/audit/facets`) for the current React
 *     audit page (`audit-page.tsx`).
 */
@ApiTags('admin/audit')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/audit')
export class AdminAuditController {
  public constructor(private readonly auditService: AuditService) {}

  // ── Legacy ─────────────────────────────────────────────────────────────

  @Get('events')
  @RequirePermission('audit', 'view')
  @ApiOperation({ summary: 'Lists admin audit events (legacy contract)' })
  public listLegacy(
    @Query() query: ListAdminAuditEventsQueryDto,
  ): Promise<readonly AdminAuditEventInterface[]> {
    return this.auditService.listEvents(query);
  }

  // ── V2 ─────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('audit', 'view')
  @ApiOperation({ summary: 'Cursor-paginated audit log with facet filters' })
  @ApiOkResponse({ description: 'Audit page payload' })
  public list(
    @Query() query: ListAuditEventsV2QueryDto,
  ): Promise<AuditEventListV2Result> {
    return this.auditService.listEventsV2(query);
  }

  @Get('facets')
  @RequirePermission('audit', 'view')
  @ApiOperation({ summary: 'Distinct values for the audit filter dropdowns' })
  public facets(): Promise<AuditFacetsInterface> {
    return this.auditService.getFacets();
  }

  // ── Export ───────────────────────────────────────────────────────────────

  /**
   * `audit:export`, not `audit:view`. The action exists in the catalog
   * (`rbac.resources.ts`, `audit: ['view', 'export']`) and, until this line,
   * appeared in no decorator anywhere - so the only two roles that ship with
   * `audit:view` (`operator` and `finance`) could download the whole log as a
   * file while the operator who granted them read access had, on the role
   * editor screen, deliberately left the export box unticked. A permission
   * nothing enforces is not a permission.
   *
   * `users:export_registration` and `config_portability:export` are the two
   * routes in this tree that already got this right; this one now matches.
   */
  @Get('export')
  @RequirePermission('audit', 'export')
  @ApiOperation({ summary: 'Download events as a plain-text (.txt) file' })
  public async export(
    @Query() query: ListAuditEventsV2QueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const txt = await this.auditService.exportEventsTxt({
      systemOnly: query.systemOnly === 'true',
      kind: query.kind,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const scope = query.systemOnly === 'true' ? 'system-events' : 'events';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rezeis-${scope}-${stamp}.txt"`);
    res.send(txt);
  }
}
