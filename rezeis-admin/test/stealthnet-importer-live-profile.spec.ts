import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StealthnetImporterService } from '../src/modules/imports/services/stealthnet-importer.service';

describe('StealthnetImporterService live panel overlay', () => {
  it('preserves a lifetime panel expiry instead of reviving an obsolete backup expiry', async () => {
    const subscriptionUpdates: Array<{ data: Record<string, unknown> }> = [];
    const service = new StealthnetImporterService(
      {
        user: {
          findUnique: async (input: { where: Record<string, unknown> }) => {
            if ('telegramId' in input.where) return { id: 'user-1' };
            return { createdAt: new Date('2020-01-01T00:00:00.000Z') };
          },
          update: async () => undefined,
          updateMany: async () => ({ count: 0 }),
        },
        subscription: {
          findFirst: async () => ({ id: 'sub-1', userId: 'user-1' }),
          update: async (input: { data: Record<string, unknown> }) => subscriptionUpdates.push(input),
        },
        importRecord: { create: async () => ({ id: 'import-1' }) },
      } as never,
      {
        getAllPanelUsers: async () => [{
          uuid: 'panel-user-1', username: 'legacy', status: 'ACTIVE', subscriptionUrl: 'https://example.test/sub',
          telegramId: 123, panelId: 1, email: null, expireAt: '', createdAt: '2026-01-01T00:00:00.000Z',
          lastTrafficResetAt: null, trafficLimitBytes: 0, hwidDeviceLimit: 1, trafficLimitStrategy: null,
          tag: null, description: null, activeInternalSquads: [], externalSquadUuid: null,
        }],
      } as never,
      { syncImport: async () => ({
        mappings: [], created: 0, existing: 0, skipped: 0,
        creditsCreated: 0, creditsExisting: 0, creditsSkipped: 0,
      }) } as never,
    );

    await service.run({
      mode: 'import', createdBy: 'admin-1',
      clients: [{
        id: 'client-1', email: null, password_hash: null, role: 'user', remnawave_uuid: null,
        referral_code: null, referrer_id: null, balance: 0, preferred_lang: 'ru', preferred_currency: 'RUB',
        telegram_id: '123', telegram_username: null, is_blocked: false, block_reason: null, trial_used: false,
        current_tariff_id: null, bot_id: null, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
      }],
      subscriptions: [{
        id: 'source-sub-1', owner_id: 'client-1', remnawave_uuid: 'panel-user-1', subscription_index: 1,
        tariff_id: null, gift_status: null, gifted_to_client_id: null,
        created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
        expire_at: '2030-01-01T00:00:00.000Z', extra_devices: 0, extra_devices_monthly_price: 0,
      }],
      tariffs: [], tariffCategories: [], tariffPriceOptions: [], payments: [], referralCredits: [],
    });

    assert.equal(subscriptionUpdates.length, 1);
    assert.equal(subscriptionUpdates[0].data.expiresAt, null);
  });
});
