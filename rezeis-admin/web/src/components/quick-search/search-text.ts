/**
 * Text plumbing for the panel-wide search: normalisation, word splitting,
 * keyboard-layout and transliteration variants, bounded edit distance.
 *
 * Pure module — no React, no i18next, no DOM. Everything here is exercised
 * directly by `search-text.test.ts`, and the engine (`search-engine.ts`)
 * builds on it.
 *
 * The rule that shapes all of it: an operator types what they REMEMBER, not
 * what the panel wrote. They type two words out of five, in the wrong order,
 * in the wrong case, in the wrong inflection, sometimes in the wrong keyboard
 * layout. A search that only answers `label.includes(query)` answers almost
 * none of that, which is the complaint this module exists to fix.
 */

/**
 * Case-folds, unifies `ё`/`е`, drops diacritics and reduces every run of
 * punctuation to a single space.
 *
 * Folding `ё` onto `е` is not cosmetic: the panel's own copy is inconsistent
 * about it («счёт» in one string, «счет» in the next), so without folding,
 * half of a page is unreachable by the spelling the operator used. It is not
 * a special case either — decomposing (NFD) and dropping every combining mark
 * folds `ё`→`е`, `й`→`и` and every Latin diacritic in one rule, and it folds
 * the indexed text and the query the same way, which is what matters.
 *
 * `{{count}}`-style interpolation placeholders are removed rather than split
 * into words: they are i18next machinery, never something an operator reads
 * or types, and left in they make `count`, `name` and `value` match hundreds
 * of unrelated strings.
 */
