import type { Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';

import { InternalCustomEmojiController } from '../../custom-emoji/controllers/internal-custom-emoji.controller';
import { InternalLandingConfigController } from '../../landing-config/controllers/internal-landing-config.controller';
import { InternalLegalDocumentsController } from '../../legal-documents/controllers/internal-legal-documents.controller';
import { InternalBrandingController } from '../../settings/controllers/internal-branding.controller';
import { InternalPlatformPolicyController } from '../../settings/controllers/internal-platform-policy.controller';
import { InternalConnectPageController } from '../../subpage-config/connect-page/connect-page.controllers';
import { InternalGuestSupportController } from '../../support-tickets/controllers/internal-guest-support.controller';
import { InternalBotConfigController } from '../controllers/internal-bot-config.controller';
import { CONFIG_VERSION_KEY } from './config-versions.constants';
import type { ConfigVersionSource } from './config-versions.service';

/**
 * Where each group's payload is read from: THE ROUTE HANDLER ITSELF
 * ═════════════════════════════════════════════════════════════════
 * A version has to be computed from exactly what the cabinet receives, or the
 * cabinet's copy never matches it. The public config shows why a service call
 * would not do: its payload is assembled inside the controller, from four
 * services and the env, and a second assembly here would be a copy that drifts
 * the first time either side gains a field.
 *
 * So each source calls the same handler the route calls, on the same instance
 * Nest built for the route, and hashes what it returns through the same
 * `JSON.stringify` Express uses (`config-version-hash.ts`). Guards, pipes and
 * interceptors are not in the way: none of these routes transforms its answer —
 * `test/config-versions.spec.ts` pins that each source reads the handler of the
 * route the cabinet calls.
 *
 * Looked up lazily, per read: the handlers live in their own modules, and
 * importing those modules here would close cycles through the modules that
 * import this one. `strict: false` finds a controller in whichever module
 * declares it.
 */
export function buildConfigVersionSources(moduleRef: ModuleRef): readonly ConfigVersionSource[] {
  const handler = <T>(type: Type<T>): T => moduleRef.get(type, { strict: false });
  return [
    {
      key: CONFIG_VERSION_KEY.publicConfig,
      read: () => handler(InternalBrandingController).getPublicConfig(),
    },
    {
      key: CONFIG_VERSION_KEY.botConfig,
      read: () => handler(InternalBotConfigController).getBotConfig(),
    },
    {
      key: CONFIG_VERSION_KEY.landing,
      read: () => handler(InternalLandingConfigController).getEffective(),
    },
    {
      key: CONFIG_VERSION_KEY.connectPage,
      read: () => handler(InternalConnectPageController).getEffective(),
    },
    {
      key: CONFIG_VERSION_KEY.platformPolicy,
      read: () => handler(InternalPlatformPolicyController).getPlatformPolicy(),
    },
    {
      key: CONFIG_VERSION_KEY.legalDocumentsRu,
      read: () => handler(InternalLegalDocumentsController).list('ru'),
    },
    {
      key: CONFIG_VERSION_KEY.legalDocumentsEn,
      read: () => handler(InternalLegalDocumentsController).list('en'),
    },
    {
      key: CONFIG_VERSION_KEY.customEmojiPacks,
      read: () => handler(InternalCustomEmojiController).listPacks(),
    },
    {
      key: CONFIG_VERSION_KEY.guestSupport,
      read: () => handler(InternalGuestSupportController).getConfig(),
    },
  ];
}
