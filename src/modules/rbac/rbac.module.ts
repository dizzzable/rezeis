import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminAdminsController } from './controllers/admin-admins.controller';
import { AdminAuthPermissionsController } from './controllers/admin-auth-permissions.controller';
import { AdminRbacController } from './controllers/admin-rbac.controller';
import { RbacGuard } from './guards/rbac.guard';
import { RbacService } from './services/rbac.service';

/**
 * Global RBAC module.
 *
 * `RbacService` and `RbacGuard` are exported so any feature module can
 * gate routes with `@RequirePermission` without re-importing this
 * module. The service runs `seedSystemRoles` on `onModuleInit` to keep
 * the DB in sync with the declarative resource catalog.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AdminRbacController, AdminAuthPermissionsController, AdminAdminsController],
  providers: [RbacService, RbacGuard],
  exports: [RbacService, RbacGuard],
})
export class RbacModule {}
