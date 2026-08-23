import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList, AlertCircle, ChevronDown, Filter, ScrollText, X, Activity, Bell, Download } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDateTime, cn, truncate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { useTabSync } from '@/lib/use-tab-sync';
import { HUB_TABS } from '@/components/layout/admin-nav-config';
import { SavedFiltersBar } from '@/components/SavedFiltersBar';
import { ExportDropdown } from '@/components/ExportDropdown';
import { PermissionGate } from '@/features/rbac';
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

async function fetchAuditEvents(params: Record<string, string>, signal?: AbortSignal): Promise<AuditResponse> {
  const res = await api.get<AuditResponse>('/admin/audit', { params, signal });
  return res.data;
}

async function fetchFacets(signal?: AbortSignal): Promise<Facets> {
  const res = await api.get<Facets>('/admin/audit/facets', { signal });
  return res.data;
}

/** Download events as a .txt file (system-only or full audit). */
async function downloadEventsTxt(systemOnly: boolean): Promise<void> {
  const res = await api.get('/admin/audit/export', {
    params: systemOnly ? { systemOnly: 'true' } : {},
    responseType: 'blob',
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rezeis-${systemOnly ? 'system-events' : 'events'}-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform duration-200 ease-out',
              open ? 'rotate-0' : '-rotate-90',
            )}
            aria-hidden
          />
          {open ? t('auditPage.events.payload.hide') : t('auditPage.events.payload.show')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-animate overflow-hidden">
        <pre className="mt-1 text-[10px] bg-muted rounded p-2 max-w-xs overflow-auto max-h-32 whitespace-pre-wrap">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

const SystemLogsTab = lazy(() => import('@/features/system-logs/system-logs-page'))

/**
 * Tab values that `#hash` deep links may address. Kept in sync with the
 * `TabsTrigger`/`TabsContent` values below — `useTabSync` falls back to the
 * default for anything not listed, so an unknown hash lands on Audit rather
 * than on a blank panel.
 */
const ALLOWED_TABS = HUB_TABS['/audit']
type AuditTab = (typeof ALLOWED_TABS)[number]

interface UserEvent {
  id: string;
  type: string;
  userId: string;
  telegramId: string | null;
  userName: string | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

interface UserEventsResponse {
  items: UserEvent[];
  nextCursor: string | null;
}

async function fetchUserEvents(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<UserEventsResponse> {
  const res = await api.get<UserEventsResponse>('/admin/notifications/events', { params, signal });
  return res.data;
}

export default function AuditPage() {
  const { t } = useTranslation()
  // `router.tsx` redirects `/system/logs` to `/audit#system-logs`, and the
  // Cmd+K page index offers the same target. Both were dead: `Tabs` was
  // uncontrolled (`defaultValue="audit"`), so the hash was parsed by nobody and
  // every one of those links dropped the operator on the Audit tab with no
  // indication that the thing they asked for was one click away.
  const { activeTab, setTab } = useTabSync<AuditTab>(ALLOWED_TABS, 'audit')
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

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="audit" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            {t('auditPage.tabs.audit')}
          </TabsTrigger>
          <TabsTrigger value="system-events" className="gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            {t('auditPage.tabs.systemEvents')}
          </TabsTrigger>
          <TabsTrigger value="user-events" className="gap-1.5">
            <Bell className="h-3.5 w-3.5" />
            {t('auditPage.tabs.userEvents')}
          </TabsTrigger>
          <TabsTrigger value="system-logs" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            {t('auditPage.tabs.systemLogs')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="audit" className="pt-2">
          <AuditLogTab />
        </TabsContent>

        <TabsContent value="system-events" className="pt-2">
          <SystemEventsTab />
        </TabsContent>

        <TabsContent value="user-events" className="pt-2">
          <UserEventsTab />
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
    queryFn: ({ signal }) => fetchAuditEvents(params, signal),
    placeholderData: keepPreviousData,
  });

  const { data: facets } = useQuery({
    queryKey: ['audit-facets'],
    queryFn: ({ signal }) => fetchFacets(signal),
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
                              <span className="font-mono ml-1">#{truncate(event.targetId, 8)}</span>
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

function severityVariant(severity: string): 'default' | 'destructive' | 'warning' | 'success' | 'secondary' {
  if (severity === 'ERROR') return 'destructive';
  if (severity === 'WARNING') return 'warning';
  return 'secondary';
}

/**
 * System-events feed — the `SystemEventsService` stream (rows whose audit
 * `action` starts with `event.`). Surfaces severity / category / message
 * prominently, unlike the admin-action audit log. Reuses the audit V2
 * endpoint with `systemOnly=true`.
 */
function SystemEventsTab() {
  const { t } = useTranslation();
  const [severity, setSeverity] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursors, setCursors] = useState<string[]>([]);

  const params: Record<string, string> = { limit: '50', systemOnly: 'true' };
  if (cursor) params.cursor = cursor;

  const { data, isLoading, error } = useQuery({
    queryKey: ['system-events', params],
    queryFn: ({ signal }) => fetchAuditEvents(params, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
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

  const readStr = (payload: Record<string, unknown> | null, key: string): string =>
    payload && typeof payload[key] === 'string' ? (payload[key] as string) : '';

  const visibleItems = (data?.items ?? []).filter((event) => {
    if (!severity) return true;
    return readStr(event.payload, 'severity') === severity;
  });

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
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{t('auditPage.filters.title')}</CardTitle>
            <div className="ml-auto flex items-center gap-2">
              <div className="w-48">
                <Select
                  value={severity || 'all'}
                  onValueChange={(v) => setSeverity(v === 'all' ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('auditPage.systemEvents.filters.severityPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('auditPage.systemEvents.filters.allSeverities')}</SelectItem>
                    <SelectItem value="INFO">{t('auditPage.systemEvents.severity.INFO')}</SelectItem>
                    <SelectItem value="WARNING">{t('auditPage.systemEvents.severity.WARNING')}</SelectItem>
                    <SelectItem value="ERROR">{t('auditPage.systemEvents.severity.ERROR')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* The export route now demands the dedicated `audit:export`
                  action rather than `audit:view`, because it hands over the
                  whole log as a file. `operator` and `finance` hold the read
                  and not the export, so without this gate they would see a
                  button that 403s. */}
              <PermissionGate resource="audit" action="export">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void downloadEventsTxt(true)}
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  {t('auditPage.systemEvents.exportTxt')}
                </Button>
              </PermissionGate>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('auditPage.systemEvents.title')}</CardTitle>
          </div>
          <CardDescription>{t('auditPage.systemEvents.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <Activity className="h-10 w-10 opacity-30" />
              <p>{t('auditPage.systemEvents.empty')}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('auditPage.events.columns.time')}</TableHead>
                    <TableHead>{t('auditPage.systemEvents.columns.severity')}</TableHead>
                    <TableHead>{t('auditPage.systemEvents.columns.category')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.event')}</TableHead>
                    <TableHead>{t('auditPage.systemEvents.columns.message')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.payload')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleItems.map((event) => {
                    const sev = readStr(event.payload, 'severity') || 'INFO';
                    const category = readStr(event.payload, 'category');
                    const message = readStr(event.payload, 'message');
                    return (
                      <TableRow key={event.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDateTime(event.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={severityVariant(sev)} className="text-xs">
                            {t(`auditPage.systemEvents.severity.${sev}`, sev)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {category || '—'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="font-mono text-xs">
                            {event.kind.replace(/^event\./, '')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm max-w-xs truncate">
                          {message || '—'}
                        </TableCell>
                        <TableCell>
                          <PayloadViewer payload={event.payload} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

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
                  disabled={!data?.nextCursor}
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

/**
 * User-events feed — recent `UserNotificationEvent` rows (subscription
 * expiry, referral / partner payouts, operator pushes…). The user-facing
 * counterpart to the system-events stream. Reads `/admin/notifications/events`.
 */
function UserEventsTab() {
  const { t } = useTranslation();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursors, setCursors] = useState<string[]>([]);

  const params: Record<string, string> = { limit: '50' };
  if (cursor) params.cursor = cursor;

  const { data, isLoading, error } = useQuery({
    queryKey: ['user-events', params],
    queryFn: ({ signal }) => fetchUserEvents(params, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
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

  if (error)
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('auditPage.error.title')}</AlertTitle>
        <AlertDescription>{t('auditPage.error.body')}</AlertDescription>
      </Alert>
    );

  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('auditPage.userEvents.title')}</CardTitle>
          </div>
          <CardDescription>{t('auditPage.userEvents.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <Bell className="h-10 w-10 opacity-30" />
              <p>{t('auditPage.userEvents.empty')}</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('auditPage.events.columns.time')}</TableHead>
                    <TableHead>{t('auditPage.userEvents.columns.user')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.event')}</TableHead>
                    <TableHead>{t('auditPage.userEvents.columns.status')}</TableHead>
                    <TableHead>{t('auditPage.events.columns.payload')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(event.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-medium">{event.userName || '—'}</span>
                        {event.telegramId ? (
                          <span className="block font-mono text-[10px] text-muted-foreground">
                            {event.telegramId}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-mono text-xs">
                          {event.type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={event.readAt ? 'secondary' : 'success'} className="text-xs">
                          {event.readAt
                            ? t('auditPage.userEvents.status.read')
                            : t('auditPage.userEvents.status.unread')}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <PayloadViewer payload={event.payload} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

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
                  disabled={!data?.nextCursor}
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
