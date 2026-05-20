import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BlockedIpsController } from './controllers/blocked-ips.controller';
import { BlockedIpGuard } from './guards/blocked-ip.guard';
import { BlockedIpService } from './services/blocked-ip.service';

/**
 * Blocked IPs module.
 *
 * Two responsibilities live together:
 *   - The `BlockedIpService` exposes the CRUD surface used by both the
 *     admin UI and the automation `block_ip` action.
 *   - The `BlockedIpGuard` consults the service on every guarded request
 *     and rejects matches with `403`. Apply at the controller / app level
 *     where you want to protect privileged endpoints.
 *
 * The module is `@Global()` so any controller can `@UseGuards(BlockedIpGuard)`
 * without re-importing this module.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [BlockedIpsController],
  providers: [BlockedIpService, BlockedIpGuard],
  exports: [BlockedIpService, BlockedIpGuard],
})
export class BlockedIpsModule {}
