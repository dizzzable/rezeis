import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { SystemEventsService } from './system-events.service';

/**
 * Global module — SystemEventsService is available everywhere without
 * explicit imports. Every module can inject it to emit events.
 */
@Global()
@Module({
  imports: [HttpModule],
  providers: [SystemEventsService],
  exports: [SystemEventsService],
})
export class SystemEventsModule {}
