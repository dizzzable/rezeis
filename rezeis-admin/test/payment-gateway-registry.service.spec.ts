import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType } from '@prisma/client';

import { PaymentGatewayMoveDirection } from '../src/modules/payments/dto/move-payment-gateway.dto';
import { PaymentGatewayRegistryService } from '../src/modules/payments/services/payment-gateway-registry.service';

// The gateway secret cipher reads `process.env` at call time, so the at-rest
// specs below need key material present regardless of the shell environment.
process.env.REZEIS_CRYPT_KEY ??= 'registry-spec-crypt-key-that-is-32plus!!';

describe('PaymentGatewayRegistryService', () => {
  it('creates default gateways idempotently', async () => {
    const { service } = createService([]);
    const expectedDefaultTypes = [
      PaymentGatewayType.TELEGRAM_STARS,
      PaymentGatewayType.YOOKASSA,
      PaymentGatewayType.ANTILOPAY,
      PaymentGatewayType.PLATEGA,
      PaymentGatewayType.OVERPAY,
      PaymentGatewayType.PAYPALYCH,
      PaymentGatewayType.RIOPAY,
      PaymentGatewayType.HELEKET,
      PaymentGatewayType.CRYPTOMUS,
      PaymentGatewayType.MULENPAY,
      PaymentGatewayType.WATA,
      PaymentGatewayType.AURAPAY,
      PaymentGatewayType.ROLLYPAY,
      PaymentGatewayType.SEVERPAY,
      PaymentGatewayType.LAVA,
      PaymentGatewayType.CRYPTOPAY,
      PaymentGatewayType.VALUTIX,
    ];

    const firstCreate = await service.createDefaults();
    const secondCreate = await service.createDefaults();

    assert.equal(firstCreate.length, expectedDefaultTypes.length);
    assert.equal(secondCreate.length, expectedDefaultTypes.length);
    assert.deepStrictEqual(firstCreate.map((gateway) => gateway.type), expectedDefaultTypes);
    assert.deepStrictEqual(secondCreate.map((gateway) => gateway.type), expectedDefaultTypes);
  });

  it('updates active flag, currency, and settings', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
        settings: { shopId: 'shop-old', apiKey: 'key-old' },
      }),
    ]);

    // Reveal requested: this asserts what was PERSISTED, and the default
    // response now masks secrets for callers without `view_secrets`.
    const updatedGateway = await service.updateGateway(
      'gateway-1',
      {
        isActive: false,
        currency: Currency.RUB,
        settings: { shopId: 'shop-new', apiKey: 'key-new' },
      },
      true,
    );

    assert.equal(updatedGateway.isActive, false);
    assert.equal(updatedGateway.currency, Currency.RUB);
    assert.deepStrictEqual(updatedGateway.settings, {
      shopId: 'shop-new',
      apiKey: 'key-new',
    });
  });

  it('moves ordering up and down by swapping orderIndex with nearest gateway', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
      createGateway({
        id: 'gateway-2',
        type: PaymentGatewayType.PLATEGA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 2,
      }),
    ]);

    const movedUp = await service.moveGateway('gateway-2', PaymentGatewayMoveDirection.UP);
    assert.equal(movedUp.orderIndex, 1);

    const movedDown = await service.moveGateway('gateway-2', PaymentGatewayMoveDirection.DOWN);
    assert.equal(movedDown.orderIndex, 2);
  });

  it('rejects invalid scalar settings payloads', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
    ]);

    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-1', { settings: 'not-an-object' as never });
      },
      {
        name: 'BadRequestException',
        message: 'PAYMENT_GATEWAY_SETTINGS_INVALID',
      },
    );
  });

  it('rejects unknown settings fields for a configured gateway type', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
    ]);

    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-1', {
          settings: { shopId: 'shop-1', unexpected: true } as never,
        });
      },
      {
        name: 'BadRequestException',
        message: 'PAYMENT_GATEWAY_SETTINGS_INVALID',
      },
    );
  });

  it('normalizes platega paymentMethod aliases into deterministic numeric settings', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.PLATEGA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
      }),
    ]);

    const updatedGateway = await service.updateGateway(
      'gateway-1',
      {
        settings: {
          merchantId: 'merchant-1',
          secret: 'secret-1',
          paymentMethod: 'SBP',
        },
      },
      true,
    );

    assert.deepStrictEqual(updatedGateway.settings, {
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 2,
    });
  });

  it('exposes the backend readiness verdict and the absolute webhook URL', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
        settings: { shopId: 'shop-1', apiKey: 'key-1' },
      }),
      createGateway({
        id: 'gateway-2',
        type: PaymentGatewayType.WATA,
        currency: Currency.RUB,
        isActive: false,
        orderIndex: 2,
        // `publicKey` alone is not enough to issue a checkout — the panel's old
        // "any non-empty field" rule would have shown this one as ready.
        settings: { publicKey: 'MFwwDQYJKoZI' },
      }),
    ]);

    const [yookassa, wata] = await service.listGateways();

    assert.equal(yookassa.isConfigured, true);
    assert.equal(
      yookassa.webhookUrl,
      'https://panel.example.com/api/v1/payments/webhooks/YOOKASSA',
    );
    assert.equal(wata.isConfigured, false);
    assert.equal(wata.webhookUrl, 'https://panel.example.com/api/v1/payments/webhooks/WATA');
  });

  it('falls back to the relative webhook path when the public domain is unset', async () => {
    const { service } = createService(
      [
        createGateway({
          id: 'gateway-1',
          type: PaymentGatewayType.WATA,
          currency: Currency.RUB,
          isActive: false,
          orderIndex: 1,
        }),
      ],
      null,
    );

    const gateway = await service.getGateway('gateway-1');

    assert.equal(gateway.webhookUrl, '/api/v1/payments/webhooks/WATA');
  });

  it('refuses to enable a gateway whose stored settings are incomplete', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 1,
        settings: { shopId: 'shop-1' },
      }),
    ]);

    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-1', { isActive: true });
      },
      {
        name: 'BadRequestException',
        message: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      },
    );

    const gateway = await service.getGateway('gateway-1');
    assert.equal(gateway.isActive, false);
  });

  it('enables a gateway whose stored settings are complete', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 1,
        settings: { shopId: 'shop-1', apiKey: 'key-1' },
      }),
    ]);

    const updatedGateway = await service.updateGateway('gateway-1', { isActive: true });

    assert.equal(updatedGateway.isActive, true);
    assert.equal(updatedGateway.isConfigured, true);
  });

  it('validates the merged result when one PATCH carries settings and isActive', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.WATA,
        currency: Currency.RUB,
        isActive: false,
        orderIndex: 1,
      }),
      createGateway({
        id: 'gateway-2',
        type: PaymentGatewayType.WATA,
        currency: Currency.RUB,
        isActive: false,
        orderIndex: 2,
        settings: { apiKey: 'wata-key' },
      }),
    ]);

    // Credentials arriving in the same request count: judging the stored row
    // would reject a save that is about to make the gateway valid.
    const enabledGateway = await service.updateGateway('gateway-1', {
      settings: { apiKey: 'wata-key', publicKey: 'MFwwDQYJKoZI' },
      isActive: true,
    });
    assert.equal(enabledGateway.isActive, true);
    assert.equal(enabledGateway.isConfigured, true);

    // …and the reverse: settings are replaced, not merged, so a save that
    // blanks the credential must not leave the gateway enabled.
    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-2', {
          settings: { apiKey: '   ' },
          isActive: true,
        });
      },
      {
        name: 'BadRequestException',
        message: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
      },
    );
  });

  it('always allows disabling a gateway, configured or not', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.WATA,
        currency: Currency.RUB,
        isActive: true,
        orderIndex: 1,
      }),
    ]);

    const updatedGateway = await service.updateGateway('gateway-1', { isActive: false });

    assert.equal(updatedGateway.isActive, false);
    assert.equal(updatedGateway.isConfigured, false);
  });
});

