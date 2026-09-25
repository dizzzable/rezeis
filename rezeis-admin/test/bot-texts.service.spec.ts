import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { BotTextsService } from '../src/modules/bot-config/services/bot-texts.service';

interface Row {
  id: string;
  key: string;
  value: string;
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal in-memory `PrismaService` stub for the `botText` model. `$transaction`
 * runs the callback against the same store so the EN-sibling writes commit
 * atomically with the base write (mirrors the real client closely enough for
 * the create/update/delete/list semantics under test).
 */
function makePrisma(): { prisma: PrismaService; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 0;
  const botText = {
    findMany: async (): Promise<Row[]> =>
      [...rows].sort((a, b) => a.key.localeCompare(b.key)),
    findUnique: async ({ where }: { where: { id?: string; key?: string } }): Promise<Row | null> => {
      if (where.id !== undefined) return rows.find((r) => r.id === where.id) ?? null;
      if (where.key !== undefined) return rows.find((r) => r.key === where.key) ?? null;
      return null;
    },
    create: async ({ data }: { data: { key: string; value: string; visible?: boolean } }): Promise<Row> => {
      const row: Row = {
        id: `id${++seq}`,
        key: data.key,
        value: data.value,
        visible: data.visible ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { key?: string; value?: string; visible?: boolean };
    }): Promise<Row> => {
      const row = rows.find((r) => r.id === where.id);
      if (row === undefined) throw new Error('not found');
      if (data.key !== undefined) row.key = data.key;
      if (data.value !== undefined) row.value = data.value;
      if (data.visible !== undefined) row.visible = data.visible;
      return row;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { key: string; value: string; visible?: boolean };
      update: { value?: string };
    }): Promise<Row> => {
      const row = rows.find((r) => r.key === where.key);
      if (row !== undefined) {
        if (update.value !== undefined) row.value = update.value;
        return row;
      }
      const created: Row = {
        id: `id${++seq}`,
        key: create.key,
        value: create.value,
        visible: create.visible ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(created);
      return created;
    },
    delete: async ({ where }: { where: { id: string } }): Promise<Row> => {
      const i = rows.findIndex((r) => r.id === where.id);
      if (i < 0) throw new Error('not found');
      return rows.splice(i, 1)[0]!;
    },
    deleteMany: async ({ where }: { where: { key: string } }): Promise<{ count: number }> => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.key === where.key) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    },
  };
  const prisma = {
    botText,
    $transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(prisma),
  };
  return { prisma: prisma as unknown as PrismaService, rows };
}

