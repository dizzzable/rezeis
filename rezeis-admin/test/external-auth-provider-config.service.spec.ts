import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExternalAuthProvider } from '@prisma/client';

import { ExternalProviderConfigService } from '../src/modules/external-auth/services/external-provider-config.service';

interface Row {
  provider: ExternalAuthProvider;
  isEnabled: boolean;
  displayName: string;
  clientId: string | null;
  clientSecretEnc: string | null;
  usePkce: boolean;
  scopes: string | null;
  useOidc?: boolean;
}

function createService(current: Row | null) {
  const upserts: Array<{ create: unknown; update: unknown }> = [];
  const prisma = {
    externalAuthProviderConfig: {
      findUnique: async () => current,
      findMany: async () => (current ? [current] : []),
      upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        upserts.push({ create: args.create, update: args.update });
        // Echo a plausible resulting row (merge current + create for new rows).
        const base = current ?? {
          provider: args.create.provider as ExternalAuthProvider,
          isEnabled: false,
          displayName: String(args.create.displayName ?? ''),
          clientId: null,
          clientSecretEnc: null,
          usePkce: true,
          scopes: null,
        };
        return {
          ...base,
          ...(args.create as Partial<Row>),
          ...(args.update as Partial<Row>),
        };
      },
    },
  };
  const cryptoService = {
    encrypt: (v: string) => `enc(${v})`,
    decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ''),
  };
  const service = new ExternalProviderConfigService(prisma as never, cryptoService as never);
  return { service, upserts };
}

describe('ExternalProviderConfigService', () => {
  it('refuses to enable an OAuth provider without credentials', async () => {
    const { service } = createService(null);
    await assert.rejects(
      service.updateConfig(ExternalAuthProvider.GOOGLE, { isEnabled: true }),
      /requires a client id and client secret/,
    );
  });

  it('enables an OAuth provider when client id + secret are provided and encrypts the secret', async () => {
    const { service, upserts } = createService(null);
    const view = await service.updateConfig(ExternalAuthProvider.GOOGLE, {
      isEnabled: true,
      clientId: 'cid',
      clientSecret: 'topsecret',
    });
    assert.equal(view.isEnabled, true);
    assert.equal(view.hasSecret, true);
    // Secret is stored encrypted, never in plaintext.
    const created = upserts[0].create as { clientSecretEnc?: string };
    assert.equal(created.clientSecretEnc, 'enc(topsecret)');
  });

  it('allows enabling Telegram without any client credentials (reuses bot token)', async () => {
    const { service } = createService({
      provider: ExternalAuthProvider.TELEGRAM,
      isEnabled: false,
      displayName: 'Telegram',
      clientId: null,
      clientSecretEnc: null,
      usePkce: false,
      scopes: null,
    });
    const view = await service.updateConfig(ExternalAuthProvider.TELEGRAM, { isEnabled: true });
    assert.equal(view.isEnabled, true);
    assert.equal(view.usesBotToken, true);
  });

  it('decrypts the adapter config for an enabled OAuth provider', async () => {
    const { service } = createService({
      provider: ExternalAuthProvider.YANDEX,
      isEnabled: true,
      displayName: 'Yandex',
      clientId: 'yid',
      clientSecretEnc: 'enc(ysecret)',
      usePkce: true,
      scopes: null,
    });
    const cfg = await service.getEnabledAdapterConfig(ExternalAuthProvider.YANDEX);
    assert.equal(cfg.clientId, 'yid');
    assert.equal(cfg.clientSecret, 'ysecret');
  });

  it('rejects adapter config for a disabled provider', async () => {
    const { service } = createService({
      provider: ExternalAuthProvider.YANDEX,
      isEnabled: false,
      displayName: 'Yandex',
      clientId: 'yid',
      clientSecretEnc: 'enc(ysecret)',
      usePkce: true,
      scopes: null,
    });
    await assert.rejects(service.getEnabledAdapterConfig(ExternalAuthProvider.YANDEX));
  });

  it('surfaces Telegram as default-on in the public list before any config row exists', async () => {
    const { service } = createService(null);
    const providers = await service.getEnabledProviders();
    assert.ok(
      providers.some((p) => p.provider === ExternalAuthProvider.TELEGRAM),
      'Telegram must be enabled by default without a seeded row',
    );
    // OAuth providers stay default-off until explicitly configured + enabled.
    assert.equal(providers.some((p) => p.provider === ExternalAuthProvider.GOOGLE), false);
  });

  it('treats Telegram as enabled by default in isProviderEnabled (OAuth default-off)', async () => {
    const { service } = createService(null);
    assert.equal(await service.isProviderEnabled(ExternalAuthProvider.TELEGRAM), true);
    assert.equal(await service.isProviderEnabled(ExternalAuthProvider.GOOGLE), false);
  });

  it('respects an explicit admin disable of Telegram', async () => {
    const { service } = createService({
      provider: ExternalAuthProvider.TELEGRAM,
      isEnabled: false,
      displayName: 'Telegram',
      clientId: null,
      clientSecretEnc: null,
      usePkce: false,
      scopes: null,
    });
    assert.equal(await service.isProviderEnabled(ExternalAuthProvider.TELEGRAM), false);
    const providers = await service.getEnabledProviders();
    assert.equal(providers.some((p) => p.provider === ExternalAuthProvider.TELEGRAM), false);
  });

  it('reports Telegram mode=oidc when OIDC is on with client credentials', async () => {
    const { service } = createService({
      provider: ExternalAuthProvider.TELEGRAM,
      isEnabled: true,
      displayName: 'Telegram',
      clientId: 'tg-id',
      clientSecretEnc: 'enc(tg-secret)',
      usePkce: true,
      scopes: null,
      useOidc: true,
    });
    const tg = (await service.getEnabledProviders()).find(
      (p) => p.provider === ExternalAuthProvider.TELEGRAM,
    );
    assert.equal(tg?.mode, 'oidc');
  });

  it('reports Telegram mode=widget when OIDC is off (default)', async () => {
    const { service } = createService(null);
    const tg = (await service.getEnabledProviders()).find(
      (p) => p.provider === ExternalAuthProvider.TELEGRAM,
    );
    assert.equal(tg?.mode, 'widget');
  });

  it('refuses to enable Telegram OIDC without client credentials', async () => {
    const { service } = createService({
      provider: ExternalAuthProvider.TELEGRAM,
      isEnabled: false,
      displayName: 'Telegram',
      clientId: null,
      clientSecretEnc: null,
      usePkce: false,
      scopes: null,
    });
    await assert.rejects(
      service.updateConfig(ExternalAuthProvider.TELEGRAM, { isEnabled: true, useOidc: true }),
      /requires a client id and client secret/,
    );
  });
});
