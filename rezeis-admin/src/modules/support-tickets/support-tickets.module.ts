import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminSupportTicketsController } from './controllers/admin-support-tickets.controller';
import { SupportTicketsService } from './services/support-tickets.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminSupportTicketsController],
  providers: [SupportTicketsService],
  exports: [SupportTicketsService],
})
export class SupportTicketsModule {}
