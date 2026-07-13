import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { AdminAddOnCreateDto, AdminAddOnUpdateDto } from '../dto/admin-add-on.dto';
import { AddOnsService, AddOnInterface } from '../services/add-ons.service';

@Controller('admin/add-ons')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('add_ons', 'view')
export class AdminAddOnsController {
  public constructor(private readonly addOnsService: AddOnsService) {}

  @Get()
  public list(): Promise<readonly AddOnInterface[]> {
    return this.addOnsService.listAll();
  }

  @Post()
  @RequirePermission('add_ons', 'create')
  public create(@Body() body: AdminAddOnCreateDto): Promise<AddOnInterface> {
    return this.addOnsService.create(body);
  }

  @Patch(':id')
  @RequirePermission('add_ons', 'edit')
  public update(@Param('id') id: string, @Body() body: AdminAddOnUpdateDto): Promise<AddOnInterface> {
    return this.addOnsService.update(id, body);
  }

  @Post(':id/archive')
  @RequirePermission('add_ons', 'edit')
  public archive(@Param('id') id: string): Promise<AddOnInterface> {
    return this.addOnsService.archive(id);
  }

  @Delete(':id')
  @RequirePermission('add_ons', 'delete')
  public async delete(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.addOnsService.delete(id);
    return { deleted: true };
  }
}
