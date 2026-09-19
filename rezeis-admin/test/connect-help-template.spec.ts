import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveNotificationCategory, resolveTerminalRouteFor } from '../src/modules/bot-map/services/notification-target-resolver';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { NotificationTemplatesService } from '../src/modules/notifications/services/notification-templates.service';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import {
  isSubscriberMailableType,
  isSubscriberNotificationEnabled,
  readSubscriberNotificationPrefs,
  resolveToggleKey,
} from '../src/modules/notifications/utils/notification-toggle.util';

/**
 * «Не получилось подключиться?» — the two shipped templates, what they render
 * to, how they are seeded, and the one switch the customer has for both.
 */

const PAID = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === 'connect_help');
const TRIAL = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === 'connect_help_trial');

/** What Telegram counts: characters after the markup is parsed — code points, not UTF-16 units. */
function telegramLength(html: string): number {
  const parsed = html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return [...parsed].length;
}

/** The text the bot would be handed for one customer, through the real renderer. */
async function renderedForBot(input: {
  readonly type: 'connect_help' | 'connect_help_trial';
  readonly plan: string;
  readonly language: 'RU' | 'EN';
  readonly projectName: string;
}): Promise<string> {
  const sent: string[] = [];
  const catalogue = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === input.type);
  assert.ok(catalogue);
  const service = new UserNotificationsService(
    {
      userNotificationEvent: {
        create: async () => ({ id: 'cmf0rendercheck000000001' }),
        update: async () => ({}),
        count: async () => 0,
      },
      user: {
        findUnique: async () => ({
          telegramId: 5n,
          isBotBlocked: false,
          name: 'Анна',
          language: input.language,
          notificationPrefs: null,
        }),
      },
      settings: { findUnique: async () => ({ platformPolicy: { projectName: input.projectName } }) },
    } as never,
    {
      getByType: async () => ({
        ...catalogue,
        titleEn: catalogue.titleEn ?? null,
        bodyEn: catalogue.bodyEn ?? null,
        buttons: catalogue.buttons ?? [],
        bannerUrl: null,
        isActive: true,
      }),
    } as never,
    {
      isEnabled: true,
      notifyUser: async (call: { text: string }) => {
        sent.push(call.text);
        return { status: 'confirmed', messageId: 1, httpStatus: 200, detail: null };
      },
    } as never,
    {} as never,
    { substituteTelegramHtml: async (t: string) => t, substituteFallbacks: async (t: string) => t } as never,
    {} as never,
  );
  const result = await service.deliverFirstReachable({
    userId: 'user-1',
    type: input.type,
    payload: { subscriptionId: 'sub-1', plan: input.plan, planName: input.plan },
  });
  assert.equal(result.outcome, 'bot');
  assert.equal(sent.length, 1);
  return sent[0];
}

describe('the shipped «Помощь с подключением» templates', () => {
  it('ships both types with Russian and English copy', () => {
    for (const template of [PAID, TRIAL]) {
      assert.ok(template, 'a connect help template is missing from the catalogue');
      assert.equal(template.title, 'Не получилось подключиться?');
      assert.equal(template.titleEn, "Couldn't connect?");
      assert.ok(template.body.includes('{{plan}}'));
      assert.ok((template.bodyEn ?? '').includes('{{plan}}'));
    }
  });

  it('says «оплачена» to a paying customer and never to a trial or a gift', () => {
    assert.match(PAID?.body ?? '', /оплачена/);
    assert.match(PAID?.bodyEn ?? '', /\bpaid\b/);
    assert.doesNotMatch(TRIAL?.body ?? '', /оплач/);
    assert.doesNotMatch(TRIAL?.bodyEn ?? '', /\bpaid\b/);
  });

  it('carries the connect deep link and support, in both languages', () => {
    for (const template of [PAID, TRIAL]) {
      assert.deepEqual(template?.buttons, [
        { labelRu: '📲 Подключить', labelEn: '📲 Connect', kind: 'webApp', target: '/dashboard?connect=help' },
        { labelRu: '💬 Поддержка', labelEn: '💬 Support', kind: 'webApp', target: '/support' },
      ]);
    }
  });

  it('fits a Telegram caption (1024 characters) with the longest plan name a plan may have', async () => {
    // 128 is `CreatePlanDto.name`'s own limit; emoji are two UTF-16 units each
    // and one character to Telegram, which counts code points.
    const plan = '🚀'.repeat(128);
    for (const type of ['connect_help', 'connect_help_trial'] as const) {
      for (const language of ['RU', 'EN'] as const) {
        const html = await renderedForBot({ type, plan, language, projectName: 'Reiwa VPN' });
        assert.ok(html.includes(plan), `${type}/${language}: the plan did not render`);
        const length = telegramLength(html);
        assert.ok(length <= 1024, `${type}/${language}: ${length} characters`);
        assert.ok([...html].length < html.length, 'the fixture must tell code points from UTF-16 units');
      }
    }
  });

  it('renders the plan into the words, escaped for Telegram', async () => {
    const html = await renderedForBot({ type: 'connect_help', plan: 'Pro <Max>', language: 'RU', projectName: '' });
    assert.match(html, /^<b>Не получилось подключиться\?<\/b>\n\nПодписка «Pro &lt;Max&gt;» оплачена/);
  });
});

