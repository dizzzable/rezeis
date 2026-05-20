import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminAuditController } from './controllers/admin-audit.controller';
import { AuditService } from './services/audit.service';

/**
 * Read-only admin audit log module.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminAuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
