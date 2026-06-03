import { HttpModule } from '@nestjs/axios';
import { Global, Module } from '@nestjs/common';

import { buildBoundedOutboundHttpOptions } from './outbound-http-options';

@Global()
@Module({
  imports: [HttpModule.register(buildBoundedOutboundHttpOptions())],
  exports: [HttpModule],
})
export class OutboundHttpModule {}
