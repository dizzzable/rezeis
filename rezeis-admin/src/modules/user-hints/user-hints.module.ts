import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminUserHintsController } from './controllers/admin-user-hints.controller';
import { InternalUserHintsController } from './controllers/internal-user-hints.controller';
import { HintAudienceService } from './services/hint-audience.service';
import { UserHintDeliveryService } from './services/user-hint-delivery.service';
import { UserHintService } from './services/user-hint.service';

/**
 * In-cabinet hints — the library an operator authors and the queue that owes
 * them to people.
 *
 * ── Two doors, deliberately ───────────────────────────────────────────────
 *
 * `AdminUserHintsController` is the authoring surface: JWT, RBAC, audited.
 * `InternalUserHintsController` is what reiwa calls, behind the shared-secret
 * guard every other internal route uses. They share the services and nothing
 * else — the cabinet must never reach the authoring API, and an operator has no
 * reason to reach the delivery one.
 *
 * ── Why the delivery service is exported ──────────────────────────────────
 *
 * `UserHintDeliveryService.raise()` is what an automation action will call to
 * queue a hint. That action lives in `AutomationsModule`, so the service has to
 * leave this module — but the LIBRARY service does not, because nothing outside
 * an operator's hands should be authoring hint copy.
 */
@Module({
  imports: [AuthModule, RbacModule],
  controllers: [AdminUserHintsController, InternalUserHintsController],
  providers: [UserHintService, UserHintDeliveryService, HintAudienceService],
  exports: [UserHintDeliveryService, HintAudienceService],
})
export class UserHintsModule {}
