import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../common/prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AiConfigService } from './services/ai-config.service.js';
import { AiInstructionService } from './services/ai-instruction.service.js';
import { AdminAiConfigController } from './controllers/admin-ai-config.controller.js';
import { AdminAiInstructionController } from './controllers/admin-ai-instruction.controller.js';
import { InternalAiConfigController } from './controllers/internal-ai-config.controller.js';

@Module({
  imports: [PrismaModule, AuthModule, HttpModule],
  providers: [AiConfigService, AiInstructionService],
  controllers: [AdminAiConfigController, AdminAiInstructionController, InternalAiConfigController],
  exports: [AiConfigService, AiInstructionService],
})
export class AiConfigModule {}
