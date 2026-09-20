import { Global, Module } from '@nestjs/common';

import { OutboundHttpModule } from '../http/outbound-http.module';
import { StartupAnnouncerService } from './startup-announcer.service';
import { SystemEventsService } from './system-events.service';

/**
 * Global module — SystemEventsService is available everywhere without
 * explicit imports. Every module can inject it to emit events.
 */
@Global()
@Module({
  imports: [OutboundHttpModule],
  providers: [SystemEventsService, StartupAnnouncerService],
  exports: [SystemEventsService],
})
export class SystemEventsModule {}
