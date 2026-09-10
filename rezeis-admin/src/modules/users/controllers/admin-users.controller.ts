import {
  BadRequestException,
  Controller,
  ForbiddenException,
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
import { RbacService } from '../../rbac/services/rbac.service';
import {
  AdminUserExportQueryDto,
  AdminUserListQueryDto,
} from '../dto/admin-user-list-query.dto';
import { AdminUserResolveQueryDto } from '../dto/admin-user-resolve-query.dto';
import { AdminUserSearchQueryDto } from '../dto/admin-user-search-query.dto';
import { AdminUserListResultInterface } from '../interfaces/admin-user-list-item.interface';
import { AdminUserResolveResultInterface } from '../interfaces/admin-user-resolve-result.interface';
import { AdminUserSearchResultInterface } from '../interfaces/admin-user-search-result.interface';
import { AdminUsersService, buildUserListWhere } from '../services/admin-users.service';
import { RegistrationExportService } from '../services/registration-export.service';
import {
  UserExportService,
  clampUserExportLimit,
} from '../services/user-export.service';
import {
  USER_EXPORT_COLUMNS,
  elevatedAmong,
  resolveExportColumns,
} from '../utils/user-export.catalog';
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
    private readonly userExportService: UserExportService,
    private readonly rbacService: RbacService,
    private readonly prismaService: PrismaService,
  ) {}

  /**
   * Whether this admin may have the registration snapshot columns.
   *
   * Asked rather than assumed: the endpoint is gated on `users:export`, and a
   * role can hold that without holding `users:export_registration` — which is
   * the whole point of the two being separate.
   */
  private hasRegistrationExport(admin: CurrentAdminInterface): Promise<boolean> {
    return this.rbacService.hasPermission(admin, 'users', 'export_registration');
  }

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
   * The column catalogue, so the panel's picker IS the server's list.
   *
   * Served rather than duplicated in the SPA for the reason every other
   * served vocabulary in this codebase exists: a second copy would let an
   * operator tick a column the export does not write, and a column that exports
   * blank reads as "we hold no such data about these people" — a conclusion
   * they would act on.
   *
   * `elevated` travels with it so the picker can show those columns as locked
   * rather than hiding them: an operator who cannot see a column cannot ask for
   * the permission that would give it to them.
   */
  @Get('export/columns')
  @RequirePermission('users', 'export')
  @ApiOperation({ summary: 'Columns the user export can write' })
  public async exportColumns(@CurrentAdmin() admin: CurrentAdminInterface): Promise<{
    columns: ReadonlyArray<{ id: string; group: string; source: string; elevated: boolean }>;
    allowElevated: boolean;
  }> {
    return {
      columns: USER_EXPORT_COLUMNS.map((column) => ({
        id: column.id,
        group: column.group,
        source: column.source,
        elevated: column.elevated === true,
      })),
      allowElevated: await this.hasRegistrationExport(admin),
    };
  }

  /**
   * The full customer export.
   *
   * The filters are the LIST'S filters, taken by the same DTO, so an operator
   * exports exactly the population they were just looking at. `columns` is a
   * comma-separated list of catalogue ids; absent means everything the caller
   * is allowed to have, which is what pressing Export without touching the
   * dialog means.
   *
   * A GET because it is a download: the browser's save dialog wants a URL, and
   * a POST would need the answer stapled into a blob by hand for no gain. The
   * column list is not secret — the file it produces is.
   */
  @Get('export/users.csv')
  @RequirePermission('users', 'export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="users-export.csv"')
  @ApiOperation({ summary: 'Export users as CSV with a chosen column set' })
  public async exportUsersCsv(
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
    @Res() response: Response,
    // ONE DTO for the whole query string. The global pipe runs with
    // `forbidNonWhitelisted`, so an unnamed `@Query()` beside a named one
    // validates EVERYTHING against the unnamed one's class and rejects keys it
    // does not declare — which made every export answer 400.
    @Query() query: AdminUserExportQueryDto,
  ): Promise<void> {
    // A STRING BY THE TIME IT GETS HERE, and not because of the `String(...)`.
    //
    // Express hands a DUPLICATED query parameter — a hand-written or bookmarked
    // `?columns=a&columns=b` — to the pipe as an ARRAY, and the pipe runs
    // BEFORE this handler: the DTO's `@IsString()` refused the whole request
    // with a 400 that read as if the column list were too long. The flattening
    // is therefore a `@Transform` on the DTO (`toCommaJoined`), where it can
    // still change the outcome. The `String(...)` below is belt and braces over
    // a value TypeScript already knows is a string.
    const requested =
      query.columns === undefined
        ? undefined
        : String(query.columns)
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
    const allowElevated = await this.hasRegistrationExport(admin);

    // REFUSED, not silently dropped. The registration snapshot is the
    // customer's IP and user agent, and a column that vanishes from a file
    // without a word is indistinguishable from one that came back empty — so
    // an operator without the permission would read "we have no IP for these
    // people" and be wrong about every row.
    if (!allowElevated) {
      const refused = elevatedAmong(requested);
      if (refused.length > 0) {
        throw new ForbiddenException(
          `These columns need users:export_registration: ${refused.join(', ')}`,
        );
      }
    }

    const columns = resolveExportColumns(requested, { allowElevated });
    if (columns.length === 0) {
      throw new BadRequestException('No exportable columns were selected');
    }

    const limit = clampUserExportLimit(query.rowLimit);
    const result = await this.userExportService.exportCsv({
      where: buildUserListWhere(query),
      columns,
      limit,
    });

    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'users.export',
        ipAddress: rm.remoteAddress,
        userAgent: rm.userAgent,
        // THE COLUMNS ARE IN THE AUDIT ROW, not just the fact of an export.
        // "Somebody exported the users" and "somebody exported every customer's
        // email and expiry date" are different events, and only one of them is
        // worth reading a log for.
        metadata: {
          requestId: rm.requestId,
          rowCount: result.rowCount,
          limit,
          columns: columns.map((column) => column.id),
          elevated: columns.some((column) => column.elevated === true),
          truncated: result.truncated,
          devicesComplete: result.devicesComplete,
          usersWithoutDevices: result.usersWithoutDevices,
        } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });

    // SAID OUT LOUD, not only in the audit row. The registration export beside
    // this one already answers with its count; an export that silently stopped
    // at the ceiling is an operator acting on a base they think is complete.
    response
      .setHeader('X-Export-Row-Count', String(result.rowCount))
      .setHeader('X-Export-Truncated', result.truncated ? 'true' : 'false')
      .send(result.csv);
  }

  /**
   * Elevated bulk export of registration IP / UA / Referer / UTM.
   * Requires `users:export_registration` (not granted to default operator/support).
   * Hard-capped at REGISTRATION_EXPORT_MAX_LIMIT rows; audited.
   *
   * Kept BESIDE the full export rather than folded into it: this one is the
   * registration snapshot and nothing else, and the roles that may pull it are
   * deliberately not the roles that may pull a mailing list.
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
