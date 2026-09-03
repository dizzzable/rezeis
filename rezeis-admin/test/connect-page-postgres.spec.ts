import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { ConnectPageService } from '../src/modules/subpage-config/connect-page/connect-page.service';

/**
 * The connect-page catalog against a real PostgreSQL.
 *
 * Everything else about this service is checked against a fake Prisma, and a
 * fake Prisma agrees with any storage decision — including the wrong ones. The
 * three things below are decisions about the DATABASE, and each of them is a
 * claim a hand-written double cannot test because the double is the claim:
 *
 *   • the catalog lives in `subpage_configs` under a SECOND key, beside the v1
 *     row the old editor still writes. The unique index is on `key`, not on the
 *     table, so a second row is legal — but "legal" here is a property of a
 *     migration nobody re-read, and getting it wrong means the two features
 *     overwrite each other in production and nowhere else;
 *   • the switch lives under a THIRD key, so flicking it is not an edit of the
 *     catalog;
 *   • an upsert of a whole JSON document round-trips through `jsonb` unchanged —
 *     key order, nested nulls, unicode and all.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec here; CI's fourth job
 * runs it. This file is deliberately in that job's list — a live spec nothing
 * executes is the shape that has cost this repository real defects.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const CATALOG_KEY = 'connect-page-v2';
const ENABLED_KEY = 'connect-page-enabled';
const V1_KEY = 'default';

let prisma: PrismaService;
let service: ConnectPageService;

function catalog(name = 'Happ') {
  return {
    version: 2,
    connectScreenEnabled: false,
    icons: { happ: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' },
    platforms: [
      {
        id: 'ios',
        title: { ru: 'iOS', en: 'iOS' },
        iconKey: null,
        apps: [
          {
            id: 'happ',
            name,
            iconKey: 'happ',
            featured: true,
            steps: [
              {
                title: { ru: 'Добавьте подписку', en: 'Add the subscription' },
                body: null,
                iconKey: null,
                buttons: [
                  {
                    kind: 'deepLink',
                    label: { ru: 'Добавить', en: 'Add' },
                    template: 'clash://install-config?url={{SUBSCRIPTION_LINK}}',
                  },
                  { kind: 'copyLink', label: { ru: 'Скопировать', en: 'Copy' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

run('ConnectPageService on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ConnectPageService(prisma);
    await prisma.subpageConfig.deleteMany({
      where: { key: { in: [CATALOG_KEY, ENABLED_KEY, V1_KEY] } },
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.subpageConfig
      .deleteMany({ where: { key: { in: [CATALOG_KEY, ENABLED_KEY, V1_KEY] } } })
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  it('stores the catalog beside the v1 row without either touching the other', async () => {
    // Both features write `subpage_configs`. If the unique index were on the
    // table rather than on `key`, the second write would fail — or worse,
    // replace the first — and only in production, where both rows exist.
    await prisma.subpageConfig.create({
      data: { key: V1_KEY, config: { version: '1', legacy: true } },
    });

    await service.replaceConfig(catalog());

    const [v1, v2] = await Promise.all([
      prisma.subpageConfig.findUnique({ where: { key: V1_KEY } }),
      prisma.subpageConfig.findUnique({ where: { key: CATALOG_KEY } }),
    ]);
    assert.deepEqual(v1?.config, { version: '1', legacy: true }, 'the old editor keeps its row');
    assert.equal((v2?.config as { version: number }).version, 2);
  });

  it('round-trips the whole document through jsonb unchanged', async () => {
    // `jsonb` normalises: it reorders keys and rejects some scalars. A catalog
    // carries nested nulls, unicode and a template full of punctuation, and the
    // service reads it back through a schema that refuses anything it does not
    // recognise — so a normalisation this file did not expect would surface as
    // "the stored config no longer parses" on the customer's screen.
    const saved = await service.replaceConfig(catalog('Happ · Прокси'));

    const readBack = await service.getEffectiveConfig();

    assert.deepEqual(readBack.platforms, saved.config.platforms);
    assert.equal(readBack.platforms[0].apps[0].name, 'Happ · Прокси');
    assert.equal(readBack.platforms[0].apps[0].steps[0].body, null);
    assert.equal(
      readBack.platforms[0].apps[0].steps[0].buttons.find((b) => b.kind === 'deepLink')?.encode,
      'component',
      'the derived encoding must survive storage, or every Clash button breaks',
    );
  });

  it('keeps the switch in its own row, so flicking it is not an edit', async () => {
    await prisma.subpageConfig.deleteMany({ where: { key: { in: [CATALOG_KEY, ENABLED_KEY] } } });

    await service.setEnabled(true);

    assert.equal(
      await prisma.subpageConfig.count({ where: { key: CATALOG_KEY } }),
      0,
      'flicking the switch must not freeze the built-in default into the database',
    );
    assert.equal((await service.getEffectiveConfig()).connectScreenEnabled, true);
    assert.equal(await service.hasStoredConfig(), false);
  });

  it('does not let a catalog save carry the switch back off', async () => {
    await service.setEnabled(true);

    await service.replaceConfig({ ...catalog(), connectScreenEnabled: false });

    assert.equal((await service.getEffectiveConfig()).connectScreenEnabled, true);
  });

  it('reports a stored row that no longer parses instead of passing off the default', async () => {
    // The editor shows what this returns. Told `stored: true` with the default
    // in hand, an operator edits it and the first save destroys the real one.
    await prisma.subpageConfig.upsert({
      where: { key: CATALOG_KEY },
      create: { key: CATALOG_KEY, config: { version: 2, platforms: 'not an array' } },
      update: { config: { version: 2, platforms: 'not an array' } },
    });

    const state = await service.readState();

    assert.equal(state.stored, true);
    assert.notEqual(state.corrupted, null);
    assert.ok(state.config.platforms.length > 0, 'the default still serves customers meanwhile');
  });

  it('survives two saves racing for the same row', async () => {
    // `upsert` on a unique key is the one place this service can collide with
    // itself: two operators, or one operator and a retry. Postgres decides;
    // what matters is that the row is left readable either way.
    await prisma.subpageConfig.deleteMany({ where: { key: CATALOG_KEY } });

    const results = await Promise.allSettled([
      service.replaceConfig(catalog('First')),
      service.replaceConfig(catalog('Second')),
    ]);

    assert.ok(
      results.some((result) => result.status === 'fulfilled'),
      'at least one save has to win',
    );
    const readBack = await service.getEffectiveConfig();
    assert.ok(['First', 'Second'].includes(readBack.platforms[0].apps[0].name));
  });
});
