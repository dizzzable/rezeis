/**
 * Gateway Settings Page (re-designed)
 *
 * Layout per row:
 *   [status dot]  [icon]  [name]   [Default badge]   [Active switch]
 *                 [↑] [↓] reorder · [⚙] settings
 *
 * The first row (orderIndex = 1) is implicitly the *default* gateway
 * shown to the user when picking a payment method. Reordering shifts
 * which one wins that slot — it's enough for the public-facing list.
 *
 * Configuration lives in a dialog opened by the gear icon. Readiness comes
 * from the backend (`isConfigured`) rather than being guessed here — there
 * used to be a “Test” button next to the gear that only re-read the gateway
 * row and always reported success, so it certified gateways that could not
 * receive a single webhook. Removed rather than left as a false green; a
 * real probe would have to call the provider from the server.
 *
 * That same `isConfigured` is now load-bearing rather than advisory: the
 * checkout guard refuses on it, so `isActive && !isConfigured` is not a
 * half-finished setup, it is a gateway turning buyers away. `isGatewayFaulted`
 * is the only place that combination is named, and it drives a destructive row
 * rail plus a page-level banner. Everything else on the page stays quiet on
 * purpose — an unconfigured gateway that is switched off is the resting state
 * of most of this list.
 *
 * Credentials are encrypted at rest and reads are permission-gated: without
 * `payment_gateways:view_secrets` the API returns each stored secret as
 * `********` plus its real last 4 characters, and says so via `secretsVisible`
 * / `configuredSecretKeys`. The form renders what it is given, so that operator
 * used to meet an unexplained `********c8e5` in a field with no way to tell a
 * redaction from a corrupted value. `secretsHidden` in the settings dialog is
 * the only place that state is named — and it is named nowhere at all for a
 * caller who can read the real values, since for them there is nothing to
 * explain.
 */

import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  Bitcoin,
  Coins,
  Copy,
  CreditCard,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Settings as SettingsIcon,
  Star,
  TriangleAlert,
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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

interface GatewayFieldOption {
  value: string
  labelKey: string
}

