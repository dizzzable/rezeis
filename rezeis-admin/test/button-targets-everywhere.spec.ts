import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, BadRequestException, ValidationPipe } from '@nestjs/common';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { BotButtonsService } from '../src/modules/bot-config/services/bot-buttons.service';
import { AdminBotFlowController } from '../src/modules/bot-flow/controllers/admin-bot-flow.controller';
import { BotFlowScreenService } from '../src/modules/bot-flow/services/bot-flow-screen.service';
import { MINI_APP_TERMINALS } from '../src/modules/bot-map/catalogs/mini-app-terminals.catalog';
import {
  BUTTON_TARGET_PROBLEM_MESSAGES,
  buttonTargetRefusal,
} from '../src/modules/bot-map/services/button-target-refusal';
import {
  buttonTargetProblem,
  menuButtonTargetProblem,
  type ButtonTargetPlace,
  type ButtonTargetProblem,
} from '../src/modules/bot-map/services/menu-button-route';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { AdminNotificationTemplatesController } from '../src/modules/notifications/controllers/admin-notification-templates.controller';
import {
  CreateNotificationTemplateDto,
  UpdateNotificationTemplateDto,
} from '../src/modules/notifications/dto/notification-template.dto';
import { NotificationTemplatesService } from '../src/modules/notifications/services/notification-templates.service';
import { validateStoredButton } from '../src/modules/notifications/utils/notification-template-locale.util';

/**
 * A BUTTON'S TARGET IS SAVED BY ONE RULE, WHEREVER IT IS SAVED.
 *
 * A main-menu button's «Внешняя ссылка» and «Mini App» were checked on save —
 * the route model's rule, the same in the server and the SPA — and a form
 * showed why before sending. A notification's buttons and a screen's were not:
 * any string saved, and «Карта бота» then drew the button red — a Mini App
 * address in a notification (which the bot opens as `<miniApp>/https://…`, a
 * page the cabinet does not have), a screen's `http://` link (which the bot
 * leaves out). Now the same rule (`buttonTargetProblem`) is asked what each
 * place can open, and refuses the rest with the main menu's words.
 *
 * Each request goes the way the app sends it: `main.ts`'s global pipe, the
 * controller, the service, a fake Prisma underneath.
 */

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

async function validated<T>(metatype: new () => T, body: unknown): Promise<T> {
  return (await pipe.transform(body, { type: 'body', metatype })) as T;
}

const PAGES = MINI_APP_TERMINALS.map((terminal) => terminal.route);

