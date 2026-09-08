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
const THEME_KEY = 'connect-page-theme';

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
      where: { key: { in: [CATALOG_KEY, ENABLED_KEY, V1_KEY, THEME_KEY] } },
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.subpageConfig
      .deleteMany({ where: { key: { in: [CATALOG_KEY, ENABLED_KEY, V1_KEY, THEME_KEY] } } })
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

  // ── The appearance, in its own row ─────────────────────────────────────────
  //
  // Third row on this service, and it exists for the reason the second one
  // does: picking a concept must not be an edit of the catalog. These check the
  // part a Prisma fake cannot, because the fake IS the claim under test.

  it('keeps the appearance out of the catalog row', async () => {
    await service.replaceConfig(catalog());
    await service.setTheme({
      presetId: 'concept-ba',
      tokens: { 'brand-primary': '#FF6B7A' },
      backgroundImage: 'linear-gradient(145deg, #05070D 0%, #0B0610 100%)',
      backgroundColor: '#05070D',
      rail: '#FF6B7A',
    });

    const [catalogRow, themeRow] = await Promise.all([
      prisma.subpageConfig.findUnique({ where: { key: CATALOG_KEY } }),
      prisma.subpageConfig.findUnique({ where: { key: THEME_KEY } }),
    ]);
    // A copy in the catalog row could only ever be stale, and a stale palette
    // in the row an export or a restore carries is a copy that gets believed.
    assert.equal((catalogRow?.config as Record<string, unknown>)['theme'], null);
    assert.equal((themeRow?.config as Record<string, unknown>)['presetId'], 'concept-ba');
  });

  it('serves the theme row over anything the catalog blob carries', async () => {
    // The shape a pre-existing install is in: a catalog saved while the schema
    // still accepted `theme` inline. The row wins, always.
    const current = await service.getEffectiveConfig();
    await prisma.subpageConfig.update({
      where: { key: CATALOG_KEY },
      data: {
        config: {
          ...current,
          theme: { presetId: 'concept-stale', tokens: { 'brand-primary': '#00FF00' } },
        } as never,
      },
    });

    const effective = await service.getEffectiveConfig();
    assert.equal(effective.theme?.presetId, 'concept-ba');
  });

  it('saving the catalog does not disturb the appearance', async () => {
    // The failure this prevents: an operator picks a concept, then edits a step
    // and presses Save on a draft branched before the pick, and the concept
    // silently goes back. That is exactly what the switch beside it used to do.
    await service.replaceConfig(catalog('Renamed'));
    const effective = await service.getEffectiveConfig();
    assert.equal(effective.theme?.presetId, 'concept-ba');
    assert.equal(effective.platforms[0].apps[0].name, 'Renamed');
  });

  it('clearing deletes the row rather than storing an empty theme', async () => {
    assert.equal(await service.setTheme(null), null);
    const row = await prisma.subpageConfig.findUnique({ where: { key: THEME_KEY } });
    assert.equal(row, null, 'an empty theme reads back as null anyway; keeping the row invents state');
    assert.equal((await service.getEffectiveConfig()).theme, null);
  });

  it('refuses a background that is not one, in front of the operator', async () => {
    // Refused here it is an error message. Refused in the cabinet it is silence
    // - the concept does not apply and the report is "nothing happened".
    await assert.rejects(() =>
      service.setTheme({
        tokens: { 'brand-primary': '#FF6B7A' },
        backgroundImage: 'linear-gradient(0deg,#000,#fff), url(a.png)',
      }),
    );
    assert.equal(await prisma.subpageConfig.findUnique({ where: { key: THEME_KEY } }), null);
  });

  it('answers the cabinet appearance when the stored theme no longer parses', async () => {
    // A schema change that landed without a migration. Decoration must not be
    // able to take the catalog down with it.
    await prisma.subpageConfig.create({
      data: { key: THEME_KEY, config: { tokens: { 'brand-primary': 'not-a-colour' } } },
    });
    assert.equal(await service.readTheme(), null);
    const effective = await service.getEffectiveConfig();
    assert.equal(effective.theme, null);
    assert.ok(effective.platforms.length > 0, 'the catalog still serves');
    await prisma.subpageConfig.deleteMany({ where: { key: THEME_KEY } });
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