interface GatewayField {
  key: string
  labelKey: string
  placeholder: string
  secret?: boolean
  hintKey?: string
  /** Render as a Select / Switch instead of a text input. */
  type?: 'text' | 'select' | 'toggle'
  options?: ReadonlyArray<GatewayFieldOption>
  /**
   * Offer a «not set» entry above the options. For a setting whose correct
   * value can genuinely be «none» — Antilopay's `vat` is required on ОСНО and
   * must stay unset on УСН/НПД — a plain dropdown is a one-way door: Radix
   * reserves `''` for «nothing selected» and refuses a `SelectItem` carrying
   * it, so once the list is opened there is no way back to unset.
   */
  clearable?: boolean
  /**
   * Only render this field when the referenced boolean field's value is
   * `'true'`. Used to collapse the whole «Мой Налог» (self-employed) block
   * behind its enable toggle so it appears only when sync is turned on.
   */
  dependsOn?: string
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
      {
        key: 'savePaymentMethod',
        labelKey: 'paymentGateways.fields.savePaymentMethod',
        placeholder: '',
        type: 'toggle',
        hintKey: 'paymentGateways.hints.savePaymentMethod',
      },
      {
        key: 'selfEmployedEnabled',
        labelKey: 'paymentGateways.fields.selfEmployedEnabled',
        placeholder: '',
        type: 'toggle',
        hintKey: 'paymentGateways.hints.selfEmployedEnabled',
      },
      {
        key: 'moyNalogAuthMethod',
        labelKey: 'paymentGateways.fields.moyNalogAuthMethod',
        placeholder: '',
        type: 'select',
        dependsOn: 'selfEmployedEnabled',
        options: [
          { value: 'password', labelKey: 'paymentGateways.options.moyNalogAuthPassword' },
          { value: 'refresh', labelKey: 'paymentGateways.options.moyNalogAuthRefresh' },
        ],
        hintKey: 'paymentGateways.hints.moyNalogAuthMethod',
      },
      {
        key: 'moyNalogInn',
        labelKey: 'paymentGateways.fields.moyNalogInn',
        placeholder: '7707083893',
        dependsOn: 'selfEmployedEnabled',
        hintKey: 'paymentGateways.hints.moyNalogInn',
      },
      {
        key: 'moyNalogPassword',
        labelKey: 'paymentGateways.fields.moyNalogPassword',
        placeholder: '••••••••',
        secret: true,
        dependsOn: 'selfEmployedEnabled',
        hintKey: 'paymentGateways.hints.moyNalogPassword',
      },
      {
        key: 'moyNalogRefreshToken',
        labelKey: 'paymentGateways.fields.moyNalogRefreshToken',
        placeholder: 'refresh-token',
        secret: true,
        dependsOn: 'selfEmployedEnabled',
        hintKey: 'paymentGateways.hints.moyNalogRefreshToken',
      },
      {
        key: 'moyNalogDeviceId',
        labelKey: 'paymentGateways.fields.moyNalogDeviceId',
        placeholder: 'auto from INN',
        dependsOn: 'selfEmployedEnabled',
        hintKey: 'paymentGateways.hints.moyNalogDeviceId',
      },
      {
        key: 'moyNalogProxy',
        labelKey: 'paymentGateways.fields.moyNalogProxy',
        placeholder: 'socks5h://user:pass@host:1080',
        secret: true,
        dependsOn: 'selfEmployedEnabled',
        hintKey: 'paymentGateways.hints.moyNalogProxy',
      },
      {
        key: 'incomeDescriptionTemplate',
        labelKey: 'paymentGateways.fields.incomeDescriptionTemplate',
        placeholder: 'Платеж #{description}',
        dependsOn: 'selfEmployedEnabled',
        hintKey: 'paymentGateways.hints.incomeDescriptionTemplate',
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
      {
        // Platega's own enum, verbatim — the numbers are part of every label
        // because they are what the provider's dashboard and support speak in,
        // and because the ambiguity is what caused the outage: the panel used
        // to send `CARD` as method 1, which Platega does not have, so every
        // card checkout came back without a link. A free-text box here would
        // ask the operator to remember six magic numbers and would silently
        // reroute the whole gateway to a different rail on a typo.
        key: 'paymentMethod',
        labelKey: 'paymentGateways.fields.plategaPaymentMethod',
        placeholder: '',
        type: 'select',
        options: [
          { value: '2', labelKey: 'paymentGateways.options.plategaSbp' },
          { value: '3', labelKey: 'paymentGateways.options.plategaErip' },
          { value: '11', labelKey: 'paymentGateways.options.plategaCard' },
          { value: '12', labelKey: 'paymentGateways.options.plategaInternational' },
          { value: '13', labelKey: 'paymentGateways.options.plategaCrypto' },
          { value: '14', labelKey: 'paymentGateways.options.plategaSberpay' },
        ],
        hintKey: 'paymentGateways.hints.plategaPaymentMethod',
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
      {
        // «Ставка ндс, возможные значения: 10, 22. Поле обязательное, если
        // сно Мерчанта - ОСНО» — Antilopay's own wording. A merchant on ОСНО
        // gets error 17 on every checkout until this is stored, so the whole
        // gateway is dead for that tax regime; a merchant on УСН/НПД must
        // leave it unset. Only two rates exist and neither can be guessed for
        // the merchant, which is why it is a clearable select rather than a
        // free-text box that would invite a third value the API rejects.
        key: 'vat',
        labelKey: 'paymentGateways.fields.antilopayVat',
        placeholder: '',
        type: 'select',
        clearable: true,
        options: [
          { value: '10', labelKey: 'paymentGateways.options.antilopayVat10' },
          { value: '22', labelKey: 'paymentGateways.options.antilopayVat22' },
        ],
        hintKey: 'paymentGateways.hints.antilopayVat',
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
      {
        key: 'serviceId',
        labelKey: 'paymentGateways.fields.serviceId',
        placeholder: '1',
        hintKey: 'paymentGateways.hints.riopayServiceId',
      },
    ],
  },
  {
    type: 'VALUTIX',
    displayName: 'Valutix',
    icon: CreditCard,
    iconColor: 'text-green-500',
    fields: [
      {
        key: 'apiToken',
        labelKey: 'paymentGateways.fields.apiToken',
        placeholder: 'X-Api-Token',
        secret: true,
        hintKey: 'paymentGateways.hints.valutixToken',
      },
      {
        // Same platform engine as RioPay, down to the field name.
        key: 'serviceId',
        labelKey: 'paymentGateways.fields.serviceId',
        placeholder: '1',
        hintKey: 'paymentGateways.hints.valutixServiceId',
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
        // Wata signs webhooks with SHA512withRSA and has no shared secret, so
        // the `webhookSecret` this form used to offer was dead — the verifier
        // reads `publicKey`, and a save from here replaces the whole settings
        // object, wiping any key inserted straight into the database.
        key: 'publicKey',
        labelKey: 'paymentGateways.fields.publicKey',
        placeholder: '-----BEGIN RSA PUBLIC KEY-----…',
        hintKey: 'paymentGateways.hints.wataPublicKey',
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
  /**
   * Backend verdict (`isGatewayConfigured`) — the same rule that decides
   * whether a checkout may be issued. The page used to derive readiness on
   * its own from "any non-empty field", which went green for gateways the
   * backend would refuse.
   */
  isConfigured: boolean
  /**
   * Whether `settings` carries real secret values or their masks — the
   * backend's verdict on the CALLER (`payment_gateways:view_secrets`), not on
   * the row. Optional, and absence means "real values": the masked treatment
   * must only ever appear because the backend actually masked something, never
   * because a field was missing from the response.
   */
  secretsVisible?: boolean
  /**
   * Secret-bearing keys that hold a stored value. Reported the same way for
   * both audiences, which is what makes it the only honest way to tell «set but
   * hidden» from «not set» — the masked string itself is a redaction and says
   * nothing about what is behind it.
   */
  configuredSecretKeys?: readonly string[]
  /** Absolute callback URL, so the operator can paste it into the provider. */
  webhookUrl: string
  isUsedInPricing?: boolean
  updatedAt: string
}

/**
 * The one combination that is an outage rather than a state.
 *
 * `isConfigured` used to be advisory — a nudge to finish setting a gateway up.
 * It is now load-bearing: the checkout guard reads the same verdict and answers
 * `PAYMENT_GATEWAY_NOT_CONFIGURED` (400) on every attempt, and the credential
 * set it demands grew to include the webhook key (Antilopay/OverPay/WATA
 * `publicKey`, AuraPay `secretKey`, RollyPay `signingSecret`, Lava
 * `webhookApiKey`). A gateway that has been taking money for months can
 * therefore go dead on deploy, with the Switch still reading Active, the
 * «Default» badge still showing, and the row still first in the buyer's picker
 * — an operator has no reason to touch the toggle, which was the only place
 * the panel ever said a word about it.
 *
 * Deliberately narrow. `!isActive && !isConfigured` is the resting state of
 * the fifteen gateways nobody uses; alarming on that would put a warning on
 * almost every row and bury the one that is losing money.
 */
function isGatewayFaulted(gateway: AdminGateway): boolean {
  return gateway.isActive && !gateway.isConfigured
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

  // Money is being lost right now on each of these. The row treatment alone
  // relies on the operator scanning far enough down a seventeen-row list and
  // reading a colour as an alarm; the banner states it once, at the top, in
  // words, and names the gateways so it survives being skimmed.
  const faultedGateways = sortedGateways.filter(isGatewayFaulted)

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

      {faultedGateways.length > 0 && (
        <FadeIn>
          <Alert variant="destructive" className="border-destructive/50 bg-destructive/5">
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>{t('paymentGateways.faulted.bannerTitle')}</AlertTitle>
            <AlertDescription>
              {t('paymentGateways.faulted.bannerDescription', {
                names: faultedGateways
                  .map((gateway) => META_BY_TYPE[gateway.type]?.displayName ?? gateway.type)
                  .join(', '),
              })}
            </AlertDescription>
          </Alert>
        </FadeIn>
      )}

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
                    canEdit={canEditGateways}
                    onOpenSettings={() => setSettingsTarget(gateway)}
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
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
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
  readonly canEdit: boolean
  readonly onOpenSettings: () => void
}

function GatewayRow({
  gateway,
  isFirst,
  isLast,
  canEdit,
  onOpenSettings,
}: GatewayRowProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const meta = META_BY_TYPE[gateway.type]

  const toggleActiveMutation = useMutation({
    mutationFn: (next: boolean) => {
      if (!canEdit) throw new Error('Missing payment_gateways:edit')
      return api.patch(`/admin/payments/gateways/${gateway.id}`, { isActive: next })
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.payments.gateways.all }),
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      // The backend refuses to activate a gateway that cannot issue a
      // checkout; the bare product code would read as gibberish to an
      // operator, so it gets its own sentence.
      toast.error(
        message === 'PAYMENT_GATEWAY_NOT_CONFIGURED'
          ? t('paymentGateways.enableBlocked')
          : t('paymentGateways.toggleFailed'),
      )
    },
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
  //   • inactive                       → muted dot (idle; the common resting
  //                                      state, and nothing is wrong with it)
  //   • active + configured            → green dot
  //   • active + missing credentials   → destructive: live in the picker,
  //                                      dead at the till (see isGatewayFaulted)
  const isFaulted = isGatewayFaulted(gateway)
  const status = !gateway.isActive ? 'inactive' : gateway.isConfigured ? 'ready' : 'faulted'

  const statusClass =
    status === 'ready'
      ? 'bg-emerald-500'
      : status === 'faulted'
        ? 'bg-destructive'
        : 'bg-muted-foreground/30'

  return (
    <div
      className={cn(
        'flex items-center gap-4 px-4 py-3',
        // Left rail rather than a full tint: it survives being skimmed at the
        // edge of vision, and the 2px it takes is given back out of the
        // padding so the icons stay on the same column as every other row.
        isFaulted && 'border-l-2 border-l-destructive bg-destructive/5 pl-[14px]',
      )}
    >
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
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{meta.displayName}</p>
          {isFirst && gateway.isActive && (
            // The badge is kept on a faulted gateway on purpose — that the
            // broken rail is the one buyers meet first is the worst part of
            // this, not something to hide — but the solid primary fill reads
            // as an endorsement, so it drops to a destructive outline.
            <Badge
              variant={isFaulted ? 'outline' : 'default'}
              className={cn('text-[10px]', isFaulted && 'border-destructive/40 text-destructive')}
            >
              {t('paymentGateways.defaultBadge')}
            </Badge>
          )}
          {isFaulted ? (
            <Badge variant="destructive" className="text-[10px]">
              <TriangleAlert className="mr-1 h-3 w-3" />
              {t('paymentGateways.faulted.badge')}
            </Badge>
          ) : !gateway.isConfigured ? (
            // Switched off and unset: a to-do, not an incident. It used to be
            // amber with an alarm glyph, which is the same visual weight the
            // outage now needs — and with fifteen idle gateways wearing it,
            // amber had stopped meaning anything.
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {t('paymentGateways.notConfigured')}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <RowCurrencyBadge code={gateway.currency} />
          </span>
          <span className="truncate">· {gateway.webhookUrl}</span>
        </div>
        {isFaulted && (
          // Says what is happening and what to do, in the operator's terms.
          // A colour and a badge say "something is off"; only a sentence says
          // "buyers are being turned away and here is the fix".
          <p className="mt-1 text-xs font-medium text-destructive">
            {t('paymentGateways.faulted.rowDetail')}
            {isFirst ? ` ${t('paymentGateways.faulted.rowIsDefault')}` : ''}
          </p>
        )}
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

            <span className="mx-1 h-6 w-px bg-border" aria-hidden />

            <Switch
              checked={gateway.isActive}
              onCheckedChange={(next) => toggleActiveMutation.mutate(next)}
              disabled={toggleActiveMutation.isPending}
              aria-label={t('paymentGateways.toggleActive')}
            />
          </>
        ) : (
          // Read-only audiences see this column instead of the Switch. The
          // word stays true — the gateway *is* active — but success-green on a
          // gateway that cannot take a rouble was half of what made the fault
          // invisible.
          <Badge variant={isFaulted ? 'destructive' : gateway.isActive ? 'success' : 'secondary'}>
            {gateway.isActive ? t('paymentGateways.active') : t('paymentGateways.disabled')}
          </Badge>
        )}
      </div>
    </div>
  )
}

// ── Settings dialog ─────────────────────────────────────────────────────────

/**
 * A blank field means «not configured», never «configured as empty» — every
 * setting the backend accepts is non-empty, and the numeric ones (`serviceId`,
 * Platega's `paymentMethod`) would not survive a `''` at all. The form posts
 * every field of the gateway, so untouched optional ones have to leave as
 * absent keys rather than empty strings. Clearing a value still works: the
 * backend replaces the settings object instead of merging into it, so a key
 * that stops being sent stops being stored.
 */
function withoutBlankEntries(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.trim().length > 0),
  )
}

/**
 * Stand-in for the «not set» choice of a `clearable` select. Radix reserves
 * `''` for «nothing selected» and throws on a `SelectItem` holding it, so the
 * entry needs a value of its own; it is translated straight back to `''` on
 * pick, and `withoutBlankEntries` then keeps the key out of the PATCH rather
 * than sending a blank the backend enum would reject.
 */
const SELECT_UNSET_VALUE = '__unset__'

/**
 * What a masked field holds after the first edit lands on it.
 *
 * A mask is not text. `********c8e5` stands for a credential nobody on this
 * screen may read, so an edit that lands *next* to it produces a value that is
 * neither the old key nor the new one — and the damage is silent rather than
 * cosmetic: the backend recognises a mask deliberately permissively (anything
 * starting with `********` means «unchanged»), so it reads
 * `********c8e5my-new-key` as "keep what is stored". The rotation is dropped,
 * the save reports success, and the operator leaves believing the key was
 * replaced while the old one is still live.
 *
 * So the mask behaves as a single atomic token: the first edit drops it whole
 * and keeps only what the operator actually contributed. Focusing the field
 * selects it, which already makes the ordinary click-and-type path do exactly
 * this; this is what covers the rest — End-then-type, a paste behind the caret,
 * and every browser that collapses the focus selection on mouse-up.
 */
function valueAfterMaskEdit(incoming: string, mask: string): string {
  if (incoming.includes(mask)) {
    return incoming.replace(mask, '')
  }
  // Backspacing into the mask leaves a fragment of it. No provider issues a
  // credential beginning with an asterisk, so a leading run of them is always
  // leftover mask — and a fragment that still starts with `********` would be
  // read as «unchanged» again, swallowing the edit.
  return incoming.startsWith('*') ? '' : incoming
}

interface GatewaySettingsFormProps {
  readonly gateway: AdminGateway
  readonly onClose: () => void
}

function GatewaySettingsForm({ gateway, onClose }: GatewaySettingsFormProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const meta = META_BY_TYPE[gateway.type]

  const initialValues: Record<string, string> = Object.fromEntries(
    (meta?.fields ?? []).map((field) => {
      const raw = gateway.settings?.[field.key]
      // YooKassa save_payment_method defaults ON when the operator never set it.
      if (field.key === 'savePaymentMethod' && (raw === undefined || raw === null || raw === '')) {
        return [field.key, 'true']
      }
      // Numbers have to survive the round-trip: the backend normalizes
      // Platega's `paymentMethod`, the RioPay/Valutix `serviceId` and
      // Antilopay's `vat` to numbers on save, so reading them as "not a
      // string, therefore blank" would empty the field every time the dialog
      // is reopened — and the next save would drop a setting the operator
      // never touched.
      const value =
        typeof raw === 'string'
          ? raw
          : typeof raw === 'boolean' || typeof raw === 'number'
            ? String(raw)
            : ''
      return [field.key, value]
    }),
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

  // Whether this caller was handed masks instead of credentials. Explicit
  // `false` only: an older API that does not send the flag is treated as
  // "these are the real values", so the extra wording can only ever appear
  // because something was genuinely redacted.
  const secretsHidden = gateway.secretsVisible === false
  // Which fields the masks are actually behind. `configuredSecretKeys` is the
  // backend's own list of secret-bearing keys that hold a value, so an empty
  // field stays plainly empty rather than being described as hidden — sniffing
  // the rendered string for asterisks would be guessing about a value we were
  // deliberately not shown.
  const hiddenSecretKeys = new Set<string>(
    secretsHidden ? (gateway.configuredSecretKeys ?? []) : [],
  )

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/payments/gateways/${gateway.id}`, {
        settings: withoutBlankEntries(values),
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

  // Providers are configured by pasting this address into their dashboard,
  // so it has to be the absolute URL they will actually call — the panel
  // used to print the bare path, which is unusable outside our own origin.
  function handleCopyWebhookUrl(): void {
    void navigator.clipboard.writeText(gateway.webhookUrl)
      .then((): void => {
        toast.success(t('paymentGateways.webhookUrlCopied'))
      })
      .catch((): void => {
        toast.error(t('paymentGateways.webhookUrlCopyFailed'))
      })
  }

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
        <DialogDescription>{t('paymentGateways.settingsDescription')}</DialogDescription>
      </DialogHeader>

      {hiddenSecretKeys.size > 0 && (
        // Stated once, at the top, before anything below it is read: the rule
        // it carries (untouched keeps, typed replaces, empty removes) governs
        // the whole form, and an operator meeting a field of asterisks needs it
        // before deciding whether to re-paste a live key «just in case».
        // Deliberately muted — nothing is wrong here, which is the entire
        // message; the destructive palette belongs to the gateway that is
        // actually losing payments.
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t('paymentGateways.secretsHidden.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('paymentGateways.secretsHidden.description')}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>{t('paymentGateways.webhookHint')}</Label>
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-2 font-mono text-xs">
          <code className="flex-1 break-all">{gateway.webhookUrl}</code>
          <Button size="sm" variant="outline" onClick={handleCopyWebhookUrl}>
            <Copy className="mr-1 h-3 w-3" /> {t('paymentGateways.copyWebhookUrl')}
          </Button>
        </div>
      </div>

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
          // A credential is stored here and this caller may not read it.
          const isHiddenSecret = hiddenSecretKeys.has(field.key)
          // …and nothing has been typed over it yet, so what the field holds is
          // still the backend's mask rather than a value.
          const isUntouchedMask = isHiddenSecret && value === initialValues[field.key]
          // Collapse dependent fields (the whole «Мой Налог» block) unless
          // their controlling toggle is on.
          if (field.dependsOn && values[field.dependsOn] !== 'true') {
            return null
          }
          if (field.type === 'toggle') {
            const on = value === 'true'
            return (
              <div
                key={field.key}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5"
              >
                <div className="space-y-0.5">
                  <Label>{t(field.labelKey)}</Label>
                  {field.hintKey && (
                    <p className="text-xs text-muted-foreground">{t(field.hintKey)}</p>
                  )}
                </div>
                <Switch
                  checked={on}
                  onCheckedChange={(next): void =>
                    setValues((prev) => ({ ...prev, [field.key]: next ? 'true' : 'false' }))
                  }
                  aria-label={t(field.labelKey)}
                />
              </div>
            )
          }
          if (field.type === 'select' && field.options) {
            return (
              <div key={field.key} className="space-y-1.5">
                <Label>{t(field.labelKey)}</Label>
                <Select
                  value={value}
                  onValueChange={(next): void =>
                    setValues((prev) => ({
                      ...prev,
                      [field.key]: next === SELECT_UNSET_VALUE ? '' : next,
                    }))
                  }
                >
                  <SelectTrigger className="h-10" aria-label={t(field.labelKey)}>
                    <SelectValue placeholder={t('paymentGateways.selectPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.clearable === true && (
                      <SelectItem value={SELECT_UNSET_VALUE}>
                        {t('paymentGateways.options.notSet')}
                      </SelectItem>
                    )}
                    {field.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {field.hintKey && (
                  <p className="text-xs text-muted-foreground">{t(field.hintKey)}</p>
                )}
              </div>
            )
          }
          return (
            <div key={field.key} className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                {t(field.labelKey)}
                {isHiddenSecret && (
                  <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />
                )}
              </Label>
              <div className="relative">
                <Input
                  // A mask is the redaction of a secret, not a secret: the last
                  // 4 characters it carries are there so the operator can tell
                  // WHICH key is installed against the provider's dashboard.
                  // Behind `type="password"` it degrades to twelve anonymous
                  // bullets — which is precisely the state that reads as a
                  // corrupted value. Once something has been typed over it the
                  // field holds a real credential again and goes back to dots.
                  type={isUntouchedMask ? 'text' : isSecret && !visible ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={value}
                  onFocus={(e): void => {
                    // Selects the mask whole, so the ordinary click-and-type
                    // replaces it rather than growing it. The guarantee lives
                    // in `valueAfterMaskEdit`; this is the affordance that
                    // makes the mask look like the single token it is.
                    if (isUntouchedMask) {
                      e.currentTarget.select()
                    }
                  }}
                  onChange={(e): void =>
                    setValues((prev) => ({
                      ...prev,
                      [field.key]: isUntouchedMask
                        ? valueAfterMaskEdit(e.target.value, value)
                        : e.target.value,
                    }))
                  }
                  className={isSecret && !isUntouchedMask ? 'pr-10' : undefined}
                />
                {isSecret && !isUntouchedMask && (
                  // No reveal control over a mask: there is nothing behind it
                  // to reveal, and offering one would promise this operator a
                  // value the backend refused them.
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
              {isHiddenSecret && (
                <p className="text-xs text-muted-foreground">
                  {t('paymentGateways.secretsHidden.fieldHint')}
                </p>
              )}
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
