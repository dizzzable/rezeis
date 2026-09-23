/**
 * The mapping guard.
 *
 * Panel search is built from the translation dictionaries, so it can only
 * answer for a namespace somebody said where to send. That is the one part of
 * this feature that rots silently: a page shipped next month arrives with its
 * strings, the index skips them, and search simply never mentions that page —
 * no error, no warning, nothing to notice. This file makes that a red test.
 *
 * It also checks the other direction, which is the failure an operator SEES: a
 * target that resolves to no nav row (a result with nowhere to go), a `#tab`
 * the page does not accept (a result that lands on the wrong tab), or a label
 * key with no translation (a result that shows `panelSettings.tabs.branding`
 * to a human).
 */
import { describe, expect, it } from 'vitest';

import { HUB_TABS } from '@/components/layout/admin-nav-config';
import { mergeDictionary } from './search-engine';
import {
  IGNORED_NAMESPACES,
  SEARCH_KEY_TARGETS,
  resolveSearchTarget,
} from './search-pages';

const CORE = import.meta.glob<Record<string, unknown>>('../../i18n/{ru,en}.ts', { eager: true });
const FEATURES = import.meta.glob<Record<string, unknown>>('../../i18n/features/*.{ru,en}.ts', {
  eager: true,
});

function dictionaryFor(locale: 'ru' | 'en'): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [path, module] of [...Object.entries(CORE), ...Object.entries(FEATURES)]) {
    if (!path.endsWith(`/${locale}.ts`) && !path.endsWith(`.${locale}.ts`)) continue;
    const dictionary = module[locale] as Record<string, unknown> | undefined;
    // Deep, as the engine merges: a namespace may be split between files.
    if (dictionary) mergeDictionary(merged, dictionary);
  }
  return merged;
}

const ru = dictionaryFor('ru');
const en = dictionaryFor('en');
const mappedPrefixes = Object.keys(SEARCH_KEY_TARGETS);
const targetPaths = [...new Set(Object.values(SEARCH_KEY_TARGETS))];

/**
 * Top-level namespaces, derived the way the engine derives them.
 *
 * Not `Object.keys`: a few dictionary keys contain a dot themselves
 * (`screen.cabinet`, which i18next resolves through `ignoreJSONStructure`),
 * and reading those as whole namespaces would report four namespaces that the
 * engine never sees.
 */
function namespacesOf(dictionary: Record<string, unknown>): string[] {
  return [...new Set(Object.keys(dictionary).map((key) => key.split('.')[0] ?? key))];
}

/** Reads a dotted key out of a dictionary. */
function lookup(dictionary: Record<string, unknown>, key: string): unknown {
  let cursor: unknown = dictionary;
  for (const segment of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

describe('every namespace has an address', () => {
  it('maps or explicitly ignores each one', () => {
    const unmapped = namespacesOf(ru).filter(
      (namespace) =>
        !IGNORED_NAMESPACES.has(namespace) &&
        !mappedPrefixes.some((prefix) => prefix === namespace || prefix.startsWith(`${namespace}.`)),
    );
    expect(
      unmapped,
      'add each to SEARCH_KEY_TARGETS (where its strings are shown) or to IGNORED_NAMESPACES',
    ).toEqual([]);
  });

  it('maps nothing that no longer exists', () => {
    const stale = mappedPrefixes.filter((prefix) => lookup(ru, prefix) === undefined);
    expect(stale, 'these prefixes are in the map but not in the dictionary').toEqual([]);
  });

  it('ignores nothing that no longer exists', () => {
    const known = new Set(namespacesOf(ru));
    const stale = [...IGNORED_NAMESPACES].filter((namespace) => !known.has(namespace));
    expect(stale, 'these namespaces are ignored but no longer exist').toEqual([]);
  });

  /**
   * The two dictionaries have to agree, because the index is built from
   * whichever one the operator is reading. A namespace only present in EN is a
   * hole in the Russian panel's search and vice versa — `bundle-parity.test.ts`
   * owns the general rule; this is the half that would reach search.
   */
  it('finds the same namespaces in both languages', () => {
    const inRu = new Set(namespacesOf(ru));
    expect(namespacesOf(en).filter((namespace) => !inRu.has(namespace))).toEqual([]);
  });
});

describe('every target is a place the panel can open', () => {
  it('resolves to a nav row, which is what gates and names it', () => {
    for (const path of targetPaths) {
      expect(resolveSearchTarget(path), path).not.toBeNull();
    }
  });

  /**
   * The load-bearing one, and the same rule `admin-nav-config.test.ts` applies
   * to the sidebar's own deep links: `/settings/panel#branding` is a deep link
   * only while the hub accepts `branding`. A hash the page ignores does not
   * fail — it lands the operator on the page's default tab, which reads as
   * search sending them to the wrong place.
   */
  it('points every hash at a tab its page accepts', () => {
    const hubTabs = HUB_TABS as Record<string, ReadonlyArray<string> | undefined>;
    for (const path of targetPaths) {
      const hashAt = path.indexOf('#');
      if (hashAt < 0) continue;
      const page = path.slice(0, hashAt);
      const tab = path.slice(hashAt + 1);
      expect(hubTabs[page], `no HUB_TABS entry for "${page}"`).toBeDefined();
      expect(hubTabs[page] ?? [], path).toContain(tab);
    }
  });

  it('names every target in both languages', () => {
    for (const path of targetPaths) {
      const target = resolveSearchTarget(path);
      if (!target) continue;
      for (const key of [target.labelKey, target.parentLabelKey]) {
        if (key === null) continue;
        expect(typeof lookup(ru, key), `${path} → ${key}`).toBe('string');
        expect(typeof lookup(en, key), `${path} → ${key}`).toBe('string');
      }
    }
  });
});
