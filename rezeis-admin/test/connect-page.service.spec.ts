import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConnectPageService } from '../src/modules/subpage-config/connect-page/connect-page.service';
import { DEFAULT_CONNECT_PAGE_CONFIG } from '../src/modules/subpage-config/connect-page/connect-page.default';
import type { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * The three things the save path promises and nothing was checking.
 *
 * Each of these is a way for a successful-looking save to leave the operator
 * worse off than before they pressed the button — and none of them shows up in
 * a schema test, because in every case the config being saved is perfectly
 * valid. They are about what happens to it afterwards.
 */

type Row = { key: string; config: unknown };

function fakePrisma(rows: Row[] = []) {
  const store = new Map(rows.map((row) => [row.key, row.config]));
  return {
    prisma: {
      subpageConfig: {
        findUnique: ({ where }: { where: { key: string } }) =>
          Promise.resolve(store.has(where.key) ? { key: where.key, config: store.get(where.key) } : null),
        count: ({ where }: { where: { key: string } }) =>
          Promise.resolve(store.has(where.key) ? 1 : 0),
        upsert: ({ where, create, update }: { where: { key: string }; create: Row; update: { config: unknown } }) => {
          store.set(where.key, store.has(where.key) ? update.config : create.config);
          return Promise.resolve({ key: where.key, config: store.get(where.key) });
        },
      },
    } as unknown as PrismaService,
    store,
  };
}

const service = (rows: Row[] = []) => {
  const { prisma, store } = fakePrisma(rows);
  return { service: new ConnectPageService(prisma), store };
};

/** A minimal catalog that passes every rule. */
function catalog(icons: Record<string, string> = {}) {
  return {
    version: 2,
    connectScreenEnabled: false,
    icons: { happ: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>', ...icons },
    platforms: [
      {
        id: 'ios',
        title: { ru: 'iOS', en: 'iOS' },
        iconKey: null,
        apps: [
          {
            id: 'happ',
            name: 'Happ',
            iconKey: 'happ',
            featured: true,
            steps: [
              {
                title: { ru: 'Добавьте', en: 'Add' },
                body: null,
                iconKey: null,
                buttons: [{ kind: 'copyLink', label: { ru: 'Копировать', en: 'Copy' } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('what is written can be read back', () => {
  it('never stores an icon its own reader would refuse', async () => {
    // THE TRAP. Cleaning GROWS markup — every `&` becomes `&amp;` — and the
    // ceiling was checked on the way in, on the authored string, and never
    // again on the stored one. An icon just under the limit came out over it,
    // was written anyway, and then failed to parse on the way out: a green
    // "saved" toast followed by a catalog the cabinet could not read.
    const dense = `<svg viewBox="0 0 1 1"><path d="M0 0"/><title>${'&'.repeat(16_000)}</title></svg>`;
    const { service: s } = service();

    await assert.rejects(
      () => s.replaceConfig(catalog({ big: dense })),
      (error: unknown) => {
        const issues = (error as { response?: { issues?: Array<{ message: string }> } }).response?.issues ?? [];
        assert.ok(
          issues.some((issue) => /too large once cleaned/i.test(issue.message)),
          JSON.stringify(issues),
        );
        return true;
      },
    );
  });

  it('reads back exactly what a successful save wrote', async () => {
    const { service: s } = service();

    const saved = await s.replaceConfig(catalog());
    const readBack = await s.getEffectiveConfig();

    assert.deepEqual(readBack.platforms, saved.config.platforms);
    assert.deepEqual(readBack.icons, saved.config.icons);
  });
});

describe('a corrupt row is not a fresh install', () => {
  it('says so, instead of showing the default as if it were yours', async () => {
    // Both hand back the built-in default with `stored: true`. An operator
    // would take it for their catalog, change one label, press Save — and the
    // real one is gone. The landing builder was bitten by exactly this.
    const { service: s } = service([{ key: 'connect-page-v2', config: { version: 2, nonsense: true } }]);

    const state = await s.readState();

    assert.equal(state.stored, true);
    assert.notEqual(state.corrupted, null);
    assert.deepEqual(
      state.config.platforms.map((p) => p.id),
      DEFAULT_CONNECT_PAGE_CONFIG.platforms.map((p) => p.id),
      'the default is what is shown, and the operator has to be told that',
    );
  });

  it('says nothing when there is simply nothing saved', async () => {
    const state = await service().service.readState();

    assert.equal(state.stored, false);
    assert.equal(state.corrupted, null);
  });
});

describe('the switch is not an edit of the catalog', () => {
  it('does not freeze the built-in default into the database', async () => {
    // Flicking the switch used to send the whole effective config back — which
    // is the DEFAULT on a fresh install. From then on `hasStoredConfig` was
    // true forever and no later improvement to the built-in catalog could ever
    // reach that install again.
    const { service: s, store } = service();

    await s.setEnabled(true);

    assert.equal(store.has('connect-page-v2'), false, 'the catalog must be untouched');
    assert.equal(await s.hasStoredConfig(), false);
    assert.equal((await s.getEffectiveConfig()).connectScreenEnabled, true);
  });

  it('survives a catalog save that was drafted before it was flicked', async () => {
    // The editor holds a draft. Branched before the switch was turned on, that
    // draft carries the old value — and saving it silently turned the screen
    // back off under a green toast.
    const { service: s } = service();
    await s.setEnabled(true);

    await s.replaceConfig({ ...catalog(), connectScreenEnabled: false });

    assert.equal((await s.getEffectiveConfig()).connectScreenEnabled, true);
  });
});

describe('the dry run judges exactly as the save does', () => {
  it('reports what a save would strip, instead of a clean bill of health', async () => {
    // The dry run is what runs while the operator is typing. It used to discard
    // `removed`, so markup the save rewrites was reported as untouched.
    const { service: s } = service();

    const result = s.dryRun(
      catalog({ x: '<svg viewBox="0 0 1 1"><path d="M0 0" onload="alert(1)"/></svg>' }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.cleanedIcons['x'], ['event handler']);
  });

  it('refuses the same catalogs the save refuses', async () => {
    const { service: s } = service();
    const broken = { ...catalog(), platforms: [] };

    assert.equal(s.dryRun(broken).ok, false);
    await assert.rejects(() => s.replaceConfig(broken));
  });
});
