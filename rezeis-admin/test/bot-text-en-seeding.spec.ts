import 'reflect-metadata';

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { AdminBotConfigController } from '../src/modules/bot-config/controllers/admin-bot-config.controller';
import { BotTextsService } from '../src/modules/bot-config/services/bot-texts.service';
import { InternalBotConfigService } from '../src/modules/bot-config/services/internal-bot-config.service';

/**
 * The English bot texts have to be created on installations that already exist.
 *
 * WHAT WENT WRONG, TWICE.
 *
 * 1. `seedDefaultTexts` runs on every boot and skips a seed whose Russian row
 *    is already there, and the English sibling was created INSIDE that skipped
 *    branch: every upgrade has the Russian rows, so not one English row was
 *    ever written anywhere but on a virgin database.
 * 2. Moved out of the branch, it was written as `create({ key: '<key>@en' })`
 *    — a key the real `BotTextsService` refuses, because `@` is reserved for
 *    exactly these siblings («key must be alphanumeric»). Every English seed
 *    threw, was logged as «Failed to seed bot text …», and never landed, on
 *    any install (FX5b, 25.09.2026). This file stubbed `create` then, so it
 *    stayed green over the defect it was written for.
 *
 * So the REAL `BotTextsService` runs here, over an in-memory `bot_texts`
 * table that answers the way the database does, and the rows in that table
 * are what is asserted. The seed writes an English text the way «Тексты» and
 * «Карта бота» save one (`create` with `valueEn` for a new row, `update` with
 * `valueEn` beside an existing one), so a seeded row is exactly what a save
 * would have written.
 */

interface Row {
  id: string;
  key: string;
  value: string;
  visible: boolean;
}

/** An in-memory `bot_texts` table with the unique `key` the real one has. */
function botTextTable() {
  const rows: Row[] = [];
  let seq = 0;
  let writes = 0;
  const byWhere = (where: { id?: string; key?: string }) =>
    rows.find((row) => (where.id !== undefined ? row.id === where.id : row.key === where.key)) ?? null;
  const insert = (data: { key: string; value: string; visible?: boolean }): Row => {
    if (rows.some((row) => row.key === data.key)) throw new Error(`Unique constraint failed on the fields: (key) ${data.key}`);
    const row = { id: `id${++seq}`, key: data.key, value: data.value, visible: data.visible ?? true };
    rows.push(row);
    writes += 1;
    return { ...row };
  };
  const botText = {
    findUnique: async ({ where }: { where: { id?: string; key?: string } }) => {
      const row = byWhere(where);
      return row === null ? null : { ...row };
    },
    findMany: async () => [...rows].sort((a, b) => a.key.localeCompare(b.key)).map((row) => ({ ...row })),
    create: async ({ data }: { data: { key: string; value: string; visible?: boolean } }) => insert(data),
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = byWhere(where);
      if (row === null) throw new Error('Record to update not found');
      Object.assign(row, data);
      if (Object.keys(data).length > 0) writes += 1;
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
      const hit = rows.filter((row) => Object.entries(where).every(([field, value]) => row[field as keyof Row] === value));
      hit.forEach((row) => Object.assign(row, data));
      writes += hit.length;
      return { count: hit.length };
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { key: string; value: string; visible?: boolean };
      update: Partial<Row>;
    }) => {
      const row = byWhere(where);
      if (row === null) return insert(create);
      Object.assign(row, update);
      writes += 1;
      return { ...row };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = rows.findIndex((row) => row.id === where.id);
      if (index < 0) throw new Error('Record to delete does not exist');
      writes += 1;
      return rows.splice(index, 1)[0];
    },
    deleteMany: async ({ where }: { where: { key: string } }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index]?.key === where.key) rows.splice(index, 1);
      writes += before - rows.length;
      return { count: before - rows.length };
    },
  };
  return { rows, botText, writes: () => writes };
}

/** One boot of the bot config over `table`, with the REAL `BotTextsService`. */
async function boot(table: ReturnType<typeof botTextTable>): Promise<BotTextsService> {
  const prismaService = {
    settings: { findFirst: async () => null, create: async () => ({}) },
    botButton: { count: async () => 1 },
    botEmoji: { findUnique: async () => ({ id: 'seeded' }) },
    botText: table.botText,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(prismaService),
  };
  const botTexts = new BotTextsService(prismaService as never);
  // A fresh service each time: the seed runs once per process.
  const service = new InternalBotConfigService(
    prismaService as never,
    { listAll: async () => [], count: async () => 1 } as never,
    { listAll: async () => [] } as never,
    botTexts,
    { getActive: async () => null } as never,
  );
  await service.onApplicationBootstrap();
  return botTexts;
}

