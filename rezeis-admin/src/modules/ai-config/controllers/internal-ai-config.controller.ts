import { Controller, Get, UseGuards } from '@nestjs/common';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard.js';
import { AiConfigService } from '../services/ai-config.service.js';
import { AiInstructionService } from '../services/ai-instruction.service.js';

@Controller('internal/ai-config')
@UseGuards(InternalAdminAuthGuard)
export class InternalAiConfigController {
  public constructor(
    private readonly aiConfigService: AiConfigService,
    private readonly aiInstructionService: AiInstructionService,
  ) {}

  @Get('settings')
  async getSettings() {
    return this.aiConfigService.getSettingsMasked();
  }

  @Get('instructions')
  async getPublicInstructions() {
    return this.aiInstructionService.getPublicInstructions();
  }
}
