import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminSystemLogsController } from './controllers/admin-system-logs.controller';
import { SystemLogsService } from './services/system-logs.service';

/**
 * Phase 8 — System Logs.
 *
 * Wires the in-memory ring-buffer logger that backs the admin "Logs"
 * page. Marked `@Global` so `main.ts` can `app.get(SystemLogsService)`
 * and install it as the global Nest logger before the rest of the
 * graph boots — that way every `Logger.log(...)` call recorded during
 * startup also lands in the buffer.
 */
@Global()
@Module({
  imports: [AuthModule, RbacModule],
  controllers: [AdminSystemLogsController],
  providers: [SystemLogsService],
  exports: [SystemLogsService],
})
export class SystemLogsModule {}
