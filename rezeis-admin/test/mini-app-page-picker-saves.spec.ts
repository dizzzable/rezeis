import 'reflect-metadata';

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';

import { AdminBotConfigController } from '../src/modules/bot-config/controllers/admin-bot-config.controller';
import { CreateBotButtonDto, UpdateBotButtonDto } from '../src/modules/bot-config/dto/bot-config.dto';
import { BotButtonsService, BUTTON_ID_REGEX } from '../src/modules/bot-config/services/bot-buttons.service';
import { AdminBotFlowController } from '../src/modules/bot-flow/controllers/admin-bot-flow.controller';
import { BotFlowScreenService } from '../src/modules/bot-flow/services/bot-flow-screen.service';
import { MINI_APP_TERMINALS } from '../src/modules/bot-map/catalogs/mini-app-terminals.catalog';
import { AdminNotificationTemplatesController } from '../src/modules/notifications/controllers/admin-notification-templates.controller';
import { UpdateNotificationTemplateDto } from '../src/modules/notifications/dto/notification-template.dto';
import { NotificationTemplatesService } from '../src/modules/notifications/services/notification-templates.service';
import { resolveTemplateButtons } from '../src/modules/notifications/utils/notification-template-locale.util';

/**
 * A page picked in 553e1ae6's Mini App page picker, saved — through each
 * form's own server path.
 *
 * The picker sets a Mini App button's target to a page of the cabinet
 * (`/referrals`) in four forms: the main-menu constructor, «Кнопки бота» (create
 * and edit), a notification's buttons and a screen's buttons. The main-menu two
 * refused every such save with 400 (`validateAction` wanted `https://`), while
 * the SPA's tests — every one of them with a mocked API — stayed green. Here
 * each form's request goes the way the app takes it: the global
 * `ValidationPipe` with `main.ts`'s options, the controller, the service, a
 * fake Prisma underneath. The main-menu payload is the SPA's own
 * (`buildActionPayload`, loaded as it is); the notification's and the screen's
 * are written as their editors send them (`toShape` in `NotificationEditor.tsx`,
 * `onUpdate({ webAppUrl })` in `ScreenEditorPanel.tsx`), which are `.tsx` files
 * Node cannot load.
 *
 * Then what reaches reiwa: a main-menu target and a screen's `webAppUrl` go in
 * the config it reads, and it puts a path on its Mini App address
 * (`miniAppButtonUrl`, `buildScreenKeyboard`); a notification's goes out as
 * `webAppPath` (`resolveTemplateButtons`), which its notify listener puts on
 * the same address.
 */

const importNative = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
const SPA_PAYLOAD = resolve(__dirname, '../web/src/features/bot-config/bot-button-payload.ts');

/**
 * What this spec uses of `bot-button-payload.ts`, typed here: a type import of
 * the file would pull the SPA's `@/` imports into this program, which cannot
 * resolve them.
 */
interface SpaButtonPayload {
  readonly BUTTON_ID_PATTERN: RegExp;
  buildActionPayload(
    actionType: 'CALLBACK' | 'URL' | 'WEBAPP' | 'SCREEN' | 'SUPPORT_URL',
    actionTarget: string,
  ): { actionType: string; actionTarget: string | null };
}
let spa: SpaButtonPayload;

before(async () => {
  spa = (await importNative(pathToFileURL(SPA_PAYLOAD).href)) as SpaButtonPayload;
});

/** `main.ts`'s global pipe. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

async function validated<T>(metatype: new () => T, body: unknown): Promise<T> {
  return (await pipe.transform(body, { type: 'body', metatype })) as T;
}

const PAGES = MINI_APP_TERMINALS.map((terminal) => terminal.route);

/**
 * Each case counts the pages it saved: a catalog emptied, or a loop left
 * early, would otherwise pass having saved nothing.
 */
function assertEveryPage(saved: number): void {
  assert.ok(PAGES.length > 0, 'the picker offers no page');
  assert.equal(saved, PAGES.length, 'pages saved');
}

interface Written {
  data?: Record<string, unknown>;
}

