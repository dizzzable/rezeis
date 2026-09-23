import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminSubpageConfigController } from '../src/modules/subpage-config/controllers/admin-subpage-config.controller';
import { InternalSubpageConfigController } from '../src/modules/subpage-config/controllers/internal-subpage-config.controller';
import { SubpageConfigService } from '../src/modules/subpage-config/services/subpage-config.service';
import { DEFAULT_SUBPAGE_CONFIG } from '../src/modules/subpage-config/subpage-config.default';
import { DEFAULT_BRANDING } from '../src/modules/settings/interfaces/branding-settings.interface';

/**
 * THE HEADER OF A CUSTOMER'S SUBSCRIPTION PAGE: THE OPERATOR'S TITLE, OR THE BRAND.
 *
 * rezeis-subpage draws `brandingSettings.title` in large letters beside the
 * logo at the top of the page a customer opens from their subscription link.
 * Until an operator saved a config on «Страница подписки», the panel served
 * the bundled default — generated in rezeis-subpage and kept byte-identical to
 * it — whose title is "Rezeis": the panel's name, on the customer's page.
 *
 * The first repair put the brand INTO the default. The editor loads that
 * config, so «Название» showed the brand as if somebody had typed it, and the
 * first «Сохранить» anywhere on the page froze it into the stored row: a later
 * brand rename never reached the page again — the SMTP sender name's defect
 * all over again.
 *
 * So the title is a saved value or nothing. `''` is stored for "not set";
 * the editor is given the saved title only, with the brand as its
 * placeholder; the page (`/internal/subpage-config/effective`) is given the
 * saved title, or — while there is none — the brand as it is at that moment.
 */

const PANEL_NAME = /rezeis/i;

/** Every string VALUE in `value` that names the panel, by its path. Keys are code. */
function pathsNamingThePanel(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return PANEL_NAME.test(value) ? [path] : [];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    pathsNamingThePanel(inner, path === '' ? key : `${path}.${key}`),
  );
}

interface Install {
  /** The stored config row; absent = nothing saved yet. */
  stored?: Record<string, unknown>;
  /** The branding row; `null` = no settings row; `'fails'` = the read rejects. */
  brandingSettings?: Record<string, unknown> | null | 'fails';
  /** The row's `updatedAt`, moved by every write — what a compare-and-set compares. */
  updatedAt?: number;
  /** Rows written by `updateMany`: a write moves `updatedAt` even with the same value. */
  writes?: number;
  /** Cache-busts pushed to rezeis-subpage. */
  invalidations?: string[];
  /** Runs once, right after the next read of the row: an operator's save landing there. */
  afterRead?: () => void;
}

function serviceFor(install: Install): SubpageConfigService {
  const prisma = {
    subpageConfig: {
      findUnique: async () => {
        const row =
          install.stored === undefined
            ? null
            : { config: install.stored, updatedAt: new Date(install.updatedAt ?? 0) };
        const hook = install.afterRead;
        install.afterRead = undefined;
        hook?.();
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; updatedAt?: Date };
        data: { config: Record<string, unknown> };
      }) => {
        const matches =
          install.stored !== undefined &&
          (where.updatedAt === undefined || where.updatedAt.getTime() === (install.updatedAt ?? 0));
        if (!matches) return { count: 0 };
        install.stored = data.config;
        install.updatedAt = (install.updatedAt ?? 0) + 1;
        install.writes = (install.writes ?? 0) + 1;
        return { count: 1 };
      },
      upsert: async ({ create }: { create: { config: Record<string, unknown> } }) => {
        install.stored = create.config;
        install.updatedAt = (install.updatedAt ?? 0) + 1;
        return { config: create.config };
      },
    },
    settings: {
      findFirst: async () => {
        if (install.brandingSettings === 'fails') throw new Error('connection terminated');
        return install.brandingSettings === undefined || install.brandingSettings === null
          ? null
          : { brandingSettings: install.brandingSettings };
      },
    },
  };
  const subpageCache = {
    invalidate: async (reason: string) => {
      (install.invalidations ??= []).push(reason);
      return true;
    },
  };
  return new SubpageConfigService(prisma as never, subpageCache as never);
}

function titleOf(config: Record<string, unknown>): unknown {
  return (config.brandingSettings as Record<string, unknown>).title;
}

function savedWithTitle(title: string): Record<string, unknown> {
  return {
    ...DEFAULT_SUBPAGE_CONFIG,
    brandingSettings: { title, logoUrl: '', supportUrl: '' },
  };
}

