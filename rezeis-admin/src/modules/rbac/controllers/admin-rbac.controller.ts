import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { CreateAdminRoleDto, UpdateAdminRoleDto } from '../dto/upsert-admin-role.dto';
import { RbacGuard } from '../guards/rbac.guard';
import {
  AdminRoleInterface,
  AdminRoleListItemInterface,
} from '../interfaces/admin-permission.interface';
import { RBAC_ACTIONS, RbacAction } from '../rbac.resources';
import { RbacService } from '../services/rbac.service';

interface ResourceCatalogResponse {
  readonly actions: readonly RbacAction[];
  readonly resources: Readonly<Record<string, readonly RbacAction[]>>;
}

@ApiTags('admin/rbac')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/rbac')
export class AdminRbacController {
  public constructor(private readonly rbacService: RbacService) {}

  @Get('resources')
  @RequirePermission('rbac_roles', 'view')
  @ApiOperation({ summary: 'Returns the resource × action catalog used by the role editor' })
  @ApiOkResponse({ description: 'Resource catalog' })
  public getResourceCatalog(): ResourceCatalogResponse {
    return {
      actions: RBAC_ACTIONS,
      resources: this.rbacService.listResources(),
    };
  }

  @Get('roles')
  @RequirePermission('rbac_roles', 'view')
  @ApiOperation({ summary: 'Lists every role with admin/permission counts' })
  public listRoles(): Promise<readonly AdminRoleListItemInterface[]> {
    return this.rbacService.listRoles();
  }

  @Get('roles/:id')
  @RequirePermission('rbac_roles', 'view')
  @ApiOperation({ summary: 'Fetches a single role with its full permission matrix' })
  public getRole(@Param('id') id: string): Promise<AdminRoleInterface> {
    return this.rbacService.getRoleById(id);
  }

  @Post('roles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('rbac_roles', 'create')
  @ApiOperation({ summary: 'Creates a new custom role with the supplied permission matrix' })
  public async createRole(
    @Body() dto: CreateAdminRoleDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AdminRoleInterface> {
    return this.rbacService.createRole({
      name: dto.name,
      displayName: dto.displayName,
      description: dto.description ?? null,
      permissions: dto.permissions,
      actorPermissions: await this.actorPermissions(admin),
    });
  }

  @Put('roles/:id')
  @RequirePermission('rbac_roles', 'edit')
  @ApiOperation({ summary: 'Replaces a role display info and (for non-system roles) its permissions' })
  public async updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateAdminRoleDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AdminRoleInterface> {
    return this.rbacService.updateRole(id, {
      displayName: dto.displayName,
      description: dto.description ?? null,
      permissions: dto.permissions,
      actorPermissions: await this.actorPermissions(admin),
    });
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('rbac_roles', 'delete')
  @ApiOperation({ summary: 'Deletes a non-system role that is not assigned to any admin' })
  public async deleteRole(@Param('id') id: string): Promise<void> {
    await this.rbacService.deleteRole(id);
  }

  @Post('roles/sync-system')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rbac_roles', 'edit')
  @ApiOperation({ summary: 'Re-runs the system-role bootstrap (idempotent)' })
  public async syncSystemRoles(): Promise<{ ok: true }> {
    await this.rbacService.seedSystemRoles();
    return { ok: true };
  }

  /**
   * The acting admin's own grants, which bound what the two write routes above
   * may hand out.
   *
   * `rbac_roles:edit` on its own used to be the whole panel: the service
   * validated the submitted pairs against the catalog and nothing else, so an
   * admin could open their own custom role, tick `admins:edit`, save, and then
   * PATCH their own account to `role: DEV`. Resolved here rather than inside
   * the service because only the request knows who is acting -
   * `admin-config-portability.controller.ts` resolves `importerPermissions`
   * the same way for the same reason.
   */
  private actorPermissions(admin: CurrentAdminInterface): Promise<ReadonlySet<string>> {
    return this.rbacService.getEffectivePermissionTokens({
      id: admin.id,
      role: admin.role,
      rbacRoleId: admin.rbacRoleId,
    });
  }
}
