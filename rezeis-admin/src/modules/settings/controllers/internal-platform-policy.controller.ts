import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { InternalPlatformPolicyInterface } from '../interfaces/internal-platform-policy.interface';
import { SettingsService } from '../services/settings.service';

/**
 * Exposes the user-safe platform policy contract to internal consumers.
 */
@Controller('internal/settings')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalPlatformPolicyController {
  public constructor(private readonly settingsService: SettingsService) {}

  /**
   * Returns the read-only platform policy payload for the user edge.
   */
  @Get('platform-policy')
  public async getPlatformPolicy(): Promise<InternalPlatformPolicyInterface> {
    return this.settingsService.getInternalPlatformPolicy();
  }

  /**
   * Returns whether self-service web registration is currently open.
   *
   * Today the flag is derived from `Settings.accessMode`:
   *   - `PUBLIC`             → registration is open
   *   - everything else      → closed (`INVITE_ONLY`, `MAINTENANCE`, ...)
   *
   * The shape stays stable so we can later back this with a dedicated
   * `registrationEnabled` column without breaking reiwa.
   */
  @Get('registration-toggle')
  public async getRegistrationToggle(): Promise<{ enabled: boolean }> {
    const policy = await this.settingsService.getInternalPlatformPolicy();
    return { enabled: policy.accessMode === 'PUBLIC' };
  }
}
