import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Search, User, CreditCard, Tag, Handshake, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { expectArray } from '@/lib/api-utils';
import { cn } from '@/lib/utils';
import { flashTextOnPage } from '@/lib/flash-on-page';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { motion, AnimatePresence } from '@/lib/motion';
import { canShowNavItem } from '@/components/layout/admin-nav-config';
import { usePermissionStore } from '@/features/rbac';
import { paymentHref } from '@/features/payments/payments-filters';
import { highlightRanges, searchQueryVariants } from './search-text';
// Types only — see the dynamic import inside the component. The engine and the
// twenty dictionaries it reads must not enter this file's static graph.
import type { SearchHitInterface, SearchIndexInterface, SearchLocale } from './search-engine';

/** What the backend's `/admin/quick-search` answers with. */
interface DataHitInterface {
  readonly type: 'user' | 'subscription' | 'transaction' | 'promocode' | 'partner';
  readonly id: string;
  readonly label: string;
  readonly subtitle?: string;
}

const TYPE_META: Record<
  DataHitInterface['type'],
  { icon: React.ElementType; color: string; route: (id: string) => string }
> = {
  user: { icon: User, color: 'text-blue-500', route: (id) => `/users/${id}` },
  subscription: { icon: CreditCard, color: 'text-green-500', route: (_id) => `/subscriptions` },
  // The hit's id is the payment's `paymentId` (quick-search.service.ts). It
  // opens THAT payment's details; the bare `/payments` it used to open left the
  // operator to find it again in the full ledger.
  transaction: { icon: CreditCard, color: 'text-yellow-500', route: (id) => paymentHref(id) },
  promocode: { icon: Tag, color: 'text-purple-500', route: (_id) => `/promocodes` },
  partner: { icon: Handshake, color: 'text-orange-500', route: (_id) => `/partners` },
};

async function fetchSearch(q: string): Promise<DataHitInterface[]> {
  if (q.length < 2) return [];
  const res = await api.get('/admin/quick-search', { params: { q, limit: 12 } });
  return expectArray<DataHitInterface>(res.data);
}

/** Module-level constants so their identity is stable across renders. */
const EMPTY_DATA_HITS: DataHitInterface[] = [];
const EMPTY_LOCAL_HITS: SearchHitInterface[] = [];

/**
 * Asked of the engine, then cut to `LOCAL_ROWS` after the permission filter.
 *
 * Two numbers, not one, because filtering after the cut is how a role with
 * three permissions ends up staring at an empty overlay while the panel holds
 * a perfectly good answer it was never asked for.
 */
const LOCAL_CANDIDATES = 24;
const LOCAL_ROWS = 8;

type SearchEngineModule = typeof import('./search-engine');

interface LoadedEngineInterface {
  readonly module: SearchEngineModule;
  readonly index: SearchIndexInterface;
}

type RowInterface =
  | { readonly kind: 'place'; readonly hit: SearchHitInterface }
  | { readonly kind: 'data'; readonly hit: DataHitInterface };

