import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { AdminAddOnCreateDto, AdminAddOnUpdateDto } from '../dto/admin-add-on.dto';
import { AddOnsService, AddOnInterface } from '../services/add-ons.service';

@Controller('admin/add-ons')
@UseGuards(AdminJwtAuthGuard)
export class AdminAddOnsController {
  public constructor(private readonly addOnsService: AddOnsService) {}

  @Get()
  public list(): Promise<readonly AddOnInterface[]> {
    return this.addOnsService.listAll();
  }

  @Post()
  public create(@Body() body: AdminAddOnCreateDto): Promise<AddOnInterface> {
    return this.addOnsService.create(body);
  }

  @Patch(':id')
  public update(@Param('id') id: string, @Body() body: AdminAddOnUpdateDto): Promise<AddOnInterface> {
    return this.addOnsService.update(id, body);
  }

  @Delete(':id')
  public async delete(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.addOnsService.delete(id);
    return { deleted: true };
  }
}
