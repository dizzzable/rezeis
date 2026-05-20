import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { AdminPermissionInterface } from '../interfaces/admin-permission.interface';
import { RbacService } from '../services/rbac.service';

interface AdminPermissionsResponse {
  readonly permissions: readonly AdminPermissionInterface[];
  readonly mustChangePassword: boolean;
  readonly rbacRoleId: string | null;
  /** Legacy enum role kept for backwards compatibility with the frontend. */
  readonly role: string;
}

/**
 * Backs `GET /admin/auth/permissions` — the call sits next to
 * `/admin/auth/me` from the frontend's perspective but lives in the
 * RBAC module so that AuthModule does not need to depend on RbacService.
 *
 * The frontend `usePermissionStore` reads this once per session and
 * after every route mutation that may change roles.
 */
@ApiTags('admin/auth')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/auth')
export class AdminAuthPermissionsController {
  public constructor(private readonly rbacService: RbacService) {}

  @Get('permissions')
  @ApiOperation({
    summary: 'Returns the effective permission set for the authenticated admin',
  })
  @ApiOkResponse({ description: 'Effective permissions and force-password-change flag' })
  public async getPermissions(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
  ): Promise<AdminPermissionsResponse> {
    const permissions = await this.rbacService.getEffectivePermissions({
      id: currentAdmin.id,
      role: currentAdmin.role,
      rbacRoleId: currentAdmin.rbacRoleId,
    });
    return {
      permissions,
      mustChangePassword: currentAdmin.mustChangePassword,
      rbacRoleId: currentAdmin.rbacRoleId,
      role: currentAdmin.role,
    };
  }
}
