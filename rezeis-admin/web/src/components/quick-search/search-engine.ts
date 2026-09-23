/**
 * The panel's own search index: every word the interface says, and where it
 * says it.
 *
 * WHY THE DICTIONARIES ARE THE INDEX
 * ----------------------------------
 * The overlay used to match the query against ~60 sidebar labels with
 * `label.includes(query)`. That answers "what is this page called" and nothing
 * else, so «автосписание», «чёрный список», «вебхук» — words an operator has
 * actually read on a screen — returned nothing, and the honest conclusion was
 * that search is broken. Everything the panel renders is already in
 * `src/i18n`: ~10 700 strings for RU. Indexing those makes the searchable
 * surface the whole interface, and keeps it that way without anybody
 * remembering to update a list.
 *
 * WHEN IT LOADS
 * -------------
 * `QuickSearchOverlay` is in the login route's render-blocking graph
 * (`scripts/check-build-graph.mjs` guards its size), so nothing here may be
 * reachable by a STATIC import from it. The dictionaries are pulled in through
 * `import.meta.glob` with `eager: false` — Vite keeps each one the separate
 * lazy chunk it already is, and the whole set is fetched the first time an
 * operator opens the overlay, not on first paint.
 *
 * `import.meta.glob` rather than a hand-written list for the same reason the
 * index is built from the dictionaries: a feature bundle added next month is
 * indexed because it exists, not because somebody remembered it.
 */
import {
  commonPrefixLength,
  editDistanceWithin,
  normalizeSearchText,
  searchQueryVariants,
  typoBudgetFor,
} from './search-text';
import {
  NAV_INDEX,
  resolveSearchTarget,
  targetPathForKey,
  type ResolvedTargetInterface,
} from './search-pages';

export type SearchLocale = 'ru' | 'en';

export interface SearchEntryInterface {
  /** i18n key path; empty for the rows that ARE pages. */
  readonly key: string;
  /** The text as the panel renders it. */
  readonly text: string;
  readonly target: ResolvedTargetInterface;
  /** How much this text says about the page. See `weightForKey`. */
  readonly weight: number;
  readonly isPage: boolean;
  /**
   * Extra words a row answers to without showing them.
   *
   * Page rows carry their nav key and their route, so `apitokens`,
   * `two-factor` and `/settings/panel` keep finding the page they always did.
   * An operator who half-remembers a URL is searching as surely as one who
   * remembers a label.
   */
  readonly aliases?: ReadonlyArray<string>;
}

export interface SearchIndexInterface {
  readonly locale: SearchLocale;
  readonly entries: ReadonlyArray<SearchEntryInterface>;
  /** Normalised full text per entry, for phrase bonuses. */
  readonly entryText: ReadonlyArray<string>;
  readonly wordToEntries: ReadonlyMap<string, ReadonlyArray<number>>;
  /** Every distinct word, sorted, for prefix ranges and fuzzy sweeps. */
  readonly sortedWords: ReadonlyArray<string>;
}

