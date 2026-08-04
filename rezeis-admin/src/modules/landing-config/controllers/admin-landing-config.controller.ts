import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { LandingConfigService } from '../services/landing-config.service';

/**
 * AdminLandingConfigController
 * ────────────────────────────
 * Admin-panel surface for the web landing builder: read draft + published,
 * save the draft (optimistic-concurrency `version` → 409 on stale), publish an
 * immutable revision, roll back, and list revision history. Cache invalidation
 * happens inside the service on publish/rollback (not via an interceptor).
 */
@ApiTags('admin/landing-config')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('landing_config', 'view')
@Controller('admin/landing-config')
export class AdminLandingConfigController {
  public constructor(private readonly landingConfigService: LandingConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Read the landing draft + published config + version' })
  public async get(): Promise<{
    draft: unknown;
    published: unknown;
    version: number;
    stored: boolean;
    hasDraftChanges: boolean;
    corrupted?: {
      issues: readonly { path: string; message: string }[];
      raw: unknown;
    };
  }> {
    const [draft, published] = await Promise.all([
      this.landingConfigService.getDraft(),
      this.landingConfigService.getPublished(),
    ]);
    const hasDraftChanges =
      published === null || JSON.stringify(published) !== JSON.stringify(draft.config);
    return {
      draft: draft.config,
      published,
      version: draft.version,
      stored: draft.stored,
      // Absent in the normal case. Present means `draft` is the bundled default
      // standing in for an unparseable stored row — the admin must warn and
      // must not autosave over it.
      ...(draft.corrupted === undefined ? {} : { corrupted: draft.corrupted }),
      hasDraftChanges,
    };
  }

  @Put()
  @RequirePermission('landing_config', 'edit')
  @ApiOperation({ summary: 'Save the landing draft (optimistic concurrency)' })
  public async save(
    @Body() body: { config?: unknown; version?: number },
  ): Promise<{ config: unknown; version: number }> {
    const expectedVersion = typeof body.version === 'number' ? body.version : 0;
    const payload = body.config ?? body;
    const result = await this.landingConfigService.saveDraft(payload, expectedVersion);
    return { config: result.config, version: result.version };
  }

  @Post('publish')
  @RequirePermission('landing_config', 'edit')
  @ApiOperation({ summary: 'Publish the current draft as an immutable revision' })
  public async publish(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ revisionId: string }> {
    return this.landingConfigService.publish(currentAdmin, extractRequestMetadata(request));
  }

  @Post('rollback/:revisionId')
  @RequirePermission('landing_config', 'edit')
  @ApiOperation({ summary: 'Roll back by re-publishing a prior revision' })
  public async rollback(
    @Param('revisionId') revisionId: string,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ revisionId: string }> {
    return this.landingConfigService.rollback(
      revisionId,
      currentAdmin,
      extractRequestMetadata(request),
    );
  }

  @Get('revisions')
  @ApiOperation({ summary: 'List the bounded landing revision history' })
  public async revisions(): Promise<unknown> {
    return this.landingConfigService.listRevisions();
  }
}
