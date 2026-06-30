import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { AdminAccountMergeController } from './controllers/admin-account-merge.controller';
import { AccountMergeService } from './services/account-merge.service';
import { AccountMergePreviewService } from './services/account-merge-preview.service';

/**
 * Account-merge — operator-controlled consolidation of two `User` accounts into
 * one (preview + irreversible transactional merge). `PrismaService`,
 * `SystemEventsService` and the RBAC guard come from their global modules;
 * `AuthModule` provides the admin JWT guard infrastructure; `ProfileSyncModule`
 * provides the queue used to re-sync moved subscriptions' Remnawave profiles.
 */
@Module({
  imports: [AuthModule, ProfileSyncModule],
  controllers: [AdminAccountMergeController],
  providers: [AccountMergeService, AccountMergePreviewService],
  exports: [AccountMergeService],
})
export class AccountMergeModule {}
