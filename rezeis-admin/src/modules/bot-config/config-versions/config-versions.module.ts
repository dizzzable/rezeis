import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { AuthModule } from '../../auth/auth.module';
import { ReiwaRelayModule } from '../../notifications/reiwa-relay.module';
import { ConfigDeliveryCheckProcessor } from './config-delivery-check.processor';
import { ConfigDeliveryCheckService } from './config-delivery-check.service';
import { ConfigDeliveryState } from './config-delivery-state';
import { buildConfigVersionSources } from './config-version-sources';
import { CONFIG_DELIVERY_CHECK_QUEUE, CONFIG_DELIVERY_TRACKER } from './config-versions.constants';
import { CONFIG_VERSION_SOURCES, ConfigVersionsService } from './config-versions.service';
import { InternalConfigVersionsController } from './internal-config-versions.controller';

/**
 * ConfigVersionsModule
 * ────────────────────
 * The cabinet's settings delivery, panel side: the versions the cabinet polls
 * (`InternalConfigVersionsController`), and the check that tells the operator
 * when a save did not arrive (`ConfigDeliveryCheckService` on its own queue).
 *
 * GLOBAL, for one consumer: `CONFIG_DELIVERY_TRACKER`. The tracker is what
 * `ReiwaCacheInvalidatorService` — declared in seven modules — and
 * `ReiwaRelayProcessor` tell about every hint, and a module import from each of
 * those would close a cycle back through the modules this one reads. They take
 * it `@Optional()`, by token (`config-versions.constants.ts`).
 *
 * Imported once, by `BotConfigModule`, the module that serves the bot's config
 * and owns the hints.
 */
@Global()
@Module({
  imports: [
    AuthModule,
    // The relay's recorder: the delivery check's card is the relay's own
    // `reiwa.relay_undelivered`, counted against the same alert windows.
    ReiwaRelayModule,
    BullModule.registerQueue({ name: CONFIG_DELIVERY_CHECK_QUEUE }),
  ],
  controllers: [InternalConfigVersionsController],
  providers: [
    {
      provide: CONFIG_VERSION_SOURCES,
      inject: [ModuleRef],
      useFactory: buildConfigVersionSources,
    },
    ConfigVersionsService,
    ConfigDeliveryState,
    ConfigDeliveryCheckService,
    ConfigDeliveryCheckProcessor,
    { provide: CONFIG_DELIVERY_TRACKER, useExisting: ConfigDeliveryCheckService },
  ],
  exports: [CONFIG_DELIVERY_TRACKER, ConfigVersionsService],
})
export class ConfigVersionsModule {}
