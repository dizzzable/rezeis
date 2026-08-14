import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiConfigService } from './services/ai-config.service';
import { AiInstructionService } from './services/ai-instruction.service';
import { AiLearningService } from './services/ai-learning.service';
import { AdminAiConfigController } from './controllers/admin-ai-config.controller';
import { AdminAiInstructionController } from './controllers/admin-ai-instruction.controller';
import { InternalAiConfigController } from './controllers/internal-ai-config.controller';

@Module({
  imports: [PrismaModule, AuthModule, HttpModule],
  providers: [AiConfigService, AiInstructionService, AiLearningService],
  controllers: [AdminAiConfigController, AdminAiInstructionController, InternalAiConfigController],
  exports: [AiConfigService, AiInstructionService],
})
export class AiConfigModule {}
