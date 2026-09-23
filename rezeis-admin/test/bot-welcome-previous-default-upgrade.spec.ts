import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalBotConfigService } from '../src/modules/bot-config/services/internal-bot-config.service';

/**
 * AN INSTALL STILL GREETING IN THE PANEL'S NAME BY DEFAULT GETS THE NEW DEFAULT.
 *
 * The seeded greeting was «Привет, {{firstName}}! 👋 Добро пожаловать в
 * Rezeis VPN.» (and «Welcome to Rezeis VPN.» in English). The default is now
 * brand-neutral (`bot-defaults-name-no-panel.spec.ts`), but a seed never
 * rewrites a row, so every install that already existed kept greeting its
 * customers in the vendor's name — unless its operator had happened to edit
 * the text.
 *
 * So, once per boot, a greeting row that is BYTE-IDENTICAL to a previous
 * default is replaced by the current one, in Russian and in its `@en`
 * sibling. Anything else — an operator's own text, even one a single
 * character away from the old default — is left exactly as it is.
 */

const PREVIOUS_RU = 'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Rezeis VPN.';
const PREVIOUS_EN = 'Hi, {{firstName}}! 👋\n\nWelcome to Rezeis VPN.';
const CURRENT_RU = 'Привет, {{firstName}}! 👋\n\nДобро пожаловать!';
const CURRENT_EN = 'Hi, {{firstName}}! 👋\n\nWelcome!';

interface Row {
  id: string;
  key: string;
  value: string;
  visible: boolean;
}

/** Does `row` satisfy a Prisma `where` of plain equalities? */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, expected]) => row[field as keyof Row] === expected);
}

/**
 * An EXISTING install: keyboard and emoji already seeded, and `texts` as its
 * table holds them. The table is shared by every service built over it, as
 * the database is shared by every boot.
 */
function existingInstall(texts: Row[]) {
  /** Rows written, counted per boot: a write bumps `updatedAt` even when the value is the same. */
  const writes = { count: 0 };
  const prismaService = {
    settings: { findFirst: async () => null },
    botButton: { count: async () => 5 },
    botEmoji: { findUnique: async () => ({ id: 'emoji' }) },
    botText: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const row = texts.find((candidate) => candidate.key === where.key);
        return row === undefined ? null : { id: row.id };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = texts.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        writes.count += hit.length;
        return { count: hit.length };
      },
    },
  };
  const boot = async (): Promise<InternalBotConfigService> => {
    const service = new InternalBotConfigService(
      prismaService as never,
      { listAll: async () => [], create: async (input: unknown) => input } as never,
      { listAll: async () => [], create: async (input: unknown) => input } as never,
      {
        listAll: async () => texts.map((row) => ({ ...row })),
        create: async (input: Omit<Row, 'id'>) => {
          texts.push({ id: `seeded-${input.key}`, ...input });
          return input;
        },
      } as never,
      { getActive: async () => null } as never,
    );
    writes.count = 0;
    await service.onApplicationBootstrap();
    return service;
  };
  return { boot, writes };
}

function valueOf(texts: Row[], key: string): string | undefined {
  return texts.find((row) => row.key === key)?.value;
}

describe('the greeting of an install that kept the previous default', () => {
  it('is replaced by the current default, in Russian and in English', async () => {
    const texts: Row[] = [
      { id: 'ru', key: 'bot.welcome_message', value: PREVIOUS_RU, visible: true },
      { id: 'en', key: 'bot.welcome_message@en', value: PREVIOUS_EN, visible: true },
    ];

    const service = await existingInstall(texts).boot();

    assert.equal(valueOf(texts, 'bot.welcome_message'), CURRENT_RU);
    assert.equal(valueOf(texts, 'bot.welcome_message@en'), CURRENT_EN);
    // And that is what the bot is sent.
    const { visual } = await service.getConfig();
    assert.equal(visual.welcomeMessage, CURRENT_RU);
    assert.equal(visual.welcomeMessageEn, CURRENT_EN);
  });

  it('keeps a hidden greeting hidden: only the words change', async () => {
    const texts: Row[] = [{ id: 'ru', key: 'bot.welcome_message', value: PREVIOUS_RU, visible: false }];

    await existingInstall(texts).boot();

    assert.equal(valueOf(texts, 'bot.welcome_message'), CURRENT_RU);
    assert.equal(texts[0].visible, false);
  });

  it('is replaced once: a second boot writes nothing', async () => {
    const texts: Row[] = [
      { id: 'ru', key: 'bot.welcome_message', value: PREVIOUS_RU, visible: true },
      { id: 'en', key: 'bot.welcome_message@en', value: PREVIOUS_EN, visible: true },
    ];
    const install = existingInstall(texts);

    await install.boot();
    assert.equal(install.writes.count, 2, 'the first boot did not upgrade both rows');
    const afterFirst = JSON.stringify(texts);
    await install.boot();

    assert.equal(JSON.stringify(texts), afterFirst);
    // Not even the same value again: every write moves `updatedAt`.
    assert.equal(install.writes.count, 0, 'the second boot rewrote rows it had already upgraded');
  });
});

describe('a greeting the operator wrote', () => {
  it('is left exactly as it is, however close to the previous default', async () => {
    const own = [
      'Привет, {{firstName}}! 👋\n\nДобро пожаловать в Winger VPN.',
      `${PREVIOUS_RU} `,
      PREVIOUS_RU.replace('\n\n', '\r\n\r\n'),
      'Привет, {{firstName}}!\n\nДобро пожаловать в Rezeis VPN.',
    ];
    for (const value of own) {
      const texts: Row[] = [
        { id: 'ru', key: 'bot.welcome_message', value, visible: true },
        { id: 'en', key: 'bot.welcome_message@en', value: 'Hi, {{firstName}}! Welcome to Rezeis VPN!', visible: true },
      ];

      await existingInstall(texts).boot();

      assert.equal(valueOf(texts, 'bot.welcome_message'), value, JSON.stringify(value));
      assert.equal(valueOf(texts, 'bot.welcome_message@en'), 'Hi, {{firstName}}! Welcome to Rezeis VPN!');
    }
  });

  it('is left alone under any other key, even word for word the old default', async () => {
    const texts: Row[] = [
      { id: 'ru', key: 'bot.welcome_message', value: 'Своё приветствие', visible: true },
      { id: 'other', key: 'start.intro', value: PREVIOUS_RU, visible: true },
    ];

    await existingInstall(texts).boot();

    assert.equal(valueOf(texts, 'start.intro'), PREVIOUS_RU);
    assert.equal(valueOf(texts, 'bot.welcome_message'), 'Своё приветствие');
  });

  it('does not swap languages: the English default is not written into the Russian row', async () => {
    const texts: Row[] = [
      { id: 'ru', key: 'bot.welcome_message', value: PREVIOUS_EN, visible: true },
      { id: 'en', key: 'bot.welcome_message@en', value: PREVIOUS_RU, visible: true },
    ];

    await existingInstall(texts).boot();

    assert.equal(valueOf(texts, 'bot.welcome_message'), PREVIOUS_EN);
    assert.equal(valueOf(texts, 'bot.welcome_message@en'), PREVIOUS_RU);
  });
});
