import {
  Controller,
  Get,
  Header,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { AdminUserListQueryDto } from '../dto/admin-user-list-query.dto';
import { AdminUserResolveQueryDto } from '../dto/admin-user-resolve-query.dto';
import { AdminUserSearchQueryDto } from '../dto/admin-user-search-query.dto';
import { AdminUserListResultInterface } from '../interfaces/admin-user-list-item.interface';
import { AdminUserResolveResultInterface } from '../interfaces/admin-user-resolve-result.interface';
import { AdminUserSearchResultInterface } from '../interfaces/admin-user-search-result.interface';
import { AdminUsersService } from '../services/admin-users.service';
import { RegistrationExportService } from '../services/registration-export.service';
import {
  REGISTRATION_EXPORT_DEFAULT_LIMIT,
  REGISTRATION_EXPORT_MAX_LIMIT,
} from '../utils/registration-export.util';

/**
 * Exposes JWT-protected user reads for the admin panel.
 *
 * Routes:
 *   • `GET /admin/users`         — paginated list for the left-rail picker.
 *   • `GET /admin/users/search`  — single-user aggregated lookup.
 *   • `GET /admin/users/resolve` — identifier → single reiwa user (plan picker).
 *   • `GET /admin/users/export/registration.csv` — elevated raw registration PII.
 */
@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
export class AdminUsersController {
  public constructor(
    private readonly adminUsersService: AdminUsersService,
    private readonly registrationExportService: RegistrationExportService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Returns the paginated admin list of users with a free-text search filter.
   */
  @Get()
  @RequirePermission('users', 'view')
  public async listUsers(
    @Query() query: AdminUserListQueryDto,
  ): Promise<AdminUserListResultInterface> {
    return this.adminUsersService.listUsers(query);
  }

  /**
   * Elevated bulk export of registration IP / UA / Referer / UTM.
   * Requires `users:export_registration` (not granted to default operator/support).
   * Hard-capped at REGISTRATION_EXPORT_MAX_LIMIT rows; audited.
   */
  @Get('export/registration.csv')
  @RequirePermission('users', 'export_registration')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="registration-export.csv"')
  @ApiOperation({ summary: 'Export raw registration snapshot CSV (elevated PII)' })
  public async exportRegistrationCsv(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Res() response: Response,
    @Query('limit') limitRaw?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const limit = limitRaw ? Number(limitRaw) : REGISTRATION_EXPORT_DEFAULT_LIMIT;
    const result = await this.registrationExportService.exportCsv({
      limit: Number.isFinite(limit) ? limit : REGISTRATION_EXPORT_DEFAULT_LIMIT,
      from,
      to,
    });
    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'users.registration.export',
        ipAddress: rm.remoteAddress,
        userAgent: rm.userAgent,
        metadata: {
          requestId: rm.requestId,
          rowCount: result.rowCount,
          limit: result.limit,
          maxLimit: REGISTRATION_EXPORT_MAX_LIMIT,
          from: result.from,
          to: result.to,
        } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });
    response
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="registration-export.csv"')
      .setHeader('X-Export-Row-Count', String(result.rowCount))
      .send(result.csv);
  }

  /**
   * Returns the aggregated admin search payload for a single user lookup.
   */
  @Get('search')
  @RequirePermission('users', 'view')
  public async searchUser(
    @Query() query: AdminUserSearchQueryDto,
  ): Promise<AdminUserSearchResultInterface> {
    return this.adminUsersService.searchUser(query);
  }

  /**
   * Resolves a free-text identifier (reiwa_id / Telegram ID / login / email)
   * to a single reiwa user — used by the plan "Allowed users" picker so admins
   * can add users by any known handle instead of only the reiwa_id.
   */
  @Get('resolve')
  @RequirePermission('users', 'view')
  public async resolveUser(
    @Query() query: AdminUserResolveQueryDto,
  ): Promise<AdminUserResolveResultInterface> {
    return this.adminUsersService.resolveUser(query);
  }
}
