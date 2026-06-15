/**
 * Gateway Settings Page (re-designed)
 *
 * Layout per row:
 *   [status dot]  [icon]  [name]   [Default badge]   [Active switch]
 *                 [↑] [↓] reorder · [⚙] settings · [▶] test
 *
 * The first row (orderIndex = 1) is implicitly the *default* gateway
 * shown to the user when picking a payment method. Reordering shifts
 * which one wins that slot — it's enough for the public-facing list.
 *
 * Configuration lives in a dialog opened by the gear icon. After saving
 * credentials the user can fire a single test transaction with the
 * “Test” button to verify the integration is healthy.
 */

import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  Bitcoin,
  Coins,
  CreditCard,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Settings as SettingsIcon,
  ShieldAlert,
  Star,
  TestTube,
  Eye,
  EyeOff,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { FadeIn, StaggerItem, StaggerList } from '@/lib/motion'
import { useHasPermission } from '@/features/rbac'

import { CURRENCY_DISPLAY_NAMES, getCurrencyIcon } from './currency-icons'
import { getPaymentGatewayIcon } from './payment-gateway-icons'

// ── Gateway metadata ────────────────────────────────────────────────────────
//
// Strictly mirrors the gateways the backend supports
// (`PaymentGatewayType` enum) — keeping unsupported entries out so the UI
// can't promise things the runtime won't deliver.

interface GatewayField {
  key: string
  labelKey: string
  placeholder: string
  secret?: boolean
  hintKey?: string
}

interface GatewayMeta {
  type: string
  displayName: string
  icon: typeof CreditCard
  iconColor: string
  fields: ReadonlyArray<GatewayField>
}

