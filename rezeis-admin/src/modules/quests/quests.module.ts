import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AdminQuestController } from './controllers/admin-quest.controller';
import { InternalQuestController } from './controllers/internal-quest.controller';
import { QuestDetectionReconcilerService } from './services/quest-detection-reconciler.service';
import { QuestIconService } from './services/quest-icon.service';
import { QuestQueryService } from './services/quest-query.service';
import { QuestEventListenerService } from './services/quest-event-listener.service';
import { QuestProgressService } from './services/quest-progress.service';
import { QuestReconcilerService } from './services/quest-reconciler.service';
import { QuestRewardService } from './services/quest-reward.service';
import { QuestService } from './services/quest.service';

/**
 * Quests module — gamification tasks that reward users (points / subscription
 * days / promocode / discount / traffic) for activation and engagement.
 *
 * Reward primitives are reused: points credit the shared `User.points` balance,
 * days reuse `SubscriptionMutationsService`, promocodes are minted inline, and
 * profile-sync is enqueued post-commit — mirroring the referral points-exchange.
 *
 * Phase A: admin CRUD + reward engine (state machine + reconciler). Later
 * slices add event-driven completion detection, the cabinet query/claim
 * surface, and the icon system.
 */
@Module({
  imports: [AuthModule, ProfileSyncModule, SubscriptionsModule],
  controllers: [AdminQuestController, InternalQuestController],
  providers: [
    QuestService,
    QuestRewardService,
    QuestReconcilerService,
    QuestProgressService,
    QuestQueryService,
    QuestIconService,
    QuestEventListenerService,
    QuestDetectionReconcilerService,
  ],
  exports: [QuestService, QuestRewardService, QuestProgressService, QuestQueryService],
})
export class QuestsModule {}
