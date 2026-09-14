import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReiwaCacheInvalidatorService } from '../src/modules/bot-config/services/reiwa-cache-invalidator.service';
import { EmailDeliveryModule } from '../src/modules/email/email.module';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import { ReiwaRelayModule } from '../src/modules/notifications/reiwa-relay.module';

/**
 * An SMTP save tells the cabinet its email switch may have moved
 * ══════════════════════════════════════════════════════════════
 * The cabinet's public-config carries `emailEnabled` — SMTP on and a host set —
 * and hides "link email" and email password recovery while it is false. That
 * answer is cached for 60 seconds and dropped early only on
 * `reiwa.branding.invalidate`, which this save never sent: an operator who
 * turned SMTP on still had subscribers told there was no email, and one who
 * turned it off still had them offered codes that could not be delivered.
 */

const ENV_SMTP = {
  enabled: false,
  host: null,
  port: 587,
  username: null,
  password: null,
  fromAddress: 'noreply@example.com',
  fromName: 'Rezeis',
  useTls: true,
  useSsl: false,
};

function harness(row: Record<string, unknown> | null) {
  const log: string[] = [];
  const settings = {
    findFirst: async () => row,
    update: async (args: unknown) => {
      log.push('write');
      return args;
    },
  };
  const tx = { settings, $queryRaw: async () => (row === null ? [] : [{ id: row.id }]) };
  const prisma = {
    settings,
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => {
      const result = await work(tx);
      log.push('commit');
      return result;
    },
  };
  const invalidator = {
    invalidateBranding: async (reason: string) => {
      log.push(`branding:${reason}`);
    },
  } satisfies Pick<ReiwaCacheInvalidatorService, 'invalidateBranding'>;
  const service = new EmailDeliveryService(
    ENV_SMTP,
    prisma as never,
    {} as never,
    { info: () => undefined } as never,
    undefined,
    invalidator as unknown as ReiwaCacheInvalidatorService,
  );
  return { service, log };
}

describe('EmailDeliveryService.saveSmtpSettings — the cabinet public-config invalidation', () => {
  it('enqueues reiwa.branding.invalidate once the save has committed', async () => {
    const { service, log } = harness({ id: 'settings-1', systemNotifications: { email: { enabled: false } } });

    await service.saveSmtpSettings({ enabled: true, host: 'smtp.example.test' });

    const branding = log.filter((entry) => entry.startsWith('branding:'));
    assert.equal(branding.length, 1, `expected one branding invalidation, got ${JSON.stringify(log)}`);
    assert.ok(log.indexOf('commit') < log.indexOf(branding[0]!), `must follow the commit: ${JSON.stringify(log)}`);
  });

  it('sends nothing when there is no settings row and so nothing was saved', async () => {
    const { service, log } = harness(null);

    await service.saveSmtpSettings({ enabled: true, host: 'smtp.example.test' });

    assert.deepStrictEqual(log.filter((entry) => entry.startsWith('branding:')), []);
  });
});

describe('EmailDeliveryModule wiring for the invalidation', () => {
  // The service takes the invalidator as `@Optional()` (specs construct it
  // positionally), so a module that forgot to provide it would boot cleanly and
  // inject `undefined`: the invalidation would silently never fire in
  // production while every case above stayed green.
  it('declares ReiwaCacheInvalidatorService and imports the relay queue it needs', () => {
    const providers = Reflect.getMetadata('providers', EmailDeliveryModule) as readonly unknown[];
    const imports = Reflect.getMetadata('imports', EmailDeliveryModule) as readonly unknown[];
    assert.ok(providers.includes(ReiwaCacheInvalidatorService), 'the module must provide the invalidator');
    assert.ok(imports.includes(ReiwaRelayModule), 'the invalidator enqueues through ReiwaRelayModule');
    const params = Reflect.getMetadata('design:paramtypes', EmailDeliveryService) as readonly unknown[];
    assert.ok(params.includes(ReiwaCacheInvalidatorService), 'the service must take it by injection');
  });
});