export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Normalised words of a string, in order, duplicates kept. */
export function tokenize(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * ЙЦУКЕН ↔ QWERTY, one physical key per pair.
 *
 * Typing the right word in the wrong layout is the single most common way an
 * operator's query comes out as nonsense: the panel is bilingual, the OS
 * layout is not switched, and «платежи» arrives as `ggfntb`-shaped noise. A
 * phone has no layouts and therefore no such failure; the desktop panel has to
 * undo it explicitly.
 */
const QWERTY = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const JCUKEN = 'йцукенгшщзхъфывапролджэячсмитьбюё';

const LATIN_TO_CYRILLIC_KEY = new Map<string, string>();
const CYRILLIC_TO_LATIN_KEY = new Map<string, string>();
for (let index = 0; index < QWERTY.length; index += 1) {
  const latin = QWERTY[index];
  const cyrillic = JCUKEN[index];
  if (!latin || !cyrillic || cyrillic === ' ') continue;
  LATIN_TO_CYRILLIC_KEY.set(latin, cyrillic);
  CYRILLIC_TO_LATIN_KEY.set(cyrillic, latin);
}

function swapLayout(value: string): string {
  let out = '';
  let changed = false;
  for (const char of value) {
    const swapped = LATIN_TO_CYRILLIC_KEY.get(char) ?? CYRILLIC_TO_LATIN_KEY.get(char);
    if (swapped) {
      out += swapped;
      changed = true;
    } else {
      out += char;
    }
  }
  return changed ? out : '';
}

/**
 * Latin → Cyrillic transliteration, digraphs first.
 *
 * Covers the other half of the layout problem: an operator who knows the word
 * but not the layout types it phonetically — `nastroyki`, `platezhi`,
 * `podpiska`. Order matters, longest sequence wins, otherwise `sh` decays into
 * `s`+`h`.
 */
const TRANSLIT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['shch', 'щ'],
  ['sch', 'щ'],
  ['yo', 'е'],
  ['zh', 'ж'],
  ['kh', 'х'],
  ['ts', 'ц'],
  ['ch', 'ч'],
  ['sh', 'ш'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['ye', 'е'],
  // `y` after a vowel is the Russian `й`, not `ы` — without these six,
  // `nastroyki` transliterates to «настроыки» and matches nothing.
  ['ay', 'ай'],
  ['ey', 'ей'],
  ['iy', 'ий'],
  ['oy', 'ой'],
  ['uy', 'уй'],
  ['yy', 'ый'],
  ['a', 'а'],
  ['b', 'б'],
  ['v', 'в'],
  ['g', 'г'],
  ['d', 'д'],
  ['e', 'е'],
  ['z', 'з'],
  ['i', 'и'],
  ['j', 'й'],
  ['y', 'ы'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['f', 'ф'],
  ['h', 'х'],
  ['c', 'к'],
  ['w', 'в'],
  ['x', 'кс'],
  ['q', 'к'],
];

function transliterate(value: string): string {
  if (!/[a-z]/.test(value)) return '';
  let out = '';
  let index = 0;
  while (index < value.length) {
    const rest = value.slice(index);
    const pair = TRANSLIT_PAIRS.find(([latin]) => rest.startsWith(latin));
    if (pair) {
      out += pair[1];
      index += pair[0].length;
    } else {
      out += value[index];
      index += 1;
    }
  }
  return out;
}

/**
 * Cyrillic → Latin, for the half of the panel that is written in Latin.
 *
 * «Терминал», «токен», «хост», «логин» are read in Russian and written in the
 * interface as `terminal_id`, `token`, `host`, `login`. An operator types what
 * they read, so the query has to be able to cross back.
 */
const CYRILLIC_TO_LATIN: ReadonlyArray<readonly [string, string]> = [
  ['щ', 'shch'],
  ['ж', 'zh'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['ю', 'yu'],
  ['я', 'ya'],
  ['ц', 'ts'],
  ['х', 'h'],
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['з', 'z'],
  ['и', 'i'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
  ['ы', 'y'],
  ['э', 'e'],
  ['ъ', ''],
  ['ь', ''],
];
const CYRILLIC_TO_LATIN_MAP = new Map(CYRILLIC_TO_LATIN);

function transliterateToLatin(value: string): string {
  if (!/[а-я]/.test(value)) return '';
  let out = '';
  for (const char of value) {
    out += CYRILLIC_TO_LATIN_MAP.get(char) ?? char;
  }
  return out;
}

/**
 * Words that carry no meaning on their own.
 *
 * An operator types a phrase, not keywords: «бан по устройству», «оплата за
 * подписку». Every word has to match for a row to qualify, so «по» — which
 * appears in a third of the panel's sentences and in none of the labels worth
 * finding — quietly decides the answer. Dropped from the QUERY only; the index
 * keeps every word it was written with.
 *
 * Never all of them: a query that is nothing but function words is still a
 * query, and answering it with everything is better than answering it with a
 * blank.
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'а',
  'в',
  'во',
  'для',
  'до',
  'же',
  'за',
  'и',
  'из',
  'к',
  'ко',
  'на',
  'не',
  'о',
  'об',
  'от',
  'по',
  'при',
  'с',
  'со',
  'у',
  'что',
  'and',
  'for',
  'from',
  'in',
  'of',
  'on',
  'the',
  'to',
  'with',
]);

function dropStopwords(normalized: string): string {
  const words = normalized.split(' ');
  if (words.length < 2) return normalized;
  const kept = words.filter((word) => !QUERY_STOPWORDS.has(word));
  return kept.length === 0 ? normalized : kept.join(' ');
}

/**
 * The query as typed, plus every rewriting worth trying, best first.
 *
 * The engine scores a row against each variant and keeps the best score, with
 * a penalty applied to everything after the first — a literal match must
 * always outrank a match that needed the query rewritten, otherwise typing
 * «сор» (a real word) starts returning rows that only match `cjh`.
 */
export function searchQueryVariants(query: string): string[] {
  const primary = dropStopwords(normalizeSearchText(query));
  if (primary.length === 0) return [];
  const variants = [primary];
  const pushIfNew = (candidate: string): void => {
    const normalized = dropStopwords(normalizeSearchText(candidate));
    if (normalized.length > 0 && !variants.includes(normalized)) variants.push(normalized);
  };
  pushIfNew(swapLayout(primary));
  pushIfNew(transliterate(primary));
  pushIfNew(transliterateToLatin(primary));
  return variants;
}

/**
 * Damerau-Levenshtein distance, abandoned as soon as it exceeds `max`.
 *
 * Returns `null` instead of the distance when the bound is blown, so callers
 * read as "is this within one typo" rather than "compute, then compare" — the
 * early exit is the whole point: the engine calls this across every distinct
 * word in the index, and an unbounded matrix walk there is what makes naive
 * fuzzy search feel slow.
 */
export function editDistanceWithin(a: string, b: string, max: number): number | null {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return null;
  if (a.length === 0) return b.length <= max ? b.length : null;
  if (b.length === 0) return a.length <= max ? a.length : null;

  let previousRow: number[] = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  let twoRowsBack: number[] = [];
  for (let i = 1; i <= a.length; i += 1) {
    const currentRow: number[] = new Array<number>(b.length + 1);
    currentRow[0] = i;
    let rowBest = currentRow[0];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previousRow[j] ?? Number.MAX_SAFE_INTEGER) + 1,
        (currentRow[j - 1] ?? Number.MAX_SAFE_INTEGER) + 1,
        (previousRow[j - 1] ?? Number.MAX_SAFE_INTEGER) + substitutionCost,
      );
      // Transposition: «настройик» for «настройки» is one swap, not two edits.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (twoRowsBack[j - 2] ?? Number.MAX_SAFE_INTEGER) + 1);
      }
      currentRow[j] = value;
      if (value < rowBest) rowBest = value;
    }
    // Every further row can only grow, so a whole row above the bound ends it.
    if (rowBest > max) return null;
    twoRowsBack = previousRow;
    previousRow = currentRow;
  }
  const distance = previousRow[b.length] ?? Number.MAX_SAFE_INTEGER;
  return distance <= max ? distance : null;
}