function createService(
  initialGateways: readonly GatewayRecord[],
  domain: string | null = 'https://panel.example.com',
): {
  readonly service: PaymentGatewayRegistryService;
  /**
   * The backing rows, exposed so the at-rest specs can assert on what actually
   * landed in the `settings` column — the service's own return value is always
   * decrypted, so it cannot prove anything about encryption.
   */
  readonly rows: readonly GatewayRecord[];
} {
  const gateways: GatewayRecord[] = initialGateways.map((gateway) => ({ ...gateway }));
  const paymentGatewayClient = {
    findMany: async (...args: readonly unknown[]): Promise<GatewayRecord[]> => {
      const select = (args[0] as { readonly select?: { readonly type?: boolean } } | undefined)?.select;
      if (select?.type) {
        return gateways.map((gateway) => ({ type: gateway.type } as GatewayRecord));
      }
      return sortGateways(gateways).map((gateway) => ({ ...gateway }));
    },
    findUnique: async (args: { readonly where: { readonly id: string } }): Promise<GatewayRecord | null> => {
      const gateway = gateways.find((candidate) => candidate.id === args.where.id);
      return gateway === undefined ? null : { ...gateway };
    },
    findFirst: async (args: {
      readonly where?: { readonly orderIndex?: { readonly lt?: number; readonly gt?: number } };
      readonly orderBy?: readonly { readonly orderIndex?: 'asc' | 'desc'; readonly type?: 'asc' | 'desc' }[];
    }): Promise<GatewayRecord | null> => {
      let filtered = [...gateways];
      const orderIndexFilter = args.where?.orderIndex;
      if (orderIndexFilter?.lt !== undefined) {
        filtered = filtered.filter((gateway) => gateway.orderIndex < orderIndexFilter.lt!);
      }
      if (orderIndexFilter?.gt !== undefined) {
        filtered = filtered.filter((gateway) => gateway.orderIndex > orderIndexFilter.gt!);
      }
      if (args.orderBy !== undefined && args.orderBy.length > 0) {
        filtered.sort((left, right) => {
          const firstSort = args.orderBy![0];
          if (firstSort.orderIndex !== undefined) {
            return firstSort.orderIndex === 'asc'
              ? left.orderIndex - right.orderIndex
              : right.orderIndex - left.orderIndex;
          }
          if (firstSort.type !== undefined) {
            return firstSort.type === 'asc'
              ? left.type.localeCompare(right.type)
              : right.type.localeCompare(left.type);
          }
          return 0;
        });
      }
      const gateway = filtered[0];
      return gateway === undefined ? null : { ...gateway };
    },
    create: async (args: { readonly data: Partial<GatewayRecord> }): Promise<GatewayRecord> => {
      const created: GatewayRecord = {
        id: `gateway-${gateways.length + 1}`,
        type: args.data.type!,
        currency: args.data.currency!,
        isActive: args.data.isActive ?? true,
        orderIndex: args.data.orderIndex ?? 0,
        settings: (args.data.settings as Record<string, unknown>) ?? {},
        updatedAt: new Date('2026-04-19T12:00:00.000Z'),
      };
      gateways.push(created);
      return created;
    },
    update: async (args: {
      readonly where: { readonly id: string };
      readonly data: Record<string, unknown>;
    }): Promise<GatewayRecord> => {
      const gateway = gateways.find((candidate) => candidate.id === args.where.id);
      if (gateway === undefined) {
        throw Object.assign(new Error('not found'), { code: 'P2025' });
      }
      if (args.data.type !== undefined) {
        gateway.type = args.data.type as PaymentGatewayType;
      }
      if (args.data.currency !== undefined) {
        gateway.currency = args.data.currency as Currency;
      }
      if (args.data.isActive !== undefined) {
        gateway.isActive = args.data.isActive as boolean;
      }
      if (args.data.orderIndex !== undefined) {
        gateway.orderIndex = args.data.orderIndex as number;
      }
      if (args.data.settings !== undefined) {
        gateway.settings = args.data.settings as Record<string, unknown>;
      }
      gateway.updatedAt = new Date('2026-04-19T12:00:00.000Z');
      return gateway;
    },
  };
  const prismaService = {
    paymentGateway: paymentGatewayClient,
    planPrice: {
      findMany: async () => [],
    },
    $transaction: async <T>(callback: (client: { readonly paymentGateway: typeof paymentGatewayClient }) => Promise<T>): Promise<T> =>
      callback({
        paymentGateway: paymentGatewayClient,
      }),
  };
  return {
    service: new PaymentGatewayRegistryService(prismaService as never, {
      domain,
      botToken: null,
    }),
    rows: gateways,
  };
}

