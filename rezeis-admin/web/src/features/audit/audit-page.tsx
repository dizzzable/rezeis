import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, AlertCircle, ChevronDown, ChevronRight, Filter, ScrollText, X } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { SavedFiltersBar } from '@/components/SavedFiltersBar';
import { ExportDropdown } from '@/components/ExportDropdown';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface AuditEvent {
  id: string;
  kind: string;
  actorId: string | null;
  actorIp: string | null;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditResponse {
  items: AuditEvent[];
  nextCursor: string | null;
}

interface Facets {
  kinds: string[];
  actors: string[];
  targetTypes: string[];
}

async function fetchAuditEvents(params: Record<string, string>): Promise<AuditResponse> {
  const res = await api.get<AuditResponse>('/admin/audit', { params });
  return res.data;
}

async function fetchFacets(): Promise<Facets> {
  const res = await api.get<Facets>('/admin/audit/facets');
  return res.data;
}

function kindVariant(kind: string): 'default' | 'destructive' | 'warning' | 'success' | 'secondary' {
  if (kind.includes('delete') || kind.includes('revoke') || kind.includes('ban')) return 'destructive';
  if (kind.includes('create') || kind.includes('grant') || kind.includes('activate')) return 'success';
  if (kind.includes('update') || kind.includes('edit') || kind.includes('change')) return 'warning';
  return 'secondary';
}

function PayloadViewer({ payload }: { payload: Record<string, unknown> | null }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false);
  if (!payload || Object.keys(payload).length === 0) return <span className="text-muted-foreground text-xs">—</span>;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {open ? t('auditPage.events.payload.hide') : t('auditPage.events.payload.show')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 text-[10px] bg-muted rounded p-2 max-w-xs overflow-auto max-h-32 whitespace-pre-wrap">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

const SystemLogsTab = lazy(() => import('@/features/system-logs/system-logs-page'))

export default function AuditPage() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ClipboardList className="h-6 w-6" />
          {t('auditPage.title')}
        </h1>
        <p className="text-muted-foreground">
          {t('auditPage.subtitle')}
        </p>
      </div>

      <Tabs defaultValue="audit">
        <TabsList>
          <TabsTrigger value="audit" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            {t('auditPage.tabs.audit')}
          </TabsTrigger>
          <TabsTrigger value="system-logs" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            {t('auditPage.tabs.systemLogs')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="audit" className="pt-2">
          <AuditLogTab />
        </TabsContent>

        <TabsContent value="system-logs" className="pt-2">
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <SystemLogsTab embedded />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AuditLogTab() {
  const { t } = useTranslation()
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [actorId, setActorId] = useState('');
  const [targetType, setTargetType] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursors, setCursors] = useState<string[]>([]);

  const params: Record<string, string> = { limit: '50' };
  if (q) params.q = q;
  if (kind) params.kind = kind;
  if (actorId) params.actorId = actorId;
  if (targetType) params.targetType = targetType;
  if (cursor) params.cursor = cursor;

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', params],
    queryFn: () => fetchAuditEvents(params),
  });

  const { data: facets } = useQuery({
    queryKey: ['audit-facets'],
    queryFn: fetchFacets,
    staleTime: 60_000,
  });

  function handleNextPage() {
    if (data?.nextCursor) {
      setCursors((prev) => [...prev, cursor ?? '']);
      setCursor(data.nextCursor);
    }
  }

  function handlePrevPage() {
    const prev = cursors[cursors.length - 1];
    setCursors((c) => c.slice(0, -1));
    setCursor(prev || undefined);
  }

  function clearFilters() {
    setQ('');
    setKind('');
    setActorId('');
    setTargetType('');
    setCursor(undefined);
    setCursors([]);
  }

  const hasFilters = q || kind || actorId || targetType;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('auditPage.error.title')}</AlertTitle>
        <AlertDescription>{t('auditPage.error.body')}</AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <ExportDropdown
          filename="audit-log"
          rows={data?.items ?? []}
          columns={[
            { header: 'createdAt', accessor: (e) => e.createdAt },
            { header: 'kind', accessor: (e) => e.kind },
            { header: 'actorId', accessor: (e) => e.actorId ?? '' },
            { header: 'actorIp', accessor: (e) => e.actorIp ?? '' },
            { header: 'targetType', accessor: (e) => e.targetType ?? '' },
            { header: 'targetId', accessor: (e) => e.targetId ?? '' },
            { header: 'payload', accessor: (e) => e.payload },
          ]}
        />
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{t('auditPage.filters.title')}</CardTitle>
            <SavedFiltersBar<{ q: string; kind: string; actorId: string; targetType: string }>
              pageKey="audit"
              current={{ q, kind, actorId, targetType }}
              onLoad={(value) => {
                setQ(value.q ?? '');
                setKind(value.kind ?? '');
                setActorId(value.actorId ?? '');
                setTargetType(value.targetType ?? '');
                setCursor(undefined);
                setCursors([]);
              }}
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={clearFilters}>
                <X className="h-3 w-3" />
                {t('auditPage.filters.clear')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Input
              placeholder={t('auditPage.filters.searchPlaceholder')}
              value={q}
              onChange={(e) => { setQ(e.target.value); setCursor(undefined); setCursors([]); }}
            />
            <Select
              value={kind || 'all'}
              onValueChange={(v) => { setKind(v === 'all' ? '' : v); setCursor(undefined); setCursors([]); }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('auditPage.filters.kindPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('auditPage.filters.allKinds')}</SelectItem>
                {facets?.kinds.map((k) => (
                  <SelectItem key={k} value={k}>{k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={actorId || 'all'}
              onValueChange={(v) => { setActorId(v === 'all' ? '' : v); setCursor(undefined); setCursors([]); }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('auditPage.filters.actorPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('auditPage.filters.allActors')}</SelectItem>
                {facets?.actors.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={targetType || 'all'}
              onValueChange={(v) => { setTargetType(v === 'all' ? '' : v); setCursor(undefined); setCursors([]); }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('auditPage.filters.targetPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('auditPage.filters.allTargets')}</SelectItem>
                {facets?.targetTypes.map((tt) => (
                  <SelectItem key={tt} value={tt}>{tt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('auditPage.events.title')}</CardTitle>
          </div>
          <CardDescription>
            {data ? t('auditPage.events.countShown', { count: data.items.length }) : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <ClipboardList className="h-10 w-10 opacity-30" />
              <p>{t('auditPage.events.empty')}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('auditPage.events.columns.time')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.event')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.actor')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.ip')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.target')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.payload')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(event.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={kindVariant(event.kind)} className="font-mono text-xs">
                          {event.kind}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {event.actorId ?? <span className="text-muted-foreground">{t('auditPage.events.systemActor')}</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {event.actorIp ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {event.targetType ? (
                          <span>
                            <span className="text-muted-foreground">{event.targetType}</span>
                            {event.targetId && (
                              <span className="font-mono ml-1">#{event.targetId.slice(0, 8)}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <PayloadViewer payload={event.payload} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrevPage}
                  disabled={cursors.length === 0}
                >
                  {t('auditPage.events.pagination.previous')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('auditPage.events.pagination.page', { page: cursors.length + 1 })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNextPage}
                  disabled={!data.nextCursor}
                >
                  {t('auditPage.events.pagination.next')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
