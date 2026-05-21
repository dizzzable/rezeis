import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminFaqController } from './controllers/admin-faq.controller';
import { InternalFaqController } from './controllers/internal-faq.controller';
import { FaqMediaUploadService } from './services/faq-media-upload.service';
import { FaqService } from './services/faq.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminFaqController, InternalFaqController],
  providers: [FaqService, FaqMediaUploadService],
  exports: [FaqService],
})
export class FaqModule {}
