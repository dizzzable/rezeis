import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { formatErrorEventCardHtml } from '../src/common/services/error-report.util';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { literalCardText } from '../src/common/utils/operator-card-text.util';
import { CustomEmojiService } from '../src/modules/custom-emoji/services/custom-emoji.service';
import { BotNotifierClient } from '../src/modules/notifications/services/bot-notifier.client';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';

/**
 * A SUBSCRIBER'S TEXT IN AN OPERATOR CARD IS NOT READ AS THE OPERATOR'S TOKENS.
 *
 * The bot resolves the operator's emoji tokens in the whole of a card before
 * Telegram sees it — `:slug:` to a pack emoji, `{{KEY}}` to a slot, an unknown
 * key to `•` — and so does the panel's own pass on notifications. A ticket
 * subject «ключ {{SUB_ID}} не работает, пишу :fire: срочно» reached the
 * operator as «ключ • не работает, пишу 🔥 срочно».
 *
 * Only the operator's template resolves tokens. Every subscriber's text a card
 * embeds goes in through one helper (`literalCardText`): HTML-escaped, and its
 * `:` `{` `}` written as numeric references, which no token pattern matches and
 * Telegram shows as the characters typed.
 */

/** What the subscriber typed. */
const TYPED = 'ключ {{SUB_ID}} не работает, пишу :fire: срочно <b>&';
/** The same, as a card carries it. The cabinet's test pins that the bot passes exactly this through. */
const CARRIED =
  'ключ &#123;&#123;SUB_ID&#125;&#125; не работает, пишу &#58;fire&#58; срочно &lt;b&gt;&amp;';

/** The token passes a card goes through: the bot's (`renderBotCopyHtml`) and the panel's (`substituteTelegramHtml`). */
const TOKEN_PATTERNS = [/\{\{([A-Z0-9_]+)\}\}/, /:([a-z0-9_]+):/];

