import { useEffect, useRef, useState, useCallback } from 'react';
import type { ComponentType, SVGProps } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Search, User, CreditCard, Tag, Handshake, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { motion, AnimatePresence } from '@/lib/motion';

interface SearchResult {
  type: 'user' | 'subscription' | 'transaction' | 'promocode' | 'partner';
  id: string;
  label: string;
  subtitle?: string;
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
};

async function fetchSearch(q: string): Promise<SearchResult[]> {
  if (q.length < 2) return [];
  const res = await api.get<SearchResult[]>('/admin/quick-search', { params: { q, limit: 12 } });
  return res.data;
}

/** Module-level constant so its identity is stable across renders. */
const EMPTY_RESULTS: SearchResult[] = [];

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
  const results: SearchResult[] = data ?? EMPTY_RESULTS;

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
      const meta = TYPE_META[result.type];
      navigate(meta.route(result.id));
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
                  const Icon = meta.icon as ComponentType<SVGProps<SVGSVGElement>>;
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
                        <Icon className={cn('h-4 w-4 shrink-0', meta.color)} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{result.label}</p>
                          {result.subtitle && (
                            <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                          )}
                        </div>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {result.type}
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
