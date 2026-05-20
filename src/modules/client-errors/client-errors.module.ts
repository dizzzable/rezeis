import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ClientErrorsController } from './client-errors.controller';

/**
 * Tiny module — accepts SPA error reports and forwards them to the
 * SystemEventsService so they land in the audit log + realtime channel
 * alongside server-side events.
 *
 * Reports are best-effort: the controller intentionally returns `204`
 * even when the payload is malformed (the reporter must never amplify
 * the failure).
 */
@Module({
  imports: [AuthModule],
  controllers: [ClientErrorsController],
})
export class ClientErrorsModule {}