/**
 * How many typos a token of this length may carry.
 *
 * Short tokens get none: at three characters an edit turns «бот» into «бит»
 * and every second row becomes a hit, which is worse than finding nothing.
 */
export function typoBudgetFor(token: string): number {
  if (token.length >= 8) return 2;
  if (token.length >= 5) return 1;
  return 0;
}

/**
 * The same folding as `normalizeSearchText`, minus everything that changes the
 * string's LENGTH.
 *
 * Highlighting needs to point at characters of the original text, so the folded
 * copy must line up with it index for index. Placeholder removal and space
 * collapsing are therefore left out, and punctuation becomes a single space
 * rather than disappearing. Returns `null` when the fold changed the length
 * anyway — some scripts decompose to more characters than they started with,
 * and a highlight drawn from a shifted index underlines the wrong word, which
 * is worse than no highlight.
 */
export function foldForHighlight(value: string): string | null {
  const folded = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, ' ');
  return folded.length === value.length ? folded : null;
}

/**
 * Character ranges of `text` that answer `tokens`, merged and ordered.
 *
 * Substring occurrences, not whole words: an operator who typed «платеж» and
 * matched «платежи» should see which part of the row answered them.
 */
export function highlightRanges(
  text: string,
  tokens: ReadonlyArray<string>,
): Array<readonly [number, number]> {
  const folded = foldForHighlight(text);
  if (folded === null) return [];
  const ranges: Array<readonly [number, number]> = [];
  for (const token of tokens) {
    if (token.length < 2) continue;
    let from = folded.indexOf(token);
    while (from !== -1) {
      ranges.push([from, from + token.length]);
      from = folded.indexOf(token, from + token.length);
    }
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<readonly [number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      if (range[1] > last[1]) merged[merged.length - 1] = [last[0], range[1]];
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/** Length of the longest common prefix of two strings. */
export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}