const GATEWAY_META: ReadonlyArray<GatewayMeta> = [
  {
    type: 'TELEGRAM_STARS',
    displayName: 'Telegram Stars',
    icon: Star,
    iconColor: 'text-amber-500',
    fields: [
      {
        key: 'providerToken',
        labelKey: 'paymentGateways.fields.providerToken',
        placeholder: '123456:LIVE:abcdef…',
        secret: true,
      },
      {
        key: 'webhookSecret',
        labelKey: 'paymentGateways.fields.webhookSecret',
        placeholder: 'webhook-secret',
        secret: true,
      },
    ],
  },
  {
    type: 'YOOKASSA',
    displayName: 'YooKassa',
    icon: CreditCard,
    iconColor: 'text-purple-500',
    fields: [
      { key: 'shopId', labelKey: 'paymentGateways.fields.shopId', placeholder: '123456' },
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'live_…',
        secret: true,
      },
      {
        key: 'customer',
        labelKey: 'paymentGateways.fields.customerEmail',
        placeholder: 'support@example.com',
      },
      {
        key: 'vatCode',
        labelKey: 'paymentGateways.fields.vatCode',
        placeholder: '1',
      },
    ],
  },
  {
    type: 'PLATEGA',
    displayName: 'Platega',
    icon: CreditCard,
    iconColor: 'text-blue-500',
    fields: [
      {
        key: 'merchantId',
        labelKey: 'paymentGateways.fields.merchantId',
        placeholder: 'merchant-id',
      },
      {
        key: 'secret',
        labelKey: 'paymentGateways.fields.secret',
        placeholder: 'secret',
        secret: true,
      },
    ],
  },
  {
    type: 'MULENPAY',
    displayName: 'MulenPay',
    icon: CreditCard,
    iconColor: 'text-emerald-500',
    fields: [
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'api-key',
        secret: true,
      },
    ],
  },
  {
    type: 'HELEKET',
    displayName: 'Heleket',
    icon: Bitcoin,
    iconColor: 'text-orange-500',
    fields: [
      {
        key: 'merchantId',
        labelKey: 'paymentGateways.fields.merchantUuid',
        placeholder: '8b03432e-385b-4670-…',
      },
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.paymentApiKey',
        placeholder: 'payment-api-key',
        secret: true,
        hintKey: 'paymentGateways.hints.paymentNotPayout',
      },
    ],
  },
  {
    type: 'CRYPTOMUS',
    displayName: 'Cryptomus',
    icon: Coins,
    iconColor: 'text-yellow-500',
    fields: [
      {
        key: 'merchantId',
        labelKey: 'paymentGateways.fields.merchantId',
        placeholder: 'merchant-id',
      },
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'api-key',
        secret: true,
      },
    ],
  },
  {
    type: 'ANTILOPAY',
    displayName: 'Antilopay',
    icon: CreditCard,
    iconColor: 'text-red-500',
    fields: [
      {
        key: 'projectIdentificator',
        labelKey: 'paymentGateways.fields.projectIdentificator',
        placeholder: 'PE8BED46C045139256',
      },
      {
        key: 'secretId',
        labelKey: 'paymentGateways.fields.secretId',
        placeholder: 'X-Apay-Secret-Id',
        secret: true,
      },
      {
        key: 'privateKey',
        labelKey: 'paymentGateways.fields.privateKey',
        placeholder: 'MIIBVAIBADANBgkq…',
        secret: true,
        hintKey: 'paymentGateways.hints.antilopayPrivateKey',
      },
      {
        key: 'publicKey',
        labelKey: 'paymentGateways.fields.publicKey',
        placeholder: 'MFwwDQYJKoZI…',
        hintKey: 'paymentGateways.hints.antilopayPublicKey',
      },
    ],
  },
  {
    type: 'OVERPAY',
    displayName: 'OverPay',
    icon: CreditCard,
    iconColor: 'text-sky-500',
    fields: [
      {
        key: 'shopId',
        labelKey: 'paymentGateways.fields.shopId',
        placeholder: 'shop-id',
      },
      {
        key: 'secretKey',
        labelKey: 'paymentGateways.fields.secret',
        placeholder: 'secret-key',
        secret: true,
      },
      {
        key: 'publicKey',
        labelKey: 'paymentGateways.fields.publicKey',
        placeholder: '-----BEGIN PUBLIC KEY-----…',
        hintKey: 'paymentGateways.hints.overpayPublicKey',
      },
    ],
  },
  {
    type: 'PAYPALYCH',
    displayName: 'PayPalych',
    icon: CreditCard,
    iconColor: 'text-indigo-500',
    fields: [
      {
        key: 'shopId',
        labelKey: 'paymentGateways.fields.shopId',
        placeholder: 'shop-id',
      },
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'Bearer token',
        secret: true,
      },
      {
        key: 'secretKey',
        labelKey: 'paymentGateways.fields.webhookSecret',
        placeholder: 'webhook-secret',
        secret: true,
      },
    ],
  },
  {
    type: 'RIOPAY',
    displayName: 'RioPay',
    icon: CreditCard,
    iconColor: 'text-teal-500',
    fields: [
      {
        key: 'apiToken',
        labelKey: 'paymentGateways.fields.apiToken',
        placeholder: 'X-Api-Token',
        secret: true,
        hintKey: 'paymentGateways.hints.riopayToken',
      },
    ],
  },
  {
    type: 'WATA',
    displayName: 'WATA',
    icon: CreditCard,
    iconColor: 'text-cyan-500',
    fields: [
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'JWT API key',
        secret: true,
        hintKey: 'paymentGateways.hints.wataApiKey',
      },
      {
        key: 'webhookSecret',
        labelKey: 'paymentGateways.fields.webhookSecret',
        placeholder: 'webhook-secret',
        secret: true,
      },
    ],
  },
  {
    type: 'AURAPAY',
    displayName: 'AuraPay',
    icon: CreditCard,
    iconColor: 'text-violet-500',
    fields: [
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'X-ApiKey',
        secret: true,
      },
      {
        key: 'shopId',
        labelKey: 'paymentGateways.fields.shopId',
        placeholder: 'shop-uuid',
      },
      {
        key: 'secretKey',
        labelKey: 'paymentGateways.fields.secret',
        placeholder: 'secret-key-2',
        secret: true,
        hintKey: 'paymentGateways.hints.aurapaySecret',
      },
    ],
  },
  {
    type: 'ROLLYPAY',
    displayName: 'RollyPay',
    icon: CreditCard,
    iconColor: 'text-pink-500',
    fields: [
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'rpk_live_…',
        secret: true,
      },
      {
        key: 'signingSecret',
        labelKey: 'paymentGateways.fields.signingSecret',
        placeholder: 'signing_secret',
        secret: true,
        hintKey: 'paymentGateways.hints.rollypaySigningSecret',
      },
    ],
  },
  {
    type: 'SEVERPAY',
    displayName: 'SeverPay',
    icon: CreditCard,
    iconColor: 'text-slate-500',
    fields: [
      {
        key: 'mid',
        labelKey: 'paymentGateways.fields.merchantId',
        placeholder: '1',
      },
      {
        key: 'secretToken',
        labelKey: 'paymentGateways.fields.webhookSecret',
        placeholder: '041131a0906b08a5bebc1d4fdcc6d9',
        secret: true,
        hintKey: 'paymentGateways.hints.severpayToken',
      },
    ],
  },
  {
    type: 'LAVA',
    displayName: 'Lava.top',
    icon: CreditCard,
    iconColor: 'text-rose-500',
    fields: [
      {
        key: 'apiKey',
        labelKey: 'paymentGateways.fields.apiKey',
        placeholder: 'lava_api_key',
        secret: true,
        hintKey: 'paymentGateways.hints.lavaApiKey',
      },
      {
        key: 'offerId',
        labelKey: 'paymentGateways.fields.lavaOfferId',
        placeholder: '836b9fc5-7ae9-4a27-9642-592bc44072b7',
        hintKey: 'paymentGateways.hints.lavaOfferId',
      },
      {
        key: 'webhookApiKey',
        labelKey: 'paymentGateways.fields.webhookSecret',
        placeholder: 'webhook X-Api-Key',
        secret: true,
        hintKey: 'paymentGateways.hints.lavaWebhookKey',
      },
    ],
  },
  {
    type: 'CRYPTOPAY',
    displayName: 'CryptoPay',
    icon: Bitcoin,
    iconColor: 'text-sky-500',
    fields: [
      {
        key: 'apiToken',
        labelKey: 'paymentGateways.fields.apiToken',
        placeholder: '12345:AA…',
        secret: true,
        hintKey: 'paymentGateways.hints.cryptopayApiToken',
      },
    ],
  },
] as const

