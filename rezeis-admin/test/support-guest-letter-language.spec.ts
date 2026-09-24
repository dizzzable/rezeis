import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';

import { InternalGuestSupportController } from '../src/modules/support-tickets/controllers/internal-guest-support.controller';
import { CreateGuestTicketDto, GuestReplyDto } from '../src/modules/support-tickets/dto/guest-support.dto';
import { SupportGuestService } from '../src/modules/support-tickets/services/support-guest.service';
import { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';
import {
  GUEST_LOCALE_HEADER,
  guestLetterLanguage,
  readGuestLocale,
} from '../src/modules/support-tickets/utils/guest-letter-language.util';

/**
 * THE GUEST'S LETTERS ARE IN THE GUEST'S LANGUAGE.
 *
 * A visitor who writes to support from the site without an account, and leaves
 * an email, gets a letter when an operator replies. It was Russian for
 * everybody: nothing on record said which language a guest reads. The guest
 * page now sends its own, `ru` or `en`, with the message that opens the
 * conversation and with each reply; the panel keeps it on that message, and
 * the letter follows the newest one that names a language.
 *
 * It travels in a HEADER (`X-Support-Guest-Locale`). The panel's pipe refuses a
 * body property a DTO does not declare, so the same field in the body would
 * have failed the whole conversation on a panel older than this one — the
 * cabinet usually ships first. A panel that does not read the header ignores
 * it; a cabinet that does not send it gets the Russian letter it always got.
 */

afterEach(() => mock.restoreAll());

interface Letter {
  readonly subject?: string;
  readonly rawHtml?: string;
  readonly locale?: string;
}

/** The letter a guest gets for an operator reply, the guest's messages (newest first) as the database holds them. */
async function letterFor(
  messages: ReadonlyArray<{ readonly metadata: unknown }> | undefined,
  options: { readonly button?: boolean; readonly reachable?: boolean } = {},
): Promise<Letter> {
  mock.method(Logger.prototype, 'warn', () => undefined);
  const sent: Letter[] = [];
  let select: Record<string, unknown> | undefined;
  const service = new SupportNotificationsService(
    {} as never,
    {
      supportTicket: {
        findUnique: async (args: { select?: Record<string, unknown> }) => {
          select = args.select;
          return {
            subject: 'Оплата',
            status: 'WAITING_REPLY',
            guestId: 'g-1',
            guest: {
              id: 'g-1',
              email: 'visitor@example.com',
              expiresAt: new Date(Date.now() + (options.reachable === false ? -60_000 : 3_600_000)),
            },
            ...(messages === undefined ? {} : { messages }),
          };
        },
      },
    } as never,
    {
      getSmtpSettings: async () => ({ enabled: true, host: 'smtp.example.com' }),
      sendImmediate: async (payload: Letter) => {
        sent.push(payload);
        return { success: true };
      },
    } as never,
    {
      newEmailResumeToken: () => 'resume-tok',
      letterTokenIssuedAt: () => null,
      extendAccessOnOperatorReply: async () => options.reachable !== false,
      activateEmailResumeToken: async () => 'activated' as const,
    } as never,
    { getByType: async () => null } as never,
    {
      resolveCabinetWebBaseUrl: async () => (options.button === false ? null : 'https://cab.example.com'),
    } as never,
  );
  await service.notifyGuestReply('t-1');
  assert.equal(sent.length, 1, 'no letter went out');
  // The letter reads the guest's own messages, newest first — not an
  // operator's, and not the oldest.
  assert.deepEqual(
    (select?.['messages'] as { where?: unknown; orderBy?: unknown } | undefined)?.where,
    { authorType: 'USER' },
  );
  assert.deepEqual((select?.['messages'] as { orderBy?: unknown }).orderBy, { createdAt: 'desc' });
  return sent[0];
}

describe('the guest reply letter, in the guest’s language', () => {
  it('is English — subject, words, button and the letter’s lang — for a guest who wrote in English', async () => {
    const letter = await letterFor([{ metadata: { locale: 'en' } }]);

    assert.equal(letter.subject, 'Support replied to your request');
    assert.equal(letter.locale, 'en', 'the letter is still marked as Russian');
    assert.match(letter.rawHtml ?? '', /There is a new reply from support to your request “Оплата”\./);
    assert.match(letter.rawHtml ?? '', /Press the button below to return to the conversation\./);
    assert.match(letter.rawHtml ?? '', />Open conversation<\/a>/);
    // The guest's own subject is theirs; nothing else may be Russian.
    assert.doesNotMatch((letter.rawHtml ?? '').replace('Оплата', ''), /[а-яё]/i, 'Russian words left in the English letter');
  });

  it('is Russian for a guest who wrote in Russian', async () => {
    const letter = await letterFor([{ metadata: { locale: 'ru' } }]);

    assert.equal(letter.subject, 'Поддержка ответила на ваше обращение');
    assert.equal(letter.locale, 'ru');
    assert.match(letter.rawHtml ?? '', /По вашему обращению «Оплата» есть новый ответ от поддержки/);
    assert.match(letter.rawHtml ?? '', />Открыть переписку<\/a>/);
  });

  it('is Russian, as it always was, when the cabinet sent no language (an older cabinet)', async () => {
    for (const messages of [[{ metadata: null }], [], undefined]) {
      const letter = await letterFor(messages);
      assert.equal(letter.subject, 'Поддержка ответила на ваше обращение', JSON.stringify(messages));
      assert.equal(letter.locale, 'ru');
    }
  });

  it('is Russian for a language it is not written in', async () => {
    for (const metadata of [{ locale: 'de' }, { locale: '' }, { locale: 42 }, { type: 'document_request' }, 'en', ['en']]) {
      const letter = await letterFor([{ metadata }]);
      assert.equal(letter.locale, 'ru', JSON.stringify(metadata));
    }
  });

  it('follows the language the guest wrote in LAST', async () => {
    // Newest first, as the letter reads them: the guest switched the page to
    // Russian after opening the conversation in English.
    assert.equal((await letterFor([{ metadata: { locale: 'ru' } }, { metadata: { locale: 'en' } }])).locale, 'ru');
    assert.equal((await letterFor([{ metadata: { locale: 'en' } }, { metadata: { locale: 'ru' } }])).locale, 'en');
    // A newer message without a language (sent from an older cabinet) does not
    // hide the one before it.
    assert.equal((await letterFor([{ metadata: null }, { metadata: { locale: 'en' } }])).locale, 'en');
  });

  it('says where the reply is in English when there is no button, and that it cannot be opened when so', async () => {
    const noButton = await letterFor([{ metadata: { locale: 'en' } }], { button: false });
    assert.match(noButton.rawHtml ?? '', /It is waiting for you in the support chat on the site\./);
    assert.doesNotMatch(noButton.rawHtml ?? '', /button/i);

    const unreachable = await letterFor([{ metadata: { locale: 'en' } }], { reachable: false });
    assert.match(unreachable.rawHtml ?? '', /the conversation can no longer be opened on the site/);
    assert.match(unreachable.rawHtml ?? '', /write to support on the site again/);
    assert.doesNotMatch(unreachable.rawHtml ?? '', /<a /);
  });
});

describe('the language the guest page sends', () => {
  it('is read from its header — ru or en, whatever the case and spacing; anything else is none', () => {
    assert.equal(GUEST_LOCALE_HEADER, 'x-support-guest-locale');
    assert.equal(readGuestLocale('en'), 'en');
    assert.equal(readGuestLocale(' EN '), 'en');
    assert.equal(readGuestLocale('ru'), 'ru');
    for (const value of ['de', 'en-US', '', undefined, null, 1, ['en']]) {
      assert.equal(readGuestLocale(value), null, JSON.stringify(value));
    }
    assert.equal(guestLetterLanguage(undefined), 'ru');
  });

  it('is handed from the header to the conversation on create and on each reply', async () => {
    const created: Array<{ locale?: unknown }> = [];
    const replied: unknown[] = [];
    const controller = new InternalGuestSupportController(
      {
        createConversation: async (input: { locale?: unknown }) => {
          created.push(input);
          return { token: 'tok', ticketId: 't-1' };
        },
        getConversation: async () => null,
        reply: async (_token: string, _content: string, locale?: unknown) => {
          replied.push(locale);
          const at = new Date('2026-09-24T10:00:00.000Z');
          return { id: 't-1', subject: 's', status: 'OPEN', channel: 'GUEST', createdAt: at, updatedAt: at, messages: [] };
        },
      } as never,
      { info: () => undefined } as never,
      { getSupportRuntimeConfig: async () => ({ enabled: true, turnstileSiteKey: '', turnstileSecret: null }) } as never,
      { evaluate: async () => ({ kind: 'allow', flaggedReason: null }) } as never,
    );
    const body: CreateGuestTicketDto = { subject: 's', message: 'm' };

    await controller.create(body, undefined, 'en');
    await controller.create(body, undefined, 'fr');
    await controller.create(body, undefined);
    assert.deepEqual(
      created.map((input) => input.locale),
      ['en', null, null],
    );

    const reply: GuestReplyDto = { content: 'still there?' };
    await controller.reply('tok', reply, 'RU');
    await controller.reply('tok', reply);
    assert.deepEqual(replied, ['ru', null]);
  });

  it('is kept on the message it came with, and nothing is kept when it named none', async () => {
    const messages: Array<{ metadata?: unknown }> = [];
    const service = new SupportGuestService(
      {
        supportGuest: {
          create: async () => ({ id: 'g-1' }),
          findFirst: async () => ({
            id: 'g-1',
            secretHash: 'not-this-token',
            expiresAt: new Date(Date.now() + 3_600_000),
            ticket: { id: 't-1', status: 'OPEN' },
          }),
          update: async () => ({}),
        },
      } as never,
      {
        createGuest: async () => ({ id: 't-1' }),
        addMessage: async (input: { metadata?: unknown }) => {
          messages.push(input);
        },
        getById: async () => ({ id: 't-1' }),
      } as never,
      {} as never,
      { getSupportLimits: async () => ({ guestTokenTtlHours: 72 }) } as never,
    );

    const { token } = await service.createConversation({ subject: 's', message: 'm', locale: 'en' });
    await service.reply(token, 'next', 'ru');
    await service.reply(token, 'from an older cabinet');
    await service.createConversation({ subject: 's', message: 'm' });

    assert.deepEqual(
      messages.map((message) => message.metadata),
      [{ locale: 'en' }, { locale: 'ru' }, undefined, undefined],
    );
  });

  it('cannot ride in the body: the pipe refuses a property the DTO does not declare, as an older panel would', async () => {
    // The options `main.ts` gives the global pipe. This is why the cabinet
    // sends a header: `{ locale }` in the body is a 400 on every panel whose
    // DTO does not list it — a guest who could not start a conversation at all.
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    await assert.rejects(
      pipe.transform({ subject: 's', message: 'm', locale: 'en' }, { type: 'body', metatype: CreateGuestTicketDto }),
      BadRequestException,
    );
    await assert.rejects(
      pipe.transform({ content: 'x', locale: 'en' }, { type: 'body', metatype: GuestReplyDto }),
      BadRequestException,
    );
    await assert.doesNotReject(
      pipe.transform({ subject: 's', message: 'm' }, { type: 'body', metatype: CreateGuestTicketDto }),
    );
  });
});