describe('the rule, by where a target is read', () => {
  const table: ReadonlyArray<[ButtonTargetPlace, string, ButtonTargetProblem | null]> = [
    // A notification's Mini App: the bot puts the target after its own address.
    ['notificationWebApp', '/renew', null],
    ['notificationWebApp', '/dashboard?connect=help', null],
    ['notificationWebApp', 'https://example.com/app', 'pageOnly'],
    ['notificationWebApp', 'http://example.com/app', 'pageOnly'],
    // A page typed without its slash: the bot gives it one (`internal-http-listener.ts`).
    ['notificationWebApp', 'renew', null],
    ['notificationWebApp', 'referrals?tab=1', null],
    // An address with its scheme or its site left off is not a page.
    ['notificationWebApp', 't.me/channel', 'pageOnly'],
    ['notificationWebApp', 'tg://resolve?domain=x', 'pageOnly'],
    ['notificationWebApp', '//evil.example', 'pageOnly'],
    ['notificationWebApp', '/re new', 'badCharacters'],
    ['notificationWebApp', 're new', 'badCharacters'],
    // A notification's link: the panel sends an https address and nothing else.
    ['notificationUrl', 'https://example.com/a', null],
    ['notificationUrl', 'https://example.com/?next=http://localhost/x', null],
    ['notificationUrl', 'http://example.com/a', 'linkNeedsHttps'],
    ['notificationUrl', 'HTTPS://example.com/a', 'upperCaseScheme'],
    ['notificationUrl', 'https://localhost:5173/', 'localAddress'],
    ['notificationUrl', 'https://exa mple.com', 'notAnAddress'],
    ['notificationUrl', '/plans', 'addressOnly'],
    ['notificationUrl', 'tg://resolve?domain=x', 'addressOnly'],
    // A screen's link: https as typed, or a page of the cabinet; http left out.
    ['screenUrl', 'https://example.com/a', null],
    ['screenUrl', '/plans', null],
    ['screenUrl', 'http://example.com/a', 'linkNeedsHttps'],
    ['screenUrl', 'Https://example.com/a', 'upperCaseScheme'],
    ['screenUrl', 'plans', null],
    ['screenUrl', 'example.com/a', 'notAPage'],
    ['screenUrl', '@support', 'notAPage'],
    ['screenUrl', 'mailto:help@example.com', 'notAPage'],
    ['screenUrl', 'https://127.0.0.1/x', 'localAddress'],
    // A screen's Mini App: as a main-menu one.
    ['screenWebApp', '/referrals', null],
    ['screenWebApp', 'https://example.com/app', null],
    ['screenWebApp', 'http://example.com/app', 'webAppNeedsHttps'],
    ['screenWebApp', 'referrals', null],
    ['screenWebApp', 'www.example.com', 'notAPage'],
  ];

  for (const [place, target, reason] of table) {
    it(`${place}: ${JSON.stringify(target)} → ${reason ?? 'saved'}`, () => {
      assert.equal(buttonTargetProblem(place, target), reason);
    });
  }

  it('takes an empty target everywhere — the map shows what a button without one does', () => {
    for (const place of ['menuUrl', 'menuWebApp', 'screenUrl', 'screenWebApp', 'notificationUrl', 'notificationWebApp'] as const) {
      assert.equal(buttonTargetProblem(place, null), null, place);
      assert.equal(buttonTargetProblem(place, '  '), null, place);
    }
  });

  it('takes every page of the cabinet where a page is opened', () => {
    for (const page of PAGES) {
      for (const place of ['menuUrl', 'menuWebApp', 'screenUrl', 'screenWebApp', 'notificationWebApp'] as const) {
        assert.equal(buttonTargetProblem(place, page), null, `${place} ${page}`);
      }
    }
  });

  it('is the main menu’s own rule: «Внешняя ссылка» takes http, a Mini App does not, both take a page without its slash', () => {
    assert.equal(menuButtonTargetProblem('URL', 'http://example.com/a'), null);
    assert.equal(menuButtonTargetProblem('WEBAPP', 'http://example.com/a'), 'webAppNeedsHttps');
    assert.equal(menuButtonTargetProblem('URL', 'HTTPS://example.com/a'), null);
    // reiwa's `addressOn` gives `plans` its slash, as the notification sender
    // and the screen renderer do.
    assert.equal(menuButtonTargetProblem('URL', 'plans'), null);
    assert.equal(menuButtonTargetProblem('WEBAPP', 'referrals'), null);
    assert.equal(menuButtonTargetProblem('URL', 'example.com/plans'), 'notAPage');
    assert.equal(menuButtonTargetProblem('SCREEN', 'plans'), null);
  });

  it('refuses a main-menu button in the main menu’s words', async () => {
    const prisma = {
      botButton: {
        findUnique: async () => null,
        findFirst: async () => ({ orderIndex: 0 }),
        create: async ({ data }: { data: unknown }) => data,
      },
    };
    const message = await refusedMessage(() =>
      new BotButtonsService(prisma as never).create({
        buttonId: 'plans',
        label: 'Тарифы',
        actionType: 'URL',
        actionTarget: 'example.com/plans',
      }),
    );
    assert.equal(
      message,
      'actionTarget must be a page of the cabinet (such as /plans) or a whole address starting with http:// or https://',
    );
  });

  it('gives the main menu’s words for the main menu’s reasons, whatever the field', () => {
    assert.equal(
      buttonTargetRefusal('notAPage', 'actionTarget'),
      'actionTarget must be a page of the cabinet (such as /plans) or a whole address starting with http:// or https://',
    );
    assert.equal(
      buttonTargetRefusal('localAddress', 'buttons.0.target'),
      'buttons.0.target must not point at localhost or 127.0.0.1: Telegram refuses such an address',
    );
  });
});

// ── A notification's buttons ──────────────────────────────────────────────────

interface Written {
  data?: Record<string, unknown>;
}

function notificationTemplates(written: Written, stored: Record<string, unknown> = {}) {
  const prisma = {
    notificationTemplate: {
      findUnique: async () => ({ id: 'tpl-1', type: 'expires_in_3_days', ...stored }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.data = data;
        return { id: 'tpl-1', type: 'expires_in_3_days', ...data };
      },
      upsert: async ({ update }: { update: Record<string, unknown> }) => {
        written.data = update;
        return { id: 'tpl-1', type: 'custom.one', ...update };
      },
    },
  };
  return new AdminNotificationTemplatesController(
    new NotificationTemplatesService(prisma as never, { info: () => undefined } as never),
  );
}

/** One button as the editor sends it (`toShape` in `NotificationEditor.tsx`). */
function shape(kind: 'webApp' | 'url' | 'callback', target: string) {
  return { labelRu: 'Открыть', labelEn: null, kind, target, style: 'default', row: 0 };
}

async function refusedMessage(run: () => Promise<unknown>): Promise<string> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof BadRequestException, `not refused: ${String(thrown)}`);
  return String((thrown.getResponse() as { message?: unknown }).message);
}

