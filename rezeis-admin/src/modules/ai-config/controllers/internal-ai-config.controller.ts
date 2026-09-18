import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { AiConfigService } from '../services/ai-config.service';
import { AiInstructionService } from '../services/ai-instruction.service';

@Controller('internal/ai-config')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
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
