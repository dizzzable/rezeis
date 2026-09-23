/**
 * The search engine against the REAL Russian dictionary.
 *
 * Fixtures would prove nothing here. The thing being tested is whether an
 * operator's remembered half-phrase finds the screen it lives on, and that is
 * a property of the panel's own 10 700 strings — their inflections, their
 * synonyms, their duplication across pages. Every query below is one somebody
 * would actually type.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { ensureSearchIndex, mergeDictionary, queryIndex, type SearchIndexInterface } from './search-engine';

let index: SearchIndexInterface;

beforeAll(async () => {
  index = await ensureSearchIndex('ru');
}, 60_000);

function pathsFor(query: string, limit = 10): string[] {
  return queryIndex(index, query, { limit }).map((hit) => hit.entry.target.path);
}

describe('panel search index', () => {
  it('indexes far more than the sidebar', () => {
    // The old overlay searched ~60 nav labels. Anything in this range means
    // the dictionaries are being read; a number near 60 means the mapping
    // silently dropped everything.
    expect(index.entries.length).toBeGreaterThan(3000);
  });

  it('gives every entry a page an operator can open', () => {
    for (const entry of index.entries) {
      expect(entry.target.path.length, entry.key).toBeGreaterThan(0);
    }
  });

  it('indexes both halves of a namespace split between the core dictionary and a feature bundle', () => {
    // `botFlow` lives in `ru.ts`, and its «Карта бота»-only part in the lazy
    // `botMap` bundle. Merged shallowly, the file read last replaced the other
    // half of the namespace, and its words vanished from the search.
    const keys = new Set(index.entries.map((entry) => entry.key));
    expect(keys.has('botFlow.newScreen'), 'core half').toBe(true);
    expect(keys.has('botFlow.systemScreens.lang.title'), 'bundle half').toBe(true);
    const entry = index.entries.find((candidate) => candidate.key === 'botFlow.systemScreens.lang.title');
    expect(entry?.target.path).toBe('/bot-map');
  });

  it('merges a split namespace without writing into the dictionaries it reads', () => {
    // The modules are shared: i18next reads the same objects.
    const core = { botFlow: { save: 'Сохранить' } };
    const bundle = { botFlow: { systemScreens: { hint: 'Экран бота' } } };
    const merged: Record<string, unknown> = {};
    mergeDictionary(merged, core);
    mergeDictionary(merged, bundle);
    expect(merged).toEqual({ botFlow: { save: 'Сохранить', systemScreens: { hint: 'Экран бота' } } });
    expect(core).toEqual({ botFlow: { save: 'Сохранить' } });
    expect(bundle).toEqual({ botFlow: { systemScreens: { hint: 'Экран бота' } } });
  });
});

describe('finding a setting by a word that is on its screen', () => {
  it('finds the autopay controls, which live on no page called «автосписание»', () => {
    expect(pathsFor('автосписание')).toContain('/payments/gateways');
  });

  it('finds the client blocklist by its tab name', () => {
    expect(pathsFor('чёрный список')).toContain('/users#blocked-identities');
  });

  it('does not care in which order the two words were typed', () => {
    expect(pathsFor('список чёрный')).toContain('/users#blocked-identities');
  });

  it('finds payment webhooks on their own tab, not on the page default', () => {
    expect(pathsFor('вебхуки платежей')).toContain('/payments#webhooks');
  });

  it('answers a word the operator inflected differently from the panel', () => {
    // The dictionary says «списание»/«списанием»; the query is another form.
    expect(pathsFor('списания').length).toBeGreaterThan(0);
  });
});

describe('forgiving the way people type', () => {
  it('reads a query typed in the wrong keyboard layout', () => {
    // `gfhnyths` is «партнеры» on a QWERTY keyboard with RU letters printed.
    expect(pathsFor('gfhnyths')).toContain('/partners');
  });

  it('survives a transposed pair of letters', () => {
    expect(pathsFor('настройик').length).toBeGreaterThan(0);
  });

  it('still answers nothing when the query is nothing', () => {
    expect(pathsFor('щщщыыыэээ')).toHaveLength(0);
  });
});

describe('ordering', () => {
  it('puts the page itself above the settings that live on it', () => {
    const hits = queryIndex(index, 'платежи', { limit: 5 });
    expect(hits[0]?.entry.isPage).toBe(true);
  });

  it('never lets one page fill the list', () => {
    const hits = queryIndex(index, 'настройки', { limit: 12 });
    const perPath = new Map<string, number>();
    for (const hit of hits) {
      if (hit.entry.isPage) continue;
      perPath.set(hit.entry.target.path, (perPath.get(hit.entry.target.path) ?? 0) + 1);
    }
    for (const [path, count] of perPath) {
      expect(count, path).toBeLessThanOrEqual(2);
    }
  });

  it('honours the limit', () => {
    expect(queryIndex(index, 'а', { limit: 6 }).length).toBeLessThanOrEqual(6);
  });
});

describe('cost', () => {
  /**
   * Search runs on every keystroke, so the budget is the feature.
   *
   * The ceiling is loose on purpose — this machine is not a benchmark rig and
   * the suite runs eight workers wide — but it is far below the cost of the
   * two things that would break it: dropping the inverted index for a scan
   * over every row, or letting the fuzzy sweep run for tokens that already
   * matched. Either would cost an order of magnitude, not a few per cent.
   */
  it('answers a typed query in a few milliseconds', () => {
    const queries = ['авт', 'авто', 'автос', 'автосп', 'автоспис', 'автосписание'];
    const startedAt = performance.now();
    for (const query of queries) queryIndex(index, query, { limit: 12 });
    const perQuery = (performance.now() - startedAt) / queries.length;
    expect(perQuery).toBeLessThan(120);
  });

  it('pays for a mistyped query only when nothing matched', () => {
    // The fuzzy sweep is the expensive path. It must stay off for a query that
    // already has answers, which is almost every query an operator types.
    const startedAt = performance.now();
    queryIndex(index, 'платежи', { limit: 12 });
    expect(performance.now() - startedAt).toBeLessThan(120);
  });
});