describe('a notification’s buttons, saved from «Карта бота»', () => {
  it('refuse a Mini App address and a link that is not https — naming the button', async () => {
    const written: Written = {};
    const body = await validated(UpdateNotificationTemplateDto, {
      buttons: [shape('webApp', '/renew'), shape('webApp', 'https://example.com/app')],
    });
    const message = await refusedMessage(() => notificationTemplates(written).update('tpl-1', body));
    assert.equal(message, buttonTargetRefusal('pageOnly', 'buttons.1.target'));
    assert.equal(written.data, undefined, 'a refused list was written');

    const link = await validated(UpdateNotificationTemplateDto, { buttons: [shape('url', 'http://example.com/a')] });
    assert.equal(
      await refusedMessage(() => notificationTemplates({}).update('tpl-1', link)),
      buttonTargetRefusal('linkNeedsHttps', 'buttons.0.target'),
    );
    const page = await validated(UpdateNotificationTemplateDto, { buttons: [shape('url', '/plans')] });
    assert.equal(
      await refusedMessage(() => notificationTemplates({}).update('tpl-1', page)),
      buttonTargetRefusal('addressOnly', 'buttons.0.target'),
    );
  });

  it('refuse the same on a template created by type', async () => {
    const body = await validated(CreateNotificationTemplateDto, {
      type: 'custom.one',
      title: 'T',
      body: 'B',
      buttons: [shape('webApp', 't.me/channel')],
    });
    assert.equal(
      await refusedMessage(() => notificationTemplates({}).create(body)),
      buttonTargetRefusal('pageOnly', 'buttons.0.target'),
    );
  });

  it('save a template whose older «Mini App» button names its page without the slash — the bot opens it, the map draws it green', async () => {
    // Typed by hand before the page picker: `renew` is the renewal page to
    // the bot (`internal-http-listener.ts` gives it the slash) and to the map.
    const stored = { buttons: [shape('webApp', 'renew'), shape('callback', 'menu:main')] };
    const written: Written = {};
    const body = await validated(UpdateNotificationTemplateDto, {
      buttons: [shape('webApp', 'renew'), shape('callback', 'menu:main'), shape('webApp', '/support')],
    });
    await notificationTemplates(written, stored).update('tpl-1', body);
    assert.deepEqual(
      (written.data?.buttons as Array<{ target: string }>).map((button) => button.target),
      ['renew', 'menu:main', '/support'],
    );
  });

  it('save pages, https links and callbacks as before', async () => {
    const written: Written = {};
    const body = await validated(UpdateNotificationTemplateDto, {
      buttons: [shape('webApp', '/dashboard?connect=help'), shape('url', 'https://t.me/support'), shape('callback', 'menu:main')],
    });
    await notificationTemplates(written).update('tpl-1', body);
    assert.equal((written.data?.buttons as unknown[]).length, 3);
  });

  it('save the rest of a template whose stored buttons the rule refuses: title, text, switch', async () => {
    const stored = { buttons: [shape('webApp', 'https://example.com/app')] };
    const written: Written = {};
    await notificationTemplates(written, stored).update(
      'tpl-1',
      await validated(UpdateNotificationTemplateDto, { title: 'Новый заголовок', isActive: false }),
    );
    assert.equal(written.data?.title, 'Новый заголовок');
    assert.equal(written.data?.buttons, undefined, 'the stored buttons were rewritten');
  });

  it('are what the panel ships: every default template’s buttons pass', () => {
    let checked = 0;
    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      for (const button of template.buttons ?? []) {
        if (button.kind === 'callback') continue;
        const place = button.kind === 'url' ? 'notificationUrl' : 'notificationWebApp';
        assert.equal(buttonTargetProblem(place, button.target), null, `${template.type}: ${button.target}`);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'no default button was checked');
  });
});

// ── A screen's buttons ───────────────────────────────────────────────────────

function screenButtons(written: Written, stored: Record<string, unknown> = {}) {
  const prisma = {
    botFlowScreen: { findUnique: async () => ({ flowId: 'flow-1' }) },
    botFlowButton: {
      findUnique: async () => ({ id: 'btn-1', actionType: 'URL', url: null, ...stored, screen: { flowId: 'flow-1' } }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        written.data = data;
        return data;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.data = data;
        return data;
      },
    },
    botFlow: { findUnique: async () => ({ status: 'DRAFT' }) },
  };
  return new AdminBotFlowController(null as never, new BotFlowScreenService(prisma as never));
}

function screenDtos(): { create: new () => object; update: new () => object } {
  const [create] = Reflect.getMetadata('design:paramtypes', AdminBotFlowController.prototype, 'createButton') as [
    new () => object,
  ];
  const [, update] = Reflect.getMetadata('design:paramtypes', AdminBotFlowController.prototype, 'updateButton') as [
    unknown,
    new () => object,
  ];
  return { create, update };
}

