/**
 * Fraud signals dashboard.
 *
 * Shows aggregate counters at the top, then a filterable / cursor-paginated
 * list of signals. Each row can be drilled into for the full metadata
 * payload, and operators can transition a signal through Acknowledge /
 * Resolve / Dismiss with an optional note.
 *
 * Real-time updates piggyback on the global `useRealtimeUpdates` hook —
 * `fraud.signal_transitioned` and `system.error` events invalidate the
 * `['admin', 'fraud', 'signals']` and `['admin', 'fraud', 'stats']`
 * queries automatically.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Filter,
  Loader2,
  PlayCircle,
  ShieldAlert,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CountUp } from '@/components/CountUp';
import { SavedFiltersBar } from '@/components/SavedFiltersBar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime, cn } from '@/lib/utils';
import {
  type FraudSignal,
  type FraudStatus,
  type FraudSeverity,
  type ListFraudSignalsParams,
  getFraudStats,
  listFraudSignals,
  runFraudDetectors,
  transitionFraudSignal,
} from './fraud-api';

const STATS_KEY = ['admin', 'fraud', 'stats'] as const;

function severityVariant(s: FraudSeverity): 'destructive' | 'warning' | 'secondary' {
  if (s === 'HIGH') return 'destructive';
  if (s === 'MEDIUM') return 'warning';
  return 'secondary';
}

function statusVariant(s: FraudStatus): 'destructive' | 'warning' | 'success' | 'secondary' {
  switch (s) {
    case 'OPEN':
      return 'destructive';
    case 'ACKNOWLEDGED':
      return 'warning';
    case 'RESOLVED':
      return 'success';
    case 'DISMISSED':
      return 'secondary';
  }
}

export default function FraudSignalsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<FraudStatus | ''>('');
  const [severityFilter, setSeverityFilter] = useState<FraudSeverity | ''>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [transitionTarget, setTransitionTarget] = useState<FraudSignal | null>(null);

  const params: ListFraudSignalsParams = { limit: 50 };
  if (statusFilter) params.status = statusFilter;
  if (severityFilter) params.severity = severityFilter;
  if (cursor) params.cursor = cursor;

  const signalsQuery = useQuery({
    queryKey: ['admin', 'fraud', 'signals', params],
    queryFn: () => listFraudSignals(params),
  });

  const statsQuery = useQuery({
    queryKey: STATS_KEY,
    queryFn: getFraudStats,
  });

  const runDetectorsMutation = useMutation({
    mutationFn: runFraudDetectors,
    onSuccess: (data) => {
      toast.success(t('fraudPage.toast.detectorsFinished', { count: data.processed }));
      queryClient.invalidateQueries({ queryKey: ['admin', 'fraud'] });
    },
    onError: (err) => toast.error(t('fraudPage.toast.detectorsFailed', { message: (err as Error).message })),
  });

  function clearFilters(): void {
    setStatusFilter('');
    setSeverityFilter('');
    setCursor(undefined);
    setCursorStack([]);
  }

  function nextPage(): void {
    if (signalsQuery.data?.nextCursor) {
      setCursorStack((prev) => [...prev, cursor ?? '']);
      setCursor(signalsQuery.data.nextCursor);
    }
  }

  function prevPage(): void {
    const last = cursorStack[cursorStack.length - 1];
    setCursorStack((c) => c.slice(0, -1));
    setCursor(last || undefined);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldAlert className="h-6 w-6" />
            {t('fraudPage.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('fraudPage.subtitle')}
          </p>
        </div>
        <Button
          onClick={() => runDetectorsMutation.mutate()}
          disabled={runDetectorsMutation.isPending}
          variant="outline"
        >
          {runDetectorsMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <PlayCircle className="mr-2 h-4 w-4" />
          )}
          {t('fraudPage.runDetectors')}
        </Button>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label={t('fraudPage.stats.open')} value={statsQuery.data?.open} severity="HIGH" />
        <StatCard label={t('fraudPage.stats.acknowledged')} value={statsQuery.data?.acknowledged} severity="MEDIUM" />
        <StatCard label={t('fraudPage.stats.resolved')} value={statsQuery.data?.resolved} severity="LOW" muted />
        <StatCard label={t('fraudPage.stats.dismissed')} value={statsQuery.data?.dismissed} severity="LOW" muted />
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{t('fraudPage.filters.title')}</CardTitle>
            <SavedFiltersBar<{ status: FraudStatus | ''; severity: FraudSeverity | '' }>
              pageKey="fraud"
              current={{ status: statusFilter, severity: severityFilter }}
              onLoad={(value) => {
                setStatusFilter(value.status ?? '');
                setSeverityFilter(value.severity ?? '');
                setCursor(undefined);
                setCursorStack([]);
              }}
            />
            {(statusFilter || severityFilter) && (
              <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={clearFilters}>
                <X className="h-3 w-3" />
                {t('fraudPage.filters.clear')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <Select
            value={statusFilter || 'all'}
            onValueChange={(v) => {
              setStatusFilter(v === 'all' ? '' : (v as FraudStatus));
              setCursor(undefined);
              setCursorStack([]);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('fraudPage.filters.statusPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('fraudPage.filters.allStatuses')}</SelectItem>
              <SelectItem value="OPEN">{t('fraudPage.statuses.OPEN')}</SelectItem>
              <SelectItem value="ACKNOWLEDGED">{t('fraudPage.statuses.ACKNOWLEDGED')}</SelectItem>
              <SelectItem value="RESOLVED">{t('fraudPage.statuses.RESOLVED')}</SelectItem>
              <SelectItem value="DISMISSED">{t('fraudPage.statuses.DISMISSED')}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={severityFilter || 'all'}
            onValueChange={(v) => {
              setSeverityFilter(v === 'all' ? '' : (v as FraudSeverity));
              setCursor(undefined);
              setCursorStack([]);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('fraudPage.filters.severityPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('fraudPage.filters.allSeverities')}</SelectItem>
              <SelectItem value="HIGH">{t('fraudPage.severities.HIGH')}</SelectItem>
              <SelectItem value="MEDIUM">{t('fraudPage.severities.MEDIUM')}</SelectItem>
              <SelectItem value="LOW">{t('fraudPage.severities.LOW')}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t('fraudPage.table.title')}</CardTitle>
          <CardDescription>
            {signalsQuery.data ? t('fraudPage.table.pageInfo', { count: signalsQuery.data.items.length }) : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {signalsQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, idx) => (
                <Skeleton key={idx} className="h-14 w-full" />
              ))}
            </div>
          ) : signalsQuery.error ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('fraudPage.errors.title')}</AlertTitle>
              <AlertDescription>{t('fraudPage.errors.loadSignals')}</AlertDescription>
            </Alert>
          ) : !signalsQuery.data || signalsQuery.data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <ShieldAlert className="h-10 w-10 opacity-30" />
              <p>{t('fraudPage.table.empty')}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">{t('fraudPage.table.columns.detected')}</TableHead>
                    <TableHead>{t('fraudPage.table.columns.signal')}</TableHead>
                    <TableHead className="w-24">{t('fraudPage.table.columns.severity')}</TableHead>
                    <TableHead className="w-24">{t('fraudPage.table.columns.status')}</TableHead>
                    <TableHead className="w-20 text-right">{t('fraudPage.table.columns.score')}</TableHead>
                    <TableHead className="w-20 text-right">{t('fraudPage.table.columns.confidence')}</TableHead>
                    <TableHead className="w-24">{t('fraudPage.table.columns.affected')}</TableHead>
                    <TableHead className="w-32 text-right">{t('fraudPage.table.columns.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signalsQuery.data.items.map((signal) => (
                    <SignalRow
                      key={signal.id}
                      signal={signal}
                      onTransition={(s) => setTransitionTarget(s)}
                    />
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between mt-4">
                <Button variant="outline" size="sm" onClick={prevPage} disabled={cursorStack.length === 0}>
                  {t('fraudPage.pagination.previous')}
                </Button>
                <span className="text-xs text-muted-foreground">{t('fraudPage.pagination.page', { number: cursorStack.length + 1 })}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={nextPage}
                  disabled={!signalsQuery.data.nextCursor}
                >
                  {t('fraudPage.pagination.next')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <TransitionDialog
        signal={transitionTarget}
        onClose={() => setTransitionTarget(null)}
      />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  severity,
  muted = false,
}: {
  label: string;
  value: number | undefined;
  severity: FraudSeverity;
  muted?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="pt-4">
        <p className={`text-2xl font-bold ${muted ? 'text-muted-foreground' : ''}`}>
          {value === undefined ? <Loader2 className="h-5 w-5 animate-spin" /> : <CountUp value={value} />}
        </p>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
          {label}
          <Badge variant={severityVariant(severity)} className="text-[10px]">
            {String(t(`fraudPage.severities.${severity}`, severity))}
          </Badge>
        </p>
      </CardContent>
    </Card>
  );
}

function SignalRow({
  signal,
  onTransition,
}: {
  signal: FraudSignal;
  onTransition: (s: FraudSignal) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDateTime(signal.detectedAt)}
        </TableCell>
        <TableCell>
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <button className="text-left flex items-start gap-1.5 group">
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 mt-1 text-muted-foreground transition-transform duration-200 ease-out',
                    open ? 'rotate-0' : '-rotate-90',
                  )}
                  aria-hidden
                />
                <div>
                  <div className="font-medium text-sm">{signal.title}</div>
                  <code className="text-[10px] text-muted-foreground">{signal.code}</code>
                </div>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="collapsible-animate overflow-hidden mt-2 ml-5 space-y-2">
              <p className="text-sm text-muted-foreground">{signal.description}</p>
              {Object.keys(signal.metadata).length > 0 && (
                <pre className="text-[10px] bg-muted rounded p-2 max-w-xl overflow-auto max-h-40 whitespace-pre-wrap">
                  {JSON.stringify(signal.metadata, null, 2)}
                </pre>
              )}
              {signal.resolutionNote && (
                <p className="text-xs">
                  <span className="text-muted-foreground">{t('fraudPage.row.resolutionLabel')}: </span>
                  {signal.resolutionNote}
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </TableCell>
        <TableCell>
          <Badge variant={severityVariant(signal.severity)}>{String(t(`fraudPage.severities.${signal.severity}`, signal.severity))}</Badge>
        </TableCell>
        <TableCell>
          <Badge variant={statusVariant(signal.status)}>{String(t(`fraudPage.statuses.${signal.status}`, signal.status))}</Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">{signal.score}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">{signal.confidence}%</TableCell>
        <TableCell className="text-xs text-muted-foreground">{signal.affectedUserIds.length}</TableCell>
        <TableCell className="text-right">
          {signal.status === 'OPEN' || signal.status === 'ACKNOWLEDGED' ? (
            <Button size="sm" variant="ghost" onClick={() => onTransition(signal)}>
              {t('fraudPage.row.resolveAction')}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{t('fraudPage.row.closed')}</span>
          )}
        </TableCell>
      </TableRow>
    </>
  );
}

function TransitionDialog({
  signal,
  onClose,
}: {
  signal: FraudSignal | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Exclude<FraudStatus, 'OPEN'>>('RESOLVED');
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: () => {
      if (!signal) return Promise.reject(new Error('No signal'));
      return transitionFraudSignal(signal.id, { status, note: note.trim() || undefined });
    },
    onSuccess: () => {
      toast.success(t('fraudPage.toast.signalUpdated'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'fraud'] });
      onClose();
      setNote('');
      setStatus('RESOLVED');
    },
    onError: (err) => toast.error(t('fraudPage.toast.updateFailed', { message: (err as Error).message })),
  });

  if (!signal) return null;

  return (
    <Dialog open={!!signal} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fraudPage.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('fraudPage.dialog.description')} <code className="text-xs">{signal.code}</code>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('fraudPage.dialog.newStatus')}</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as Exclude<FraudStatus, 'OPEN'>)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACKNOWLEDGED">{t('fraudPage.dialog.acknowledgeOption')}</SelectItem>
                <SelectItem value="RESOLVED">{t('fraudPage.dialog.resolveOption')}</SelectItem>
                <SelectItem value="DISMISSED">{t('fraudPage.dialog.dismissOption')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('fraudPage.dialog.noteLabel')}</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder={t('fraudPage.dialog.notePlaceholder')}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('fraudPage.dialog.cancel')}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            <CheckCircle2 className="mr-2 h-4 w-4" />
            {t('fraudPage.dialog.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
