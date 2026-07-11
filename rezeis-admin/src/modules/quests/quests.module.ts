import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AdminQuestController } from './controllers/admin-quest.controller';
import { InternalQuestChannelController } from './controllers/internal-quest-channel.controller';
import { InternalQuestController } from './controllers/internal-quest.controller';
import { InternalQuestPartnerController } from './controllers/internal-quest-partner.controller';
import { QuestPartnerCallbackController } from './controllers/quest-partner-callback.controller';
import { QuestChannelService } from './services/quest-channel.service';
import { QuestDetectionReconcilerService } from './services/quest-detection-reconciler.service';
import { QuestIconService } from './services/quest-icon.service';
import { QuestQueryService } from './services/quest-query.service';
import { QuestEventListenerService } from './services/quest-event-listener.service';
import { QuestPartnerService } from './services/quest-partner.service';
import { QuestPartnerSecretRegistry } from './services/quest-partner-secret.registry';
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
 * Phase A: admin CRUD + reward engine (state machine + reconciler) + cabinet
 * query/claim + event-driven completion detection + icon system.
 * Phase B: SUBSCRIBE_CHANNEL — bot-verified membership (fail-closed callback +
 * periodic recheck) via the internal channel controller.
 * Phase C: PARTNER_TASK — manual-code / signed-postback / timed-visit
 * verification with per-partner HMAC secrets and nonce replay protection.
 */
@Module({
  imports: [AuthModule, ProfileSyncModule, SubscriptionsModule],
  controllers: [
    AdminQuestController,
    InternalQuestController,
    InternalQuestChannelController,
    InternalQuestPartnerController,
    QuestPartnerCallbackController,
  ],
  providers: [
    QuestService,
    QuestRewardService,
    QuestReconcilerService,
    QuestChannelService,
    QuestPartnerService,
    {
      // Per-partner HMAC secrets are process-level config (env JSON map), not
      // per-request state — build the registry once at module init.
      provide: QuestPartnerSecretRegistry,
      useFactory: (): QuestPartnerSecretRegistry =>
        QuestPartnerSecretRegistry.fromEnv(process.env.QUEST_PARTNER_SECRETS),
    },
    QuestProgressService,
    QuestQueryService,
    QuestIconService,
    QuestEventListenerService,
    QuestDetectionReconcilerService,
  ],
  exports: [QuestService, QuestRewardService, QuestProgressService, QuestQueryService],
})
export class QuestsModule {}
