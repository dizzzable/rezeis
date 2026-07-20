import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Megaphone, Info, Plus, Copy, Archive, BarChart3, Pencil, Pause, Play } from 'lucide-react'

import { LocalQr } from '@/components/ui/local-qr'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
} from 'recharts'

import {
  approveAdRequest,
  archiveAdPlacement,
  createAdCampaign,
  createAdPlacement,
  formatRequestTerms,
  getAdOverview,
  getPlacementChartData,
  getPlacementMetrics,
  isHistoryRequest,
  listAdCampaigns,
  listAdRequests,
  placementSpendPayload,
  rejectAdRequest,
  updateAdPlacement,
  type AdMetrics,
  type AdPlacement,
  type AdPlacementRequest,
  type AdPlatform,
  type AdOwnerType,
  type AdPlacementStatus,
  type AdRequestStatus,
  type AdSignupBonusType,
} from './advertising-api'

const PLATFORMS: AdPlatform[] = [
  'TELEGRAM',
  'TELEGRAM_ADS',
  'YOUTUBE',
  'TIKTOK',
  'INSTAGRAM',
  'VK',
  'WEBSITE',
  'INFLUENCER',
  'OTHER',
]

/** Hoverable info icon: what / how / example. Reuses the product tooltip pattern. */
function InfoHint({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('advertisingPage.help.infoAria')}
            className="inline-flex text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-snug">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function formatMoney(minor: number, currency: string): string {
  return `${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`
}

export default function AdvertisingPage() {
  const { t } = useTranslation()
  const overview = useQuery({ queryKey: ['admin', 'advertising', 'overview'], queryFn: getAdOverview })
  const campaigns = useQuery({ queryKey: ['admin', 'advertising', 'campaigns'], queryFn: listAdCampaigns })

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Megaphone className="h-6 w-6" />
            {t('advertisingPage.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('advertisingPage.subtitle')}</p>
        </div>
        <NewCampaignDialog />
      </header>

      {/* Overview — compact tiles, not full-width stretched */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <OverviewTile label={t('advertisingPage.overview.campaigns')} value={overview.data?.campaigns} />
        <OverviewTile label={t('advertisingPage.overview.activePlacements')} value={overview.data?.activePlacements} />
        <OverviewTile label={t('advertisingPage.overview.opens')} value={overview.data?.opens} />
        <OverviewTile label={t('advertisingPage.overview.registrations')} value={overview.data?.registrations} />
        <OverviewTile label={t('advertisingPage.overview.conversions')} value={overview.data?.conversions} />
        <OverviewTile
          label={t('advertisingPage.overview.revenue')}
          value={overview.data ? Math.round(overview.data.revenueMinor / 100) : undefined}
        />
      </div>

      <RequestsPanel />

      {campaigns.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (campaigns.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">{t('advertisingPage.campaign.empty')}</p>
      ) : (
        <div className="space-y-4">
          {campaigns.data?.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  {c.notes && <CardDescription>{c.notes}</CardDescription>}
                </div>
                <NewPlacementDialog campaignId={c.id} />
              </CardHeader>
              <CardContent>
                {c.placements.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('advertisingPage.campaign.placementsEmpty')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {c.placements.map((p) => (
                      <PlacementTile key={p.id} placement={p} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function OverviewTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xl font-bold tabular-nums">{value?.toLocaleString() ?? '—'}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  )
}

function PlacementTile({ placement }: { placement: AdPlacement }) {
  const { t } = useTranslation()
  const [showMetrics, setShowMetrics] = useState(false)
  const queryClient = useQueryClient()
  const botUrl = placement.links?.botStart ?? ''
  const webUrl = placement.links?.miniAppWeb ?? ''
  const miniUrl = placement.links?.miniAppStart ?? null
  const canToggleStatus = placement.status === 'ACTIVE' || placement.status === 'PAUSED'
  const nextStatus: AdPlacementStatus = placement.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'

  const archive = useMutation({
    mutationFn: () => archiveAdPlacement(placement.id),
    onSuccess: () => {
      toast.success(t('advertisingPage.placement.archived'))
      queryClient.invalidateQueries({ queryKey: ['admin', 'advertising'] })
    },
  })

  const toggleStatus = useMutation({
    mutationFn: () => updateAdPlacement(placement.id, { status: nextStatus }),
    onSuccess: () => {
      toast.success(
        nextStatus === 'PAUSED'
          ? t('advertisingPage.placement.paused')
          : t('advertisingPage.placement.activated'),
      )
      queryClient.invalidateQueries({ queryKey: ['admin', 'advertising'] })
    },
  })

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t('advertisingPage.actions.copied'))
    } catch {
      /* clipboard unavailable */
    }
  }

  const spendLabel =
    placement.ownerType === 'COMPANY' && placement.spendAmountMinor != null
      ? formatMoney(placement.spendAmountMinor, placement.spendCurrency ?? 'RUB')
      : null

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{t(`advertisingPage.platforms.${placement.platform}`)}</Badge>
        <Badge variant={placement.ownerType === 'PARTNER' ? 'secondary' : 'outline'}>
          {t(`advertisingPage.owner.${placement.ownerType}`)}
        </Badge>
        {placement.channel && (
          <span className="max-w-[180px] truncate text-sm text-muted-foreground">{placement.channel}</span>
        )}
        {spendLabel && (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="placement-spend"
            title={t('advertisingPage.placement.spendLabel')}
          >
            {spendLabel}
          </span>
        )}
        <div className="flex min-w-[180px] flex-1 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{placement.payload}</code>
          <InfoHint text={t('advertisingPage.help.trackingCode')} />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={() => copyText(placement.payload)}
            aria-label={t('advertisingPage.actions.copy')}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
          {t(`advertisingPage.status.${placement.status}`)}
        </Badge>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setShowMetrics((v) => !v)}>
          <BarChart3 className="h-3.5 w-3.5" />
          {t('advertisingPage.metrics.title')}
        </Button>
        {placement.status !== 'ARCHIVED' && <EditPlacementDialog placement={placement} />}
        {canToggleStatus && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => toggleStatus.mutate()}
            disabled={toggleStatus.isPending}
            data-testid="placement-toggle-status"
          >
            {placement.status === 'ACTIVE' ? (
              <>
                <Pause className="h-3.5 w-3.5" />
                {t('advertisingPage.actions.pause')}
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                {t('advertisingPage.actions.activate')}
              </>
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs text-destructive"
          onClick={() => archive.mutate()}
          disabled={archive.isPending || placement.status === 'ARCHIVED'}
        >
          <Archive className="h-3.5 w-3.5" />
          {t('advertisingPage.actions.archive')}
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-3">
        <div className="min-w-[200px] flex-1 space-y-1 text-xs">
          {botUrl && (
            <LinkCopyRow label={t('advertisingPage.links.bot')} value={botUrl} onCopy={() => copyText(botUrl)} />
          )}
          {miniUrl && (
            <LinkCopyRow label={t('advertisingPage.links.miniApp')} value={miniUrl} onCopy={() => copyText(miniUrl)} />
          )}
          {webUrl && (
            <LinkCopyRow label={t('advertisingPage.links.web')} value={webUrl} onCopy={() => copyText(webUrl)} />
          )}
        </div>
        {(botUrl || webUrl) && (
          <div className="flex gap-3">
            {botUrl && <LocalQr label={t('advertisingPage.links.qrBot')} url={botUrl} size={88} />}
            {webUrl && <LocalQr label={t('advertisingPage.links.qrWeb')} url={webUrl} size={88} />}
          </div>
        )}
      </div>
      {showMetrics && (
        <div className="mt-3">
          <PlacementMetrics placementId={placement.id} />
        </div>
      )}
    </div>
  )
}

function LinkCopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5">{value}</code>
      <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={onCopy}>
        <Copy className="h-3 w-3" />
      </Button>
    </div>
  )
}

function PlacementMetrics({ placementId }: { placementId: string }) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'advertising', 'metrics', placementId],
    queryFn: () => getPlacementMetrics(placementId),
  })
  if (isLoading || !data) {
    return <Skeleton className="h-24 w-full" />
  }
  const fmtRatio = (v: number | null) => (v === null ? t('advertisingPage.metrics.na') : v.toFixed(2))
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const money = (v: number | null) =>
    v === null ? t('advertisingPage.metrics.na') : formatMoney(v, (data as AdMetrics).currency)
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md bg-muted/40 p-3 text-xs sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      <Metric label={t('advertisingPage.metrics.opens')} value={data.opens.toLocaleString()} />
      <Metric label={t('advertisingPage.metrics.registrations')} value={data.registrations.toLocaleString()} />
      <Metric label={t('advertisingPage.metrics.conversions')} value={data.conversions.toLocaleString()} />
      <Metric label={t('advertisingPage.metrics.revenue')} value={formatMoney(data.revenueMinor, data.currency)} />
      <Metric label={t('advertisingPage.metrics.cost')} value={formatMoney(data.costMinor, data.currency)} hint={t('advertisingPage.help.cost')} />
      <Metric label={t('advertisingPage.metrics.cac')} value={money(data.cac)} hint={t('advertisingPage.help.cac')} />
      <Metric label={t('advertisingPage.metrics.roas')} value={fmtRatio(data.roas)} hint={t('advertisingPage.help.roas')} />
      <Metric label={t('advertisingPage.metrics.roi')} value={fmtRatio(data.roi)} hint={t('advertisingPage.help.roi')} />
      <Metric label={t('advertisingPage.metrics.openToReg')} value={pct(data.openToRegistrationRate)} />
      <Metric label={t('advertisingPage.metrics.regToPurchase')} value={pct(data.registrationToPurchaseRate)} />
      <Metric label={t('advertisingPage.metrics.avgFirstPayment')} value={money(data.avgFirstPaymentMinor)} />
      <Metric label={t('advertisingPage.metrics.daysToPurchase')} value={data.avgDaysToPurchase?.toString() ?? t('advertisingPage.metrics.na')} />
      <div className="col-span-full">
        <PlacementTrend placementId={placementId} />
      </div>
    </div>
  )
}

function PlacementTrend({ placementId }: { placementId: string }) {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['admin', 'advertising', 'chart', placementId],
    queryFn: () => getPlacementChartData(placementId, 14),
  })
  if (!data || data.length === 0) {
    return null
  }
  return (
    <div className="h-28 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} tickFormatter={(d: string) => d.slice(5)} />
          <ChartTooltip />
          <Area type="monotone" dataKey="opens" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} name={t('advertisingPage.metrics.opens')} />
          <Area type="monotone" dataKey="registrations" stroke="#10b981" fill="#10b981" fillOpacity={0.25} name={t('advertisingPage.metrics.registrations')} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-muted-foreground">
        {label}
        {hint && <InfoHint text={hint} />}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  )
}

