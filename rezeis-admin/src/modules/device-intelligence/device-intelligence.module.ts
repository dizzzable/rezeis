import { Global, Module } from '@nestjs/common';

import { DeviceIntelligenceService } from './services/device-intelligence.service';

/**
 * Device signals reported by the cabinet.
 *
 * `@Global()` for the same reason `BlockedIdentitiesModule` is: the writer is
 * the cabinet-facing internal API, the readers are the users list, the user
 * card and the block cascade, and those live in modules that already import
 * each other in the other direction. A local provider in each would give the
 * process several services and several ideas of what a device match means.
 *
 * No controller of its own — the write is one endpoint on the internal user
 * controller (where the caller is already authenticated as a user) and the
 * reads hang off the admin user surfaces (where the operator already is).
 */
@Global()
@Module({
  providers: [DeviceIntelligenceService],
  exports: [DeviceIntelligenceService],
})
export class DeviceIntelligenceModule {}
