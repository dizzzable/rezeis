import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdvertisingModule } from '../src/modules/advertising/advertising.module';
import { ReiwaPublicLinksModule } from '../src/modules/advertising/reiwa-public-links.module';
import { ReiwaAdvertisingLinkConfigService } from '../src/modules/advertising/services/reiwa-advertising-link-config.service';
import { EmailDeliveryModule } from '../src/modules/email/email.module';
import { EmailTemplateRendererService } from '../src/modules/email/services/email-template-renderer.service';
import { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';
import { SupportTicketsModule } from '../src/modules/support-tickets/support-tickets.module';

/**
 * ONE RESOLVER OF THE CABINET'S ADDRESS, AND EVERY LETTER REALLY GETS IT.
 *
 * The ad links asked the cabinet for its address (`/api/v1/public-config`)
 * and fell back to .env; the letters read .env alone, whose two variables ship
 * commented out. A default install therefore had ad links and no letter link,
 * no guest-reply button, while a comment claimed the two agreed.
 *
 * Both letter services now take `ReiwaAdvertisingLinkConfigService`. They take
 * it `@Optional()` — so the specs can build them with `new` — and that is
 * exactly what makes a lost module import silent: Nest injects `undefined`,
 * the service falls back to .env, every unit test stays green, and the
 * default install is back to no link. Hence this structural check.
 */

type Ctor = abstract new (...args: never[]) => object;

/** Every module reachable from `root` through `imports`, including itself. */
function reachableImports(root: unknown): Set<unknown> {
  const seen = new Set<unknown>([root]);
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    const imports = (Reflect.getMetadata('imports', current as object) ?? []) as unknown[];
    for (const imported of imports) {
      const target =
        imported !== null && typeof imported === 'object' && 'module' in imported
          ? (imported as { module: unknown }).module
          : imported;
      if (target === undefined || target === null || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

function takesTheResolver(service: Ctor): boolean {
  const params = (Reflect.getMetadata('design:paramtypes', service) ?? []) as unknown[];
  return params.includes(ReiwaAdvertisingLinkConfigService);
}

function declares(module: unknown, provider: unknown): boolean {
  return ((Reflect.getMetadata('providers', module as object) ?? []) as unknown[]).includes(provider);
}

describe('the cabinet address a letter uses', () => {
  it('is asked of the resolver the ad links use, by both letter services', () => {
    assert.ok(takesTheResolver(EmailTemplateRendererService), 'the footer and the logo do not ask it');
    assert.ok(takesTheResolver(SupportNotificationsService), 'the guest reply button does not ask it');
  });

  it('is actually injected: every module declaring a letter service reaches the resolver', () => {
    assert.ok(declares(EmailDeliveryModule, EmailTemplateRendererService));
    assert.ok(declares(SupportTicketsModule, SupportNotificationsService));
    for (const module of [EmailDeliveryModule, SupportTicketsModule, AdvertisingModule]) {
      assert.ok(
        reachableImports(module).has(ReiwaPublicLinksModule),
        `${(module as { name: string }).name} cannot reach ReiwaPublicLinksModule — its letters fall back to .env`,
      );
    }
  });

  it('comes from one instance, so the ads and the letters share one cache', () => {
    assert.ok(declares(ReiwaPublicLinksModule, ReiwaAdvertisingLinkConfigService));
    // Declared but not exported, an importer sees nothing — and `@Optional()`
    // turns that into the silent .env fallback, not a boot error.
    const exported = (Reflect.getMetadata('exports', ReiwaPublicLinksModule) ?? []) as unknown[];
    assert.ok(exported.includes(ReiwaAdvertisingLinkConfigService), 'the shared module keeps the resolver to itself');
    for (const module of [EmailDeliveryModule, SupportTicketsModule, AdvertisingModule]) {
      assert.ok(
        !declares(module, ReiwaAdvertisingLinkConfigService),
        `${(module as { name: string }).name} declares a second resolver of its own`,
      );
    }
  });
});
