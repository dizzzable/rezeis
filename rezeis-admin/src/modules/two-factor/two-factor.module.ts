import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BlockedIpsModule } from '../blocked-ips/blocked-ips.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminIpAllowlistController } from './controllers/admin-ip-allowlist.controller';
import { AdminTwoFactorController } from './controllers/admin-two-factor.controller';
import { AdminIpAllowlistService } from './services/admin-ip-allowlist.service';
import { LoginGuardService } from './services/login-guard.service';
import { TwoFactorService } from './services/two-factor.service';

/**
 * Phase 5 — Security Hardening for the admin panel.
 *
 * Surfaces
 *   - **2FA (TOTP)** for admin operators (see `TwoFactorService`).
 *   - **Login Guard** auto-blocks IPs after repeated failed logins
 *     (see `LoginGuardService`).
 *   - **Admin IP Allowlist** lets operators restrict the admin panel to
 *     a curated set of IPs/CIDRs (see `AdminIpAllowlistService`).
 *
 * The `AdminIpAllowlistGuard` is registered globally in `app.module.ts`
 * so it runs before any controller-specific guard.
 */
@Module({
  imports: [AuthModule, RbacModule, BlockedIpsModule],
  controllers: [AdminTwoFactorController, AdminIpAllowlistController],
  providers: [TwoFactorService, LoginGuardService, AdminIpAllowlistService],
  exports: [TwoFactorService, LoginGuardService, AdminIpAllowlistService],
})
export class TwoFactorModule {}
