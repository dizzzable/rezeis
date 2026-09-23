import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { advertisingConfig } from '../../common/config/advertising.config';
import { ReiwaAdvertisingLinkConfigService } from './services/reiwa-advertising-link-config.service';

/**
 * The cabinet's public links — its address and its bot — resolved in ONE
 * place for every module that sends a customer there: the ad links, and the
 * letters (footer link, the guest reply's «Открыть переписку», the logo).
 *
 * Its own module, with nothing but the config it reads, so the email and
 * support modules can import it without pulling the advertising cabinet (and
 * the subscriptions and notifications it imports) into their graph. Nest makes
 * one instance of it for every importer, so there is one cache as well.
 */
@Module({
  imports: [ConfigModule.forFeature(advertisingConfig)],
  providers: [ReiwaAdvertisingLinkConfigService],
  exports: [ReiwaAdvertisingLinkConfigService],
})
export class ReiwaPublicLinksModule {}