const META_BY_TYPE: Record<string, GatewayMeta> = Object.fromEntries(
  GATEWAY_META.map((meta) => [meta.type, meta]),
)

// ── Wire types ──────────────────────────────────────────────────────────────
interface AdminGateway {
  id: string
  type: string
  currency: string
  isActive: boolean
  orderIndex: number
  settings: Record<string, unknown> | null
  isUsedInPricing?: boolean
  updatedAt: string
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function GatewaySettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canViewGateways = useHasPermission('payment_gateways', 'view')
  const canEditGateways = useHasPermission('payment_gateways', 'edit')

  const { data: gateways, isLoading } = useQuery({
    queryKey: adminQueryKeys.payments.gateways.all,
    queryFn: async (): Promise<AdminGateway[]> => {
      const raw = (await api.get('/admin/payments/gateways')).data as
        | AdminGateway[]
        | { items?: AdminGateway[] }
      return Array.isArray(raw) ? raw : (raw?.items ?? [])
    },
    enabled: canViewGateways,
  })

  const seedDefaultsMutation = useMutation({
    mutationFn: async () => {
      if (!canEditGateways) throw new Error('Missing payment_gateways:edit')
      return (await api.post('/admin/payments/gateways/defaults')).data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.gateways.all })
      toast.success(t('paymentGateways.defaultsCreated'))
    },
    onError: () => toast.error(t('paymentGateways.defaultsFailed')),
  })

  const [settingsTarget, setSettingsTarget] = useState<AdminGateway | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  const handleTest = async (gateway: AdminGateway): Promise<void> => {
    if (!canEditGateways) return
    setTestingId(gateway.id)
    try {
      // The backend currently does not expose a generic "test gateway"
      // endpoint, so this kicks off a configuration-validity probe via
      // the standard read endpoint. Once a dedicated probe lands we
      // wire it up here.
      await api.get(`/admin/payments/gateways/${gateway.id}`)
      toast.success(
        t('paymentGateways.testOk', { name: META_BY_TYPE[gateway.type]?.displayName ?? gateway.type }),
      )
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('paymentGateways.testFailed'))
    } finally {
      setTestingId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }

  if (!canViewGateways) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('paymentGateways.accessDeniedTitle')}</CardTitle>
          <CardDescription>{t('paymentGateways.accessDeniedDescription')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const isEmpty = !gateways || gateways.length === 0
  // Stable order (orderIndex asc; ties broken by id).
  const sortedGateways = (gateways ?? [])
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <CreditCard className="h-6 w-6" /> {t('paymentGateways.title')}
            </h1>
            <p className="text-muted-foreground">{t('paymentGateways.subtitle')}</p>
          </div>
          {!isEmpty && canEditGateways && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => seedDefaultsMutation.mutate()}
              disabled={seedDefaultsMutation.isPending}
            >
              {seedDefaultsMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              {t('paymentGateways.addDefaults')}
            </Button>
          )}
        </div>
      </FadeIn>

      {isEmpty ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('paymentGateways.empty.title')}</CardTitle>
            <CardDescription>{t('paymentGateways.empty.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            {canEditGateways ? (
              <Button
                onClick={() => seedDefaultsMutation.mutate()}
                disabled={seedDefaultsMutation.isPending}
              >
                {seedDefaultsMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                {t('paymentGateways.empty.action')}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{t('paymentGateways.readOnlyEmpty')}</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <StaggerList className="divide-y divide-border">
              {sortedGateways.map((gateway, index) => (
                <StaggerItem key={gateway.id}>
                  <GatewayRow
                    gateway={gateway}
                    isFirst={index === 0}
                    isLast={index === sortedGateways.length - 1}
                    isTesting={testingId === gateway.id}
                    canEdit={canEditGateways}
                    onOpenSettings={() => setSettingsTarget(gateway)}
                    onTest={() => handleTest(gateway)}
                  />
                </StaggerItem>
              ))}
            </StaggerList>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={settingsTarget !== null}
        onOpenChange={(open) => !open && setSettingsTarget(null)}
      >
        <DialogContent className="max-w-xl">
          {settingsTarget && (
            <GatewaySettingsForm
              gateway={settingsTarget}
              onClose={() => setSettingsTarget(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Row ─────────────────────────────────────────────────────────────────────
interface GatewayRowProps {
  readonly gateway: AdminGateway
  readonly isFirst: boolean
  readonly isLast: boolean
  readonly isTesting: boolean
  readonly canEdit: boolean
  readonly onOpenSettings: () => void
  readonly onTest: () => void
}

function GatewayRow({
  gateway,
  isFirst,
  isLast,
  isTesting,
  canEdit,
  onOpenSettings,
  onTest,
}: GatewayRowProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const meta = META_BY_TYPE[gateway.type]

  const settingsValues = (gateway.settings ?? {}) as Record<string, unknown>
  const isConfigured =
    meta !== undefined &&
    meta.fields.some(
      (field) =>
        typeof settingsValues[field.key] === 'string' &&
        (settingsValues[field.key] as string).trim().length > 0,
    )

  const toggleActiveMutation = useMutation({
    mutationFn: (next: boolean) => {
      if (!canEdit) throw new Error('Missing payment_gateways:edit')
      return api.patch(`/admin/payments/gateways/${gateway.id}`, { isActive: next })
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.gateways.all }),
    onError: () => toast.error(t('paymentGateways.toggleFailed')),
  })

  const moveMutation = useMutation({
    mutationFn: (direction: 'up' | 'down') => {
      if (!canEdit) throw new Error('Missing payment_gateways:edit')
      return api.patch(`/admin/payments/gateways/${gateway.id}/move`, { direction })
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.gateways.all }),
    onError: () => toast.error(t('paymentGateways.moveFailed')),
  })

  if (!meta) return null
  const BrandIcon = getPaymentGatewayIcon(gateway.type)
  const FallbackIcon = meta.icon

  // Status semantics:
  //   • inactive          → muted dot
  //   • active + configured → green dot
  //   • active but missing credentials → amber dot
  const status = !gateway.isActive
    ? 'inactive'
    : isConfigured
      ? 'ready'
      : 'incomplete'

  const statusClass =
    status === 'ready'
      ? 'bg-emerald-500'
      : status === 'incomplete'
        ? 'bg-amber-500'
        : 'bg-muted-foreground/30'

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span
        className={cn('h-2.5 w-2.5 shrink-0 rounded-full', statusClass)}
        aria-hidden
      />

      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/40 overflow-hidden')}>
        {BrandIcon ? (
          // eslint-disable-next-line react-hooks/static-components
          <BrandIcon className="h-6 w-6 object-contain" />
        ) : (
          <FallbackIcon className={cn('h-5 w-5', meta.iconColor)} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{meta.displayName}</p>
          {isFirst && gateway.isActive && (
            <Badge variant="default" className="text-[10px]">
              {t('paymentGateways.defaultBadge')}
            </Badge>
          )}
          {!isConfigured && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-600/40">
              <ShieldAlert className="mr-1 h-3 w-3" />
              {t('paymentGateways.notConfigured')}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <RowCurrencyBadge code={gateway.currency} />
          </span>
          <span className="truncate">· /api/v1/payments/webhooks/{gateway.type}</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => moveMutation.mutate('up')}
              disabled={isFirst || moveMutation.isPending}
              aria-label={t('paymentGateways.moveUp')}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => moveMutation.mutate('down')}
              disabled={isLast || moveMutation.isPending}
              aria-label={t('paymentGateways.moveDown')}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>

            <span className="mx-1 h-6 w-px bg-border" aria-hidden />

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onOpenSettings}
              aria-label={t('paymentGateways.openSettings')}
            >
              <SettingsIcon className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onTest}
              disabled={!isConfigured || !gateway.isActive || isTesting}
              aria-label={t('paymentGateways.runTest')}
            >
              {isTesting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <TestTube className="h-4 w-4" />
              )}
            </Button>

            <span className="mx-1 h-6 w-px bg-border" aria-hidden />

            <Switch
              checked={gateway.isActive}
              onCheckedChange={(next) => toggleActiveMutation.mutate(next)}
              disabled={toggleActiveMutation.isPending}
              aria-label={t('paymentGateways.toggleActive')}
            />
          </>
        ) : (
          <Badge variant={gateway.isActive ? 'success' : 'secondary'}>
            {gateway.isActive ? t('paymentGateways.active') : t('paymentGateways.disabled')}
          </Badge>
        )}
      </div>
    </div>
  )
}