function botConfigController(written: Written): AdminBotConfigController {
  const prisma = {
    botButton: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id === undefined ? null : { id: where.id, actionType: 'CALLBACK', actionTarget: null },
      findFirst: async () => ({ orderIndex: 3 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        written.data = data;
        return data;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.data = data;
        return data;
      },
    },
  };
  return new AdminBotConfigController(
    new BotButtonsService(prisma as never),
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

describe('a Mini App page picked in a form, saved through that form’s own server path', () => {
  it('the main-menu constructor: every page saves', async () => {
    let saved = 0;
    for (const page of PAGES) {
      const written: Written = {};
      // `reply-keyboard-editor-panel.tsx`, the row's «Сохранить».
      const body = {
        label: 'Пригласить',
        style: 'DEFAULT',
        iconCustomEmojiId: null,
        onePerRow: false,
        ...spa.buildActionPayload('WEBAPP', page),
      };
      await botConfigController(written).updateButton('row-1', await validated(UpdateBotButtonDto, body));
      assert.equal(written.data?.actionTarget, page, page);
      saved += 1;
    }
    assertEveryPage(saved);
  });

  it('«Кнопки бота»: every page saves from the create form and the edit form', async () => {
    let saved = 0;
    for (const page of PAGES) {
      const createdRow: Written = {};
      await botConfigController(createdRow).createButton(
        await validated(CreateBotButtonDto, {
          buttonId: 'referrals',
          label: 'Рефералы',
          style: 'DEFAULT',
          iconCustomEmojiId: null,
          visible: true,
          onePerRow: false,
          ...spa.buildActionPayload('WEBAPP', page),
        }),
      );
      assert.equal(createdRow.data?.actionTarget, page, `create ${page}`);

      const editedRow: Written = {};
      await botConfigController(editedRow).updateButton(
        'row-1',
        await validated(UpdateBotButtonDto, {
          label: 'Рефералы',
          style: 'DEFAULT',
          iconCustomEmojiId: null,
          visible: true,
          onePerRow: false,
          ...spa.buildActionPayload('WEBAPP', page),
        }),
      );
      assert.equal(editedRow.data?.actionTarget, page, `edit ${page}`);
      saved += 1;
    }
    assertEveryPage(saved);
  });

  it('a notification’s buttons: every page saves, and goes to the bot as that path', async () => {
    let saved = 0;
    for (const page of PAGES) {
      const written: Written = {};
      const prisma = {
        notificationTemplate: {
          findUnique: async () => ({ id: 'tpl-1', type: 'expires_in_3_days' }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            written.data = data;
            return { id: 'tpl-1', type: 'expires_in_3_days', ...data };
          },
        },
      };
      const events = { info: () => undefined };
      const controller = new AdminNotificationTemplatesController(
        new NotificationTemplatesService(prisma as never, events as never),
      );
      // `NotificationEditor.tsx` → `toShape`, then «Сохранить кнопки».
      const body = {
        buttons: [{ labelRu: 'Открыть', labelEn: null, kind: 'webApp', target: page, style: 'default', row: 0 }],
      };
      await controller.update('tpl-1', await validated(UpdateNotificationTemplateDto, body));
      const stored = written.data?.buttons as ReadonlyArray<{ readonly target: string }>;
      assert.equal(stored[0].target, page, page);
      assert.deepStrictEqual(resolveTemplateButtons({ buttons: stored }, 'ru'), [{ text: 'Открыть', webAppPath: page, row: 0 }]);
      saved += 1;
    }
    assertEveryPage(saved);
  });

  it('a screen’s buttons: every page saves', async () => {
    const [, UpdateButtonDto] = Reflect.getMetadata('design:paramtypes', AdminBotFlowController.prototype, 'updateButton') as [
      unknown,
      new () => object,
    ];
    let saved = 0;
    for (const page of PAGES) {
      const written: Written = {};
      const prisma = {
        botFlowButton: {
          findUnique: async () => ({ id: 'btn-1', screen: { flowId: 'flow-1' } }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            written.data = data;
            return data;
          },
        },
        botFlow: { findUnique: async () => ({ status: 'DRAFT' }) },
      };
      const controller = new AdminBotFlowController(null as never, new BotFlowScreenService(prisma as never));
      // `ScreenEditorPanel.tsx`: `onUpdate({ webAppUrl: target || null })`.
      await controller.updateButton('btn-1', (await validated(UpdateButtonDto, { webAppUrl: page })) as never);
      assert.equal(written.data?.webAppUrl, page, page);
      saved += 1;
    }
    assertEveryPage(saved);
  });

  it('the forms and the server agree on a button’s ID', () => {
    assert.equal(spa.BUTTON_ID_PATTERN.source, BUTTON_ID_REGEX.source);
    assert.equal(spa.BUTTON_ID_PATTERN.flags, BUTTON_ID_REGEX.flags);
  });

  it('a main-menu button is updated with PATCH, the method «Список» and the forms send', () => {
    // `bot-map-api.ts` sent PUT for «Список»'s own main-menu editor, which no
    // route answers; the SPA test `reply-button-editor-saves.test.tsx` pins
    // the method there.
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminBotConfigController.prototype.updateButton), RequestMethod.PATCH);
  });
});