type RequestFilter = 'PENDING' | 'HISTORY' | 'ALL'

function RequestsPanel() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<RequestFilter>('PENDING')
  const statusParam = filter === 'PENDING' ? 'PENDING' : undefined
  const requests = useQuery({
    queryKey: ['admin', 'advertising', 'requests', filter],
    queryFn: () => listAdRequests(statusParam),
  })

  const rows = (requests.data ?? []).filter((r) => {
    if (filter === 'PENDING') return r.status === 'PENDING'
    if (filter === 'HISTORY') return isHistoryRequest(r.status)
    return true
  })

  return (
    <Card data-testid="requests-panel">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t('advertisingPage.requests.title')}</CardTitle>
          <CardDescription>{t('advertisingPage.requests.subtitle')}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('advertisingPage.requests.filtersAria')}>
          {(['PENDING', 'HISTORY', 'ALL'] as const).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? 'default' : 'outline'}
              className="h-7 text-xs"
              role="tab"
              aria-selected={filter === key}
              data-testid={`requests-filter-${key.toLowerCase()}`}
              onClick={() => setFilter(key)}
            >
              {t(`advertisingPage.requests.filter.${key}`)}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {requests.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="requests-empty">
            {filter === 'PENDING' ? t('advertisingPage.requests.emptyPending') : t('advertisingPage.requests.empty')}
          </p>
        ) : (
          rows.map((r) => <RequestRow key={r.id} request={r} moderation={r.status === 'PENDING'} />)
        )}
      </CardContent>
    </Card>
  )
}