describe('the title the subscription page is served', () => {
  it('is the operator’s brand before anything is saved', async () => {
    const page = await new InternalSubpageConfigController(
      serviceFor({ brandingSettings: { brandName: 'Acme VPN' } }),
    ).getEffective();

    assert.equal(titleOf(page), 'Acme VPN');
    assert.deepEqual(pathsNamingThePanel(page), [], 'these fields name the panel');
  });

  it('is the brand while the saved title is empty, and follows a rename', async () => {
    const install: Install = { stored: savedWithTitle(''), brandingSettings: { brandName: 'Acme VPN' } };
    assert.equal(titleOf(await serviceFor(install).getEffectiveConfig()), 'Acme VPN');

    install.brandingSettings = { brandName: 'Beta VPN' };
    assert.equal(titleOf(await serviceFor(install).getEffectiveConfig()), 'Beta VPN');
  });

  it('is the brand when the saved title is only spaces', async () => {
    const config = await serviceFor({
      stored: savedWithTitle('   '),
      brandingSettings: { brandName: 'Acme VPN' },
    }).getEffectiveConfig();

    assert.equal(titleOf(config), 'Acme VPN');
  });

  it('is the saved title when there is one', async () => {
    const config = await serviceFor({
      stored: savedWithTitle('Saved Title'),
      brandingSettings: { brandName: 'Acme VPN' },
    }).getEffectiveConfig();

    assert.equal(titleOf(config), 'Saved Title');
  });

  it('is the stock brand where the operator set none', async () => {
    // The same name the unbranded cabinet, emails and push titles carry.
    const config = await serviceFor({ brandingSettings: null }).getEffectiveConfig();

    assert.equal(titleOf(config), DEFAULT_BRANDING.brandName);
    assert.doesNotMatch(String(titleOf(config)), PANEL_NAME);
  });

  it('is the stock brand, not a failed page, when the settings cannot be read', async () => {
    const config = await serviceFor({ stored: savedWithTitle(''), brandingSettings: 'fails' }).getEffectiveConfig();

    assert.equal(titleOf(config), DEFAULT_BRANDING.brandName);
  });

  it('leaves the bundled default itself alone', async () => {
    // It is one object shared by every request. Written into, the first
    // brand to be served would become every later install's default too.
    const before = JSON.stringify(DEFAULT_SUBPAGE_CONFIG);
    await serviceFor({ brandingSettings: { brandName: 'Acme VPN' } }).getEffectiveConfig();
    const second = await serviceFor({ brandingSettings: { brandName: 'Beta VPN' } }).getEffectiveConfig();

    assert.equal(titleOf(second), 'Beta VPN');
    assert.equal(JSON.stringify(DEFAULT_SUBPAGE_CONFIG), before);
  });
});

describe('«Название» in the editor', () => {
  it('is empty before anything is saved, with the brand offered as its placeholder', async () => {
    const view = await new AdminSubpageConfigController(
      serviceFor({ brandingSettings: { brandName: 'Acme VPN' } }),
    ).get();

    assert.equal(titleOf(view.config), '', 'the editor shows a title nobody saved');
    assert.equal(view.titleFallback, 'Acme VPN');
    assert.equal(view.stored, false);
    // Everything else is still the bundled default to edit.
    assert.deepEqual(view.config.platforms, DEFAULT_SUBPAGE_CONFIG.platforms);
  });

  it('shows a saved title as saved', async () => {
    const view = await new AdminSubpageConfigController(
      serviceFor({ stored: savedWithTitle('Saved Title'), brandingSettings: { brandName: 'Acme VPN' } }),
    ).get();

    assert.equal(titleOf(view.config), 'Saved Title');
    assert.equal(view.titleFallback, 'Acme VPN');
  });

  it('stays empty after a save that left it empty, so the page keeps following the brand', async () => {
    const install: Install = { brandingSettings: { brandName: 'Acme VPN' } };
    const controller = new AdminSubpageConfigController(serviceFor(install));

    const loaded = await controller.get();
    const saved = await controller.replace({ config: loaded.config });

    assert.equal(titleOf(saved.config), '');
    assert.equal(titleOf(install.stored ?? {}), '', 'the brand was frozen into the stored row');
    install.brandingSettings = { brandName: 'Beta VPN' };
    assert.equal(titleOf(await serviceFor(install).getEffectiveConfig()), 'Beta VPN');
  });

  it('stores a title of spaces as not set, and a real one trimmed', async () => {
    const install: Install = { brandingSettings: { brandName: 'Acme VPN' } };
    const service = serviceFor(install);

    await service.replaceConfig(savedWithTitle('   '));
    assert.equal(titleOf(install.stored ?? {}), '');

    await service.replaceConfig(savedWithTitle('  Acme Premium  '));
    assert.equal(titleOf(install.stored ?? {}), 'Acme Premium');
  });
});

