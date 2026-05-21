import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminDashboardController } from './controllers/admin-dashboard.controller';
import { AdminQuickSearchController } from './controllers/admin-quick-search.controller';
import { DashboardService } from './services/dashboard.service';
import { QuickSearchService } from './services/quick-search.service';

/**
 * Read-only dashboard analytics surface.
 *
 * Includes the Cmd+K cross-domain quick-search backing the
 * `quick-search-overlay.tsx` component on the frontend.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminDashboardController, AdminQuickSearchController],
  providers: [DashboardService, QuickSearchService],
  exports: [DashboardService, QuickSearchService],
})
export class DashboardModule {}
