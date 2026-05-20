import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminPartnersController } from './controllers/admin-partners.controller';
import { InternalPartnerController } from './controllers/internal-partner.controller';
import { PartnerEarningsService } from './services/partner-earnings.service';
import { PartnersService } from './services/partners.service';

/**
 * Partner program module — donor: altshop `src/services/partner*.py`.
 *
 * The module exposes:
 *  - admin CRUD + withdrawal approve/reject under `/admin/partners`
 *  - internal user-facing endpoints under `/internal/user/:telegramId/partner`
 *  - `PartnerEarningsService` for post-payment accrual (called by payments module)
 *  - `PartnersService` for listing, stats, and withdrawal lifecycle
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminPartnersController, InternalPartnerController],
  providers: [PartnersService, PartnerEarningsService],
  exports: [PartnersService, PartnerEarningsService],
})
export class PartnersModule {}