/**
 * "Rezeis" SAVED BY THE OLD EDITOR IS NOT A CHOICE.
 *
 * Before this patch the editor opened on the bundled default, so «Название»
 * read "Rezeis", and the first «Сохранить» for any reason stored it. Such a
 * row outlives every fix above: the page still read "Rezeis". So, once per
 * boot, a stored title that is exactly that string — byte for byte — becomes
 * "not set", and the page follows the brand. Anything else is the operator's.
 */
describe('a stored title that is still the old editor’s "Rezeis"', () => {
  /** A saved config that differs from the bundled default elsewhere too. */
  function savedByTheOldEditor(title: string): Record<string, unknown> {
    return {
      ...DEFAULT_SUBPAGE_CONFIG,
      brandingSettings: { title, logoUrl: 'https://cdn.example/logo.svg', supportUrl: 'https://t.me/acme_help' },
      platforms: { android: { apps: [] } },
    };
  }

  it('becomes "not set" at boot, so the page follows the brand; nothing else changes', async () => {
    const install: Install = { stored: savedByTheOldEditor('Rezeis'), brandingSettings: { brandName: 'Acme VPN' } };
    const service = serviceFor(install);

    await service.onApplicationBootstrap();

    const stored = install.stored ?? {};
    assert.equal(titleOf(stored), '');
    assert.deepEqual(stored.brandingSettings, {
      title: '',
      logoUrl: 'https://cdn.example/logo.svg',
      supportUrl: 'https://t.me/acme_help',
    });
    assert.deepEqual(stored.platforms, { android: { apps: [] } });
    assert.equal(titleOf(await service.getEffectiveConfig()), 'Acme VPN');
    const view = await service.getEditorView();
    assert.equal(titleOf(view.config), '');
    assert.equal(view.titleFallback, 'Acme VPN');
    // The page is told at once rather than at its next cache refresh.
    assert.equal(install.invalidations?.length, 1);
    // And from then on it follows a rename.
    install.brandingSettings = { brandName: 'Beta VPN' };
    assert.equal(titleOf(await service.getEffectiveConfig()), 'Beta VPN');
  });

  it('is upgraded once: a second boot writes nothing and tells the page nothing', async () => {
    const install: Install = { stored: savedByTheOldEditor('Rezeis'), brandingSettings: { brandName: 'Acme VPN' } };

    await serviceFor(install).onApplicationBootstrap();
    assert.equal(install.writes, 1);
    await serviceFor(install).onApplicationBootstrap();

    assert.equal(install.writes, 1, 'the second boot rewrote the row');
    assert.equal(install.invalidations?.length, 1);
  });

  it('leaves every other title as the operator saved it', async () => {
    for (const title of ['Rezeis VPN', ' Rezeis', 'Rezeis ', 'rezeis', 'REZEIS', 'Acme VPN', '']) {
      const install: Install = { stored: savedByTheOldEditor(title), brandingSettings: { brandName: 'Acme VPN' } };

      await serviceFor(install).onApplicationBootstrap();

      assert.equal(titleOf(install.stored ?? {}), title, JSON.stringify(title));
      assert.equal(install.writes ?? 0, 0, `${JSON.stringify(title)} was rewritten`);
    }
  });

  it('does nothing on an install that never saved the page', async () => {
    const install: Install = { brandingSettings: { brandName: 'Acme VPN' } };

    await serviceFor(install).onApplicationBootstrap();

    assert.equal(install.stored, undefined);
    assert.equal(install.writes ?? 0, 0);
  });

  it('never overwrites a save that lands between its read and its write', async () => {
    // The upgrade writes the whole config back. Without a compare-and-set,
    // an operator's save in that gap — its catalog, its links — would be
    // replaced by the copy the upgrade read a moment earlier.
    const install: Install = { stored: savedByTheOldEditor('Rezeis'), brandingSettings: { brandName: 'Acme VPN' } };
    const operatorsSave = savedByTheOldEditor('Rezeis');
    operatorsSave.platforms = { ios: { apps: [] } };
    install.afterRead = () => {
      install.stored = operatorsSave;
      install.updatedAt = (install.updatedAt ?? 0) + 1;
    };

    await serviceFor(install).onApplicationBootstrap();

    assert.equal(install.stored, operatorsSave, 'the operator’s save was overwritten');
    assert.equal(install.writes ?? 0, 0);
  });

  it('never fails the boot when the database refuses', async () => {
    const service = new SubpageConfigService(
      { subpageConfig: { findUnique: async () => Promise.reject(new Error('connection terminated')) } } as never,
    );

    await assert.doesNotReject(service.onApplicationBootstrap());
  });
});
