import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InternalUserModule } from '../internal-user/internal-user.module';
import { ImportsModule } from '../imports/imports.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';
import { PlansModule } from '../plans/plans.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { RbacModule } from '../rbac/rbac.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AdminBulkUsersController } from './controllers/admin-bulk-users.controller';
import { AdminUserManagementController } from './controllers/admin-user-management.controller';
import { AdminUserSubscriptionsController } from './controllers/admin-user-subscriptions.controller';
import { AdminUserWebController } from './controllers/admin-user-web.controller';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AdminUsersService } from './services/admin-users.service';
import { RegistrationExportService } from './services/registration-export.service';
import { BulkUserOperationsService } from './services/bulk-user-operations.service';
import { UserBlockService } from './services/user-block.service';
import { UserDeletionService } from './services/user-deletion.service';

/**
 * Admin users module — full user management surface.
 *
 * Phase 8 adds the bulk operations endpoint
 * (`POST /admin/users/bulk`) along with a dedicated service that
 * translates a single payload into per-row mutations.
 */
@Module({
  imports: [
    AuthModule,
    InternalUserModule,
    ImportsModule,
    NotificationsModule,
    PartnersModule,
    // Supplies `PlansAdminService` to the plan-access toggle on the user card,
    // the same way `PartnersModule` supplies `PartnersService` to the balance
    // adjustment beside it: the write belongs to the module that owns the
    // column, not to whichever screen happens to reach it.
    PlansModule,
    ProfileSyncModule,
    RbacModule,
    ReferralsModule,
    RemnawaveModule,
    SubscriptionsModule,
  ],
  controllers: [AdminUsersController, AdminUserManagementController, AdminUserSubscriptionsController, AdminUserWebController, AdminBulkUsersController],
  providers: [AdminUsersService, BulkUserOperationsService, RegistrationExportService, UserBlockService, UserDeletionService],
})
export class UsersModule {}