describe('BotTextsService — English siblings', () => {
  it('create persists a <key>@en sibling when valueEn is non-empty', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);

    await service.create({ key: 'referral.hub.title', value: 'Реферальная', valueEn: 'Referral' });

    assert.equal(rows.length, 2);
    assert.ok(rows.find((r) => r.key === 'referral.hub.title' && r.value === 'Реферальная'));
    assert.ok(rows.find((r) => r.key === 'referral.hub.title@en' && r.value === 'Referral'));
  });

  it('create skips the sibling when valueEn is empty/whitespace', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);

    await service.create({ key: 'a.b', value: 'ru', valueEn: '   ' });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.key, 'a.b');
  });

  it('listForAdmin excludes @en rows and attaches valueEn to the base row', async () => {
    const { prisma } = makePrisma();
    const service = new BotTextsService(prisma);
    await service.create({ key: 'a.b', value: 'ru', valueEn: 'en' });
    await service.create({ key: 'c.d', value: 'ru2' });

    const list = await service.listForAdmin();

    assert.equal(list.length, 2);
    const ab = list.find((r) => r.key === 'a.b')!;
    const cd = list.find((r) => r.key === 'c.d')!;
    assert.equal(ab.valueEn, 'en');
    assert.equal(cd.valueEn, null);
    assert.ok(!list.some((r) => r.key.endsWith('@en')));
  });

  it('update upserts the sibling when valueEn is provided', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);
    const base = await service.create({ key: 'a.b', value: 'ru' });

    await service.update({ id: base.id, valueEn: 'Hello' });
    assert.equal(rows.find((r) => r.key === 'a.b@en')?.value, 'Hello');

    await service.update({ id: base.id, valueEn: 'Hi' });
    assert.equal(rows.find((r) => r.key === 'a.b@en')?.value, 'Hi');
  });

  it('update deletes the sibling when valueEn is cleared (null/empty)', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);
    const base = await service.create({ key: 'a.b', value: 'ru', valueEn: 'en' });
    assert.ok(rows.some((r) => r.key === 'a.b@en'));

    await service.update({ id: base.id, valueEn: null });
    assert.ok(!rows.some((r) => r.key === 'a.b@en'));
  });

  it('update leaves the sibling untouched when valueEn is omitted', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);
    const base = await service.create({ key: 'a.b', value: 'ru', valueEn: 'en' });

    await service.update({ id: base.id, value: 'ru-updated' });

    assert.equal(rows.find((r) => r.key === 'a.b')?.value, 'ru-updated');
    assert.equal(rows.find((r) => r.key === 'a.b@en')?.value, 'en');
  });

  it('delete removes the @en sibling alongside the base row', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);
    const base = await service.create({ key: 'a.b', value: 'ru', valueEn: 'en' });

    await service.delete(base.id);

    assert.equal(rows.length, 0);
  });

  it('rejects operator keys that include the reserved @ character', async () => {
    const { prisma } = makePrisma();
    const service = new BotTextsService(prisma);

    await assert.rejects(() => service.create({ key: 'a.b@en', value: 'x' }));
  });
})

/**
 * «Меню обновилось» (`menu.updated`) is a toast: Telegram's
 * `answerCallbackQuery` takes 0-200 characters, counted as code points. A
 * longer one made the answer fail in reiwa and the old button got no menu
 * (review R2a-08); the panel refuses to save it, and says why.
 */
describe('BotTextsService — menu.updated fits a Telegram toast', () => {
  const TOO_LONG = 'М'.repeat(201);
  const refusal = (err: unknown): boolean =>
    err instanceof Error && /не больше 200 символов, а здесь 201/.test(err.message);

  it('refuses a Russian or an English value over 200 characters on create, and writes nothing', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);

    await assert.rejects(() => service.create({ key: 'menu.updated', value: TOO_LONG }), refusal);
    await assert.rejects(
      () => service.create({ key: 'menu.updated', value: 'Меню обновилось', valueEn: TOO_LONG }),
      refusal,
    );
    assert.equal(rows.length, 0);
  });

  it('refuses it on update and on upsert, and keeps what was there', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);
    const row = await service.create({ key: 'menu.updated', value: 'Меню обновилось' });

    await assert.rejects(() => service.update({ id: row.id, value: TOO_LONG }), refusal);
    await assert.rejects(() => service.update({ id: row.id, valueEn: TOO_LONG }), refusal);
    await assert.rejects(() => service.upsert({ key: 'menu.updated', value: TOO_LONG }), refusal);
    assert.deepEqual(
      rows.map((r) => [r.key, r.value]),
      [['menu.updated', 'Меню обновилось']],
    );
  });

  it('counts as Telegram does: 200 emoji of two UTF-16 units each fit; any other key keeps the 8000', async () => {
    const { prisma, rows } = makePrisma();
    const service = new BotTextsService(prisma);
    const twoHundred = '🔥'.repeat(200); // 400 UTF-16 units, 200 code points

    await service.create({ key: 'menu.updated', value: twoHundred });
    await service.create({ key: 'menu.choose_action', value: TOO_LONG });

    assert.equal(rows.find((r) => r.key === 'menu.updated')?.value, twoHundred);
    assert.equal(rows.find((r) => r.key === 'menu.choose_action')?.value, TOO_LONG);
  });
});