/** Telegram's reading of HTML text: every numeric reference, and the named ones it knows. */
function asTelegramShows(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * No token the subscriber typed is left for a pass to read, and the operator
 * reads `typed` in the card. (The card's own clock, `7:13:24`, is a `:13:` to
 * the pattern; no pack names a slug `13`, and it is the panel's text.)
 */
function assertLiteral(card: string, typed: string): void {
  assert.ok(!card.includes('{{') && !card.includes(':fire:'), card);
  assert.ok(asTelegramShows(card).includes(typed), `the operator does not read what was typed:\n${card}`);
}

describe('literalCardText', () => {
  it('writes the three token characters as numeric references, and escapes the markup', () => {
    assert.equal(literalCardText(TYPED), CARRIED);
    assert.equal(literalCardText(42), '42');
  });

  it('leaves nothing a token pass could match, and Telegram reads it back as typed', () => {
    const carried = literalCardText(TYPED);
    for (const pattern of TOKEN_PATTERNS) assert.doesNotMatch(carried, pattern);
    assert.equal(asTelegramShows(carried), TYPED);
  });

  it('keeps an escaped reference a subscriber typed as text', () => {
    assert.equal(asTelegramShows(literalCardText('&#58;fire&#58;')), '&#58;fire&#58;');
  });
});

// ── The system-event cards ────────────────────────────────────────────────────

function cardService(): { service: SystemEventsService; lastCard: () => string } {
  let last = '';
  const capture = (event: string, meta: Record<string, unknown>): void => {
    if (event === 'reiwa.dev.notify') last = String(meta['text'] ?? '');
    else if (event === 'reiwa.dev.notify.document') last = String(meta['caption'] ?? '');
  };
  const moduleRef = {
    get: (token: unknown) => {
      if (token === BotNotifierClient) {
        return {
          deliverRelayEvent: async (event: string, meta: Record<string, unknown>) => {
            capture(event, meta);
            return { status: 'unconfirmed', messageId: null, httpStatus: 204, detail: null };
          },
        };
      }
      if (token === ReiwaRelayQueueService) {
        return {
          enqueue: async (event: string, meta: Record<string, unknown>) => {
            capture(event, meta);
            return true;
          },
        };
      }
      throw new Error('not registered');
    },
  };
  const prisma = {
    settings: {
      findFirst: async () => ({
        systemNotifications: { telegram: { enabled: false, chatId: null, devChatId: null } },
        platformPolicy: {},
      }),
    },
    adminAuditLog: { create: async () => ({}) },
  };
  const service = new SystemEventsService(
    prisma as never,
    { enabled: false, urls: [] } as never,
    { post: () => { throw new Error('no Bot API without a token'); } } as never,
    moduleRef as never,
  );
  return { service, lastCard: () => last };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('a system-event card embedding what a subscriber typed', () => {
  let savedToken: string | undefined;
  beforeEach(() => {
    savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = savedToken;
  });

  it('shows a ticket’s subject and the customer’s name, username, login and address as typed', async () => {
    const { service, lastCard } = cardService();
    service.info('support.ticket_created', 'SUPPORT', 'Новый тикет', {
      ticketId: 't-1',
      subject: TYPED,
      userId: 'user-1',
      telegramId: '100200300',
      userName: `${TYPED} name`,
      username: 'vasya:fire:',
      login: '{{LOGIN}}:x:',
      email: '{{MAIL}}@mail.test',
    });
    await flush();
    const card = lastCard();

    assert.ok(card.includes(`📨 Тема: ${CARRIED}`), card);
    assertLiteral(card, TYPED);
    assert.ok(card.includes(`👤 Имя: ${CARRIED} name (@vasya&#58;fire&#58;)`), card);
    assert.ok(card.includes('🔑 Login: <code>&#123;&#123;LOGIN&#125;&#125;&#58;x&#58;</code>'), card);
    assert.ok(card.includes('📧 Email: &#123;&#123;MAIL&#125;&#125;@mail.test'), card);
    // The card's own markup and ids are untouched.
    assert.ok(card.includes('🪪 Telegram ID: <code>100200300</code>'), card);
  });

  it('shows the names in a referral card as typed, both sides of it', async () => {
    const { service, lastCard } = cardService();
    service.info('referral.created', 'REFERRAL', 'Новый реферал', {
      referralId: 'ref-1',
      referredUserId: 'user-2',
      referredName: ':fire: Петя',
      referredUsername: 'petya',
      referredLogin: 'a:b:',
      referrerId: 'user-1',
      referrerName: '{{GIFT}} Аня',
      referrerUsername: 'anya',
      referrerLogin: '{{X}}',
    });
    await flush();
    const card = lastCard();

    assert.ok(card.includes('   👤 Имя: &#58;fire&#58; Петя (@petya)'), card);
    assert.ok(card.includes('   🔑 Login: <code>a&#58;b&#58;</code>'), card);
    assert.ok(card.includes('   👤 Имя: &#123;&#123;GIFT&#125;&#125; Аня (@anya)'), card);
    assert.ok(card.includes('   🔑 Login: <code>&#123;&#123;X&#125;&#125;</code>'), card);
  });

  it('shows an offender’s name, username and address as typed on an anti-fraud card', async () => {
    const { service, lastCard } = cardService();
    service.warn('fraud.hwid_overage', 'FRAUD', 'HWID overage', {
      fraudKind: 'hwid_overage',
      fraudHasRezeisAccount: true,
      fraudUserName: ':fire: Нарушитель',
      fraudUsername: 'bad:guy:',
      fraudUserEmail: '{{VIP}}@mail.test',
    });
    await flush();
    const card = lastCard();

    assert.ok(card.includes('👤 Имя: &#58;fire&#58; Нарушитель'), card);
    assert.ok(card.includes('👤 Username: @bad&#58;guy&#58;'), card);
    assert.ok(card.includes('📧 Email: &#123;&#123;VIP&#125;&#125;@mail.test'), card);
  });

  it('shows the customer as typed on an error card too', () => {
    const card = formatErrorEventCardHtml(
      {
        kind: 'event.reiwa.error',
        severity: 'ERROR',
        category: 'SYSTEM',
        message: 'boom',
        timestamp: '2026-09-24T10:00:00.000Z',
        metadata: { userId: 'user-1', userName: ':fire: {{VIP}}', username: 'a:b:' },
      },
      { service: 'rezeis', version: '1', commit: 'abc', branch: 'main' },
    );
    assert.ok(card.includes('👤 Имя: &#58;fire&#58; &#123;&#123;VIP&#125;&#125; (@a&#58;b&#58;)'), card);
  });
});

// ── The operator's copy of a notification, and the notification itself ─────

const FIRE_ID = '5368324170671202286';

/** The panel's own emoji pass, with a pack that holds `:fire:`. */
function customEmoji(): CustomEmojiService {
  const prisma = {
    settings: {
      findFirst: async () => ({
        systemNotifications: {
          customEmojiPacks: [
            {
              id: 'pack-1',
              name: 'Pack',
              emojis: [{ slug: 'fire', imageUrl: '/uploads/fire.png', fallback: '🔥', customEmojiId: FIRE_ID }],
            },
          ],
        },
      }),
    },
  };
  return new CustomEmojiService(prisma as never, {} as never, {} as never);
}

function notifications(options: { readonly name: string; readonly username?: string | null }) {
  const relayed: Array<{ event: string; metadata: Record<string, unknown> }> = [];
  const pushes: Array<{ body: string }> = [];
  let created = 0;
  const prisma = {
    userNotificationEvent: {
      create: async (args: { data: { userId: string; type: string; payload: unknown } }) => ({
        id: `evt-${(created += 1)}`,
        userId: args.data.userId,
        type: args.data.type,
        payload: args.data.payload,
      }),
      count: async () => 0,
      update: async () => ({}),
    },
    user: {
      findUnique: async () => ({
        telegramId: null,
        isBotBlocked: false,
        name: options.name,
        username: options.username ?? null,
        language: 'ru',
        notificationPrefs: null,
      }),
    },
    settings: {
      findUnique: async () => ({
        systemNotifications: { telegram: { enabled: true, mirrorUserNotifications: true, chatId: '-100200' } },
        platformPolicy: {},
      }),
    },
  };
  const service = new UserNotificationsService(
    prisma as never,
    { getByType: async () => null } as never,
    { notifyUser: async () => undefined } as never,
    {
      resolveBrandName: async () => 'Winger VPN',
      sendToUser: async (payload: { body: string }) => {
        pushes.push(payload);
        return { attempted: 1, delivered: 1, failed: 0, disabled: false };
      },
      isConfigured: async () => true,
      countSubscriptions: async () => 1,
    } as never,
    customEmoji(),
    {
      enqueue: async (event: string, metadata: Record<string, unknown>) => {
        relayed.push({ event, metadata });
        return true;
      },
    } as never,
  );
  return {
    service,
    mirror: () => String(relayed.find((job) => job.event === 'reiwa.channel.broadcast')?.metadata['text'] ?? ''),
    pushes,
  };
}

describe('the operator’s copy of a notification', () => {
  it('names the recipient as typed', async () => {
    const { service, mirror } = notifications({ name: ':fire: Вася {{VIP}}', username: 'vasya:x:' });
    await service.create({ userId: 'user-1', type: 'subscription.expiring', payload: {}, preRenderedText: 'Подписка истекает' });
    await flush();

    assert.ok(mirror().includes('👤 Имя: &#58;fire&#58; Вася &#123;&#123;VIP&#125;&#125; (@vasya&#58;x&#58;)'), mirror());
  });

  it('carries the notification with the subscriber’s own words as typed, and the operator’s template emoji resolved', async () => {
    const { service } = notifications({ name: 'unused' });
    const rendered = await (
      service as unknown as {
        renderFromTemplate: (
          template: { title: string; body: string; titleEn: null; bodyEn: null },
          payload: unknown,
          userName: string | null,
          locale: 'ru',
        ) => Promise<{ title: string; body: string; html: string }>;
      }
    ).renderFromTemplate(
      {
        title: ':fire: {{name}}, вас пригласил {{referrerName}}',
        body: ':fire: Привет, {{name}}! Логин: {{login}}. Тариф: {{plan}}.',
        titleEn: null,
        bodyEn: null,
      },
      { referrerName: '{{GIFT}} Аня', login: 'a:fire:', plan: 'Pro <Max>' },
      ':fire: Вася',
      'ru',
    );

    const tag = `<tg-emoji emoji-id="${FIRE_ID}">🔥</tg-emoji>`;
    assert.equal(
      rendered.html,
      `<b>${tag} &#58;fire&#58; Вася, вас пригласил &#123;&#123;GIFT&#125;&#125; Аня</b>\n\n` +
        `${tag} Привет, &#58;fire&#58; Вася! Логин: a&#58;fire&#58;. Тариф: Pro &lt;Max&gt;.`,
    );
  });
});

describe('the subscriber’s own feed, push and letter text', () => {
  /** How the cabinet's feed finds a token (reiwa `EmojiText`, `SHORTCODE_RE`). */
  const CABINET_TOKEN = /:([a-z0-9_]+):/;
  const WORD_JOINER = String.fromCharCode(0x2060);
  const shown = (text: string): string => text.split(WORD_JOINER).join('');

  function render(payload: Record<string, unknown>, userName: string) {
    const { service } = notifications({ name: 'unused' });
    return (
      service as unknown as {
        renderFromTemplate: (
          template: { title: string; body: string; titleEn: null; bodyEn: null },
          payload: unknown,
          userName: string | null,
          locale: 'ru',
        ) => Promise<{ title: string; body: string; html: string }>;
      }
    ).renderFromTemplate(
      {
        title: ':fire: {{name}}, вас пригласил {{referrerName}}',
        body: ':fire: Привет, {{name}}! Логин: {{login}}. Тариф: {{plan}}.',
        titleEn: null,
        bodyEn: null,
      },
      payload,
      userName,
      'ru',
    );
  }

  it('shows their name, login and inviter as typed, and resolves the operator’s own emoji and values', async () => {
    const rendered = await render({ referrerName: '{{GIFT}} :fire: Аня', login: 'a:fire:', plan: ':fire: Pro' }, ':fire: Вася');

    assert.equal(shown(rendered.title), '🔥 :fire: Вася, вас пригласил {{GIFT}} :fire: Аня');
    assert.equal(shown(rendered.body), '🔥 Привет, :fire: Вася! Логин: a:fire:. Тариф: 🔥 Pro.');
  });

  it('leaves the cabinet’s feed nothing to draw as an emoji in what the subscriber typed', async () => {
    const rendered = await render({ referrerName: 'Аня', login: 'x:fire:y', plan: 'Pro' }, ':fire:');

    // The operator's `:fire:` is a glyph by now; the subscriber's, broken for
    // the feed's pass by characters that show nothing.
    assert.equal(CABINET_TOKEN.test(rendered.title), false, rendered.title);
    assert.equal(CABINET_TOKEN.test(rendered.body), false, rendered.body);
    assert.equal(shown(rendered.body), '🔥 Привет, :fire:! Логин: x:fire:y. Тариф: Pro.');
  });

  it('changes nothing for a name without a colon', async () => {
    const rendered = await render({ referrerName: 'Аня', login: 'vasya', plan: 'Pro' }, 'Вася');
    assert.equal(rendered.title, '🔥 Вася, вас пригласил Аня');
    assert.equal(rendered.body, '🔥 Привет, Вася! Логин: vasya. Тариф: Pro.');
  });
});

describe('a support reply to the customer — and so its operator copy', () => {
  function support(template: { title: string; body: string } | null) {
    const created: Array<{ preRenderedText?: string; payload?: Record<string, unknown> }> = [];
    const service = new SupportNotificationsService(
      { create: async (input: (typeof created)[number]) => void created.push(input) } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getByType: async () =>
          template === null ? null : { ...template, titleEn: null, bodyEn: null, buttons: [], isActive: true },
      } as never,
    );
    return { service, created };
  }

  it('carries the customer’s subject as typed, in the template’s body and title', async () => {
    const { service, created } = support({ title: 'Ответ: {{subject}}', body: '<i>«{{subject}}»</i> :fire:' });
    await service.notifyAdminReply({ ticketId: 't-1', subject: TYPED, user: { id: 'user-1', language: 'ru' } });

    const html = created[0]?.preRenderedText ?? '';
    // The operator's own words — the colon of «Ответ:», the `:fire:` — as written.
    assert.equal(html, `<b>Ответ: ${CARRIED}</b>\n\n<i>«${CARRIED}»</i> :fire:`);
    // The feed's copy is plain to the cabinet: escaped as before, no references —
    // and the client's colons out of reach of the feed's own emoji pass, which
    // still draws the operator's `:fire:`.
    const joiner = String.fromCharCode(0x2060);
    assert.equal(
      created[0]?.payload?.['text'],
      `<i>«ключ {{SUB_ID}} не работает, пишу ${joiner}:${joiner}fire${joiner}:${joiner} срочно &lt;b&gt;&amp;»</i> :fire:`,
    );
  });

  it('carries it as typed in the built-in words as well', async () => {
    const { service, created } = support(null);
    await service.notifyAdminReply({ ticketId: 't-1', subject: TYPED, user: { id: 'user-1', language: 'ru' } });

    assert.ok((created[0]?.preRenderedText ?? '').includes(`«${CARRIED}»`), created[0]?.preRenderedText);
  });

  it('reaches the lock screen as typed: the push reads the references', async () => {
    const { service, pushes } = notifications({ name: 'Вася' });
    await service.create({
      userId: 'user-1',
      type: 'support_reply',
      payload: {},
      preRenderedText: `<b>Поддержка ответила</b>\n\nПо обращению «${CARRIED}»`,
    });
    await flush();

    assert.equal(pushes[0]?.body, `Поддержка ответила\n\nПо обращению «${TYPED}»`);
  });
});
