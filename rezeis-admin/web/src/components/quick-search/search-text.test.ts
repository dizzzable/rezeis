/**
 * The text plumbing under panel search.
 *
 * Each case here is a way a real query arrives mangled: the other spelling of
 * `ё`, an interpolation placeholder inside the indexed string, the wrong
 * keyboard layout, a phonetic spelling, a swapped pair of letters.
 */
import { describe, expect, it } from 'vitest';

import {
  commonPrefixLength,
  editDistanceWithin,
  foldForHighlight,
  highlightRanges,
  normalizeSearchText,
  searchQueryVariants,
  tokenize,
  typoBudgetFor,
} from './search-text';

describe('normalisation', () => {
  it('folds ё onto е, so both spellings find the same rows', () => {
    expect(normalizeSearchText('Платёжные шлюзы')).toBe('платежные шлюзы');
    expect(normalizeSearchText('ПЛАТЕЖНЫЕ ШЛЮЗЫ')).toBe(normalizeSearchText('Платёжные шлюзы'));
  });

  it('drops i18next placeholders instead of indexing their variable names', () => {
    // Left in, `count` and `name` would match hundreds of unrelated strings.
    expect(normalizeSearchText('Подписок: {{count}} шт.')).toBe('подписок шт');
  });

  it('keeps latin words intact', () => {
    expect(normalizeSearchText('Autopay — RollyPay')).toBe('autopay rollypay');
  });

  it('splits on punctuation rather than gluing words together', () => {
    expect(tokenize('Способы оплаты / СБП')).toEqual(['способы', 'оплаты', 'сбп']);
  });
});

describe('query variants', () => {
  it('reads a Russian word typed on a latin layout', () => {
    expect(searchQueryVariants('gfhnyths')).toContain('партнеры');
  });

  it('reads a latin word typed on a Russian layout', () => {
    expect(searchQueryVariants('кщдднзфн')).toContain('rollypay');
  });

  it('reads a phonetic spelling', () => {
    // Compared against the folded form, because that is what the index holds:
    // `й` decomposes and loses its breve on both sides, so «настройки» is
    // stored — and matched — as «настроики».
    expect(searchQueryVariants('nastroyki')).toContain(normalizeSearchText('настройки'));
  });

  it('crosses back into latin, which half the panel is written in', () => {
    // The field is labelled «ID кассы (terminal_id)»; the operator reads
    // «терминал» and types it in Russian.
    expect(searchQueryVariants('терминал')).toContain('terminal');
  });

  it('always offers what was actually typed first', () => {
    expect(searchQueryVariants('платежи')[0]).toBe('платежи');
  });

  it('drops the function words that would otherwise decide the answer', () => {
    // Every word has to match, so «по» — which is in a third of the panel's
    // sentences and in none of its labels — picks the rows on its own.
    expect(searchQueryVariants('бан по устройству')[0]).toBe(
      normalizeSearchText('бан устройству'),
    );
  });

  it('keeps a query that is nothing but function words', () => {
    expect(searchQueryVariants('по')[0]).toBe('по');
  });

  it('has nothing to offer for an empty query', () => {
    expect(searchQueryVariants('   ')).toEqual([]);
  });
});

describe('typo tolerance', () => {
  it('counts a swapped pair as one edit, not two', () => {
    expect(editDistanceWithin('настройки', 'настройик', 1)).toBe(1);
  });

  it('gives up as soon as the bound is blown', () => {
    expect(editDistanceWithin('abc', 'xyz', 1)).toBeNull();
  });

  it('allows a short word no typos at all', () => {
    // At three characters an edit turns «бот» into «бит» and every second row
    // becomes a hit.
    expect(typoBudgetFor('бот')).toBe(0);
    expect(typoBudgetFor('настрой')).toBe(1);
    expect(typoBudgetFor('автосписание')).toBe(2);
  });

  it('measures the shared stem two inflections have', () => {
    expect(commonPrefixLength('платежи', 'платежный')).toBe(6);
  });
});

describe('highlighting', () => {
  it('lines up with the original text, accents and all', () => {
    const text = 'Платёжные шлюзы';
    expect(foldForHighlight(text)).toHaveLength(text.length);
  });

  it('marks the part of the word that answered', () => {
    const ranges = highlightRanges('Платёжные шлюзы', ['платеж']);
    expect(ranges).toEqual([[0, 6]]);
  });

  it('merges overlapping matches into one range', () => {
    expect(highlightRanges('Платежи платежей', ['платеж', 'платежи'])).toEqual([
      [0, 7],
      [8, 14],
    ]);
  });

  it('marks nothing when the query is not in the text', () => {
    expect(highlightRanges('Платежи', ['бэкап'])).toEqual([]);
  });
});
