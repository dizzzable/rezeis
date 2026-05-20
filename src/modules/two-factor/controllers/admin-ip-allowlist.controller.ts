import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  CreateAllowlistEntryDto,
  UpdateAllowlistEntryDto,
} from '../dto/two-factor.dto';
import { AdminIpAllowlistService } from '../services/admin-ip-allowlist.service';

/**
 * Admin IP Allowlist controller.
 *
 * Permission model
 *   - Tied to the `admins` RBAC resource (closest existing match for
 *     "control panel access policy"). DEV admins always pass.
 */
@ApiTags('admin/ip-allowlist')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/ip-allowlist')
export class AdminIpAllowlistController {
  public constructor(private readonly allowlistService: AdminIpAllowlistService) {}

  @Get()
  @RequirePermission('admins', 'view')
  @ApiOperation({ summary: 'Lists allowlist entries' })
  public list() {
    return this.allowlistService.list().then((entries) => ({ items: entries, total: entries.length }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('admins', 'edit')
  @ApiOperation({ summary: 'Adds an IP / CIDR to the allowlist' })
  public create(
    @Body() dto: CreateAllowlistEntryDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ) {
    return this.allowlistService.create({
      address: dto.address,
      label: dto.label ?? '',
      isActive: dto.isActive ?? true,
      createdById: admin.id,
    });
  }

  @Patch(':id')
  @RequirePermission('admins', 'edit')
  @ApiOperation({ summary: 'Updates an allowlist entry' })
  public update(@Param('id') id: string, @Body() dto: UpdateAllowlistEntryDto) {
    return this.allowlistService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('admins', 'delete')
  @ApiOperation({ summary: 'Removes an allowlist entry' })
  public delete(@Param('id') id: string) {
    return this.allowlistService.delete(id);
  }
}
