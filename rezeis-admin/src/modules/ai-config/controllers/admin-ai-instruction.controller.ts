import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { AiInstructionService } from '../services/ai-instruction.service.js';
import { CreateAiInstructionDto, UpdateAiInstructionDto } from '../dto/ai-instruction.dto.js';

@Controller('admin/ai-instructions')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'edit')
export class AdminAiInstructionController {
  public constructor(private readonly aiInstructionService: AiInstructionService) {}

  @Get()
  async listAll() {
    return this.aiInstructionService.listAll();
  }

  @Post()
  async create(@Body() dto: CreateAiInstructionDto) {
    return this.aiInstructionService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateAiInstructionDto) {
    return this.aiInstructionService.update(id, dto);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.aiInstructionService.delete(id);
    return { success: true };
  }
}
