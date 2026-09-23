import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { BotButtonAction } from '@prisma/client';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { BotButtonsService } from '../src/modules/bot-config/services/bot-buttons.service';
import { MINI_APP_TERMINALS } from '../src/modules/bot-map/catalogs/mini-app-terminals.catalog';

/**
 * What a main-menu button's «Внешняя ссылка» or «Mini App» target may be.
 *
 * reiwa opens a page of the cabinet for both kinds (`addressOn`,
 * `miniAppButtonUrl` in its `widgets/main-keyboard.ts`), and the Mini App page
 * picker (553e1ae6) saves one — `/referrals` — in the main-menu constructor and
 * «Кнопки бота». The validator here refused every target that did not start
 * with `http(s)://`, so saving a picked page failed with 400 on create and on
 * update, and the «Внешняя ссылка» hint promised `/plans` for nothing.
 *
 * The rule now (owner's decisions, 23.09.2026): a target that starts with a
 * single `/` is a page, without `//`, backslashes, whitespace, control or
 * invisible formatting characters; an `http(s)://` address must parse, with a
 * site and no whitespace, and a Mini App's must start with `https://` written
 * in lower case — reiwa compares it case-sensitively and drops `Https://`, the
 * spelling a phone's auto-capital gives; neither kind takes an address whose
 * HOST is local, which Telegram refuses.
 */

interface SavedRow {
  readonly actionType?: BotButtonAction;
  readonly actionTarget?: string | null;
}

function service(existing: Record<string, unknown> | null = null): BotButtonsService {
  const prisma = {
    botButton: {
      findUnique: async () => existing,
      findFirst: async () => ({ orderIndex: 3 }),
      create: async ({ data }: { data: SavedRow }) => data,
      update: async ({ data }: { data: SavedRow }) => data,
    },
  };
  return new BotButtonsService(prisma as never);
}

async function created(actionType: BotButtonAction, actionTarget: string | null): Promise<SavedRow> {
  return (await service().create({ buttonId: 'b', label: 'Кнопка', actionType, actionTarget })) as SavedRow;
}

async function updated(actionType: BotButtonAction, actionTarget: string | null): Promise<SavedRow> {
  const row = { id: 'b1', actionType: BotButtonAction.CALLBACK, actionTarget: null };
  return (await service(row).update({ id: 'b1', actionType, actionTarget })) as SavedRow;
}

async function refusal(actionType: BotButtonAction, actionTarget: string): Promise<BadRequestException> {
  let thrown: unknown = null;
  try {
    await created(actionType, actionTarget);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof BadRequestException, `${actionType} ${JSON.stringify(actionTarget)} was saved`);
  // Update refuses what create refuses.
  await assert.rejects(updated(actionType, actionTarget), BadRequestException);
  return thrown;
}

const ADDRESS_KINDS = [BotButtonAction.URL, BotButtonAction.WEBAPP] as const;

