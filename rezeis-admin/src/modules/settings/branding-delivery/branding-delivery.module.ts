import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { AdminBrandingDeliveryController } from './admin-branding-delivery.controller';
import { BrandingDeliveryService } from './branding-delivery.service';
import { InternalBrandingDeliveryController } from './internal-branding-delivery.controller';

/**
 * BrandingDeliveryModule
 * ──────────────────────
 * «Кабинет не принял часть оформления» on the branding page: the cabinet
 * reports which fields of each public-config version it did not take
 * (`InternalBrandingDeliveryController`), and the page reads the report on
 * the version the panel serves now (`AdminBrandingDeliveryController`).
 *
 * `RawCacheService` (the store) and `ConfigVersionsService` (the current
 * version) come from global modules; `AuthModule` brings both guards'
 * credentials. Imported by `SettingsModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [InternalBrandingDeliveryController, AdminBrandingDeliveryController],
  providers: [BrandingDeliveryService],
})
export class BrandingDeliveryModule {}