function RequestTermsBadge({ request }: { request: AdPlacementRequest }) {
  const { t } = useTranslation()
  const terms = formatRequestTerms(request)
  if (terms.kind === 'counter') {
    return (
      <span className="text-xs text-amber-700 dark:text-amber-400" data-testid="request-terms-counter">
        {t('advertisingPage.requests.counterTerms', {
          proposed: terms.proposed,
          approved: terms.approved,
        })}
      </span>
    )
  }
  if (terms.kind === 'agreed') {
    return (
      <span className="text-xs text-muted-foreground" data-testid="request-terms-agreed">
        {t('advertisingPage.requests.agreedWindow', { days: terms.approved })}
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-foreground" data-testid="request-terms-proposed">
      {t('advertisingPage.requests.proposedWindow', { days: terms.proposed })}
    </span>
  )
}

function RequestRow({ request, moderation }: { request: AdPlacementRequest; moderation: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [windowDays, setWindowDays] = useState(String(request.proposedWindowDays))
  const windowInputId = `request-window-${request.id}`
  const parseWindowDays = (): number | null => {
    const days = Number(windowDays)
    if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1 || days > 365) {
      return null
    }
    return days
  }

  const approve = useMutation({
    mutationFn: () => {
      const approved = parseWindowDays() ?? request.proposedWindowDays
      return approveAdRequest(request.id, approved)
    },
    onSuccess: (result) => {
      if (result.request.status === 'COUNTERED') {
        toast.success(t('advertisingPage.requests.countered'))
      } else {
        toast.success(t('advertisingPage.requests.approved'))
      }
      queryClient.invalidateQueries({ queryKey: ['admin', 'advertising'] })
    },
  })
  const reject = useMutation({
    mutationFn: () => rejectAdRequest(request.id),
    onSuccess: () => {
      toast.success(t('advertisingPage.requests.rejected'))
      queryClient.invalidateQueries({ queryKey: ['admin', 'advertising'] })
    },
  })

  const statusKey = request.status as AdRequestStatus
  const parsedWindow = parseWindowDays()
  const willCounter =
    moderation && parsedWindow != null ? parsedWindow !== request.proposedWindowDays : false

  return (
    <div
      className="flex flex-wrap items-start gap-2 rounded-md border p-2 text-sm"
      data-testid={`request-row-${request.id}`}
      data-status={request.status}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{request.channel ?? request.partnerId.slice(0, 8)}</span>
          <Badge variant="outline" className="font-normal" data-testid="request-status">
            {t(`advertisingPage.requestStatus.${statusKey}`)}
          </Badge>
          <span className="text-xs text-muted-foreground" title={request.partnerId}>
            {t('advertisingPage.requests.partnerId', { id: request.partnerId.slice(0, 10) })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{request.platforms.map((p) => t(`advertisingPage.platforms.${p}`)).join(', ')}</span>
          <RequestTermsBadge request={request} />
        </div>
        {request.notes && (
          <p className="text-xs text-muted-foreground" data-testid="request-notes">
            {request.notes}
          </p>
        )}
        {request.selfFundedBudgetNote && (
          <p className="text-xs text-muted-foreground" data-testid="request-budget-note">
            {t('advertisingPage.requests.budgetNote', { note: request.selfFundedBudgetNote })}
          </p>
        )}
      </div>
      {moderation && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Label
              htmlFor={windowInputId}
              className="text-[10px] text-muted-foreground"
            >
              {t('advertisingPage.requests.approveWindow')}
            </Label>
            <Input
              id={windowInputId}
              type="number"
              min={1}
              max={365}
              step={1}
              className="h-7 w-20 text-xs"
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
              title={t('advertisingPage.requests.approveWindowHint')}
              data-testid="request-approve-window"
            />
          </div>
          <Button
            size="sm"
            className="h-7"
            onClick={() => {
              if (parseWindowDays() == null) {
                toast.error(t('advertisingPage.requests.invalidWindow'))
                return
              }
              approve.mutate()
            }}
            disabled={approve.isPending}
            data-testid="request-approve"
          >
            {willCounter ? t('advertisingPage.requests.counter') : t('advertisingPage.requests.approve')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => reject.mutate()}
            disabled={reject.isPending}
            data-testid="request-reject"
          >
            {t('advertisingPage.requests.reject')}
          </Button>
        </div>
      )}
    </div>
  )
}

function NewCampaignDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: () => createAdCampaign({ name: name.trim(), notes: notes.trim() || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'advertising'] })
      setOpen(false)
      setName('')
      setNotes('')
    },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-1">
          <Plus className="h-4 w-4" />
          {t('advertisingPage.actions.newCampaign')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('advertisingPage.actions.newCampaign')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('advertisingPage.campaign.nameLabel')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('advertisingPage.campaign.namePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('advertisingPage.campaign.notesLabel')}</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('advertisingPage.actions.cancel')}
          </Button>
          <Button onClick={() => create.mutate()} disabled={name.trim().length < 3 || create.isPending}>
            {t('advertisingPage.actions.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function labelWithHint(label: string, hint: string): ReactNode {
  return (
    <span className="flex items-center gap-1">
      {label}
      <InfoHint text={hint} />
    </span>
  )
}

function NewPlacementDialog({ campaignId }: { campaignId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [platform, setPlatform] = useState<AdPlatform>('TELEGRAM')
  const [ownerType, setOwnerType] = useState<AdOwnerType>('COMPANY')
  const [partnerId, setPartnerId] = useState('')
  const [channel, setChannel] = useState('')
  const [windowDays, setWindowDays] = useState('30')
  const [spendMajor, setSpendMajor] = useState('')
  const [spendCurrency, setSpendCurrency] = useState('RUB')
  const [bonusType, setBonusType] = useState<AdSignupBonusType>('NONE')
  const [trialDays, setTrialDays] = useState('3')
  const [tariffPlanId, setTariffPlanId] = useState('')
  const [tariffDays, setTariffDays] = useState('30')
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: () =>
      createAdPlacement({
        campaignId,
        platform,
        ownerType,
        partnerId: ownerType === 'PARTNER' && partnerId.trim() ? partnerId.trim() : undefined,
        channel: channel.trim() || undefined,
        attributionWindowDays: Math.max(1, Math.min(365, Number(windowDays) || 30)),
        ...placementSpendPayload(ownerType, spendMajor, spendCurrency),
        signupBonus:
          bonusType === 'NONE'
            ? undefined
            : bonusType === 'TRIAL'
              ? { type: 'TRIAL', trialDurationDays: Math.max(1, Number(trialDays) || 3) }
              : {
                  type: 'TARIFF',
                  tariffPlanId: tariffPlanId.trim() || undefined,
                  tariffDurationDays: Math.max(1, Number(tariffDays) || 30),
                },
      }),
    onSuccess: () => {
      toast.success(t('advertisingPage.placement.created'))
      queryClient.invalidateQueries({ queryKey: ['admin', 'advertising'] })
      setOpen(false)
      setChannel('')
      setPartnerId('')
      setSpendMajor('')
      setSpendCurrency('RUB')
      setBonusType('NONE')
    },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1">
          <Plus className="h-4 w-4" />
          {t('advertisingPage.actions.newPlacement')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('advertisingPage.actions.newPlacement')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('advertisingPage.placement.platformLabel')}</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as AdPlatform)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`advertisingPage.platforms.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{labelWithHint(t('advertisingPage.placement.ownerLabel'), t('advertisingPage.help.ownerType'))}</Label>
            <Select value={ownerType} onValueChange={(v) => setOwnerType(v as AdOwnerType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="COMPANY">{t('advertisingPage.owner.COMPANY')}</SelectItem>
                <SelectItem value="PARTNER">{t('advertisingPage.owner.PARTNER')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {ownerType === 'PARTNER' && (
            <div className="space-y-1.5">
              <Label>{t('advertisingPage.placement.partnerIdLabel')}</Label>
              <Input value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder="partner id" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t('advertisingPage.placement.channelLabel')}</Label>
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{labelWithHint(t('advertisingPage.placement.windowLabel'), t('advertisingPage.help.attributionWindow'))}</Label>
            <Input type="number" min="1" max="365" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
          </div>
          {ownerType === 'COMPANY' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>{labelWithHint(t('advertisingPage.placement.spendLabel'), t('advertisingPage.help.spend'))}</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={spendMajor}
                  onChange={(e) => setSpendMajor(e.target.value)}
                  placeholder="0"
                  data-testid="create-spend-major"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('advertisingPage.placement.spendCurrencyLabel')}</Label>
                <Input
                  value={spendCurrency}
                  onChange={(e) => setSpendCurrency(e.target.value.toUpperCase())}
                  maxLength={8}
                  data-testid="create-spend-currency"
                />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{labelWithHint(t('advertisingPage.placement.bonusLabel'), t('advertisingPage.help.signupBonus'))}</Label>
            <Select value={bonusType} onValueChange={(v) => setBonusType(v as AdSignupBonusType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">{t('advertisingPage.bonus.NONE')}</SelectItem>
                <SelectItem value="TRIAL">{t('advertisingPage.bonus.TRIAL')}</SelectItem>
                <SelectItem value="TARIFF">{t('advertisingPage.bonus.TARIFF')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {bonusType === 'TRIAL' && (
            <div className="space-y-1.5">
              <Label>{t('advertisingPage.placement.trialDurationLabel')}</Label>
              <Input type="number" min="1" max="730" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} />
            </div>
          )}
          {bonusType === 'TARIFF' && (
            <>
              <div className="space-y-1.5">
                <Label>{t('advertisingPage.placement.tariffPlanIdLabel')}</Label>
                <Input value={tariffPlanId} onChange={(e) => setTariffPlanId(e.target.value)} placeholder="plan id" />
              </div>
              <div className="space-y-1.5">
                <Label>{t('advertisingPage.placement.tariffDurationLabel')}</Label>
                <Input type="number" min="1" max="730" value={tariffDays} onChange={(e) => setTariffDays(e.target.value)} />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('advertisingPage.actions.cancel')}
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {t('advertisingPage.actions.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditPlacementDialog({ placement }: { placement: AdPlacement }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState(placement.channel ?? '')
  const [windowDays, setWindowDays] = useState(String(placement.attributionWindowDays))
  const [spendMajor, setSpendMajor] = useState(
    placement.spendAmountMinor != null ? String(placement.spendAmountMinor / 100) : '',
  )
  const [spendCurrency, setSpendCurrency] = useState(placement.spendCurrency ?? 'RUB')
  const [status, setStatus] = useState<AdPlacementStatus>(
    placement.status === 'ARCHIVED' ? 'ARCHIVED' : placement.status,
  )
  const queryClient = useQueryClient()

  const resetFromPlacement = () => {
    setChannel(placement.channel ?? '')
    setWindowDays(String(placement.attributionWindowDays))
    setSpendMajor(placement.spendAmountMinor != null ? String(placement.spendAmountMinor / 100) : '')
    setSpendCurrency(placement.spendCurrency ?? 'RUB')
    setStatus(placement.status)
  }

  const save = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof updateAdPlacement>[1] = {
        channel: channel.trim() || undefined,
        attributionWindowDays: Math.max(1, Math.min(365, Number(windowDays) || 30)),
        status: status === 'ARCHIVED' ? undefined : status,
      }
      if (placement.ownerType === 'COMPANY') {
        Object.assign(body, placementSpendPayload('COMPANY', spendMajor, spendCurrency))
      }
      return updateAdPlacement(placement.id, body)
    },
    onSuccess: () => {
      toast.success(t('advertisingPage.placement.updated'))
      queryClient.invalidateQueries({ queryKey: ['admin', 'advertising'] })
      setOpen(false)
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) resetFromPlacement()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" data-testid="placement-edit">
          <Pencil className="h-3.5 w-3.5" />
          {t('advertisingPage.actions.edit')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('advertisingPage.actions.editPlacement')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('advertisingPage.placement.channelLabel')}</Label>
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} data-testid="edit-channel" />
          </div>
          <div className="space-y-1.5">
            <Label>{labelWithHint(t('advertisingPage.placement.windowLabel'), t('advertisingPage.help.attributionWindow'))}</Label>
            <Input
              type="number"
              min="1"
              max="365"
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
              data-testid="edit-window"
            />
          </div>
          {placement.ownerType === 'COMPANY' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>{labelWithHint(t('advertisingPage.placement.spendLabel'), t('advertisingPage.help.spend'))}</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={spendMajor}
                  onChange={(e) => setSpendMajor(e.target.value)}
                  data-testid="edit-spend-major"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('advertisingPage.placement.spendCurrencyLabel')}</Label>
                <Input
                  value={spendCurrency}
                  onChange={(e) => setSpendCurrency(e.target.value.toUpperCase())}
                  maxLength={8}
                  data-testid="edit-spend-currency"
                />
              </div>
            </div>
          )}
          {placement.ownerType === 'PARTNER' && (
            <p className="text-xs text-muted-foreground">{t('advertisingPage.placement.partnerSpendNote')}</p>
          )}
          {placement.status !== 'ARCHIVED' && (
            <div className="space-y-1.5">
              <Label>{t('advertisingPage.placement.statusLabel')}</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as AdPlacementStatus)}>
                <SelectTrigger data-testid="edit-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">{t('advertisingPage.status.ACTIVE')}</SelectItem>
                  <SelectItem value="PAUSED">{t('advertisingPage.status.PAUSED')}</SelectItem>
                  <SelectItem value="DRAFT">{t('advertisingPage.status.DRAFT')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('advertisingPage.actions.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="edit-save">
            {t('advertisingPage.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