describe('a main-menu button’s address, as saved', () => {
  it('takes every page the Mini App page picker offers, on create and on update', async () => {
    for (const actionType of ADDRESS_KINDS) {
      for (const { route } of MINI_APP_TERMINALS) {
        assert.equal((await created(actionType, route)).actionTarget, route, `${actionType} ${route}`);
        assert.equal((await updated(actionType, route)).actionTarget, route, `${actionType} ${route}`);
      }
    }
  });

  it('takes a page with parameters, the root, and a page typed with spaces around it', async () => {
    assert.equal((await created(BotButtonAction.WEBAPP, '/promo?code=SALE')).actionTarget, '/promo?code=SALE');
    assert.equal((await created(BotButtonAction.URL, '/')).actionTarget, '/');
    assert.equal((await updated(BotButtonAction.URL, '  /plans  ')).actionTarget, '/plans');
  });

  it('takes an address as before — a link on http or https, a Mini App on https — and no target at all', async () => {
    assert.equal((await created(BotButtonAction.URL, 'http://example.com/a')).actionTarget, 'http://example.com/a');
    assert.equal((await created(BotButtonAction.URL, 'https://example.com/a')).actionTarget, 'https://example.com/a');
    assert.equal((await created(BotButtonAction.WEBAPP, 'https://example.com/app')).actionTarget, 'https://example.com/app');
    assert.equal((await created(BotButtonAction.WEBAPP, '   ')).actionTarget, null);
  });

  it('refuses a path without its leading slash, and one starting with two', async () => {
    for (const actionType of ADDRESS_KINDS) {
      for (const target of ['plans', '//evil.example/x']) {
        const error = await refusal(actionType, target);
        assert.match(String(error.message), /single "\/"/);
      }
    }
  });

  it('refuses a backslash, whitespace or a control character inside a path', async () => {
    const TAB = String.fromCharCode(9);
    const NUL = String.fromCharCode(0);
    for (const target of ['/\\evil.example', '/pl ans', `/pl${TAB}ans`, `/plans${NUL}`]) {
      const error = await refusal(BotButtonAction.URL, target);
      assert.match(String(error.message), /spaces, backslashes, control or invisible formatting characters/);
    }
  });

  it('refuses a C1 control, a zero-width or a bidi formatting character inside a path, and takes a Cyrillic one', async () => {
    // Written by code point: the characters themselves are invisible in this file.
    const codes = [0x80, 0x85, 0x9f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0xfeff];
    for (const code of codes) {
      const error = await refusal(BotButtonAction.WEBAPP, `/pro${String.fromCodePoint(code)}mo`);
      assert.match(String(error.message), /invisible formatting characters/, code.toString(16));
    }
    assert.equal((await created(BotButtonAction.URL, '/промо')).actionTarget, '/промо');
  });

  it('refuses an address that does not parse, has no site after its scheme, or holds a space', async () => {
    for (const actionType of ADDRESS_KINDS) {
      // The last one parses — a URL parser encodes the space — and is refused for the space.
      for (const target of ['https://exa mple.com', 'https://', 'https://example.com/a b']) {
        const error = await refusal(actionType, target);
        assert.match(String(error.message), /a whole address/, `${actionType} ${target}`);
      }
    }
  });

  it('refuses a Mini App whose scheme is not written in lower case — the bot leaves it out — and takes such a link', async () => {
    for (const target of ['Https://example.com/app', 'HTTPS://example.com/app']) {
      const error = await refusal(BotButtonAction.WEBAPP, target);
      assert.match(String(error.message), /in lower case/, target);
    }
    // A «Внешняя ссылка» goes out as typed, as before.
    assert.equal((await created(BotButtonAction.URL, 'HTTPS://example.com/a')).actionTarget, 'HTTPS://example.com/a');
  });

  it('refuses a local address for both kinds, and a Mini App on http', async () => {
    for (const actionType of ADDRESS_KINDS) {
      const error = await refusal(actionType, 'https://localhost:5173/app');
      assert.match(String(error.message), /localhost or 127\.0\.0\.1/);
    }
    await refusal(BotButtonAction.URL, 'http://127.0.0.1/x');
    await refusal(BotButtonAction.URL, 'https://LOCALHOST/x');
    const http = await refusal(BotButtonAction.WEBAPP, 'http://example.com/app');
    assert.match(String(http.message), /must use https:\/\//);
  });

  it('calls an address local by its host, not by what its path or query mention', async () => {
    for (const target of ['https://example.com/?next=http://localhost/x', 'https://localhost.example.com/a']) {
      assert.equal((await created(BotButtonAction.URL, target)).actionTarget, target);
      assert.equal((await created(BotButtonAction.WEBAPP, target)).actionTarget, target);
    }
  });

  it('keeps its reason on the way to the operator: the admin filter passes each one through', async () => {
    const targets: ReadonlyArray<[BotButtonAction, string]> = [
      [BotButtonAction.URL, 'plans'],
      [BotButtonAction.URL, '/pl ans'],
      [BotButtonAction.URL, 'https://exa mple.com'],
      [BotButtonAction.URL, 'https://localhost:5173/'],
      [BotButtonAction.WEBAPP, 'http://example.com/app'],
      [BotButtonAction.WEBAPP, 'Https://example.com/app'],
    ];
    for (const [actionType, target] of targets) {
      const error = await refusal(actionType, target);
      const body = throughFilter(error);
      // The forms show `message` as it comes; the filter blanks one it finds
      // an address or a secret in, and the operator would read «Request failed».
      assert.equal(body.message, error.message, `${actionType} ${target}`);
    }
  });

  it('gives no address to a button that has none to follow', async () => {
    assert.equal((await created(BotButtonAction.CALLBACK, 'https://example.com')).actionTarget, null);
    assert.equal((await created(BotButtonAction.SUPPORT_URL, '/plans')).actionTarget, null);
  });
});

function throughFilter(error: unknown): { readonly message?: unknown } {
  let body: unknown = null;
  const response = {
    status: () => response,
    json: (value: unknown) => {
      body = value;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/api/admin/bot-config/buttons', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(error, host);
  return body as { readonly message?: unknown };
}