const valueOf = (table: ReturnType<typeof botTextTable>, key: string) => table.rows.find((row) => row.key === key)?.value;
const englishRows = (table: ReturnType<typeof botTextTable>) => table.rows.filter((row) => row.key.endsWith('@en'));

describe('English bot-text seeding, through the real BotTextsService', () => {
  it('a new installation gets every default text with its English version', async () => {
    const table = botTextTable();

    await boot(table);

    assert.ok(englishRows(table).length >= 30, `only ${englishRows(table).length} English rows were written`);
    assert.equal(valueOf(table, 'profile.subscription@en'), 'Subscription');
    assert.equal(valueOf(table, 'channel.check_button@en'), '✅ I subscribed');
    for (const row of englishRows(table)) {
      assert.ok(valueOf(table, row.key.slice(0, -'@en'.length)) !== undefined, `${row.key} has no Russian row`);
    }
  });

  it('an installation with the Russian rows alone gets the English ones, and its Russian texts stay as the operator left them', async () => {
    // The shape of every real upgrade: the Russian rows, no English one.
    const table = botTextTable();
    const botTexts = await boot(table);
    const seededEnglish = englishRows(table).map((row) => [row.key, row.value]);
    for (const [key] of seededEnglish) await table.botText.deleteMany({ where: { key: key as string } });
    const russian = table.rows.find((row) => row.key === 'profile.traffic');
    assert.ok(russian !== undefined);
    await botTexts.update({ id: russian.id, value: 'Трафик (ГБ)' });

    await boot(table);

    assert.deepEqual(
      englishRows(table)
        .map((row) => [row.key, row.value])
        .sort(),
      [...seededEnglish].sort(),
      'every English seed is written on an install that had only the Russian rows',
    );
    assert.equal(valueOf(table, 'profile.traffic'), 'Трафик (ГБ)', 'an operator’s Russian text is never rewritten');
  });

  it('an English text an operator saved is never touched', async () => {
    const table = botTextTable();
    const botTexts = await boot(table);
    const base = table.rows.find((row) => row.key === 'menu.updated');
    assert.ok(base !== undefined);
    await botTexts.update({ id: base.id, valueEn: 'Menu refreshed' });

    await boot(table);

    assert.equal(valueOf(table, 'menu.updated@en'), 'Menu refreshed');
  });

  it('writes an English text beside a hidden Russian one hidden, as the editor does', async () => {
    const table = botTextTable();
    const botTexts = await boot(table);
    const base = table.rows.find((row) => row.key === 'channel.verified');
    assert.ok(base !== undefined);
    await botTexts.update({ id: base.id, visible: false, valueEn: null });
    assert.equal(valueOf(table, 'channel.verified@en'), undefined);

    await boot(table);

    const english = table.rows.find((row) => row.key === 'channel.verified@en');
    assert.equal(english?.value, '✅ Subscription confirmed!');
    assert.equal(english?.visible, false, 'a sibling takes its row’s visibility, as `update` with `valueEn` writes it');
  });

  it('writes the English beside a Russian text saved over the pop-up limit before that limit existed', async () => {
    // `access_mode.restricted` is also an alert, held to 200 since FX5b; an
    // operator's longer Russian text from before must not keep its English out.
    const table = botTextTable();
    await boot(table);
    const base = table.rows.find((row) => row.key === 'access_mode.restricted');
    assert.ok(base !== undefined);
    base.value = 'Р'.repeat(250);
    await table.botText.deleteMany({ where: { key: 'access_mode.restricted@en' } });

    await boot(table);

    assert.match(valueOf(table, 'access_mode.restricted@en') ?? '', /^🛠 Service is temporarily unavailable/);
    assert.equal(valueOf(table, 'access_mode.restricted'), 'Р'.repeat(250), 'the operator’s Russian text is left as it is');
  });

  it('writes nothing at all when both languages are already there', async () => {
    const table = botTextTable();
    await boot(table);
    const writes = table.writes();
    const rows = table.rows.map((row) => ({ ...row }));

    await boot(table);

    assert.equal(table.writes(), writes, 'a second boot wrote rows into a fully seeded table');
    assert.deepEqual(table.rows, rows);
  });
});

/**
 * The English the seed writes is the English the bot ALREADY speaks.
 *
 * With no `<key>@en` row, reiwa answers an English user from its built-in
 * `EN_PACK` (reiwa `src/infrastructure/i18n/translator/translator.ts`: the
 * operator's English, then the pack's, then the Russian). The English seeds
 * never landed before 25.09.2026, so the pack is what every English user has
 * read; a seed worded otherwise would change the bot on the first boot after
 * the update, and the editor would show a text the bot never said. So every
 * English seed equals the pack's text for its key (owner's decision via
 * `main`, 25.09.2026 — 14 of them had been worded apart).
 *
 * Read from the sibling checkout (`../reiwa` next to this repo) and skipped
 * without it: CI for this repo has no reiwa working tree. The pack is compiled
 * and run here — reiwa is an ES-module package, which `require` refuses, and
 * the pack imports nothing.
 */
