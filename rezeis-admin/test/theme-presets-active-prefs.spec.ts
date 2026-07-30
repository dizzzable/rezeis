import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';

import {
  ACTIVE_PREFS_LIMITS,
  ACTIVE_PREFS_STORE_KEYS,
  isValidActivePrefs,
  sanitizeStoredActivePrefs,
  ThemePresetsService,
} from '../src/modules/theme-presets/services/theme-presets.service';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { PrismaService } from '../src/common/prisma/prisma.service';

function envelope(state: Record<string, unknown>, version = 1): Record<string, unknown> {
  return { state, version };
}

function validPrefs(): Record<string, unknown> {
  return {
    'rezeis-admin-theme': envelope({
      presetId: 'concept-cz',
      mode: 'dark',
      radius: 0.75,
      customCss: '',
      overridesLight: {},
      overridesDark: {},
    }, 2),
    'rezeis-admin-glass': envelope({
      glassEnabled: true,
      background: { id: 'liquidChrome', opacity: 0.5, props: { speed: 0.27 } },
    }, 4),
    'rezeis-admin-effects': envelope({
      textAnimation: 'shiny',
      cursorEffect: 'none',
      clickEffect: 'spark',
      hoverEffect: 'spotlight',
      contentAnimation: 'animatedContent',
      effectsEnabled: true,
    }, 2),
    'rezeis-admin-appearance': envelope({
      density: 'comfortable',
      fontSize: 'default',
      animationsEnabled: true,
      visualEffects: true,
    }, 0),
  };
}

function currentAdmin(): CurrentAdminInterface {
  return { id: 'admin-1' } as CurrentAdminInterface;
}

describe('active appearance preferences contract', () => {
  it('accepts the four bounded Zustand persistence envelopes', () => {
    const prefs = validPrefs();

    assert.equal(isValidActivePrefs(prefs), true);
    assert.deepStrictEqual(Object.keys(prefs), [...ACTIVE_PREFS_STORE_KEYS]);
  });

  it('rejects unknown stores, malformed envelopes, unsafe trees, and oversized data', () => {
    const cases: readonly unknown[] = [
      { ...validPrefs(), 'unexpected-store': envelope({ enabled: true }) },
      { 'rezeis-admin-theme': [] },
      { 'rezeis-admin-theme': { state: {}, version: 1, extra: true } },
      { 'rezeis-admin-theme': { state: { invalid: new Date() }, version: 1 } },
      {
        'rezeis-admin-theme': envelope({
          customCss: 'x'.repeat(ACTIVE_PREFS_LIMITS.storeBytes + 1),
        }),
      },
    ];

    for (const prefs of cases) {
      assert.equal(isValidActivePrefs(prefs), false);
    }
  });

  it('salvages valid known stores from legacy database rows without exposing junk', () => {
    const theme = envelope({ presetId: 'concept-a', customCss: '' }, 2);
    const sanitized = sanitizeStoredActivePrefs({
      'rezeis-admin-theme': theme,
      'rezeis-admin-glass': { state: [], version: 4 },
      unknown: envelope({ injected: true }),
    });

    assert.deepStrictEqual(sanitized, { 'rezeis-admin-theme': theme });
    assert.equal(sanitizeStoredActivePrefs({ unknown: envelope({}) }), null);
    assert.equal(sanitizeStoredActivePrefs(null), null);
  });

  it('persists valid prefs and rejects invalid service calls before Prisma', async () => {
    const updates: unknown[] = [];
    const prisma = {
      adminUser: {
        update: async (input: unknown): Promise<void> => {
          updates.push(input);
        },
      },
    };
    const service = new ThemePresetsService(prisma as unknown as PrismaService);
    const prefs = validPrefs();

    await service.saveAppearancePrefs(currentAdmin(), prefs);
    assert.deepStrictEqual(updates, [
      {
        where: { id: 'admin-1' },
        data: { appearancePrefs: prefs },
      },
    ]);

    await assert.rejects(
      service.saveAppearancePrefs(currentAdmin(), {
        'rezeis-admin-theme': { state: [], version: 2 },
      }),
      BadRequestException,
    );
    assert.equal(updates.length, 1);
  });

  it('sanitizes legacy rows on read before returning them to a browser', async () => {
    const theme = envelope({ presetId: 'concept-ba' }, 2);
    const prisma = {
      adminUser: {
        findUnique: async (): Promise<Record<string, unknown>> => ({
          appearancePrefs: {
            'rezeis-admin-theme': theme,
            'rezeis-admin-effects': { state: 'broken', version: 2 },
            arbitrary: envelope({ shouldNotLeak: true }),
          },
        }),
      },
    };
    const service = new ThemePresetsService(prisma as unknown as PrismaService);

    assert.deepStrictEqual(await service.getAppearancePrefs(currentAdmin()), {
      'rezeis-admin-theme': theme,
    });
  });
});