export interface SearchHitInterface {
  readonly entry: SearchEntryInterface;
  readonly score: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dictionary loading
// ─────────────────────────────────────────────────────────────────────────────

type DictionaryModule = Record<string, unknown>;
type DictionaryLoader = () => Promise<DictionaryModule>;

// Narrow patterns on purpose. `../../i18n/*.ts` would also match `i18n.ts` and
// the dictionaries' own test files, and a non-eager glob still puts everything
// it matches into the build graph — a test file inside the shipped bundle.
const CORE_DICTIONARIES = import.meta.glob<DictionaryModule>('../../i18n/{ru,en}.ts');
const FEATURE_DICTIONARIES = import.meta.glob<DictionaryModule>(
  '../../i18n/features/*.{ru,en}.ts',
);

function dictionaryLoadersFor(locale: SearchLocale): DictionaryLoader[] {
  const loaders: DictionaryLoader[] = [];
  for (const [path, loader] of Object.entries(CORE_DICTIONARIES)) {
    if (path.endsWith(`/${locale}.ts`)) loaders.push(loader);
  }
  for (const [path, loader] of Object.entries(FEATURE_DICTIONARIES)) {
    if (path.endsWith(`.${locale}.ts`)) loaders.push(loader);
  }
  return loaders;
}

async function loadDictionaries(locale: SearchLocale): Promise<Record<string, unknown>> {
  const modules = await Promise.all(
    dictionaryLoadersFor(locale).map((load) =>
      load().catch((error: unknown): DictionaryModule => {
        // One missing chunk must not cost the whole index. The operator gets
        // search over everything else instead of an empty overlay.
        console.warn('[quick-search] dictionary chunk failed to load:', error);
        return {};
      }),
    ),
  );
  const merged: Record<string, unknown> = {};
  for (const module of modules) {
    const dictionary = (module[locale] ?? module['default']) as Record<string, unknown> | undefined;
    if (!dictionary || typeof dictionary !== 'object') continue;
    mergeDictionary(merged, dictionary);
  }
  return merged;
}

function isDictionaryNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges `source` into `target` the way i18next's `addResourceBundle(…, deep)`
 * does, without writing into either module object.
 *
 * One namespace can live in two files: part of `botFlow` is in the core
 * dictionary, part in the lazy `botMap` bundle, where it waits until the page
 * that shows it is opened. `Object.assign` kept whichever file came last and
 * dropped the other half of the namespace from the index.
 */
export function mergeDictionary(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isDictionaryNode(existing) && isDictionaryNode(value)) {
      const copy: Record<string, unknown> = { ...existing };
      mergeDictionary(copy, value);
      target[key] = copy;
    } else {
      target[key] = value;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Index building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key segments whose strings are never an answer to a search.
 *
 * Failure and machinery copy: read when something breaks, typed never. Left
 * in, they are worse than noise — «не удалось сохранить» appears on forty
 * pages, so a query matching it names forty places the operator did not ask
 * about.
 */
const SKIPPED_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  'a11y',
  'aria',
  'ariaLabel',
  'error',
  'errors',
  'placeholder',
  'placeholders',
  'srOnly',
  'toast',
  'toasts',
  'validation',
]);

/**
 * Key segments that mark a string as the NAME of something.
 *
 * `fields` earns its place: `paymentGateways.fields.*` is the label above
 * every input on the gateway form, which is precisely what an operator means
 * by "a setting". Without it those labels sat at body weight and lost to
 * client-facing message templates that merely mentioned the same words.
 */
const NAMING_SEGMENTS: ReadonlySet<string> = new Set([
  'field',
  'fields',
  'heading',
  'label',
  'labels',
  'name',
  'tab',
  'tabs',
  'title',
  'titles',
]);

/** Key segments that mark explanatory copy sitting under a name. */
const EXPLAINING_SEGMENTS: ReadonlySet<string> = new Set([
  'caption',
  'description',
  'descriptions',
  'help',
  'hint',
  'hints',
  'info',
  'subtitle',
  'summary',
  'tooltip',
]);

const WEIGHT_PAGE = 1.6;
const WEIGHT_NAME = 1;
const WEIGHT_EXPLANATION = 0.72;
const WEIGHT_BODY = 0.5;

/**
 * Subtrees that NAME other parts of the panel instead of belonging to their
 * own page.
 *
 * The roles matrix is the extreme case: `rolesPage.resources.*` is a catalogue
 * of every area the panel has, written out in full («Чёрный список»,
 * «Вебхуки платёжных систем», «Бэкапы»). Weighted like ordinary names, the
 * roles page answers almost every query and outranks the actual screen — it
 * did, measurably, for six of the ten queries this index was first tried on.
 * The strings stay searchable, because "where do I grant access to backups" is
 * a real question; they simply stop outranking backups themselves.
 */
const KEY_WEIGHT_OVERRIDES: ReadonlyArray<readonly [string, number]> = [
  ['rolesPage.resources', 0.22],
  ['rolesPage.actions', 0.22],
  ['rolesPage.groups', 0.22],
  // The branding icon catalogue names client-facing surfaces («Способы
  // оплаты», «Устройства»), none of which are panel pages.
  ['brandingPage.sections.iconColors', 0.3],
];

/**
 * How much of its weight a string keeps when the same text sits on this many
 * different pages.
 *
 * «Настройки», «Аналитика», «Правила» are written on a dozen screens. A query
 * for one of them used to return a column of identical labels differing only
 * in the page underneath; keeping them all at full weight says every one of
 * those pages is equally the answer, which is the same as saying nothing.
 */
const GENERIC_TEXT_PAGE_THRESHOLD = 4;
const GENERIC_TEXT_FACTOR = 0.55;

/**
 * Prose longer than this is indexed but never becomes a result row: a
 * paragraph makes a useless label, and matching one word of it says little
 * about the page. The ceiling is on WORDS, not characters, so a long German
 * compound is not mistaken for an essay.
 */
