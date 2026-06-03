import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EVENT_TYPES, SystemEventsService } from '../src/common/services/system-events.service';
import { NotificationTemplatesService } from '../src/modules/notifications/services/notification-templates.service';

describe('NotificationTemplatesService', () => {
  it('emits realtime-visible events for operator template changes', async () => {
    const events: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
    let existingTemplate: Record<string, unknown> | null = null;
    const prismaService = {
      notificationTemplate: {
        findUnique: async (args: { where: { id?: string; type?: string } }) => {
          if (args.where.id === 'template-1') return existingTemplate;
          if (args.where.type === 'payment.completed') return null;
          return null;
        },
        upsert: async () => {
          existingTemplate = buildTemplate({ id: 'template-1', type: 'payment.completed' });
          return existingTemplate;
        },
        update: async () => buildTemplate({ id: 'template-1', type: 'payment.completed' }),
        delete: async () => buildTemplate({ id: 'template-1', type: 'payment.completed' }),
      },
    };
    const service = createService(prismaService, events);

    await service.upsert({ type: 'payment.completed', title: 'Paid', body: 'Paid body' });
    await service.update({ id: 'template-1', title: 'Paid updated' });
    await service.delete('template-1');

    assert.deepStrictEqual(events.map((event) => event.type), [
      EVENT_TYPES.NOTIFICATION_TEMPLATE_CREATED,
      EVENT_TYPES.NOTIFICATION_TEMPLATE_UPDATED,
      EVENT_TYPES.NOTIFICATION_TEMPLATE_DELETED,
    ]);
    assert.deepStrictEqual(events[0]?.metadata, {
      templateId: 'template-1',
      type: 'payment.completed',
    });
  });

  it('emits the seed event only for manual seed operations that create templates', async () => {
    const events: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
    let existing = false;
    const prismaService = {
      notificationTemplate: {
        findUnique: async () => existing ? { id: 'template-existing' } : null,
        upsert: async () => {
          existing = true;
          return buildTemplate({ id: 'template-new', type: 'seeded.template' });
        },
      },
    };
    const service = createService(prismaService, events);

    await service.seedDefaults();
    existing = false;
    const result = await service.seedDefaults({ emitEvent: true });

    assert.equal(result.created, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, EVENT_TYPES.NOTIFICATION_TEMPLATE_SEEDED);
    assert.equal(events[0]?.metadata?.['created'], 1);
  });
});

function createService(
  prismaService: unknown,
  events: Array<{ type: string; metadata?: Record<string, unknown> }>,
): NotificationTemplatesService {
  return new NotificationTemplatesService(
    prismaService as never,
    {
      info: (type: string, _category: string, _message: string, metadata?: Record<string, unknown>) => {
        events.push({ type, metadata });
      },
    } as unknown as SystemEventsService,
  );
}

function buildTemplate(input: { readonly id: string; readonly type: string }): Record<string, unknown> {
  return {
    id: input.id,
    type: input.type,
    title: 'Template title',
    body: 'Template body',
    isActive: true,
    createdAt: new Date('2026-06-04T00:00:00.000Z'),
    updatedAt: new Date('2026-06-04T00:00:00.000Z'),
  };
}