describe('a screen’s buttons, saved from «Схема»', () => {
  it('refuse an http link and a Mini App target the bot cannot open — naming the field', async () => {
    const { update } = screenDtos();
    const written: Written = {};
    assert.equal(
      await refusedMessage(async () =>
        screenButtons(written).updateButton('btn-1', (await validated(update, { url: 'http://example.com/a' })) as never),
      ),
      buttonTargetRefusal('linkNeedsHttps', 'url'),
    );
    assert.equal(
      await refusedMessage(async () =>
        screenButtons(written).updateButton('btn-1', (await validated(update, { webAppUrl: 'www.example.com' })) as never),
      ),
      buttonTargetRefusal('notAPage', 'webAppUrl'),
    );
    assert.equal(written.data, undefined, 'a refused target was written');
  });

  it('save a page typed without its slash, as the bot opens it', async () => {
    const { update } = screenDtos();
    for (const body of [{ url: 'plans' }, { webAppUrl: 'referrals?tab=1' }]) {
      const written: Written = {};
      await screenButtons(written).updateButton('btn-1', (await validated(update, body)) as never);
      assert.ok(written.data !== undefined, JSON.stringify(body));
    }
  });

  it('refuse the same when the button is created', async () => {
    const { create } = screenDtos();
    const body = await validated(create, {
      screenId: 'scr-1',
      labelRu: 'Кнопка',
      labelEn: 'Button',
      actionType: 'URL',
      url: 'http://example.com/a',
    });
    assert.equal(
      await refusedMessage(() => screenButtons({}).createButton(body as never)),
      buttonTargetRefusal('linkNeedsHttps', 'url'),
    );
  });

  it('save an https link, a page, a cleared target', async () => {
    const { update } = screenDtos();
    for (const body of [{ url: 'https://example.com/a' }, { url: '/plans' }, { webAppUrl: '/referrals' }, { url: null }]) {
      const written: Written = {};
      await screenButtons(written).updateButton('btn-1', (await validated(update, body)) as never);
      assert.ok(written.data !== undefined, JSON.stringify(body));
    }
  });

  it('save the caption, the row and the action of a button whose stored target the rule refuses', async () => {
    const { update } = screenDtos();
    const stored = { url: 'http://example.com/a' };
    for (const body of [{ labelRu: 'Новая подпись' }, { row: 2 }, { actionType: 'URL' }, { actionType: 'CALLBACK' }]) {
      const written: Written = {};
      await screenButtons(written, stored).updateButton('btn-1', (await validated(update, body)) as never);
      assert.ok(written.data !== undefined, JSON.stringify(body));
    }
  });
});

// ── The map, the delivery and the save agree ─────────────────────────────────

describe('a notification’s link, as the map and the delivery read it', () => {
  it('is local by its host alone — as the save reads it', () => {
    const link = (target: string) => validateStoredButton({ labelRu: 'x', kind: 'url', target });
    // Saved (not local by the host), so delivered and drawn green.
    assert.equal(link('https://example.com/?next=http://localhost/x'), true);
    assert.equal(link('https://localhost.example.com/a'), true);
    // Local by the host: refused on save, dropped at delivery, drawn red.
    assert.equal(link('https://user@localhost/x'), false);
    assert.equal(link('https://127.0.0.1:8443/x'), false);
    assert.equal(buttonTargetProblem('notificationUrl', 'https://user@localhost/x'), 'localAddress');
  });

  it('is left out at delivery, as it is refused on save, when it does not parse — one such button sinks the whole message', () => {
    const link = (target: string) => validateStoredButton({ labelRu: 'x', kind: 'url', target });
    for (const target of ['https://exa mple.com', 'https://', 'https://example.com/a b', 'HTTPS://example.com/a', '']) {
      assert.equal(link(target), false, JSON.stringify(target));
    }
    assert.equal(buttonTargetProblem('notificationUrl', 'https://exa mple.com'), 'notAnAddress');
    // The delivery keeps what the save takes.
    assert.equal(link('  https://example.com/a  '), true);
  });
});

describe('the refusals on their way to the operator', () => {
  it('pass the admin filter whole: no message is blanked as carrying an address', () => {
    for (const [problem, text] of Object.entries(BUTTON_TARGET_PROBLEM_MESSAGES)) {
      const error = new BadRequestException(buttonTargetRefusal(problem as ButtonTargetProblem, 'buttons.0.target'));
      assert.equal(throughFilter(error).message, error.message, `${problem}: ${text}`);
    }
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
      getRequest: () => ({ originalUrl: '/api/admin/notifications/templates/tpl-1', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new AdminSafeExceptionFilter().catch(error, host);
  return body as { readonly message?: unknown };
}