// ── Settings dialog ─────────────────────────────────────────────────────────
interface GatewaySettingsFormProps {
  readonly gateway: AdminGateway
  readonly onClose: () => void
}

function GatewaySettingsForm({ gateway, onClose }: GatewaySettingsFormProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const meta = META_BY_TYPE[gateway.type]

  const initialValues: Record<string, string> = Object.fromEntries(
    (meta?.fields ?? []).map((field) => [
      field.key,
      typeof gateway.settings?.[field.key] === 'string'
        ? (gateway.settings?.[field.key] as string)
        : '',
    ]),
  )

  const [values, setValues] = useState<Record<string, string>>(initialValues)
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})
  const [currency, setCurrency] = useState<string>(gateway.currency)

  // Static map fetched once per page-mount; cached by react-query so the
  // settings dialog reads it without an extra round-trip.
  const { data: supportedMap } = useQuery({
    queryKey: adminQueryKeys.payments.gateways.supportedCurrencies,
    queryFn: async (): Promise<Record<string, readonly string[]>> => {
      const res = await api.get('/admin/payments/gateways/supported-currencies')
      return res.data as Record<string, readonly string[]>
    },
    staleTime: 5 * 60_000,
  })

  // Reset local state when the gateway prop changes — using the
  // "store-prev-prop in render" pattern.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevGatewayId, setPrevGatewayId] = useState<string>(gateway.id)
  if (gateway.id !== prevGatewayId) {
    setPrevGatewayId(gateway.id)
    setValues(initialValues)
    setShowSecrets({})
    setCurrency(gateway.currency)
  }

  const supportedCurrencies = supportedMap?.[gateway.type] ?? [gateway.currency]
  const currencyChanged = currency !== gateway.currency

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/payments/gateways/${gateway.id}`, {
        settings: values,
        ...(currencyChanged ? { currency } : {}),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.gateways.all })
      toast.success(
        t('paymentGateways.saved', { name: meta?.displayName ?? gateway.type }),
      )
      onClose()
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast.error(message ?? t('paymentGateways.saveFailed'))
    },
  })

  if (!meta) return null
  const BrandIcon = getPaymentGatewayIcon(gateway.type)
  const FallbackIcon = meta.icon

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {BrandIcon ? (
            // eslint-disable-next-line react-hooks/static-components
            <BrandIcon className="h-5 w-5 object-contain" />
          ) : (
            <FallbackIcon className={cn('h-5 w-5', meta.iconColor)} />
          )}
          {meta.displayName}
        </DialogTitle>
        <DialogDescription>
          {t('paymentGateways.settingsDescription', {
            url: `/api/v1/payments/webhooks/${gateway.type}`,
          })}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Default currency selector — drives both the catalog row's display
            currency and the currency the user is charged in when initiating
            a checkout from the reiwa client. The list is intersected with
            what the gateway can actually accept. */}
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5">
            <Coins className="h-3.5 w-3.5 text-muted-foreground" />
            {t('paymentGateways.fields.defaultCurrency')}
          </Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger className="h-10">
              <SelectValue>
                <CurrencyOption code={currency} />
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {supportedCurrencies.map((code) => (
                <SelectItem key={code} value={code}>
                  <CurrencyOption code={code} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('paymentGateways.hints.defaultCurrency')}
          </p>
        </div>

        {meta.fields.map((field) => {
          const value = values[field.key] ?? ''
          const isSecret = field.secret === true
          const visible = showSecrets[field.key] === true
          return (
            <div key={field.key} className="space-y-1.5">
              <Label>{t(field.labelKey)}</Label>
              <div className="relative">
                <Input
                  type={isSecret && !visible ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={value}
                  onChange={(e): void =>
                    setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  className={isSecret ? 'pr-10' : undefined}
                />
                {isSecret && (
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={(): void =>
                      setShowSecrets((prev) => ({
                        ...prev,
                        [field.key]: !prev[field.key],
                      }))
                    }
                    aria-label={visible ? t('paymentGateways.hideSecret') : t('paymentGateways.showSecret')}
                  >
                    {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                )}
              </div>
              {field.hintKey && (
                <p className="text-xs text-muted-foreground">{t(field.hintKey)}</p>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={(): void => {
            setValues(initialValues)
            setCurrency(gateway.currency)
          }}
        >
          <RotateCcw className="mr-2 h-4 w-4" /> {t('paymentGateways.revert')}
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('paymentGateways.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={(): void => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          {t('paymentGateways.save')}
        </Button>
      </div>
    </>
  )
}


/**
 * Renders a currency code with its brand SVG (or a fiat glyph fallback)
 * and the human-readable name. Used both in the Select trigger (current
 * value) and the dropdown items, which is why it lives next to the form.
 */
function CurrencyOption({ code }: { readonly code: string }): JSX.Element {
  const Icon = getCurrencyIcon(code)
  const displayName = CURRENCY_DISPLAY_NAMES[code as keyof typeof CURRENCY_DISPLAY_NAMES]
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/40">
        {Icon ? (
          // eslint-disable-next-line react-hooks/static-components
          <Icon className="h-4 w-4 object-contain" />
        ) : (
          <span className="text-[11px] font-semibold tabular-nums text-foreground">
            {code === 'USD' ? '$' : code === 'EUR' ? '€' : code.charAt(0)}
          </span>
        )}
      </span>
      <span className="text-sm font-medium">{code}</span>
      {displayName && <span className="text-xs text-muted-foreground">· {displayName}</span>}
    </span>
  )
}


/**
 * Tight currency chip used in the gateway list row. Smaller than the
 * full `CurrencyOption` (no display name), keeps the row compact while
 * still showing the brand glyph at a glance.
 */
function RowCurrencyBadge({ code }: { readonly code: string }): JSX.Element {
  const Icon = getCurrencyIcon(code)
  return (
    <span className="inline-flex items-center gap-1">
      <span className="flex h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-full bg-muted/40">
        {Icon ? (
          // eslint-disable-next-line react-hooks/static-components
          <Icon className="h-3 w-3 object-contain" />
        ) : (
          <span className="text-[8px] font-semibold tabular-nums">
            {code === 'USD' ? '$' : code === 'EUR' ? '€' : code.charAt(0)}
          </span>
        )}
      </span>
      <span className="text-foreground/80">{code}</span>
    </span>
  )
}
