import { Global, Module } from '@nestjs/common';
import { RawCacheService } from './raw-cache.service';

@Global()
@Module({
  providers: [RawCacheService],
  exports: [RawCacheService],
})
export class RawCacheModule {}
