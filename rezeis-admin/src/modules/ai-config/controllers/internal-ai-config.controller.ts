import { Controller, Get, UseGuards } from '@nestjs/common';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { AiConfigService } from '../services/ai-config.service';
import { AiInstructionService } from '../services/ai-instruction.service';

@Controller('internal/ai-config')
@UseGuards(InternalAdminAuthGuard)
export class InternalAiConfigController {
  public constructor(
    private readonly aiConfigService: AiConfigService,
    private readonly aiInstructionService: AiInstructionService,
  ) {}

  @Get('settings')
  async getSettings() {
    return this.aiConfigService.getSettings();
  }

  @Get('instructions')
  async getPublicInstructions() {
    return this.aiInstructionService.getPublicInstructions();
  }
}