const REIWA_EN_PACK = join(__dirname, '..', '..', '..', 'reiwa', 'src', 'infrastructure', 'i18n', 'packs', 'en.pack.ts');

function cabinetEnglishPack(): Readonly<Record<string, string>> {
  const { outputText } = ts.transpileModule(readFileSync(REIWA_EN_PACK, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: Record<string, unknown> = {};
  new Function('exports', outputText)(exports);
  const pack = exports['EN_PACK'];
  assert.ok(pack !== null && typeof pack === 'object', `${REIWA_EN_PACK}: no EN_PACK`);
  return pack as Readonly<Record<string, string>>;
}

describe('the English seeds against the cabinet’s built-in English', { skip: !existsSync(REIWA_EN_PACK) }, () => {
  it('write, for every key, exactly the text the bot already shows an English user', async () => {
    const table = botTextTable();
    await boot(table);
    const pack = cabinetEnglishPack();

    const seeded = englishRows(table);
    assert.ok(seeded.length >= 30, `only ${seeded.length} English rows were written`);
    const apart = seeded
      .map((row) => ({ key: row.key.slice(0, -'@en'.length), seed: row.value }))
      .filter(({ key, seed }) => pack[key] !== seed)
      .map(({ key, seed }) => `${key}: seed ${JSON.stringify(seed)} ≠ bot ${JSON.stringify(pack[key])}`);
    assert.deepEqual(apart, [], 'an English seed that would change what English users read');
  });
});

/**
 * WHAT DELETING A DEFAULT TEXT IS: A RESET. The seed writes a default text
 * again at the next start whenever it is missing, and until then the bot
 * speaks its built-in text for the key — the same default. So the «Тексты» tab
 * calls it «Вернуть стандартный текст» for exactly these rows, which the list
 * marks `isDefault` (FX5b, 25.09.2026). There is no record of a deletion; the
 * operator is told the text comes back instead.
 */
describe('deleting a default text resets it', () => {
  it('comes back at the next start — the default, in both languages, not the operator’s last words', async () => {
    const table = botTextTable();
    const botTexts = await boot(table);
    const row = table.rows.find((candidate) => candidate.key === 'channel.verified');
    assert.ok(row !== undefined);
    await botTexts.update({ id: row.id, value: 'Своя подпись', valueEn: 'My own words' });
    await botTexts.delete(row.id);
    assert.equal(valueOf(table, 'channel.verified'), undefined);
    assert.equal(valueOf(table, 'channel.verified@en'), undefined);

    await boot(table);

    assert.equal(valueOf(table, 'channel.verified'), '✅ Подписка подтверждена!');
    assert.equal(valueOf(table, 'channel.verified@en'), '✅ Subscription confirmed!');
  });

  it('the list marks every text the seed writes again, and no other row', async () => {
    const table = botTextTable();
    await boot(table);
    const seeded = new Set(table.rows.filter((row) => !row.key.endsWith('@en')).map((row) => row.key));
    assert.ok(seeded.has('menu.updated') && seeded.has('bot.welcome_message'));
    const custom = { id: 'own', key: 'my.own.text', value: 'Своё', visible: true, valueEn: null };
    const listed = [
      ...table.rows.filter((row) => !row.key.endsWith('@en')).map((row) => ({ ...row, valueEn: null })),
      custom,
    ];
    const controller = new AdminBotConfigController(
      {} as never,
      {} as never,
      { listForAdmin: async () => listed } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const answer = await controller.listTexts();

    assert.equal(answer.length, listed.length);
    for (const row of answer) assert.equal(row.isDefault, seeded.has(row.key), row.key);
    assert.equal(answer.find((row) => row.key === 'my.own.text')?.isDefault, false);
  });
});

/**
 * «Меню обновилось» — the toast the bot answers a button it no longer knows with
 * (reiwa `bot/pages/stale-button.ts`, 24.09.2026). A text the bot sends is not
 * done until the panel lets the operator change it: seeded here, it is in
 * «Тексты» and under «Карта бота» on every installation after the upgrade, in
 * both languages.
 */
describe('the stale-button toast among the default texts', () => {
  it('is created, in both languages, on an installation that has every other text', async () => {
    const table = botTextTable();
    await boot(table);
    await table.botText.deleteMany({ where: { key: 'menu.updated' } });
    await table.botText.deleteMany({ where: { key: 'menu.updated@en' } });

    await boot(table);

    assert.equal(valueOf(table, 'menu.updated'), 'Меню обновилось');
    assert.equal(valueOf(table, 'menu.updated@en'), 'Menu updated');
  });
});
