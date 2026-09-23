import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalBotConfigService } from '../src/modules/bot-config/services/internal-bot-config.service';

/**
 * The bot an operator gets out of the box says nothing in the panel's name.
 *
 * "Rezeis" is the product the operator RUNS, not the service their customers
 * buy. Until 23.09.2026 the first message every Telegram customer received on a
 * fresh install was «Привет, …! Добро пожаловать в Rezeis VPN.» — in Russian
 * from the seeded `bot.welcome_message` row, and in English from the built-in
 * default, which every install serves until its operator writes an English
 * greeting of their own. The customer met the vendor's name before the
 * operator's.
 *
 * The bot copy has no brand placeholder (`{{firstName}}` and emoji tokens are
 * all the greeting resolves), so the default is brand-neutral, and the operator
 * writes their own name in «Карта бота» → «Схема» → «Тексты».
 *
 * What is checked is the CLASS, not the one sentence: everything a fresh
 * install's bot payload carries — every seeded text, both greetings, the
 * seeded keyboard — composed through the same door reiwa reads it by. The next
 * default that names the panel fails here without anybody having to remember
 * this file.
 */

const PANEL_NAME = /rezeis/i;

/** Every string in `value` that names the panel, by its path. */
function pathsNamingThePanel(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return PANEL_NAME.test(value) ? [path] : [];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    pathsNamingThePanel(inner, path === '' ? key : `${path}.${key}`),
  );
}

interface Row {
  readonly key: string;
  readonly value: string;
  readonly visible: boolean;
}

/**
 * A database that starts EMPTY and keeps what the seeding writes into it: the
 * state of every install on its first boot. `listAll` answers with the rows the
 * seed created, so `getConfig` composes the payload a fresh install really
 * serves rather than one assembled by hand.
 */
function buildFreshInstall() {
  const texts: Row[] = [];
  const buttons: Array<Record<string, unknown>> = [];
  const emojis: Array<Record<string, unknown>> = [];

  const prismaService = {
    settings: { findFirst: async () => null },
    botButton: { count: async () => buttons.length },
    botEmoji: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        emojis.some((row) => row.key === where.key) ? { id: where.key } : null,
    },
    botText: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        texts.some((row) => row.key === where.key) ? { id: where.key } : null,
      // The boot-time upgrade of a retired default
      // (`bot-welcome-previous-default-upgrade.spec.ts`); a fresh install holds
      // none, so it matches nothing here.
      updateMany: async ({ where }: { where: { key: string; value: string } }) => ({
        count: texts.filter((row) => row.key === where.key && row.value === where.value).length,
      }),
    },
  };

  const service = new InternalBotConfigService(
    prismaService as never,
    {
      listAll: async () => [...buttons],
      create: async (input: Record<string, unknown>) => {
        buttons.push(input);
        return input;
      },
    } as never,
    {
      listAll: async () => [...emojis],
      create: async (input: Record<string, unknown>) => {
        emojis.push(input);
        return input;
      },
    } as never,
    {
      listAll: async () => [...texts],
      create: async (input: Row) => {
        texts.push({ key: input.key, value: input.value, visible: input.visible });
        return input;
      },
    } as never,
    { getActive: async () => null } as never,
  );

  return { service, texts, buttons };
}

describe('the bot a fresh install serves', () => {
  it('names no panel anywhere in the payload reiwa reads', async () => {
    const { service, texts, buttons } = buildFreshInstall();
    await service.onApplicationBootstrap();
    const payload = await service.getConfig();

    // The seed ran, or this case proves nothing about the defaults.
    assert.ok(
      texts.some((row) => row.key === 'bot.welcome_message'),
      'the fresh install seeded no greeting row',
    );
    assert.ok(buttons.length > 0, 'the fresh install seeded no keyboard');

    assert.deepEqual(pathsNamingThePanel(payload), [], 'these fields name the panel');
  });

  it('writes no row that names the panel', async () => {
    // The rows outlive the release that seeded them: nothing rewrites a seeded
    // row, so a name that reaches the table stays on that install for good.
    const { service, texts } = buildFreshInstall();
    await service.onApplicationBootstrap();

    for (const row of texts) {
      assert.doesNotMatch(row.value, PANEL_NAME, `seeded row ${row.key} names the panel`);
    }
  });

  it('still greets the customer by name, in both languages', async () => {
    // Neutral must not mean empty: the greeting keeps its `{{firstName}}`.
    const { service } = buildFreshInstall();
    await service.onApplicationBootstrap();
    const { visual } = await service.getConfig();

    assert.match(visual.welcomeMessage, /\{\{firstName\}\}/);
    assert.ok(visual.welcomeMessageEn !== null, 'no English greeting is served');
    assert.match(visual.welcomeMessageEn, /\{\{firstName\}\}/);
  });

  it('serves a neutral greeting while the operator’s row is missing', async () => {
    // «Удалить» on the greeting in «Тексты» removes the row, and the seed puts
    // it back only on the next boot. Until then reiwa is sent the built-in
    // default, which is a second copy of the text and has to be neutral too.
    const { service, texts } = buildFreshInstall();
    await service.onApplicationBootstrap();
    texts.splice(
      texts.findIndex((row) => row.key === 'bot.welcome_message'),
      1,
    );

    const { visual } = await service.getConfig();

    assert.doesNotMatch(visual.welcomeMessage, PANEL_NAME);
    assert.match(visual.welcomeMessage, /\{\{firstName\}\}/);
  });
});