const MAX_INDEXED_WORDS = 24;

function weightForKey(key: string): number {
  for (const [prefix, weight] of KEY_WEIGHT_OVERRIDES) {
    if (key.startsWith(`${prefix}.`)) return weight;
  }
  const segments = key.split('.');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? '';
    if (NAMING_SEGMENTS.has(segment)) return WEIGHT_NAME;
    if (EXPLAINING_SEGMENTS.has(segment)) return WEIGHT_EXPLANATION;
  }
  return WEIGHT_BODY;
}

/** The page a target belongs to — the route without its `#tab`. */
export function pageOf(path: string): string {
  const hashAt = path.indexOf('#');
  return hashAt > 0 ? path.slice(0, hashAt) : path;
}

function isSkippedKey(key: string): boolean {
  return key.split('.').some((segment) => SKIPPED_KEY_SEGMENTS.has(segment));
}

function flattenDictionary(
  value: unknown,
  prefix: string,
  sink: Array<readonly [string, string]>,
): void {
  if (typeof value === 'string') {
    sink.push([prefix, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenDictionary(item, `${prefix}.${index}`, sink));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    flattenDictionary(childValue, prefix ? `${prefix}.${childKey}` : childKey, sink);
  }
}

/** The page rows: one per sidebar entry and per routable-but-hidden surface. */
function pageEntries(dictionary: Record<string, unknown>): SearchEntryInterface[] {
  const navDictionary = dictionary['adminNav'] as
    | { items?: Record<string, string>; groups?: Record<string, string> }
    | undefined;
  const entries: SearchEntryInterface[] = [];
  for (const { item } of NAV_INDEX) {
    const target = resolveSearchTarget(item.path);
    if (!target) continue;
    const label = navDictionary?.items?.[item.key];
    if (!label) continue;
    entries.push({
      key: '',
      text: label,
      target,
      weight: WEIGHT_PAGE,
      isPage: true,
      aliases: [item.key, item.path],
    });
  }
  return entries;
}

/**
 * Builds the searchable index from a merged dictionary.
 *
 * Exported for the tests, which build it from the real RU dictionary rather
 * than from a fixture: an index that only works on invented data would prove
 * nothing about a query an operator actually types.
 */
export function buildSearchIndex(
  locale: SearchLocale,
  dictionary: Record<string, unknown>,
): SearchIndexInterface {
  const flat: Array<readonly [string, string]> = [];
  flattenDictionary(dictionary, '', flat);

  const entries: SearchEntryInterface[] = pageEntries(dictionary);
  // One row per (page, text). The same sentence often appears under several
  // keys of one page — a tab name and the heading it opens — and showing it
  // twice spends the operator's list on nothing.
  const seen = new Set<string>(entries.map((entry) => `${entry.target.path}||${entry.text}`));

  for (const [key, text] of flat) {
    if (text.length < 2 || isSkippedKey(key)) continue;
    const path = targetPathForKey(key);
    if (!path) continue;
    const target = resolveSearchTarget(path);
    if (!target) continue;
    const normalized = normalizeSearchText(text);
    if (normalized.length < 2) continue;
    if (normalized.split(' ').length > MAX_INDEXED_WORDS) continue;
    const dedupeKey = `${target.path}||${text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entries.push({ key, text, target, weight: weightForKey(key), isPage: false });
  }

  // How many different pages say each thing. Computed from the index itself,
  // so a word that becomes generic next release is discounted next release —
  // no list to maintain.
  const pagesPerText = new Map<string, Set<string>>();
  for (const entry of entries) {
    const bucket = pagesPerText.get(entry.text);
    if (bucket) bucket.add(pageOf(entry.target.path));
    else pagesPerText.set(entry.text, new Set([pageOf(entry.target.path)]));
  }
  const weighted: SearchEntryInterface[] = entries.map((entry) => {
    if (entry.isPage) return entry;
    const spread = pagesPerText.get(entry.text)?.size ?? 1;
    if (spread < GENERIC_TEXT_PAGE_THRESHOLD) return entry;
    return { ...entry, weight: entry.weight * GENERIC_TEXT_FACTOR };
  });

  const entryText: string[] = [];
  const wordToEntries = new Map<string, number[]>();
  weighted.forEach((entry, index) => {
    const normalized = normalizeSearchText(entry.text);
    const words = normalized.length === 0 ? [] : normalized.split(' ');
    entryText.push(normalized);
    const aliasWords = (entry.aliases ?? []).flatMap((alias) => {
      const foldedAlias = normalizeSearchText(alias);
      return foldedAlias.length === 0 ? [] : foldedAlias.split(' ');
    });
    for (const word of new Set([...words, ...aliasWords])) {
      const bucket = wordToEntries.get(word);
      if (bucket) bucket.push(index);
      else wordToEntries.set(word, [index]);
    }
  });

  return {
    locale,
    entries: weighted,
    entryText,
    wordToEntries,
    sortedWords: [...wordToEntries.keys()].sort(),
  };
}

const indexCache = new Map<SearchLocale, SearchIndexInterface>();
const indexPromises = new Map<SearchLocale, Promise<SearchIndexInterface>>();

/** The built index for `locale`, if it is already in memory. */
export function peekSearchIndex(locale: SearchLocale): SearchIndexInterface | null {
  return indexCache.get(locale) ?? null;
}

/**
 * Loads the dictionaries and builds the index, once per locale.
 *
 * Concurrent callers share one promise: the overlay asks on every open, and
 * two opens in quick succession must not fetch twenty chunks twice.
 */
export function ensureSearchIndex(locale: SearchLocale): Promise<SearchIndexInterface> {
  const built = indexCache.get(locale);
  if (built) return Promise.resolve(built);
  const pending = indexPromises.get(locale);
  if (pending) return pending;
  const promise = loadDictionaries(locale)
    .then((dictionary) => {
      const index = buildSearchIndex(locale, dictionary);
      indexCache.set(locale, index);
      return index;
    })
    .finally(() => {
      indexPromises.delete(locale);
    });
  indexPromises.set(locale, promise);
  return promise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Querying
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How well one indexed word answers one typed token, 0 to 1.
 *
 * The ladder is the whole difference between "search that finds things" and
 * `includes()`. Two rungs matter more than they look:
 *
 *  - TOKEN STARTS WITH WORD (0.72) is Russian inflection. The operator types
 *    «платежи», the panel wrote «платёж»; the query is longer than the word,
 *    so a plain prefix test fails in the direction nobody expects.
 *  - SHARED STEM (0.58) catches «списание» against «списания» and
 *    «автосписанием» — same root, different endings on both sides. It needs
 *    five characters of agreement, which is short enough to catch endings and
 *    long enough that «пла» does not unify «платёж» with «планом».
 */
function wordQuality(word: string, token: string): number {
  if (word === token) return 1;
  if (word.startsWith(token)) return 0.9;
  // The word may be at most three characters shorter than what was typed.
  // Without that bound «автосписание» matches the bare «авто» in «авто-расчёт»
  // at inflection strength, and two unrelated pages outrank the one that says
  // «автосписанием».
  if (token.length >= 4 && word.length >= 4 && token.length - word.length <= 3 && token.startsWith(word)) {
    return 0.72;
  }
  if (word.length >= 5 && token.length >= 5 && commonPrefixLength(word, token) >= 5) return 0.58;
  if (token.length >= 3 && word.includes(token)) return 0.45;
  return 0;
}

/** Index of the first word `>= prefix`, by binary search. */
function lowerBound(sortedWords: ReadonlyArray<string>, prefix: string): number {
  let low = 0;
  let high = sortedWords.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sortedWords[middle] ?? '') < prefix) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Hard ceiling on how many distinct words one token may expand to.
 *
 * A two-character token can prefix-match thousands of words; without a cap the
 * cheapest query in the overlay is also the most expensive thing it does. The
 * cap costs nothing in practice — a token that vague is not selecting rows for
 * the operator either way.
 */
const MAX_WORDS_PER_TOKEN = 2500;

/** Every entry that answers one token, with the best quality found for it. */
function matchToken(index: SearchIndexInterface, token: string): Map<number, number> {
  const hits = new Map<number, number>();
  const record = (word: string, quality: number): void => {
    if (quality <= 0) return;
    const bucket = index.wordToEntries.get(word);
    if (!bucket) return;
    for (const entryIndex of bucket) {
      const previous = hits.get(entryIndex) ?? 0;
      if (quality > previous) hits.set(entryIndex, quality);
    }
  };

  // Exact and prefix, straight out of the sorted word list.
  let scanned = 0;
  for (let cursor = lowerBound(index.sortedWords, token); cursor < index.sortedWords.length; cursor += 1) {
    const word = index.sortedWords[cursor] ?? '';
    if (!word.startsWith(token)) break;
    record(word, wordQuality(word, token));
    scanned += 1;
    if (scanned >= MAX_WORDS_PER_TOKEN) break;
  }

  // The inflection rungs and the substring rung need a sweep; it is one pass
  // over the distinct words (~12 000 for RU), which is cheaper than it sounds
  // and only runs for tokens long enough to mean something.
  if (token.length >= 3) {
    for (const word of index.sortedWords) {
      if (word.startsWith(token)) continue;
      const quality = wordQuality(word, token);
      if (quality > 0) record(word, quality);
    }
  }

  if (hits.size > 0) return hits;

  // Nothing at all: the token is probably mistyped. Only now is a fuzzy sweep
  // worth its cost, and only for tokens long enough that an edit does not turn
  // one real word into another.
  const budget = typoBudgetFor(token);
  if (budget === 0) return hits;
  for (const word of index.sortedWords) {
    const distance = editDistanceWithin(word, token, budget);
    if (distance === null) continue;
    record(word, distance === 1 ? 0.36 : 0.28);
  }
  return hits;
}

const PHRASE_BONUS = 0.22;
const HEAD_BONUS = 0.12;
/**
 * What a match costs when the query had to be rewritten to find it.
 *
 * Steep on purpose: a literal match must always win. Without it, typing a
 * short real word starts returning rows that only match its keyboard-layout
 * shadow, and the operator sees nonsense above the thing they typed.
 */
const VARIANT_PENALTY = 0.55;

/**
 * What one rewriting of the query found.
 *
 * Two kinds of answer, because operators ask in two ways. Sometimes the whole
 * query is one label («чёрный список»), and the row that carries it is the
 * answer. Sometimes the query names a thing and the place it lives («вебхуки
 * платежей»), and no single string on the panel says both — the PAGE says
 * both, across its tab name and its title. A search that only did the first
 * kind sends that query to whatever page happens to contain the two words in
 * one sentence, which is how the old overlay answered «вебхуки платежей» with
 * the roles matrix.
 */
interface VariantResultInterface {
  /** Rows whose own text carries every token. */
  readonly entryScores: ReadonlyMap<number, number>;
  /** Pages that carry every token across their rows, and the row to show. */
  readonly pageScores: ReadonlyMap<string, { readonly score: number; readonly entryIndex: number }>;
}

const EMPTY_VARIANT_RESULT: VariantResultInterface = {
  entryScores: new Map(),
  pageScores: new Map(),
};

interface PageCandidateInterface {
  readonly quality: number;
  readonly entryIndex: number;
  readonly weight: number;
}

/**
 * What a page-wide match is worth against a row that says the whole thing
 * itself.
 *
 * Below 1 on purpose, and not far below: one string containing everything the
 * operator typed is the better answer when it exists, but a page that answers
 * across two of its rows is a real answer too, not a consolation.
 */
const PAGE_MATCH_FACTOR = 0.62;

function scoreVariant(index: SearchIndexInterface, variant: string): VariantResultInterface {
  const tokens = variant.split(' ').filter((token) => token.length > 0);
  if (tokens.length === 0) return EMPTY_VARIANT_RESULT;

  const tokenHits = tokens.map((token) => matchToken(index, token));
  // A token nothing in the panel knows sinks the whole query. That is the
  // point of AND: «оплата подписки» must not answer with every row that says
  // «оплата».
  if (tokenHits.some((hits) => hits.size === 0)) return EMPTY_VARIANT_RESULT;

  // ── Rows that carry every token themselves ────────────────────────────────
  let surviving: Map<number, number> | null = null;
  for (const hits of tokenHits) {
    if (surviving === null) {
      surviving = new Map(hits);
      continue;
    }
    const merged = new Map<number, number>();
    for (const [entryIndex, quality] of hits) {
      const carried = surviving.get(entryIndex);
      if (carried === undefined) continue;
      merged.set(entryIndex, carried + quality);
    }
    surviving = merged;
    if (surviving.size === 0) break;
  }

  const entryScores = new Map<number, number>();
  for (const [entryIndex, qualitySum] of surviving ?? []) {
    const entry = index.entries[entryIndex];
    if (!entry) continue;
    let score = (qualitySum / tokens.length) * entry.weight;
    const text = index.entryText[entryIndex] ?? '';
    // Word ORDER is never required — that is the difference from a substring
    // match, and it is what lets an operator type two remembered words in
    // whichever order they come to mind. Getting the order right is merely
    // rewarded.
    if (tokens.length > 1 && text.includes(variant)) score += PHRASE_BONUS;
    if (text.startsWith(tokens[0] ?? '')) score += HEAD_BONUS;
    entryScores.set(entryIndex, score);
  }

  // ── Pages that carry every token across their rows ────────────────────────
  const pageScores = new Map<string, { score: number; entryIndex: number }>();
  if (tokens.length < 2) return { entryScores, pageScores };

  const perTokenPages = tokenHits.map((hits) => {
    const best = new Map<string, PageCandidateInterface>();
    for (const [entryIndex, quality] of hits) {
      const entry = index.entries[entryIndex];
      if (!entry) continue;
      const page = pageOf(entry.target.path);
      const current = best.get(page);
      if (current && current.quality * current.weight >= quality * entry.weight) continue;
      best.set(page, { quality, entryIndex, weight: entry.weight });
    }
    return best;
  });

  const [firstToken, ...restTokens] = perTokenPages;
  for (const [page, first] of firstToken ?? []) {
    let qualitySum = first.quality;
    let bestWeight = first.weight;
    let display = first;
    let complete = true;
    for (const tokenPages of restTokens) {
      const hit = tokenPages.get(page);
      if (!hit) {
        complete = false;
        break;
      }
      qualitySum += hit.quality;
      if (hit.weight > bestWeight) bestWeight = hit.weight;
      // The row shown is the strongest of the ones that answered — which is
      // usually the most specific, so «вебхуки платежей» opens the Webhooks
      // tab rather than the Payments page the title matched.
      if (hit.quality * hit.weight > display.quality * display.weight) display = hit;
    }
    if (!complete) continue;
    pageScores.set(page, {
      score: (qualitySum / tokens.length) * bestWeight * PAGE_MATCH_FACTOR,
      entryIndex: display.entryIndex,
    });
  }

  return { entryScores, pageScores };
}

export interface QueryOptionsInterface {
  /** Rows to return. */
  readonly limit: number;
  /** Rows one PAGE may contribute, counting its tabs. */
  readonly perPageLimit?: number;
}

/**
 * Ranked hits for a query.
 *
 * Results are capped per page (`perPageLimit`) before the overall cut: one
 * settings page can carry forty strings that all match, and a list showing
 * forty rows from one page while nine other pages wait behind them is a worse
 * answer than ten pages with their best line each. The page's own row never
 * counts against that budget — losing the page because its settings matched
 * first is the one substitution an operator never wants.
 */
export function queryIndex(
  index: SearchIndexInterface,
  rawQuery: string,
  options: QueryOptionsInterface,
): SearchHitInterface[] {
  const variants = searchQueryVariants(rawQuery);
  if (variants.length === 0) return [];

  const best = new Map<number, number>();
  const keepBest = (entryIndex: number, score: number): void => {
    const previous = best.get(entryIndex) ?? 0;
    if (score > previous) best.set(entryIndex, score);
  };
  variants.forEach((variant, variantIndex) => {
    const penalty = variantIndex === 0 ? 1 : VARIANT_PENALTY;
    const { entryScores, pageScores } = scoreVariant(index, variant);
    for (const [entryIndex, score] of entryScores) keepBest(entryIndex, score * penalty);
    // A page-wide answer promotes the row it chose, so both kinds of match
    // compete in one ranking instead of being stitched together afterwards.
    for (const { score, entryIndex } of pageScores.values()) keepBest(entryIndex, score * penalty);
  });

  const ranked = [...best]
    .map(([entryIndex, score]): SearchHitInterface | null => {
      const entry = index.entries[entryIndex];
      return entry ? { entry, score } : null;
    })
    .filter((hit): hit is SearchHitInterface => hit !== null)
    // Ties broken by the shorter text: «Вебхуки» before «Журнал вебхуков за
    // последние 30 дней», which is what an operator scanning a list expects.
    .sort((a, b) => b.score - a.score || a.entry.text.length - b.entry.text.length);

  const perPageLimit = options.perPageLimit ?? 2;
  const perPage = new Map<string, number>();
  const picked: SearchHitInterface[] = [];
  for (const hit of ranked) {
    if (picked.length >= options.limit) break;
    if (hit.entry.isPage) {
      picked.push(hit);
      continue;
    }
    const page = pageOf(hit.entry.target.path);
    const used = perPage.get(page) ?? 0;
    if (used >= perPageLimit) continue;
    perPage.set(page, used + 1);
    picked.push(hit);
  }
  return picked;
}
