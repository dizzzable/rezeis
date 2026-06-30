import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { AccountMergeDto, AccountMergePreviewQueryDto } from '../dto/account-merge.dto';
import { AccountMergeService } from '../services/account-merge.service';
import { AccountMergePreviewService } from '../services/account-merge-preview.service';

/**
 * Operator-facing account consolidation. `merge-preview` resolves a counterpart
 * account by any identifier and returns a side-by-side comparison + detected
 * conflicts; `merge` performs the irreversible transactional merge. Both gated
 * by the dedicated `users:merge` permission and audited.
 */
@ApiTags('admin/users/merge')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/users')
export class AdminAccountMergeController {
  public constructor(
    private readonly previewService: AccountMergePreviewService,
    private readonly mergeService: AccountMergeService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get(':id/merge-preview')
  @RequirePermission('users', 'merge')
  @ApiOperation({ summary: 'Resolve a counterpart account and preview a merge' })
  public preview(@Param('id') id: string, @Query() query: AccountMergePreviewQueryDto) {
    return this.previewService.preview(id, query.ref);
  }

  @Post('merge')
  @RequirePermission('users', 'merge')
  @ApiOperation({ summary: 'Merge two accounts into one (irreversible)' })
  public async merge(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Body() body: AccountMergeDto,
  ) {
    const result = await this.mergeService.merge({
      sourceId: body.sourceId,
      targetId: body.targetId,
      choices: body.choices ?? {},
      confirm: body.confirm,
      actorAdminId: admin.id,
    });
    await this.audit(admin, req, 'users.accounts_merged', {
      sourceId: body.sourceId,
      targetId: body.targetId,
      movedCounts: result.movedCounts,
    });
    return result;
  }

  private async audit(
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
