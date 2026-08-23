import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
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
import { BulkUserOperationsDto } from '../dto/bulk-user-operations.dto';
import { BulkUserOperationsService } from '../services/bulk-user-operations.service';

/**
 * Bulk user operations endpoint — backs the multi-select toolbar on
 * the user list page.
 *
 * Permission model
 *   `users:bulk_operations` (already defined in the RBAC catalog).
 *   Single-row mutations like block/unblock keep using the existing
 *   `:telegramId/{block|unblock}` endpoints with the regular
 *   `users:edit` action.
 */
@ApiTags('admin/users/bulk')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/users/bulk')
export class AdminBulkUsersController {
  public constructor(private readonly bulkService: BulkUserOperationsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users', 'bulk_operations')
  @ApiOperation({ summary: 'Executes a bulk action over a set of user IDs' })
  public bulk(
    @Body() dto: BulkUserOperationsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    // `@Req` is here for the same reason every other mutating admin route has
    // it: an audit row wants the ip and user-agent behind the act. This one
    // wrote no audit row at all, so it never needed the request.
    return this.bulkService.execute({
      userIds: dto.userIds,
      action: dto.action,
      payload: dto.payload,
      currentAdmin: admin,
      requestMetadata: extractRequestMetadata(req),
    });
  }
}