/** Interpolation placeholders are i18next machinery; an operator reads a gap. */
function displayText(value: string): string {
  return value
    .replace(/\{\{[^}]*\}\}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The part of a row's text that will be on the page verbatim.
 *
 * A string with `{{count}}` in it renders with a NUMBER there, so searching
 * the page for the string as written finds nothing. The longest run of
 * literal words between placeholders is what both the dictionary and the
 * rendered page agree on.
 */
function flashNeedle(value: string): string {
  return value
    .split(/\{\{[^}]*\}\}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .reduce((longest, part) => (part.length > longest.length ? part : longest), '');
}

/** The query's own words, marked inside a row so the match is visible. */
function Highlighted({
  text,
  tokens,
}: {
  readonly text: string;
  readonly tokens: ReadonlyArray<string>;
}): ReactNode {
  const ranges = highlightRanges(text, tokens);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={`${start}-${end}-${index}`} className="bg-transparent text-primary font-semibold">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

interface QuickSearchOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function QuickSearchOverlay({ open, onClose }: QuickSearchOverlayProps) {
  const { t, i18n: runtime } = useTranslation();
  // Read off `useTranslation`, not off the i18next singleton: importing that
  // module here would pull `initReactI18next` into every test that mocks
  // react-i18next, and it makes the index follow a language switch for free.
  const locale: SearchLocale =
    (runtime as { language?: string } | undefined)?.language?.startsWith('ru') === true
      ? 'ru'
      : 'en';
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const permissionsLoaded = usePermissionStore((s) => s.loaded);
  const hasPermission = usePermissionStore((s) => s.hasPermission);

  // Everything downstream gates on the TRIMMED query, never on the raw input.
  // Gating on `query.length` meant two spaces counted as a two-character query:
  // it fired a request, the backend trimmed it back to nothing and answered
  // `[]`, and the overlay rendered "No results for '  '" — an operator reading
  // that concludes search is broken. Keying the cache on the trimmed value also
  // collapses "ada" and "ada " into one entry instead of two round-trips.
  const trimmedQuery = query.trim();
  const { data, isFetching } = useQuery({
    queryKey: ['quick-search', trimmedQuery],
    queryFn: () => fetchSearch(trimmedQuery),
    enabled: trimmedQuery.length >= 2,
    staleTime: 10_000,
  });
  // Stable empty-array reference: TanStack returns `undefined` while
  // the query is idle/loading, but if we use `data: results = []` the
  // destructure default produces a NEW array literal on every render
  // and breaks the `prevRows` identity check below — that drove an
  // infinite render loop and the React error #301 we were chasing.
  const dataHits: DataHitInterface[] = data ?? EMPTY_DATA_HITS;

  /**
   * The panel's own index: every page, tab and setting, by the words written
   * on them.
   *
   * Loaded on first open rather than with the app. The dictionaries are ~600 KB
   * of lazy chunks that the login route must never pull, and nothing here is
   * needed until somebody actually searches. The cost lands once, on a
   * deliberate action, and warms the very chunks the pages it finds will want.
   */
  const [engine, setEngine] = useState<LoadedEngineInterface | null>(null);
  const [indexFailed, setIndexFailed] = useState(false);
  const ready = engine !== null && engine.index.locale === locale;
  // Derived, never stored. A separate `indexing` flag has to be cleared by the
  // same effect that set it, and this effect re-runs the moment the index
  // lands — the cleanup then cancels the clearing, and the overlay says "still
  // reading the pages" over a finished index, for as long as it is open.
  const indexing = !ready && !indexFailed;
  useEffect(() => {
    if (!open || ready) return;
    let cancelled = false;
    void import('./search-engine')
      .then(async (module) => {
        const index = await module.ensureSearchIndex(locale);
        if (!cancelled) setEngine({ module, index });
      })
      .catch((error: unknown) => {
        // Search over the operator's data still works; only the page index is
        // missing. Failing loudly here would replace a degraded overlay with
        // no overlay at all.
        console.warn('[quick-search] page index unavailable:', error);
        if (!cancelled) setIndexFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, ready, locale]);

  /**
   * Pages, tabs and settings, gated by the same permission as the sidebar row
   * that owns them: a result an operator cannot open is worse than no result.
   */
  const localHits = useMemo<SearchHitInterface[]>(() => {
    if (engine === null || !ready || trimmedQuery.length < 2) return EMPTY_LOCAL_HITS;
    const hits = engine.module
      .queryIndex(engine.index, trimmedQuery, { limit: LOCAL_CANDIDATES })
      .filter((hit) => canShowNavItem(hit.entry.target.nav, permissionsLoaded, hasPermission))
      .slice(0, LOCAL_ROWS);
    return hits.length === 0 ? EMPTY_LOCAL_HITS : hits;
  }, [engine, ready, trimmedQuery, permissionsLoaded, hasPermission]);

  const rows = useMemo<RowInterface[]>(
    () => [
      ...localHits.map((hit): RowInterface => ({ kind: 'place', hit })),
      ...dataHits.map((hit): RowInterface => ({ kind: 'data', hit })),
    ],
    [localHits, dataHits],
  );

  const highlightTokens = useMemo<string[]>(() => {
    const [primary] = searchQueryVariants(trimmedQuery);
    return primary === undefined ? [] : primary.split(' ');
  }, [trimmedQuery]);

  // Reset state when the overlay (re)opens. Uses the
  // "store-prev-prop in render" pattern.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }
  // Focus input shortly after the overlay opens (DOM must be mounted first).
  useEffect(() => {
    if (!open) return;
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(focusTimer);
  }, [open]);

  // Reset selection when the rows array identity changes.
  const [prevRows, setPrevRows] = useState<RowInterface[]>(rows);
  if (rows !== prevRows) {
    setPrevRows(rows);
    setSelectedIndex(0);
  }

  const handleSelect = useCallback(
    (row: RowInterface) => {
      if (row.kind === 'data') {
        navigate(TYPE_META[row.hit.type].route(row.hit.id));
        onClose();
        return;
      }
      const { entry } = row.hit;
      navigate(entry.target.path);
      // A page row has arrived where it was going. A SETTING row has not: the
      // page it named can be forty fields long, so the control itself is
      // marked once the page renders.
      if (!entry.isPage) flashTextOnPage(flashNeedle(entry.text));
      onClose();
    },
    [navigate, onClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[selectedIndex];
      if (row) handleSelect(row);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  /** Where a hit lives, in words: the page, and the tab inside it. */
  const placeSubtitle = (hit: SearchHitInterface): string => {
    const { target } = hit.entry;
    if (hit.entry.isPage) {
      return `${t(`adminNav.groups.${target.groupKey}`)} · ${target.path}`;
    }
    const place = t(target.labelKey);
    return target.parentLabelKey === null ? place : `${t(target.parentLabelKey)} → ${place}`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="overflow-hidden p-0 shadow-2xl max-w-xl"
        aria-label={t('quickSearchOverlay.aria')}
      >
        {/* Search input */}
        <div className="flex items-center border-b px-4 py-3 gap-3">
          {isFetching || indexing ? (
            <Loader2 className="h-4 w-4 shrink-0 text-muted-foreground animate-spin" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('quickSearchOverlay.placeholder')}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label={t('quickSearchOverlay.clearAria')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Results */}
        {/*
          Four empty-looking states, four distinct renders. They used to
          collapse into two: while the first request was in flight
          `results.length === 0 && !isFetching` was false, so the branch below
          rendered an EMPTY `<ul>` — a blank panel with no message at all. The
          operator saw nothing for "too short", nothing for "loading" and a
          sentence only for "no results", and read all three as a dead feature.
          Each state now says which one it is, and the order matters: too-short
          wins over loading (the query is disabled, so nothing is loading),
          loading wins over empty (no answer yet is not the same as no rows),
          and the page index reading itself in says so rather than borrowing
          the network's wording.
        */}
        {/* Readiness is stated, not inferred. The page index arrives
            asynchronously, so "the row is not here" is ambiguous until it has
            landed — and a test that asserts absence before then passes for the
            wrong reason. */}
        <div
          className="max-h-96 overflow-y-auto"
          data-search-index={ready ? 'ready' : 'loading'}
        >
          {/*
            No `exit` animation, and no `mode="wait"`.

            Both were here, and both are wrong for a panel that swaps states
            while the operator is still typing. `mode="wait"` holds the next
            state until the previous one has finished fading out, so the
            results list waited on the spinner — and with the page index
            loading asynchronously the overlay reached results through TWO
            swaps and could sit on the spinner indefinitely. An exit animation
            alone still leaves the old state mounted on top of the new one,
            which is how «Идёт поиск…» and «Нет результатов» ended up on
            screen together. Entering fades stay; leaving is instant.
          */}
          <AnimatePresence initial={false}>
            {trimmedQuery.length < 2 ? (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center gap-2 py-10 text-muted-foreground text-sm"
              >
                <Search className="h-8 w-8 opacity-20" />
                <p>{t('quickSearchOverlay.typeMore')}</p>
              </motion.div>
            ) : rows.length === 0 && (isFetching || indexing) ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center gap-2 py-10 text-muted-foreground text-sm"
              >
                <Loader2 className="h-8 w-8 opacity-20 animate-spin" />
                <p>
                  {indexing
                    ? t('quickSearchOverlay.indexing')
                    : t('quickSearchOverlay.searching')}
                </p>
              </motion.div>
            ) : rows.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center gap-2 py-10 text-muted-foreground text-sm"
              >
                <p>{t('quickSearchOverlay.noResults', { query: trimmedQuery })}</p>
              </motion.div>
            ) : (
              <motion.ul
                key="results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="py-1"
              >
                {rows.map((row, index) => {
                  const previous = rows[index - 1];
                  const startsGroup = previous === undefined || previous.kind !== row.kind;
                  const label =
                    row.kind === 'place'
                      ? displayText(
                          row.hit.entry.isPage
                            ? t(row.hit.entry.target.labelKey)
                            : row.hit.entry.text,
                        )
                      : row.hit.label;
                  const subtitle =
                    row.kind === 'place' ? placeSubtitle(row.hit) : row.hit.subtitle;
                  const meta = row.kind === 'data' ? TYPE_META[row.hit.type] : null;
                  const IconComponent = (
                    row.kind === 'place' ? row.hit.entry.target.nav.icon : meta?.icon
                  ) as ComponentType<SVGProps<SVGSVGElement>>;
                  const badge =
                    row.kind === 'data'
                      ? row.hit.type
                      : row.hit.entry.isPage
                        ? 'navigation'
                        : 'setting';
                  const key =
                    row.kind === 'place'
                      ? `place-${row.hit.entry.target.path}-${row.hit.entry.key}`
                      : `data-${row.hit.type}-${row.hit.id}`;
                  return (
                    <li key={key}>
                      {startsGroup && (
                        <p className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t(
                            row.kind === 'place'
                              ? 'quickSearchOverlay.groups.places'
                              : 'quickSearchOverlay.groups.data',
                          )}
                        </p>
                      )}
                      <button
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                          index === selectedIndex
                            ? 'bg-accent text-accent-foreground'
                            : 'hover:bg-accent/50',
                        )}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => handleSelect(row)}
                      >
                        <IconComponent
                          className={cn('h-4 w-4 shrink-0', meta?.color ?? 'text-cyan-500')}
                        />
                        {/* `title` on both lines: they are `truncate`d, and a
                            setting's label is exactly the kind of long string
                            that gets cut — the operator can read the rest by
                            hovering instead of opening the page to find out. */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" title={label}>
                            {row.kind === 'place' ? (
                              <Highlighted text={label} tokens={highlightTokens} />
                            ) : (
                              label
                            )}
                          </p>
                          {subtitle && (
                            <p
                              className="text-xs text-muted-foreground truncate"
                              title={subtitle}
                            >
                              {subtitle}
                            </p>
                          )}
                        </div>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {/* All seven, not just the local ones: the data hits
                              rendered the raw wire value, so an English badge
                              sat beside a Russian one in the same list. */}
                          {t(`quickSearchOverlay.types.${badge}`, { defaultValue: badge })}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>

        {/* Footer hint */}
        <div className="border-t px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span><kbd className="font-mono bg-muted px-1 rounded">↑↓</kbd> {t('quickSearchOverlay.footer.navigate')}</span>
          <span><kbd className="font-mono bg-muted px-1 rounded">↵</kbd> {t('quickSearchOverlay.footer.open')}</span>
          <span><kbd className="font-mono bg-muted px-1 rounded">Esc</kbd> {t('quickSearchOverlay.footer.close')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