function createGateway(input: {
  readonly id: string;
  readonly type: PaymentGatewayType;
  readonly currency: Currency;
  readonly isActive: boolean;
  readonly orderIndex: number;
  readonly settings?: Record<string, unknown>;
}): GatewayRecord {
  return {
    id: input.id,
    type: input.type,
    currency: input.currency,
    isActive: input.isActive,
    orderIndex: input.orderIndex,
    settings: input.settings ?? {},
    updatedAt: new Date('2026-04-19T12:00:00.000Z'),
  };
}

function sortGateways(gateways: readonly GatewayRecord[]): GatewayRecord[] {
  return [...gateways].sort((left, right) => {
    if (left.orderIndex !== right.orderIndex) {
      return left.orderIndex - right.orderIndex;
    }
    return left.type.localeCompare(right.type);
  });
}

interface GatewayRecord {
  id: string;
  type: PaymentGatewayType;
  orderIndex: number;
  currency: Currency;
  isActive: boolean;
  settings: Record<string, unknown>;
  updatedAt: Date;
}

describe('PaymentGatewayRegistryService secret handling', () => {
  it('encrypts secret settings at rest while leaving configuration readable', async () => {
    const { service, rows } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.PLATEGA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 1,
      }),
    ]);

    await service.updateGateway('gateway-1', {
      settings: { merchantId: 'merchant-1', secret: 'platega-secret-value', paymentMethod: 'SBP' },
    });

    const stored = rows[0]!.settings;
    // The credential is unreadable in the column…
    assert.equal(String(stored.secret).startsWith('PGENC1:'), true);
    assert.equal(String(stored.secret).includes('platega-secret-value'), false);
    // …and the merchant id / payment method stay browsable, because they are
    // configuration an operator reads back when a gateway misbehaves.
    assert.equal(stored.merchantId, 'merchant-1');
    assert.equal(stored.paymentMethod, 2);
  });

  it('returns decrypted settings to a caller holding payment_gateways:view_secrets', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 1,
      }),
    ]);
    await service.updateGateway('gateway-1', {
      settings: { shopId: 'shop-1', apiKey: 'live_sk_9f3a72be41d0c8e5' },
    });

    const gateway = await service.getGateway('gateway-1', true);

    assert.deepStrictEqual(gateway.settings, {
      shopId: 'shop-1',
      apiKey: 'live_sk_9f3a72be41d0c8e5',
    });
    assert.equal(gateway.secretsVisible, true);
    assert.deepStrictEqual(gateway.configuredSecretKeys, ['apiKey']);
  });

  it('masks secrets for the ordinary gateway permission and reveals them for the elevated one', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 1,
      }),
    ]);
    await service.updateGateway('gateway-1', {
      settings: { shopId: 'shop-1', apiKey: 'live_sk_9f3a72be41d0c8e5' },
    });

    const [masked] = await service.listGateways();
    const [revealed] = await service.listGateways(true);

    // `payment_gateways:view` keeps working — the gateway still lists, still
    // shows its shop id and its readiness — but the credential is hidden.
    assert.equal(masked!.settings.shopId, 'shop-1');
    assert.equal(masked!.settings.apiKey, '********c8e5');
    assert.equal(masked!.secretsVisible, false);
    assert.equal(revealed!.settings.apiKey, 'live_sk_9f3a72be41d0c8e5');
    assert.equal(revealed!.secretsVisible, true);
    // Readiness and the "which secrets are set" list are identical for both
    // audiences: the indicator must not depend on who is asking.
    assert.equal(masked!.isConfigured, revealed!.isConfigured);
    assert.equal(masked!.isConfigured, true);
    assert.deepStrictEqual(masked!.configuredSecretKeys, revealed!.configuredSecretKeys);
  });

  it('distinguishes an unset secret from a set-but-masked one', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.PAYPALYCH,
        currency: Currency.RUB,
        isActive: false,
        orderIndex: 1,
        // `apiKey` is stored, `secretKey` was never configured.
        settings: { shopId: 'shop-1', apiKey: 'paypalych-api-key-1234' },
      }),
    ]);

    const gateway = await service.getGateway('gateway-1');

    // Present-with-a-mask means "set but hidden"; absent means "not set".
    assert.equal(gateway.settings.apiKey, '********1234');
    assert.equal('secretKey' in gateway.settings, false);
    assert.deepStrictEqual(gateway.configuredSecretKeys, ['apiKey']);
  });

  it('reads a legacy plaintext row and upgrades it to encrypted on the next save', async () => {
    const { service, rows } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: true,
        orderIndex: 1,
        // Written before at-rest encryption existed.
        settings: { shopId: 'shop-1', apiKey: 'legacy-plaintext-key' },
      }),
    ]);

    // Read side: the legacy row is understood as-is, so nothing an operator
    // stored before the upgrade is lost or misreported.
    const before = await service.getGateway('gateway-1', true);
    assert.equal(before.settings.apiKey, 'legacy-plaintext-key');
    assert.equal(before.isConfigured, true);
    assert.equal(rows[0]!.settings.apiKey, 'legacy-plaintext-key');

    // Any save rewrites the whole column, so the row comes back encrypted
    // without a migration — even one that only touches an unrelated field.
    const after = await service.updateGateway(
      'gateway-1',
      { settings: { shopId: 'shop-2', apiKey: '********-key' } },
      true,
    );

    assert.equal(String(rows[0]!.settings.apiKey).startsWith('PGENC1:'), true);
    // …and the legacy credential survived the upgrade untouched.
    assert.equal(after.settings.apiKey, 'legacy-plaintext-key');
    assert.equal(after.settings.shopId, 'shop-2');
    assert.equal(after.isConfigured, true);
  });

  it('preserves the stored secret when an operator saves a form full of masks', async () => {
    const { service, rows } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.AURAPAY,
        currency: Currency.RUB,
        isActive: false,
        orderIndex: 1,
      }),
    ]);
    await service.updateGateway('gateway-1', {
      settings: { apiKey: 'aurapay-api-key-abcd', shopId: 'shop-1', secretKey: 'aurapay-hmac-wxyz' },
    });

    // What an operator holding only `payment_gateways:view` + `edit` sees.
    const shown = await service.getGateway('gateway-1');
    assert.equal(shown.settings.apiKey, '********abcd');
    assert.equal(shown.settings.secretKey, '********wxyz');

    // They change the shop id and submit the form back verbatim. Settings are
    // REPLACED, not merged, so without mask resolution this save would store
    // `********abcd` as the live API key and take the gateway down.
    const saved = await service.updateGateway('gateway-1', {
      settings: { ...shown.settings, shopId: 'shop-2' },
    });

    assert.equal(saved.settings.apiKey, '********abcd');
    assert.equal(saved.settings.shopId, 'shop-2');
    assert.equal(saved.isConfigured, true);

    // The real credentials are still what they were — write-without-read works.
    const revealed = await service.getGateway('gateway-1', true);
    assert.equal(revealed.settings.apiKey, 'aurapay-api-key-abcd');
    assert.equal(revealed.settings.secretKey, 'aurapay-hmac-wxyz');
    assert.equal(String(rows[0]!.settings.apiKey).startsWith('PGENC1:'), true);
  });

  it('lets an operator who cannot read secrets still replace one', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 1,
        settings: { shopId: 'shop-1', apiKey: 'live_sk_9f3a72be41d0c8e5' },
      }),
    ]);

    // Typing over the masked field is a genuine new value, not a mask.
    await service.updateGateway('gateway-1', {
      settings: { shopId: 'shop-1', apiKey: 'rotated_sk_0000111122223333' },
    });

    const revealed = await service.getGateway('gateway-1', true);
    assert.equal(revealed.settings.apiKey, 'rotated_sk_0000111122223333');
  });

  it('keeps the enable guard working against encrypted settings', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.WATA,
        currency: Currency.RUB,
        isActive: false,
        orderIndex: 1,
      }),
    ]);
    // Store the checkout credential only — Wata also needs `publicKey`.
    await service.updateGateway('gateway-1', { settings: { apiKey: 'wata-api-key' } });

    // `isGatewayConfigured` runs on the DECRYPTED settings, so an envelope is
    // never mistaken for a satisfied requirement.
    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-1', { isActive: true });
      },
      { name: 'BadRequestException', message: 'PAYMENT_GATEWAY_NOT_CONFIGURED' },
    );

    const enabled = await service.updateGateway('gateway-1', {
      settings: { apiKey: '********-key', publicKey: 'MFwwDQYJKoZI' },
      isActive: true,
    });
    assert.equal(enabled.isActive, true);
    assert.equal(enabled.isConfigured, true);
  });

  it('refuses a submitted value impersonating the storage envelope', async () => {
    const { service } = createService([
      createGateway({
        id: 'gateway-1',
        type: PaymentGatewayType.YOOKASSA,
        currency: Currency.USD,
        isActive: false,
        orderIndex: 1,
      }),
    ]);

    // Stored verbatim it could never be decrypted, so every later read would
    // drop the field and the credential would vanish silently.
    await assert.rejects(
      async () => {
        await service.updateGateway('gateway-1', {
          settings: { shopId: 'shop-1', apiKey: 'PGENC1:aa:bb:cc' },
        });
      },
      { name: 'BadRequestException', message: 'PAYMENT_GATEWAY_SETTINGS_INVALID' },
    );
  });
});
