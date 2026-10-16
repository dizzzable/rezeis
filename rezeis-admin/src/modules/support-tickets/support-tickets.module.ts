import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { ReiwaPublicLinksModule } from '../advertising/reiwa-public-links.module';
import { AiConfigModule } from '../ai-config/ai-config.module';
import { AuthModule } from '../auth/auth.module';
import { BlockedIdentitiesModule } from '../blocked-identities/blocked-identities.module';
import { DeviceIntelligenceModule } from '../device-intelligence/device-intelligence.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminSupportTicketsController } from './controllers/admin-support-tickets.controller';
import { InternalGuestSupportController } from './controllers/internal-guest-support.controller';
import { InternalUserSupportController } from './controllers/internal-user-support.controller';
import { SupportAiDispatchService } from './services/support-ai-dispatch.service';
import { SupportNotificationsService } from './services/support-notifications.service';
import { SupportAttachmentService } from './services/support-attachment.service';
import { GuestGateService } from './services/guest-gate.service';
import { SupportGuestService } from './services/support-guest.service';
import { SupportTicketsService } from './services/support-tickets.service';
import { SUPPORT_AI_QUEUE } from './support-ai.constants';

@Module({
  // For `BlockedIdentityService`: silencing a guest device is a MANUAL
  // blocklist entry, and manual is what separates a refusal from the
  // cascade rows every block writes automatically.
  // `ReiwaPublicLinksModule`: the cabinet's address for a guest reply's
  // «Открыть переписку», from the resolver the ad links and letters share.
  // `AiConfigModule` and the `support-ai` queue: whether the AI assistant can
  // answer, and queueing its answer. Its worker is `SupportAiProcessor` in
  // `SupportAiModule`, which depends on this module and not the other way
  // round — see `SupportAiDispatchService`.
  imports: [
    AiConfigModule,
    AuthModule,
    BlockedIdentitiesModule,
    DeviceIntelligenceModule,
    NotificationsModule,
    SettingsModule,
    ReiwaPublicLinksModule,
    BullModule.registerQueue({ name: SUPPORT_AI_QUEUE }),
  ],
  controllers: [
    AdminSupportTicketsController,
    InternalUserSupportController,
    InternalGuestSupportController,
  ],
  providers: [
    SupportTicketsService,
    SupportNotificationsService,
    SupportGuestService,
    SupportAttachmentService,
    GuestGateService,
    SupportAiDispatchService,
  ],
  // `SupportNotificationsService` is exported so a module that posts an
  // operator message of its own — the wheel settling a manual prize — can
  // announce it the same way a reply from the inbox is announced, rather
  // than growing a second, quieter delivery path. `SupportAiDispatchService`
  // for the assistant's worker, which hands threads over through it.
  exports: [SupportTicketsService, SupportGuestService, SupportNotificationsService, SupportAiDispatchService],
})
export class SupportTicketsModule {}
