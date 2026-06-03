import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';

describe('EmailDeliveryService', () => {
  it('emits a redacted settings event after SMTP settings are saved', async () => {
    const events: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
    const updates: unknown[] = [];
    const prismaService = {
      settings: {
        findFirst: async () => ({
          id: 'settings-1',
          systemNotifications: {
            email: {
              enabled: false,
              host: 'smtp.old.example',
              port: 587,
              username: 'old-user',
              password: 'old-secret',
              fromAddress: 'old@example.com',
              fromName: 'Old Name',
              useTls: true,
              useSsl: false,
            },
          },
        }),
        update: async (args: unknown) => {
          updates.push(args);
          return args;
        },
      },
    };
    const service = new EmailDeliveryService(
      {
        enabled: false,
        host: null,
        port: 587,
        username: null,
        password: null,
        fromAddress: 'noreply@example.com',
        fromName: 'Rezeis',
        useTls: true,
        useSsl: false,
      },
      prismaService as never,
      {} as never,
      {
        info: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) => {
          events.push({ type, metadata });
        },
      } as unknown as SystemEventsService,
    );

    await service.saveSmtpSettings({ enabled: true, password: 'new-secret', host: 'smtp.new.example' });

    assert.equal(updates.length, 1);
    assert.deepStrictEqual(events, [{
      type: EVENT_TYPES.SETTINGS_EMAIL_UPDATED,
      metadata: { updatedFields: ['enabled', 'host', 'passwordSet'] },
    }]);
  });
});
