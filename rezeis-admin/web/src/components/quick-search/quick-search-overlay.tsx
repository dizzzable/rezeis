import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ComponentType, SVGProps } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Search, User, CreditCard, Tag, Handshake, Compass, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { motion, AnimatePresence } from '@/lib/motion';
import { navGroups, type NavItem } from '@/components/layout/admin-nav-config';

interface SearchResult {
  type: 'user' | 'subscription' | 'transaction' | 'promocode' | 'partner' | 'navigation';
  id: string;
  label: string;
  subtitle?: string;
  /** For `type: 'navigation'` only — overrides `TYPE_META.route(id)`. */
  to?: string;
  /** For `type: 'navigation'` only — replaces the default Compass icon. */
  icon?: React.ElementType;
}

const TYPE_META: Record<
  SearchResult['type'],
  { icon: React.ElementType; color: string; route: (id: string) => string }
> = {
  user: { icon: User, color: 'text-blue-500', route: (id) => `/users/${id}` },
  subscription: { icon: CreditCard, color: 'text-green-500', route: (_id) => `/subscriptions` },
  transaction: { icon: CreditCard, color: 'text-yellow-500', route: (_id) => `/payments` },
  promocode: { icon: Tag, color: 'text-purple-500', route: (_id) => `/promocodes` },
  partner: { icon: Handshake, color: 'text-orange-500', route: (_id) => `/partners` },
  // `navigation` rows always carry their own `to`; the route() is a safe
  // fallback so the lookup table stays exhaustive.
  navigation: { icon: Compass, color: 'text-cyan-500', route: (id) => id },
};

async function fetchSearch(q: string): Promise<SearchResult[]> {
  if (q.length < 2) return [];
  const res = await api.get<SearchResult[]>('/admin/quick-search', { params: { q, limit: 12 } });
  return res.data;
}

/** Module-level constant so its identity is stable across renders. */
const EMPTY_RESULTS: SearchResult[] = [];

/**
 * Flat navigation index used by the overlay to surface page jumps
 * alongside data hits. Group key is included as a hint shown in the
 * row subtitle so two pages with the same English label (rare) are
 * still distinguishable.
 */
interface NavIndexEntry {
  readonly item: NavItem;
  readonly groupKey: string;
}
const NAV_INDEX: ReadonlyArray<NavIndexEntry> = navGroups.flatMap((group) =>
  group.items.map((item) => ({ item, groupKey: group.key })),
);
/** Hard cap on navigation hits so they never crowd out data results. */
const NAV_HITS_CAP = 6;

interface QuickSearchOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function QuickSearchOverlay({ open, onClose }: QuickSearchOverlayProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const { data, isFetching } = useQuery({
    queryKey: ['quick-search', query],
    queryFn: () => fetchSearch(query),
    enabled: query.length >= 2,
    staleTime: 10_000,
  });
  // Stable empty-array reference: TanStack returns `undefined` while
  // the query is idle/loading, but if we use `data: results = []` the
  // destructure default produces a NEW array literal on every render
  // and breaks the `prevResults` identity check below — that drove an
  // infinite render loop and the React error #301 we were chasing.
  const dataResults: SearchResult[] = data ?? EMPTY_RESULTS;

  // Page-jump hits are computed locally — no roundtrip needed. We match
  // against the localised label (`adminNav.items.<key>`), the path, and
  // the raw key. Resolved labels go through `t()` so RU and EN both work.
  const navResults = useMemo<SearchResult[]>(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length < 2) return EMPTY_RESULTS;
    const hits: SearchResult[] = [];
    for (const { item, groupKey } of NAV_INDEX) {
      const itemLabel = t(`adminNav.items.${item.key}`);
      const groupLabel = t(`adminNav.groups.${groupKey}`);
      const haystacks = [item.key.toLowerCase(), item.path.toLowerCase(), itemLabel.toLowerCase()];
      const matches = haystacks.some((h) => h.includes(trimmed));
      if (!matches) continue;
      hits.push({
        type: 'navigation',
        id: item.path,
        to: item.path,
        icon: item.icon,
        label: itemLabel,
        subtitle: `${groupLabel} · ${item.path}`,
      });
      if (hits.length >= NAV_HITS_CAP) break;
    }
    return hits;
  }, [query, t]);

  // Navigation always wins the top of the list — Cmd+K should feel like
  // Linear/Spotlight: type the page name, hit Enter, and you're there.
  const results = useMemo<SearchResult[]>(() => {
    if (navResults.length === 0) return dataResults;
    return [...navResults, ...dataResults];
  }, [navResults, dataResults]);

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

  // Reset selection when the results array identity changes.
  const [prevResults, setPrevResults] = useState<SearchResult[]>(results);
  if (results !== prevResults) {
    setPrevResults(results);
    setSelectedIndex(0);
  }

  const handleSelect = useCallback(
    (result: SearchResult) => {
      const target = result.to ?? TYPE_META[result.type].route(result.id);
      navigate(target);
      onClose();
    },
    [navigate, onClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) handleSelect(results[selectedIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="overflow-hidden p-0 shadow-2xl max-w-xl"
        aria-label={t('quickSearchOverlay.aria')}
      >
        {/* Search input */}
        <div className="flex items-center border-b px-4 py-3 gap-3">
          {isFetching ? (
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
        <div className="max-h-80 overflow-y-auto">
          <AnimatePresence mode="wait">
            {query.length < 2 ? (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-2 py-10 text-muted-foreground text-sm"
              >
                <Search className="h-8 w-8 opacity-20" />
                <p>{t('quickSearchOverlay.typeMore')}</p>
              </motion.div>
            ) : results.length === 0 && !isFetching ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-2 py-10 text-muted-foreground text-sm"
              >
                <p>{t('quickSearchOverlay.noResults', { query })}</p>
              </motion.div>
            ) : (
              <motion.ul
                key="results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-1"
              >
                {results.map((result, index) => {
                  const meta = TYPE_META[result.type];
                  const IconComponent = (result.icon ?? meta.icon) as ComponentType<SVGProps<SVGSVGElement>>;
                  return (
                    <li key={`${result.type}-${result.id}`}>
                      <button
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                          index === selectedIndex
                            ? 'bg-accent text-accent-foreground'
                            : 'hover:bg-accent/50',
                        )}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => handleSelect(result)}
                      >
                        <IconComponent className={cn('h-4 w-4 shrink-0', meta.color)} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{result.label}</p>
                          {result.subtitle && (
                            <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                          )}
                        </div>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {result.type === 'navigation'
                            ? t('quickSearchOverlay.types.navigation')
                            : result.type}
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
