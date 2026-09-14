import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ReiwaCacheInvalidatorService } from '../bot-config/services/reiwa-cache-invalidator.service';
import { ReiwaRelayModule } from '../notifications/reiwa-relay.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminCustomEmojiController } from './controllers/admin-custom-emoji.controller';
import { InternalCustomEmojiController } from './controllers/internal-custom-emoji.controller';
import { CustomEmojiService } from './services/custom-emoji.service';
import { CustomEmojiSeedService } from './services/custom-emoji-seed.service';
import { EmojiAssetUploadService } from './services/emoji-asset-upload.service';

/**
 * Custom emoji packs: operator-uploaded emoji libraries (static PNG + Lottie)
 * inserted into broadcasts as `:slug:` shortcodes. Rendered inline in the
 * reiwa cabinet feed; Telegram receives the per-emoji fallback glyph.
 *
 * `ReiwaCacheInvalidatorService` is declared here, with the `ReiwaRelayModule`
 * it enqueues through, for the reason `LegalDocumentsModule` gives: a pack edit
 * has to drop the bot's config and the cabinet's pack list, and importing
 * `BotConfigModule` for one stateless dispatcher would pull the bot editor in.
 */
@Module({
  imports: [AuthModule, SettingsModule, ReiwaRelayModule],
  controllers: [AdminCustomEmojiController, InternalCustomEmojiController],
  providers: [
    CustomEmojiService,
    CustomEmojiSeedService,
    EmojiAssetUploadService,
    ReiwaCacheInvalidatorService,
  ],
  exports: [CustomEmojiService],
})
export class CustomEmojiModule {}