describe('seeding them', () => {
  function templatesHarness(existing: Record<string, { title: string; titleEn: string | null; bodyEn: string | null; buttons: unknown }>) {
    const created: Array<Record<string, unknown>> = [];
    const updated: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const prisma = {
      notificationTemplate: {
        findUnique: async (args: { where: { type: string } }) => {
          const row = existing[args.where.type];
          return row === undefined ? null : { id: `id-${args.where.type}`, ...row };
        },
        upsert: async (args: { where: { type: string }; create: Record<string, unknown> }) => {
          created.push(args.create);
          return args.create;
        },
        update: async (args: { where: unknown; data: Record<string, unknown> }) => {
          updated.push(args);
          return {};
        },
      },
    };
    const service = new NotificationTemplatesService(prisma as never, { info: () => undefined } as never);
    return { service, created, updated };
  }

  it('inserts both, active, with their buttons, on a first boot', async () => {
    const { service, created } = templatesHarness({});
    await service.seedDefaults();
    for (const type of ['connect_help', 'connect_help_trial']) {
      const row = created.find((entry) => entry['type'] === type);
      assert.ok(row, `${type} was not seeded`);
      assert.equal(row['isActive'], true);
      assert.equal((row['buttons'] as unknown[]).length, 2);
      assert.equal(typeof row['titleEn'], 'string');
    }
  });

  it('never overwrites a text an operator edited', async () => {
    const { service, created, updated } = templatesHarness({
      connect_help: {
        title: 'Наш заголовок',
        titleEn: 'Our title',
        bodyEn: 'Our body',
        buttons: [{ labelRu: 'Своя', kind: 'webApp', target: '/dashboard' }],
      },
    });
    await service.seedDefaults();
    assert.equal(created.some((entry) => entry['type'] === 'connect_help'), false, 'the edited row was re-created');
    assert.equal(
      updated.some((entry) => (entry.where as { id: string }).id === 'id-connect_help'),
      false,
      'the edited row was written to',
    );
  });
});

describe('one switch for both, on the customer’s side', () => {
  it('maps the trial type onto the paid one for the switch, the push tag and the mail gate', () => {
    assert.equal(resolveToggleKey('connect_help_trial'), 'connect_help');
    assert.equal(resolveToggleKey('connect_help'), 'connect_help');
    for (const type of ['connect_help', 'connect_help_trial']) {
      assert.equal(isSubscriberNotificationEnabled({ connect_help: false }, type), false, type);
      assert.equal(isSubscriberNotificationEnabled({ connect_help: true }, type), true, type);
      assert.equal(isSubscriberNotificationEnabled(null, type), true, `${type}: absent means send`);
      assert.equal(isSubscriberMailableType(type), true, type);
    }
  });

  it('stores the switch a browser sends, and only that key', () => {
    assert.deepEqual(readSubscriberNotificationPrefs({ connect_help: false, connect_help_trial: false }), {
      connect_help: false,
    });
  });
});

describe('the bot map', () => {
  it('files both types with the subscription notices and points them at the dashboard', () => {
    for (const type of ['connect_help', 'connect_help_trial']) {
      assert.equal(resolveNotificationCategory(type), 'expires', type);
      assert.equal(resolveTerminalRouteFor(type), '/dashboard', type);
    }
  });
});
