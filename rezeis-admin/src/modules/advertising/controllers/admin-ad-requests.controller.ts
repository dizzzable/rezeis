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
import { ModerateRequestDto } from '../dto/advertising.dto';
import { AdPlacementRequestService } from '../services/ad-placement-request.service';

@ApiTags('admin/advertising/requests')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/advertising/requests')
export class AdminAdRequestsController {
  public constructor(
    private readonly requestService: AdPlacementRequestService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @RequirePermission('advertising', 'view')
  @ApiOperation({ summary: 'List partner advertising requests (moderation queue)' })
  public list(@Query('status') status?: string) {
    return this.requestService.listRequests(status);
  }

  @Post(':id/approve')
  @RequirePermission('advertising', 'moderate')
  @ApiOperation({ summary: 'Approve as-is, or counter with adjusted terms' })
  public async approve(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() input: ModerateRequestDto,
  ) {
    const result = await this.requestService.approve(id, admin.id, input);
    await this.audit(admin, req, 'advertising.request.approved', {
      requestId: id,
      status: result.request.status,
    });
    return result;
  }

  @Post(':id/reject')
  @RequirePermission('advertising', 'moderate')
  public async reject(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() input: ModerateRequestDto,
  ) {
    // The reason reaches the partner with the notification. Rejecting in silence
    // left them with a status change and no way to learn what to change.
    const request = await this.requestService.reject(id, admin.id, input.notes ?? null);
    await this.audit(admin, req, 'advertising.request.rejected', {
      requestId: id,
      hasReason: (input.notes ?? '').trim().length > 0,
    });
    return request;
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
