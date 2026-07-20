/**
 * UserDetailPanel — right-side panel in the two-panel Users layout.
 *
 * Shows full user profile + ALL available admin actions:
 *   • Profile editing (role, discounts, points, max subs)
 *   • Block / Unblock / Delete
 *   • Send notification
 *   • Subscriptions management (give, trial, extend, traffic, devices, sync)
 *   • Partner lifecycle (create, toggle, balance, delete)
 *   • Referral attach
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AtSign,
  Apple,
  AlertTriangle,
  Calendar,
  ChevronDown,
  Copy,
  Globe,
  Hash,
  Link2,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Save,
  Send,
  Smartphone,
  Tag,
  Trash2,
  UserCheck,
  UserX,
  Wallet,
  Wifi,
  ClipboardList,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { usePlans } from '@/features/plans/plans-api'
import { getErrorMessage } from '@/lib/http-errors'
import { RemnawaveIcon } from '@/features/remnawave/remnawave-icon'
import type {
  UserDetail,
  UserPartner,
  UserSubscription,
  UserReferralEntry,
  UserPartnerTransaction,
} from './user-detail-shape'
import { DatePicker } from '@/components/ui/date-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PermissionGate } from '@/features/rbac'
import { usersApi, type AccountMergePreview, type AccountMergeChoices } from './users-api'

interface UserDetailPanelProps {
  readonly telegramId: string
}

export default function UserDetailPanel({ telegramId }: UserDetailPanelProps) {
  const { t } = useTranslation()
  const queryKey = ['admin', 'users', telegramId]

  const { data: user, isLoading } = useQuery<UserDetail>({
    queryKey,
    queryFn: async () => (await api.get<UserDetail>(`/admin/users/${telegramId}`)).data,
    enabled: !!telegramId,
  })

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t('userDetailPanel.notFound')}
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      {/* ── Header ─────────────────────────────────────────────── */}
      <UserHeader user={user} telegramId={telegramId} queryKey={queryKey} />

      {/* ── Tabs ───────────────────────────────────────────────── */}
      <Tabs defaultValue="profile" className="space-y-3">
        <TabsList className="flex-wrap">
          <TabsTrigger value="profile">{t('userDetailPanel.tabs.profile')}</TabsTrigger>
          <TabsTrigger value="subscriptions">
            {t('userDetailPanel.tabs.subscriptions')} ({user.subscriptions?.length ?? 0})
          </TabsTrigger>
          {user.partner && (
            <TabsTrigger value="partner">{t('userDetailPanel.tabs.partner')}</TabsTrigger>
          )}
          {!user.isPartner && (
            <TabsTrigger value="referrals">{t('userDetailPanel.tabs.referrals')}</TabsTrigger>
          )}
          <TabsTrigger value="invites">{t('userDetailPanel.tabs.invites')}</TabsTrigger>
          <TabsTrigger value="transactions">
            {t('userDetailPanel.tabs.transactions')} ({user.transactions?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="web">{t('userDetailPanel.tabs.web')}</TabsTrigger>
          <TabsTrigger value="analytics">{t('userDetailPanel.tabs.analytics')}</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <ProfileTab user={user} telegramId={telegramId} queryKey={queryKey} />
        </TabsContent>
        <TabsContent value="subscriptions">
          <SubscriptionsTab user={user} telegramId={telegramId} queryKey={queryKey} />
        </TabsContent>
        {user.partner && (
          <TabsContent value="partner">
            <PartnerTab user={user} telegramId={telegramId} queryKey={queryKey} />
          </TabsContent>
        )}
        {!user.isPartner && (
          <TabsContent value="referrals">
            <ReferralsTab user={user} telegramId={telegramId} queryKey={queryKey} />
          </TabsContent>
        )}
        <TabsContent value="invites">
          <InviteSettingsTab user={user} telegramId={telegramId} queryKey={queryKey} />
        </TabsContent>
        <TabsContent value="transactions">
          <TransactionsTab user={user} />
        </TabsContent>
        <TabsContent value="web">
          <WebCabinetTab user={user} telegramId={telegramId} queryKey={queryKey} />
        </TabsContent>
        <TabsContent value="analytics">
          <AnalyticsTab user={user} />
        </TabsContent>
      </Tabs>
    </div>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// Analytics Tab — registration snapshot + ad acquisition (read-only)
// ══════════════════════════════════════════════════════════════════════════════

function AnalyticsTab({ user }: { user: UserDetail }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language?.startsWith('ru') ? 'ru-RU' : 'en-US'
  const canPii = user.canViewRegistration === true
  const utm = user.registrationUtm ?? null
  const placement = user.acquisitionPlacement ?? null

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('userDetailPanel.analytics.networkTitle')}</CardTitle>
          <CardDescription>{t('userDetailPanel.analytics.networkHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <AnalyticsRow
            label={t('userDetailPanel.analytics.registeredAt')}
            value={user.createdAt ? new Date(user.createdAt).toLocaleString(locale) : '—'}
          />
          <AnalyticsRow
            label={t('userDetailPanel.analytics.channel')}
            value={user.registrationChannel ?? '—'}
          />
          {canPii ? (
            <>
              <AnalyticsRow
                label={t('userDetailPanel.analytics.ip')}
                value={user.registrationIp ?? '—'}
                mono
                copyable={Boolean(user.registrationIp)}
              />
              <AnalyticsRow
                label={t('userDetailPanel.analytics.referer')}
                value={user.registrationReferer ?? '—'}
                mono
              />
              <AnalyticsRow
                label={t('userDetailPanel.analytics.userAgent')}
                value={user.registrationUserAgent ?? '—'}
                mono
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('userDetailPanel.analytics.piiDenied')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('userDetailPanel.analytics.utmTitle')}</CardTitle>
          <CardDescription>{t('userDetailPanel.analytics.utmHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {canPii && utm && Object.keys(utm).length > 0 ? (
            Object.entries(utm).map(([k, v]) => (
              <AnalyticsRow key={k} label={k} value={String(v)} mono />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">
              {canPii
                ? t('userDetailPanel.analytics.utmEmpty')
                : t('userDetailPanel.analytics.piiDenied')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('userDetailPanel.analytics.adTitle')}</CardTitle>
          <CardDescription>{t('userDetailPanel.analytics.adHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {placement ? (
            <>
              <AnalyticsRow label={t('userDetailPanel.analytics.campaign')} value={placement.campaignName} />
              <AnalyticsRow label={t('userDetailPanel.analytics.platform')} value={placement.platform} />
              <AnalyticsRow label={t('userDetailPanel.analytics.channelLabel')} value={placement.channel ?? '—'} />
              <AnalyticsRow
                label={t('userDetailPanel.analytics.trackingCode')}
                value={placement.trackingCode}
                mono
                copyable
              />
              <AnalyticsRow
                label={t('userDetailPanel.analytics.acquisitionAt')}
                value={
                  user.acquisitionAt ? new Date(user.acquisitionAt).toLocaleString(locale) : '—'
                }
              />
              <AnalyticsRow label={t('userDetailPanel.analytics.ownerType')} value={placement.ownerType} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('userDetailPanel.analytics.adEmpty')}</p>
          )}
          {user.acquiredByPartner && (
            <AnalyticsRow
              label={t('userDetailPanel.analytics.partnerSource')}
              value={
                user.acquiredByPartner.username ||
                user.acquiredByPartner.name ||
                user.acquiredByPartner.partnerId
              }
            />
          )}
          {user.referral?.referrer && (
            <AnalyticsRow
              label={t('userDetailPanel.analytics.referralSource')}
              value={
                user.referral.referrer.username ||
                user.referral.referrer.name ||
                '—'
              }
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AnalyticsRow({
  label,
  value,
  mono,
  copyable,
}: {
  label: string
  value: string
  mono?: boolean
  copyable?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 text-right ${mono ? 'break-all font-mono text-xs' : ''}`}>{value}</span>
      {copyable && value !== '—' && (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            toast.success(t('userDetailPanel.analytics.copied'))
          }}
        >
          <Copy className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Profile Tab — two-column layout: info (left) + actions (right)
// ══════════════════════════════════════════════════════════════════════════════

function ProfileTab({
  user,
  telegramId,
  queryKey,
}: {
  user: UserDetail
  telegramId: string
  queryKey: string[]
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [role, setRole] = useState(user.role ?? 'USER')
  const [personalDiscount, setPersonalDiscount] = useState(
    String(user.personalDiscount ?? 0),
  )
  const [purchaseDiscount, setPurchaseDiscount] = useState(
    String(user.purchaseDiscount ?? 0),
  )
  const [maxSubs, setMaxSubs] = useState(
    user.maxSubscriptions != null ? String(user.maxSubscriptions) : '__default__',
  )
  const [currencyOverride, setCurrencyOverride] = useState<string>(
    user.partnerBalanceCurrencyOverride ?? '__none__',
  )
  const [pointsDelta, setPointsDelta] = useState('')
  const [dirty, setDirty] = useState(false)

  const saveMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.patch(`/admin/users/${telegramId}/profile`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.toasts.profileSaved'))
      setDirty(false)
    },
    onError: () => toast.error(t('userDetailPanel.toasts.profileFailed')),
  })

  const pointsMutation = useMutation({
    mutationFn: (delta: number) =>
      api.post(`/admin/users/${telegramId}/points`, { delta }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.toasts.pointsUpdated'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.profileFailed'))),
  })

  const createPartnerMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/create-partner`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.toasts.partnerCreated'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.profileFailed'))),
  })

  const togglePartnerMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/partner/toggle`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.toasts.statusChanged'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.profileFailed'))),
  })

  const handleSave = (): void => {
    saveMutation.mutate({
      role,
      personalDiscount: parseInt(personalDiscount, 10),
      purchaseDiscount: parseInt(purchaseDiscount, 10),
      maxSubscriptions:
        maxSubs === '__default__' ? null : parseInt(maxSubs, 10),
      partnerBalanceCurrencyOverride:
        currencyOverride === '__none__' ? null : currencyOverride,
    })
  }

  const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US'
  const identityLabel = t(`userDetailPanel.header.identityKind.${user.identityKind ?? 'LOCAL_ONLY'}`)
  const currentSub = user.subscriptions?.find((s) => s.status === 'ACTIVE')

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {/* ── LEFT: User Information ─────────────────────────────── */}
      <Card>
        <CardHeader className="px-4 pt-3 pb-2">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('userDetailPanel.profile.infoTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-3 text-xs">
          {/* Profile section */}
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.profile.sectionProfile')}
            </p>
            <div className="grid gap-0.5">
              <InfoRow icon={<Hash className="h-3 w-3" />} label="Reiwa ID" value={user.id} mono />
              <InfoRow icon={<Globe className="h-3 w-3" />} label={t('userDetailPanel.profile.identityType')} value={identityLabel} />
              {user.telegramId && (
                <InfoRow icon={<Smartphone className="h-3 w-3" />} label="Telegram ID" value={user.telegramId} mono />
              )}
              {user.webAccount?.login && (
                <InfoRow icon={<Globe className="h-3 w-3" />} label={t('userDetailPanel.profile.webLogin')} value={user.webAccount.login} mono />
              )}
              {user.username && (
                <InfoRow icon={<AtSign className="h-3 w-3" />} label={t('userDetailPanel.profile.publicUsername')} value={`@${user.username}`} />
              )}
              <InfoRow icon={<UserCheck className="h-3 w-3" />} label={t('userDetailPanel.profile.nameLabel')} value={user.name || '—'} />
              <InfoRow icon={<Hash className="h-3 w-3" />} label={t('userDetailPanel.profile.role')} value={user.role} />
              <InfoRow icon={<Globe className="h-3 w-3" />} label={t('userDetailPanel.profile.language')} value={user.language} />
              <InfoRow icon={<Wallet className="h-3 w-3" />} label={t('userDetailPanel.profile.points')} value={String(user.points ?? 0)} mono />
            </div>
          </div>

          {/* Discounts section */}
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.profile.sectionDiscounts')}
            </p>
            <div className="grid gap-0.5">
              <InfoRow icon={<Tag className="h-3 w-3" />} label={t('userDetailPanel.profile.personalDiscount')} value={`${user.personalDiscount ?? 0}%`} />
              <InfoRow icon={<Tag className="h-3 w-3" />} label={t('userDetailPanel.profile.purchaseDiscount')} value={`${user.purchaseDiscount ?? 0}%`} />
            </div>
          </div>

          {/* Subscription section */}
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.profile.sectionSubscription')}
            </p>
            {currentSub ? (
              <div className="grid gap-0.5">
                <InfoRow icon={<Wifi className="h-3 w-3" />} label={t('userDetailPanel.profile.currentPlan')} value={currentSub.plan?.name ?? '—'} />
                <InfoRow
                  icon={<Calendar className="h-3 w-3" />}
                  label={t('userDetailPanel.profile.expiresAt')}
                  value={currentSub.expireAt ? new Date(currentSub.expireAt).toLocaleDateString(locale) : '—'}
                />
                <InfoRow icon={<Hash className="h-3 w-3" />} label={t('userDetailPanel.profile.subsCount')} value={String(user.subscriptions?.length ?? 0)} />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">
                {t('userDetailPanel.profile.noActiveSub')}
              </p>
            )}
          </div>

          {/* Meta section */}
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.profile.sectionMeta')}
            </p>
            <div className="grid gap-0.5">
              <InfoRow icon={<Link2 className="h-3 w-3" />} label="Referral Code" value={user.referralCode} mono />
              <InfoRow icon={<AtSign className="h-3 w-3" />} label="Email" value={user.email ?? user.webAccount?.email ?? '—'} />
              <InfoRow
                icon={<Calendar className="h-3 w-3" />}
                label={t('userDetailPanel.profile.registered')}
                value={new Date(user.createdAt).toLocaleString(locale)}
              />
              <InfoRow
                icon={<Monitor className="h-3 w-3" />}
                label={t('userDetailPanel.profile.maxSubs')}
                value={user.maxSubscriptions === null ? t('userDetailPanel.profile.maxSubsDefault') : user.maxSubscriptions === -1 ? '∞' : String(user.maxSubscriptions)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── RIGHT: Actions (label left, control right) ─────── */}
      <PermissionGate resource="users" action="edit">
      <Card>
        <CardHeader className="px-4 pt-3 pb-2">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('userDetailPanel.profile.actionsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 pb-3">
          {/* Role */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Hash className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.profile.role')}
            </span>
            <Select value={role} onValueChange={(v) => { setRole(v); setDirty(true) }}>
              <SelectTrigger className="h-7 w-40 text-xs" aria-label={t('userDetailPanel.profile.role')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">USER</SelectItem>
                <SelectItem value="ADMIN">ADMIN</SelectItem>
                <SelectItem value="DEV">DEV</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Max subscriptions */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Monitor className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.profile.maxSubs')}
            </span>
            <Select value={maxSubs} onValueChange={(v) => { setMaxSubs(v); setDirty(true) }}>
              <SelectTrigger className="h-7 w-40 text-xs" aria-label={t('userDetailPanel.profile.maxSubs')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t('userDetailPanel.profile.maxSubsDefault')}</SelectItem>
                <SelectItem value="-1">∞</SelectItem>
                <SelectItem value="1">1</SelectItem>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem>
                <SelectItem value="5">5</SelectItem>
                <SelectItem value="10">10</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Personal discount */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Tag className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.profile.personalDiscount')}
            </span>
            <Input type="number" className="h-7 w-40 text-xs text-right px-2" min="0" max="100" value={personalDiscount} onChange={(e) => { setPersonalDiscount(e.target.value); setDirty(true) }} aria-label={t('userDetailPanel.profile.personalDiscount')} />
          </div>

          {/* Purchase discount */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Tag className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.profile.purchaseDiscount')}
            </span>
            <Input type="number" className="h-7 w-40 text-xs text-right px-2" min="0" max="100" value={purchaseDiscount} onChange={(e) => { setPurchaseDiscount(e.target.value); setDirty(true) }} aria-label={t('userDetailPanel.profile.purchaseDiscount')} />
          </div>

          {/* Partner currency */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Wallet className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.profile.partnerCurrencyOverride')}
            </span>
            <Select value={currencyOverride} onValueChange={(v) => { setCurrencyOverride(v); setDirty(true) }}>
              <SelectTrigger className="h-7 w-40 text-xs" aria-label={t('userDetailPanel.profile.partnerCurrencyOverride')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('userDetailPanel.profile.partnerCurrencyDefault')}</SelectItem>
                <SelectItem value="RUB">RUB</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
                <SelectItem value="USDT">USDT</SelectItem>
                <SelectItem value="TON">TON</SelectItem>
                <SelectItem value="XTR">XTR</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Points */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Wallet className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.profile.points')} ({user.points ?? 0})
            </span>
            <Input
              type="number"
              className="h-7 w-40 text-xs text-right px-2"
              placeholder="±"
              aria-label={t('userDetailPanel.profile.points')}
              value={pointsDelta}
              onChange={(e) => setPointsDelta(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const delta = parseInt(pointsDelta, 10)
                  if (Number.isFinite(delta) && delta !== 0) {
                    pointsMutation.mutate(delta)
                    setPointsDelta('')
                  }
                }
              }}
            />
          </div>

          {/* Partner toggle */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <UserCheck className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.profile.activatePartner')}
            </span>
            {user.partner ? (
              <Button
                size="sm"
                variant="outline"
                className={`h-7 w-40 text-xs ${user.partner.isActive ? 'border-emerald-500/50 text-emerald-500' : 'border-destructive/50 text-destructive'}`}
                onClick={() => togglePartnerMutation.mutate()}
                disabled={togglePartnerMutation.isPending}
              >
                {user.partner.isActive ? t('userDetailPanel.profile.partnerActive') : t('userDetailPanel.profile.partnerDisabled')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-40 text-xs"
                onClick={() => createPartnerMutation.mutate()}
                disabled={createPartnerMutation.isPending}
              >
                {t('userDetailPanel.profile.activatePartnerBtn')}
              </Button>
            )}
          </div>

          {/* Save */}
          {dirty && (
            <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending} className="w-full h-7 text-xs">
              {saveMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
              {t('userDetailPanel.profile.saveChanges')}
            </Button>
          )}
        </CardContent>
      </Card>
      </PermissionGate>
    </div>
  )
}

function InfoRow({ label, value, mono, icon }: { label: string; value: string | number | bigint | null | undefined; mono?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon && <span className="text-muted-foreground/60">{icon}</span>}
        {label}
      </span>
      <span className={`truncate text-right ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value == null ? '—' : String(value)}
      </span>
    </div>
  )
}

/**
 * One-row Remnawave profile reveal for the subscription card. Shows:
 *   • the live `username` from Remnawave (e.g. `rz_user_sub`),
 *   • a Copy button that yanks the panel UUID to the clipboard,
 *   • a tiny tooltip-like underline with the truncated UUID below.
 *
 * If we don't yet know the profile (no remnawaveId or upstream errored),
 * we render an "—" placeholder rather than hiding the row, because the
 * row's vertical rhythm is what makes the card legible.
 *
 * Painted in pink to read as a Remnawave-link affordance distinct from
 * the rest of the plain InfoRow stack.
 */
function RemnawaveProfileRow({ sub }: { sub: UserSubscription }) {
  const { t } = useTranslation()
  const profileName = sub.remnawaveProfileName?.trim()
  const remnawaveId = sub.remnawaveId

  function handleCopy(): void {
    if (!remnawaveId) return
    void navigator.clipboard.writeText(remnawaveId)
    toast.success(t('userDetailPanel.subscriptions.remnawaveProfile.copied'))
  }

  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex shrink-0 items-center gap-1.5 text-pink-500 dark:text-pink-400">
        <RemnawaveIcon className="h-3 w-3" alt="" />
        {t('userDetailPanel.subscriptions.remnawaveProfile.label')}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-right">
        {profileName ? (
          <span
            className="truncate font-mono text-[11px] font-medium text-pink-500 dark:text-pink-400"
            title={remnawaveId ?? undefined}
          >
            {profileName}
          </span>
        ) : remnawaveId ? (
          <span
            className="truncate font-mono text-[11px] text-pink-500/70 dark:text-pink-400/70"
            title={remnawaveId}
          >
            {remnawaveId.slice(0, 8)}…
          </span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        )}
        {remnawaveId ? (
          <button
            type="button"
            onClick={handleCopy}
            className="text-pink-500/60 transition hover:text-pink-500 dark:text-pink-400/60 dark:hover:text-pink-400"
            aria-label={t('userDetailPanel.subscriptions.remnawaveProfile.copyAria')}
          >
            <Copy className="h-3 w-3" />
          </button>
        ) : null}
      </span>
    </div>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// Header — identity, contacts, primary actions
// ══════════════════════════════════════════════════════════════════════════════

type IdentityKind =
  | 'TELEGRAM_LINKED'
  | 'TELEGRAM_PROVISIONAL'
  | 'TELEGRAM_ONLY'
  | 'WEB_ONLY'
  | 'LOCAL_ONLY'

function UserHeader({
  user,
  telegramId,
  queryKey,
}: {
  user: UserDetail
  telegramId: string
  queryKey: string[]
}) {
  const { t, i18n } = useTranslation()

  const identityKey = (user.identityKind ?? 'LOCAL_ONLY') as IdentityKind
  const identityLabel = t(`userDetailPanel.header.identityKind.${identityKey}`)

  const tempPasswordExpiresAt: string | null = user.webAccount?.temporaryPasswordExpiresAt ?? null
  // The badge is "active" only while the timestamp is in the future. Without
  // this guard the amber notice lingers forever after expiry, even though the
  // back-end has long since rejected the temp password.
  const tempPasswordActive: boolean =
    tempPasswordExpiresAt !== null &&
    new Date(tempPasswordExpiresAt).getTime() > Date.now()

  return (
    <div className="space-y-3">
      {/* Title row + primary actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xl font-bold">{user.name || user.username || user.webAccount?.login || '—'}</h2>
            {user.username && (
              <span className="truncate text-sm text-muted-foreground">@{user.username}</span>
            )}
          </div>

          {/* Status indicators — minimal text style */}
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <UserStatusDot user={user} />
            <span className="text-muted-foreground">{identityLabel}</span>
            <span className="text-muted-foreground">{user.role}</span>
            <span className="text-muted-foreground">{user.language}</span>
            {user.isBotBlocked && (
              <span className="text-amber-500">{t('userDetailPanel.header.botBlocked')}</span>
            )}
            {user.isRulesAccepted === false && (
              <span className="text-amber-500">{t('userDetailPanel.header.rulesNotAccepted')}</span>
            )}
            {user.partner && (
              <span className={`${user.partner.isActive ? 'text-emerald-500' : 'text-destructive'}`}>
                {user.partner.isActive
                  ? t('userDetailPanel.header.partnerActive')
                  : t('userDetailPanel.header.partnerInactive')}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <PermissionGate resource="users" action="edit">
            <NotifyButton telegramId={telegramId} />
            <BlockButton telegramId={telegramId} isBlocked={user.isBlocked} queryKey={queryKey} />
          </PermissionGate>
          <PermissionGate resource="users" action="delete">
            <DeleteButton telegramId={telegramId} />
          </PermissionGate>
        </div>
      </div>

      {/* Inline alerts */}
      {(user.webAccount?.requiresPasswordChange || tempPasswordActive) && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {tempPasswordActive
            ? t('userDetailPanel.header.webPasswordTemporary', {
                expiresAt: new Date(tempPasswordExpiresAt!).toLocaleString(
                  i18n.language === 'ru' ? 'ru-RU' : 'en-US',
                ),
              })
            : t('userDetailPanel.header.webRequiresPasswordChange')}
        </div>
      )}
      {user.attachReferrerReason && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t(`userDetailPanel.header.attachReason.${user.attachReferrerReason}`)}
        </div>
      )}
    </div>
  )
}

/**
 * User status dot with pulse animation.
 * - Online (lastSeenAt < 5min): green + pulse
 * - AFK (lastSeenAt < 30min): amber
 * - Blocked: red
 * - Inactive: transparent with border
 *
 * Uses `lastSeenAt` (a real cabinet-activity signal) rather than `updatedAt`,
 * which only changes when the User row is written and never reflected actual
 * presence.
 */
function UserStatusDot({ user }: { user: UserDetail }) {
  // TODO: refactor — recompute the dot class via useMemo with a 1-minute interval tick
  // instead of reading Date.now() during render.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now()
  const lastSeen = user.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0
  const diffMin = (now - lastSeen) / 60000

  let dotClass: string

  if (user.isBlocked) {
    dotClass = 'bg-destructive text-destructive'
  } else if (diffMin < 5) {
    dotClass = 'bg-emerald-500 text-emerald-500 status-dot-pulse'
  } else if (diffMin < 30) {
    dotClass = 'bg-amber-500 text-amber-500'
  } else {
    dotClass = 'bg-transparent border border-muted-foreground/50'
  }

  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass}`} />
}


// ══════════════════════════════════════════════════════════════════════════════
// Subscriptions Tab
// ══════════════════════════════════════════════════════════════════════════════

function SubscriptionsTab({ user, telegramId, queryKey }: { user: UserDetail; telegramId: string; queryKey: string[] }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showGiveSub, setShowGiveSub] = useState(false)
  const [showAssignPlan, setShowAssignPlan] = useState(false)
  const [assignPlanId, setAssignPlanId] = useState('')
  const [selectedSubIds, setSelectedSubIds] = useState<string[]>([])
  const [openSubId, setOpenSubId] = useState<string | null>(null)

  const grantTrialMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/grant-trial`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.trialGranted')) },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPage.subscriptionUpdateFailed'))),
  })

  const updateSubMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.patch(`/admin/users/subscriptions/${id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.subUpdated')) },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPage.subscriptionUpdateFailed'))),
  })

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/subscriptions/${id}/sync`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.synced')) },
    onError: () => toast.error(t('userDetailPanel.toasts.syncFailed')),
  })

  const resetTrafficMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/subscriptions/${id}/reset-traffic`),
    onSuccess: () => toast.success(t('userDetailPanel.toasts.trafficReset')),
    onError: () => toast.error(t('userDetailPanel.toasts.trafficResetFailed')),
  })

  const deleteSubMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/subscriptions/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.subDeleted')) },
  })

  const syncAllMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/sync`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey })
      const enqueued = res.data?.enqueued ?? 0
      toast.success(t('userDetailPanel.subscriptions.syncAllEnqueued', { count: enqueued }))
    },
    onError: () => toast.error(t('userDetailPanel.toasts.syncFailed')),
  })

  const assignPlanMutation = useMutation({
    mutationFn: ({ id, planId }: { id: string; planId: string }) =>
      api.patch(`/admin/users/subscriptions/${id}`, { planId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.subscriptions.planAssigned'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.subUpdated'))),
  })

  // Bulk assign: apply the chosen plan to each selected subscription via the
  // per-subscription PATCH (sequential to avoid hammering the Remnawave sync).
  const bulkAssignMutation = useMutation({
    mutationFn: async ({ ids, planId }: { ids: string[]; planId: string }) => {
      for (const id of ids) {
        await api.patch(`/admin/users/subscriptions/${id}`, { planId })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.subscriptions.planAssigned'))
      setShowAssignPlan(false)
      setAssignPlanId('')
      setSelectedSubIds([])
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.subscriptions.assignFailed'))),
  })

  const { data: plans } = usePlans()
  // Operators can assign ANY plan by hand — including archived ones (e.g. to
  // grandfather a user onto a retired tariff). Archived plans are kept but
  // labelled so they're distinguishable in the picker.
  const assignablePlans = plans ?? []

  const subs = user.subscriptions ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <PermissionGate resource="subscriptions" action="create">
          <Button size="sm" onClick={() => setShowGiveSub(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> {t('userDetailPanel.subscriptions.giveSub')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => grantTrialMutation.mutate()} disabled={grantTrialMutation.isPending}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> {t('userDetailPanel.subscriptions.giveTrial')}
          </Button>
        </PermissionGate>
        <PermissionGate resource="subscriptions" action="edit">
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncAllMutation.mutate()}
            disabled={syncAllMutation.isPending || subs.length === 0}
          >
            {syncAllMutation.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            {t('userDetailPanel.subscriptions.syncAll')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAssignPlan(!showAssignPlan)}
          >
            <ClipboardList className="mr-1 h-3.5 w-3.5" />
            {t('userDetailPanel.subscriptions.assignPlan')}
          </Button>
        </PermissionGate>
      </div>

      {showAssignPlan && plans && (
        <div className="space-y-3 rounded-md border border-primary/30 p-3">
          {(() => {
            const selectable = subs.filter((s) => s.status !== 'DELETED')
            const allSelected = selectable.length > 0 && selectedSubIds.length === selectable.length
            const toggle = (id: string) =>
              setSelectedSubIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            const toggleAll = () =>
              setSelectedSubIds(allSelected ? [] : selectable.map((s) => s.id))
            return (
              <>
                <p className="text-xs font-medium text-muted-foreground">
                  {t('userDetailPanel.subscriptions.assignPlanPickSubs')}
                </p>
                {selectable.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('userDetailPanel.subscriptions.noSubs')}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-xs font-medium">
                      <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                      {t('userDetailPanel.subscriptions.assignPlanSelectAll')}
                    </label>
                    <div className="max-h-40 space-y-1 overflow-y-auto pl-1">
                      {selectable.map((s) => (
                        <label key={s.id} className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={selectedSubIds.includes(s.id)}
                            onCheckedChange={() => toggle(s.id)}
                          />
                          <span className="truncate">
                            {s.remnawaveProfileName || s.plan?.name || s.id}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Select value={assignPlanId} onValueChange={setAssignPlanId}>
                    <SelectTrigger
                      className="flex-1 h-8 text-xs"
                      aria-label={t('userDetailPanel.subscriptions.selectPlan')}
                    >
                      <SelectValue placeholder={t('userDetailPanel.subscriptions.selectPlan')} />
                    </SelectTrigger>
                    <SelectContent>
                      {assignablePlans.map((plan) => (
                        <SelectItem key={plan.id} value={String(plan.id)} className="text-xs">
                          {plan.name} {plan.trafficLimit ? `(${plan.trafficLimit} GB)` : ''}
                          {plan.isArchived ? ` · ${t('userDetailPanel.subscriptions.archivedTag')}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8"
                    onClick={() => bulkAssignMutation.mutate({ ids: selectedSubIds, planId: assignPlanId })}
                    disabled={!assignPlanId || selectedSubIds.length === 0 || bulkAssignMutation.isPending}
                  >
                    {bulkAssignMutation.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    {t('userDetailPanel.subscriptions.assign')}
                  </Button>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {subs.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{t('userDetailPanel.subscriptions.noSubs')}</CardContent></Card>
      ) : (
        <div className="grid items-start gap-3 sm:grid-cols-2">
          {subs.map((sub) => (
            <SubscriptionCard
              key={sub.id}
              sub={sub}
              isOpen={openSubId === sub.id}
              onToggleOpen={() => setOpenSubId(openSubId === sub.id ? null : sub.id)}
              assignablePlans={assignablePlans}
              onUpdate={(data) => updateSubMutation.mutate({ id: sub.id, data })}
              onSync={() => syncMutation.mutate(sub.id)}
              isSyncing={syncMutation.isPending && syncMutation.variables === sub.id}
              onResetTraffic={() => resetTrafficMutation.mutate(sub.id)}
              onDelete={() => deleteSubMutation.mutate(sub.id)}
              onAssignPlan={(planId) => assignPlanMutation.mutate({ id: sub.id, planId })}
            />
          ))}
        </div>
      )}

      {/* ── Plan Access toggles ─────────────────────────────────── */}
      <PlanAccessSection telegramId={telegramId} queryKey={queryKey} plans={assignablePlans} />

      <Dialog open={showGiveSub} onOpenChange={setShowGiveSub}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('userDetailPanel.subscriptions.giveSubDialog')}</DialogTitle></DialogHeader>
          <GiveSubForm telegramId={telegramId} queryKey={queryKey} onClose={() => setShowGiveSub(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Admin HWID device interface — mirrors `RemnawaveHwidDevice` from the
 * backend (`/admin/users/subscriptions/:id/devices`).
 */
interface AdminHwidDevice {
  readonly hwid: string
  readonly platform: string | null
  readonly osVersion: string | null
  readonly deviceModel: string | null
  readonly userAgent: string | null
  readonly createdAt: string
  readonly lastSeenAt: string | null
}

/**
 * DevicesSection
 * ──────────────
 * Lists the HWID devices bound to a subscription's Remnawave profile and
 * lets the operator revoke any of them. Left side shows the platform icon +
 * device name; right side shows the HWID and a trash button.
 *
 * Only rendered for subscriptions that have a Remnawave profile (a `hwid`
 * list is meaningless otherwise). The list query is keyed on the
 * subscription id and invalidated after a revoke.
 */
function DevicesSection({ subscriptionId }: { subscriptionId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const queryKey = ['admin', 'subscription-devices', subscriptionId]

  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get<{ devices: AdminHwidDevice[]; deviceCount: number }>(
        `/admin/users/subscriptions/${subscriptionId}/devices`,
      )
      return res.data
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (hwid: string) =>
      api.delete(`/admin/users/subscriptions/${subscriptionId}/devices/${encodeURIComponent(hwid)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.subscriptions.devicesList.removed'))
    },
    onError: () => toast.error(t('userDetailPanel.subscriptions.devicesList.removeFailed')),
  })

  const devices = data?.devices ?? []

  return (
    <div className="mt-1.5 border-t pt-1.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Smartphone className="h-3 w-3 text-muted-foreground/60" />
        <span>{t('userDetailPanel.subscriptions.devicesList.title')}</span>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
      ) : isError ? (
        <p className="py-1 text-[11px] text-destructive">
          {t('userDetailPanel.subscriptions.devicesList.loadError')}
        </p>
      ) : devices.length === 0 ? (
        <p className="py-1 text-[11px] text-muted-foreground">
          {t('userDetailPanel.subscriptions.devicesList.empty')}
        </p>
      ) : (
        <div className="space-y-1">
          {devices.map((device) => {
            const name =
              device.deviceModel ??
              device.platform ??
              t('userDetailPanel.subscriptions.devicesList.unknownPlatform')
            const subtitle = [device.platform, device.osVersion].filter(Boolean).join(' · ')
            return (
              <div
                key={device.hwid}
                className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
              >
                {/* Left: platform icon + device name */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background">
                  {platformDeviceIcon(device.platform)}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[11px] font-medium">{name}</span>
                  {subtitle && (
                    <span className="truncate text-[10px] text-muted-foreground">{subtitle}</span>
                  )}
                </div>
                {/* Right: HWID + delete */}
                <span
                  className="max-w-[120px] truncate font-mono text-[10px] text-muted-foreground"
                  title={device.hwid}
                >
                  {device.hwid}
                </span>
                <PermissionGate resource="subscriptions" action="delete">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={t('userDetailPanel.subscriptions.devicesList.remove')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t('userDetailPanel.subscriptions.devicesList.removeConfirmTitle')}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('userDetailPanel.subscriptions.devicesList.removeConfirmText', { name })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t('userDetailPanel.subscriptions.devicesList.cancel')}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => revokeMutation.mutate(device.hwid)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {t('userDetailPanel.subscriptions.devicesList.removeConfirmAction')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                </PermissionGate>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Maps a Remnawave platform string to a Lucide device icon. */
function platformDeviceIcon(platform: string | null) {
  if (!platform) return <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
  const p = platform.toLowerCase()
  if (p.includes('android')) return <Smartphone className="h-3.5 w-3.5 text-emerald-500" />
  if (p.includes('ios') || p.includes('iphone') || p.includes('ipad') || p.includes('mac'))
    return <Apple className="h-3.5 w-3.5 text-foreground" />
  if (p.includes('windows')) return <Monitor className="h-3.5 w-3.5 text-blue-500" />
  return <Globe className="h-3.5 w-3.5 text-muted-foreground" />
}

function SubscriptionCard({
  sub,
  isOpen,
  onToggleOpen,
  assignablePlans,
  onUpdate,
  onSync,
  isSyncing,
  onResetTraffic,
  onDelete,
  onAssignPlan,
}: {
  sub: UserSubscription
  isOpen: boolean
  onToggleOpen: () => void
  assignablePlans: ReadonlyArray<import('@/features/plans/plans-api').Plan>
  onUpdate: (data: Record<string, unknown>) => void
  onSync: () => void
  isSyncing: boolean
  onResetTraffic: () => void
  onDelete: () => void
  onAssignPlan: (planId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US'

  const statusKey = String(sub.status ?? 'UNKNOWN')
  const statusDot =
    statusKey === 'ACTIVE'
      ? 'bg-emerald-500'
      : statusKey === 'EXPIRED' || statusKey === 'DELETED'
        ? 'bg-destructive'
        : statusKey === 'DISABLED'
          ? 'bg-amber-500'
          : 'bg-muted-foreground/40'

  const statusColor =
    statusKey === 'ACTIVE'
      ? 'text-emerald-500'
      : statusKey === 'DISABLED' || statusKey === 'EXPIRED' || statusKey === 'DELETED'
        ? 'text-destructive'
        : 'text-muted-foreground'

  const statusLabel = t(`userDetailPanel.subscriptions.status.${statusKey}`, statusKey)

  const [trafficLimit, setTrafficLimit] = useState(String(sub.trafficLimit ?? ''))
  const [deviceLimit, setDeviceLimit] = useState(String(sub.deviceLimit ?? ''))
  const [expiresAt, setExpiresAt] = useState<Date | undefined>(
    sub.expireAt ? new Date(sub.expireAt) : undefined,
  )
  const [dirty, setDirty] = useState(false)

  const handleSave = () => {
    const data: Record<string, unknown> = {}
    const newTraffic = parseInt(trafficLimit, 10)
    const newDevices = parseInt(deviceLimit, 10)
    if (Number.isFinite(newTraffic) && newTraffic !== sub.trafficLimit) data.trafficLimit = newTraffic
    if (Number.isFinite(newDevices) && newDevices !== sub.deviceLimit) data.deviceLimit = newDevices
    if (expiresAt) {
      const originalDate = sub.expireAt ? new Date(sub.expireAt).toISOString().slice(0, 10) : ''
      const newDate = expiresAt.toISOString().slice(0, 10)
      if (newDate !== originalDate) {
        data.expiresAt = expiresAt.toISOString()
      }
    }
    if (Object.keys(data).length > 0) {
      onUpdate(data)
      setDirty(false)
    }
  }

  return (
    <Card className={cn('flex flex-col transition-shadow', isSyncing && 'shadow-md ring-1 ring-primary/30')}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
          <span className="truncate text-xs font-medium">{sub.plan?.name ?? `#${sub.id.slice(0, 8)}`}</span>
          <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
          {sub.isTrial && <span className="rounded border border-pink-500/50 px-1 py-px text-[9px] uppercase text-pink-400">Trial</span>}
          {isSyncing ? (
            <span className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1 py-px text-[9px] font-medium uppercase text-primary">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              {t('userDetailPanel.subscriptions.syncing')}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0">
          <PermissionGate resource="subscriptions" action="edit">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onSync}
            disabled={isSyncing}
            aria-label={t('userDetailPanel.subscriptions.syncTitle')}
          >
            {isSyncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
          </PermissionGate>
          <PermissionGate resource="subscriptions" action="delete">
          <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={onDelete} aria-label={t('userDetailPanel.subscriptions.deleteTitle')}>
            <Trash2 className="h-3 w-3" />
          </Button>
          </PermissionGate>
        </div>
      </div>

      {/* Info rows */}
      <div className="grid gap-0 px-3 pb-1.5 text-[11px]">
        <InfoRow icon={<Tag className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.planLabel')} value={sub.plan?.name ?? '—'} />
        <InfoRow icon={<Hash className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.planType')} value={String(t(`userDetailPanel.subscriptions.planTypes.${sub.plan?.type ?? 'BOTH'}`, sub.plan?.type ?? '—'))} />
        <InfoRow icon={<Wifi className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.traffic')} value={sub.trafficLimit ? `${sub.trafficLimit} GB` : '∞'} />
        <InfoRow icon={<Monitor className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.devices')} value={String(sub.deviceLimit || '∞')} />
        <InfoRow icon={<Calendar className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.expires')} value={sub.expireAt ? new Date(sub.expireAt).toLocaleDateString(locale) : '—'} />
        <RemnawaveProfileRow sub={sub} />
      </div>

      {/* Quick actions — accordion (only one open at a time) */}
      <div className="border-t px-3 pb-2.5">
        <Collapsible open={isOpen} onOpenChange={(open) => { if (open) onToggleOpen(); else if (isOpen) onToggleOpen(); }}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <span>{t('userDetailPanel.subscriptions.quickEdits')}</span>
              <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="collapsible-animate overflow-hidden">
            <div className="space-y-1.5 pt-1 pb-0.5">
              <PermissionGate resource="subscriptions" action="edit">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Wifi className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.subscriptions.trafficLabel')}
                </span>
                <Input type="number" min="0" className="h-7 w-40 text-xs text-right px-1.5" value={trafficLimit} onChange={(e) => { setTrafficLimit(e.target.value); setDirty(true) }} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Monitor className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.subscriptions.devicesLabel')}
                </span>
                <Input type="number" min="0" className="h-7 w-40 text-xs text-right px-1.5" value={deviceLimit} onChange={(e) => { setDeviceLimit(e.target.value); setDirty(true) }} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <RefreshCw className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.subscriptions.resetTraffic')}
                </span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={onResetTraffic}>{t('userDetailPanel.subscriptions.resetBtn')}</Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Calendar className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.subscriptions.expires')}
                </span>
                <DatePicker
                  value={expiresAt}
                  onChange={(date) => { setExpiresAt(date); setDirty(true) }}
                  className="h-6 w-32 text-[11px]"
                />
              </div>
              {assignablePlans.length > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Tag className="h-3 w-3 text-muted-foreground/60" />
                    {t('userDetailPanel.subscriptions.assignPlanLabel')}
                  </span>
                  <Select value={sub.plan?.id ?? ''} onValueChange={(planId) => { if (planId && planId !== sub.plan?.id) onAssignPlan(planId) }}>
                    <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {assignablePlans.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}{p.isArchived ? ` · ${t('userDetailPanel.subscriptions.archivedTag')}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              </PermissionGate>
              {/* HWID devices bound to this Remnawave profile */}
              {sub.remnawaveId && <DevicesSection subscriptionId={sub.id} />}
              {/* Footer */}
              <div className="flex items-center justify-between gap-2 pt-1.5">
                <div className="flex gap-1">
                  <PermissionGate resource="subscriptions" action="edit">
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => onUpdate({ status: statusKey === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}>
                    {statusKey === 'ACTIVE' ? t('userDetailPanel.subscriptions.disableTitle') : t('userDetailPanel.subscriptions.enableTitle')}
                  </Button>
                  </PermissionGate>
                  <PermissionGate resource="subscriptions" action="delete">
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-destructive" onClick={onDelete}>
                    {t('userDetailPanel.subscriptions.deleteTitle')}
                  </Button>
                  </PermissionGate>
                </div>
                <div className="flex gap-1">
                  {sub.configUrl && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-muted-foreground" onClick={() => { navigator.clipboard.writeText(sub.configUrl ?? ''); toast.success(t('userDetailPanel.subscriptions.linkCopied')) }} aria-label={t('userDetailPanel.subscriptions.copyLink')}>
                      <Link2 className="h-3 w-3" />
                    </Button>
                  )}
                  <PermissionGate resource="subscriptions" action="edit">
                  <Button size="sm" className="h-6 px-2 text-[10px]" disabled={!dirty} onClick={handleSave}>
                    {t('userDetailPanel.subscriptions.saveBtn')}
                  </Button>
                  </PermissionGate>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Card>
  )
}


function PlanAccessSection({
  telegramId,
  queryKey,
  plans,
}: {
  telegramId: string
  queryKey: string[]
  plans: ReadonlyArray<import('@/features/plans/plans-api').Plan>
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const grantMutation = useMutation({
    mutationFn: (planId: string) =>
      api.post(`/admin/users/${telegramId}/plan-access/${planId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  const revokeMutation = useMutation({
    mutationFn: (planId: string) =>
      api.delete(`/admin/users/${telegramId}/plan-access/${planId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  // Plans with availability=ALLOWED are the ones that use allowedUserIds
  const allowedPlans = plans.filter((p) => p.availability === 'ALLOWED')
  if (allowedPlans.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('userDetailPanel.subscriptions.planAccessTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t('userDetailPanel.subscriptions.planAccessHint')}
        </p>
        {allowedPlans.map((plan) => {
          const hasAccess = (plan.allowedUserIds ?? []).includes(telegramId)
          return (
            <div key={plan.id} className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">{plan.name}</span>
              <PermissionGate resource="subscriptions" action="edit">
              <Switch
                checked={hasAccess}
                onCheckedChange={(checked) => {
                  if (checked) grantMutation.mutate(plan.id)
                  else revokeMutation.mutate(plan.id)
                }}
                aria-label={`${t('userDetailPanel.subscriptions.planAccessToggle')} ${plan.name}`}
              />
              </PermissionGate>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function GiveSubForm({ telegramId, queryKey, onClose }: { telegramId: string; queryKey: string[]; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [planId, setPlanId] = useState('')
  const [days, setDays] = useState('30')
  const [isTrial, setIsTrial] = useState(false)

  const { data: plans } = usePlans()

  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/give-subscription`, { planId, durationDays: parseInt(days), isTrial }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.subGranted')); onClose() },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPage.subscriptionUpdateFailed'))),
  })

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('userDetailPanel.subscriptions.plan')}</Label>
        <Select value={planId} onValueChange={setPlanId}>
          <SelectTrigger><SelectValue placeholder={t('userDetailPanel.subscriptions.planPlaceholder')} /></SelectTrigger>
          <SelectContent>
            {(plans ?? []).filter((p) => !p.isArchived).map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{t('userDetailPanel.subscriptions.duration')}</Label>
        <Input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={isTrial} onCheckedChange={setIsTrial} id="trial-toggle" />
        <Label htmlFor="trial-toggle">{t('userDetailPanel.subscriptions.markTrial')}</Label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>{t('userDetailPanel.subscriptions.cancel')}</Button>
        <Button onClick={() => mutation.mutate()} disabled={!planId || mutation.isPending}>
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          {t('userDetailPanel.subscriptions.give')}
        </Button>
      </div>
    </div>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// Partner Tab — two-column: profile (left) + referral stats (right)
// ══════════════════════════════════════════════════════════════════════════════

function PartnerTab({ user, telegramId, queryKey }: { user: UserDetail; telegramId: string; queryKey: string[] }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US'

  const createMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/create-partner`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.partnerCreated')) },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.profileFailed'))),
  })

  const toggleMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/partner/toggle`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.statusChanged')) },
  })

  const adjustMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/partner/adjust-balance`, {
      amount: Math.round(parseFloat(adjustAmount) * 100),
      reason: adjustReason || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.toasts.balanceAdjusted'))
      setAdjustAmount('')
      setAdjustReason('')
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.profileFailed'))),
  })

  if (!user.partner) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <p className="text-sm text-muted-foreground">{t('userDetailPanel.partner.notPartner')}</p>
          <PermissionGate resource="partners" action="edit">
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            <Plus className="mr-2 h-4 w-4" /> {t('userDetailPanel.partner.createPartner')}
          </Button>
          </PermissionGate>
        </CardContent>
      </Card>
    )
  }

  const p = user.partner
  if (!p) return null
  const referrals: ReadonlyArray<UserReferralEntry> = p.referrals ?? []
  const transactions: ReadonlyArray<UserPartnerTransaction> = p.transactions ?? []
  const fmtMoney = (v: number) => (v / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽'

  return (
    <div className="grid items-start gap-3 lg:grid-cols-2">
      {/* ── LEFT: Partner profile ── */}
      <Card>
        <CardHeader className="px-4 pt-3 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('userDetailPanel.partner.profileTitle')}
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Badge variant={p.isActive ? 'success' : 'secondary'} className="text-[10px]">
                {p.isActive ? t('userDetailPanel.partner.active') : t('userDetailPanel.partner.inactive')}
              </Badge>
              <PermissionGate resource="partners" action="edit">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => toggleMutation.mutate()}>
                {p.isActive ? t('userDetailPanel.subscriptions.disableTitle') : t('userDetailPanel.subscriptions.enableTitle')}
              </Button>
              </PermissionGate>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-3 text-xs">
          {/* Stats */}
          <div className="grid gap-0.5">
            <InfoRow icon={<Wallet className="h-3 w-3" />} label={t('userDetailPanel.partner.balance')} value={fmtMoney(p.balance ?? 0)} />
            <InfoRow icon={<Wallet className="h-3 w-3" />} label={t('userDetailPanel.partner.totalEarned')} value={fmtMoney(p.totalEarned ?? 0)} />
            <InfoRow icon={<Wallet className="h-3 w-3" />} label={t('userDetailPanel.partner.totalWithdrawn')} value={fmtMoney(p.totalWithdrawn ?? 0)} />
          </div>

          <Separator />

          {/* Balance adjustment */}
          <PermissionGate resource="partners" action="edit">
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.partner.adjustTitle')}
            </span>
            <div className="flex gap-1.5">
              <Input type="number" step="0.01" placeholder={t('userDetailPanel.partner.amountPlaceholder')} value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} className="h-7 text-xs" />
              <Input placeholder={t('userDetailPanel.partner.reasonPlaceholder')} value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} className="h-7 text-xs" />
              <Button size="sm" className="h-7 shrink-0 px-2 text-[10px]" onClick={() => adjustMutation.mutate()} disabled={!adjustAmount || adjustMutation.isPending}>
                {t('userDetailPanel.partner.applyBtn')}
              </Button>
            </div>
          </div>
          </PermissionGate>

          <Separator />

          {/* Individual settings */}
          <PermissionGate resource="partners" action="edit">
          <PartnerSettings telegramId={telegramId} partner={p} queryKey={queryKey} />
          </PermissionGate>
        </CardContent>
      </Card>

      {/* ── RIGHT: Referral statistics ── */}
      <Card>
        <CardHeader className="px-4 pt-3 pb-2">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('userDetailPanel.partner.statsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-3 text-xs">
          {/* Referral counts */}
          <div className="grid gap-0.5">
            <InfoRow icon={<UserCheck className="h-3 w-3" />} label={t('userDetailPanel.partner.referralsL1')} value={String(referrals.filter((r) => r.level === 1).length)} />
            <InfoRow icon={<UserCheck className="h-3 w-3" />} label={t('userDetailPanel.partner.referralsL2')} value={String(referrals.filter((r) => r.level === 2).length)} />
            <InfoRow icon={<UserCheck className="h-3 w-3" />} label={t('userDetailPanel.partner.referralsL3')} value={String(referrals.filter((r) => r.level === 3).length)} />
          </div>

          <Separator />

          {/* Recent transactions (earnings) */}
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.partner.recentEarnings')}
            </span>
            {transactions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">{t('userDetailPanel.partner.noEarnings')}</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-auto scrollbar-none">
                {transactions.slice(0, 20).map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
                    <div className="min-w-0">
                      <span className="text-[10px] text-muted-foreground">L{tx.level ?? '?'}</span>
                      {tx.description && <span className="ml-1.5 truncate text-[10px]">{tx.description}</span>}
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-emerald-500">
                      +{fmtMoney(tx.earnedAmount ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* Recent referrals */}
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.partner.recentReferrals')}
            </span>
            {referrals.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">{t('userDetailPanel.partner.noReferrals')}</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-auto scrollbar-none">
                {referrals.slice(0, 20).map((ref) => (
                  <div key={ref.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <UserCheck className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      <span className="truncate text-[11px]">{ref.referral?.name || ref.referral?.username || ref.referralUserId?.slice(0, 8)}</span>
                    </div>
                    <span className="shrink-0 text-[10px] text-muted-foreground">L{ref.level}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Attach referral form */}
          <Separator />
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
              {t('userDetailPanel.partner.attachReferralTitle')}
            </span>
            <p className="text-[11px] text-muted-foreground">
              {t('userDetailPanel.partner.attachReferralHint')}
            </p>
            <PermissionGate resource="partners" action="edit">
            <AttachPartnerReferralForm telegramId={telegramId} queryKey={queryKey} />
            </PermissionGate>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function AttachPartnerReferralForm({ telegramId, queryKey }: { telegramId: string; queryKey: string[] }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [identifier, setIdentifier] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/partner/attach-referral`, { referralIdentifier: identifier }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.partner.attachSuccess'))
      setIdentifier('')
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.partner.attachFailed'))),
  })

  return (
    <div className="flex gap-1.5">
      <Input
        placeholder={t('userDetailPanel.partner.attachPlaceholder')}
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        className="h-7 text-xs"
      />
      <Button
        size="sm"
        className="h-7 shrink-0 px-2 text-[10px]"
        onClick={() => mutation.mutate()}
        disabled={!identifier.trim() || mutation.isPending}
      >
        {mutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : t('userDetailPanel.partner.attachBtn')}
      </Button>
    </div>
  )
}

function PartnerSettings({ telegramId, partner, queryKey }: { telegramId: string; partner: UserPartner; queryKey: string[] }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [useGlobal, setUseGlobal] = useState<boolean>(partner.useGlobalSettings ?? true)
  const [accrualStrategy, setAccrualStrategy] = useState<string>(
    partner.accrualStrategy ?? 'ON_EACH_PAYMENT',
  )
  const [rewardType, setRewardType] = useState<string>(partner.rewardType ?? 'PERCENT')
  const [level1, setLevel1] = useState(partner.level1Percent != null ? String(partner.level1Percent) : '')
  const [level2, setLevel2] = useState(partner.level2Percent != null ? String(partner.level2Percent) : '')
  const [level3, setLevel3] = useState(partner.level3Percent != null ? String(partner.level3Percent) : '')
  const [fixed1, setFixed1] = useState(
    partner.level1FixedAmount != null ? String(Number(partner.level1FixedAmount) / 100) : '',
  )
  const [fixed2, setFixed2] = useState(
    partner.level2FixedAmount != null ? String(Number(partner.level2FixedAmount) / 100) : '',
  )
  const [fixed3, setFixed3] = useState(
    partner.level3FixedAmount != null ? String(Number(partner.level3FixedAmount) / 100) : '',
  )
  const [dirty, setDirty] = useState(false)

  const parseNullableFloat = (v: string): number | null => {
    if (v.trim() === '') return null
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : null
  }
  const toMinorUnits = (v: string): number | null => {
    const n = parseNullableFloat(v)
    return n === null ? null : Math.round(n * 100)
  }

  const saveMutation = useMutation({
    mutationFn: () => api.patch(`/admin/users/${telegramId}/partner/settings`, {
      useGlobalSettings: useGlobal,
      accrualStrategy,
      rewardType,
      level1Percent: rewardType === 'PERCENT' ? parseNullableFloat(level1) : null,
      level2Percent: rewardType === 'PERCENT' ? parseNullableFloat(level2) : null,
      level3Percent: rewardType === 'PERCENT' ? parseNullableFloat(level3) : null,
      level1FixedAmount: rewardType === 'FIXED' ? toMinorUnits(fixed1) : null,
      level2FixedAmount: rewardType === 'FIXED' ? toMinorUnits(fixed2) : null,
      level3FixedAmount: rewardType === 'FIXED' ? toMinorUnits(fixed3) : null,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('partnersDetail.toasts.settingsSaved')); setDirty(false) },
    onError: () => toast.error(t('partnersDetail.toasts.settingsFailed')),
  })

  return (
    <div className="space-y-2">
      {/* Global toggle */}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Globe className="h-3 w-3 text-muted-foreground/60" />
          {t('userDetailPanel.partner.individualSettings')}
        </span>
        <Switch checked={!useGlobal} onCheckedChange={(v) => { setUseGlobal(!v); setDirty(true) }} />
      </div>

      {!useGlobal && (
        <>
          {/* Accrual strategy */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <RefreshCw className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.partnerExt.accrualStrategy')}
            </span>
            <Select value={accrualStrategy} onValueChange={(v) => { setAccrualStrategy(v); setDirty(true) }}>
              <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ON_EACH_PAYMENT">{t('userDetailPanel.partnerExt.accrual.onEachPayment')}</SelectItem>
                <SelectItem value="ONCE_PER_USER">{t('userDetailPanel.partnerExt.accrual.oncePerUser')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Reward type */}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Wallet className="h-3 w-3 text-muted-foreground/60" />
              {t('userDetailPanel.partnerExt.rewardType')}
            </span>
            <Select value={rewardType} onValueChange={(v) => { setRewardType(v); setDirty(true) }}>
              <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PERCENT">{t('userDetailPanel.partnerExt.reward.percent')}</SelectItem>
                <SelectItem value="FIXED">{t('userDetailPanel.partnerExt.reward.fixed')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {rewardType === 'PERCENT' ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Tag className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.partner.referralsL1')} %
                </span>
                <Input type="number" min="0" max="100" step="0.1" className="h-7 w-40 text-xs text-right px-2" value={level1} onChange={(e) => { setLevel1(e.target.value); setDirty(true) }} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Tag className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.partner.referralsL2')} %
                </span>
                <Input type="number" min="0" max="100" step="0.1" className="h-7 w-40 text-xs text-right px-2" value={level2} onChange={(e) => { setLevel2(e.target.value); setDirty(true) }} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Tag className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.partner.referralsL3')} %
                </span>
                <Input type="number" min="0" max="100" step="0.1" className="h-7 w-40 text-xs text-right px-2" value={level3} onChange={(e) => { setLevel3(e.target.value); setDirty(true) }} />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Wallet className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.partnerExt.fixed.level1')}
                </span>
                <Input type="number" min="0" step="0.01" className="h-7 w-40 text-xs text-right px-2" value={fixed1} onChange={(e) => { setFixed1(e.target.value); setDirty(true) }} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Wallet className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.partnerExt.fixed.level2')}
                </span>
                <Input type="number" min="0" step="0.01" className="h-7 w-40 text-xs text-right px-2" value={fixed2} onChange={(e) => { setFixed2(e.target.value); setDirty(true) }} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Wallet className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.partnerExt.fixed.level3')}
                </span>
                <Input type="number" min="0" step="0.01" className="h-7 w-40 text-xs text-right px-2" value={fixed3} onChange={(e) => { setFixed3(e.target.value); setDirty(true) }} />
              </div>
            </>
          )}
        </>
      )}

      {dirty && (
        <Button size="sm" className="w-full h-7 text-xs" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
          {t('partnersDetail.individual.save')}
        </Button>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Referrals Tab — view + attach
// ══════════════════════════════════════════════════════════════════════════════

function ReferralsTab({ user, telegramId, queryKey }: { user: UserDetail; telegramId: string; queryKey: string[] }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [referrerId, setReferrerId] = useState('')

  const attachMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/referral/attach`, { referrerTelegramId: referrerId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('referralsActions.attach.success')); setReferrerId('') },
    onError: (err) => toast.error(getErrorMessage(err, t('referralsActions.attach.failed'))),
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('userDetailPage.referrals.referredByTitle')}</CardTitle></CardHeader>
        <CardContent>
          {user.referral ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t('userDetailPage.referrals.referrerLabel')} </span>
              <span className="font-medium">{user.referral.referrer?.name ?? user.referral.referrer?.username ?? '—'}</span>
              <span className="ml-2 text-muted-foreground">{t('userDetailPage.referrals.levelLabel')} {user.referral.level}</span>
            </p>
          ) : user.isPartner ? (
            <p className="text-sm text-muted-foreground">{t('userDetailPanel.referrals.partnerHint')}</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('userDetailPage.referrals.noReferrer')}</p>
              <PermissionGate resource="users" action="edit">
              <div className="flex gap-2">
                <Input placeholder={t('userDetailPanel.referrals.referrerIdPlaceholder')} value={referrerId} onChange={(e) => setReferrerId(e.target.value)} className="h-9 max-w-48" />
                <Button size="sm" onClick={() => attachMutation.mutate()} disabled={!referrerId || attachMutation.isPending}>
                  {t('userDetailPanel.referrals.attachBtn')}
                </Button>
              </div>
              </PermissionGate>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t('userDetailPage.referrals.referralsGivenTitle', { count: user.referralsGiven?.length ?? 0 })}</CardTitle></CardHeader>
        <CardContent>
          {user.referralsGiven?.length ? (
            <div className="space-y-1 text-sm">
              {user.referralsGiven.slice(0, 20).map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-muted/50">
                  <span>{r.referred?.name ?? r.referred?.telegramId ?? '—'}</span>
                  <span className="text-xs text-muted-foreground">L{r.level} · {r.qualifiedAt ? t('userDetailPage.referrals.qualifiedYes') : t('userDetailPage.referrals.qualifiedNo')}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('userDetailPage.referrals.empty')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Invite Settings Tab — per-user override on referral invite limits
// ══════════════════════════════════════════════════════════════════════════════

interface InviteEffective {
  linkTtlEnabled: boolean
  linkTtlSeconds: number | null
  slotsEnabled: boolean
  initialSlots: number | null
  refillThresholdQualified: number | null
  refillAmount: number | null
}

interface InviteOverride {
  useGlobalSettings?: boolean
  linkTtlEnabled?: boolean
  linkTtlSeconds?: number | null
  slotsEnabled?: boolean
  initialSlots?: number | null
  refillThresholdQualified?: number | null
  refillAmount?: number | null
  bypassInviteGate?: boolean
}

function readOverride(raw: unknown): InviteOverride {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as InviteOverride
  }
  return {}
}

function InviteSettingsTab({
  user,
  telegramId,
  queryKey,
}: {
  user: UserDetail
  telegramId: string
  queryKey: string[]
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const effective: InviteEffective = {
    linkTtlEnabled: user.effectiveInviteSettings?.linkTtlEnabled ?? false,
    linkTtlSeconds: user.effectiveInviteSettings?.linkTtlSeconds ?? null,
    slotsEnabled: user.effectiveInviteSettings?.slotsEnabled ?? false,
    initialSlots: user.effectiveInviteSettings?.initialSlots ?? null,
    refillThresholdQualified: user.effectiveInviteSettings?.refillThresholdQualified ?? null,
    refillAmount: user.effectiveInviteSettings?.refillAmount ?? null,
  }
  const initialOverride = readOverride(user.userInviteSettingsOverride)
  const initialUseGlobal =
    initialOverride.useGlobalSettings === undefined
      ? user.userInviteSettingsOverride === null || user.userInviteSettingsOverride === undefined
      : initialOverride.useGlobalSettings === true

  const [useGlobal, setUseGlobal] = useState(initialUseGlobal)
  const [linkTtlEnabled, setLinkTtlEnabled] = useState(
    initialOverride.linkTtlEnabled ?? effective.linkTtlEnabled,
  )
  const [linkTtlSeconds, setLinkTtlSeconds] = useState(
    initialOverride.linkTtlSeconds !== undefined && initialOverride.linkTtlSeconds !== null
      ? String(initialOverride.linkTtlSeconds)
      : effective.linkTtlSeconds !== null
        ? String(effective.linkTtlSeconds)
        : '',
  )
  const [slotsEnabled, setSlotsEnabled] = useState(
    initialOverride.slotsEnabled ?? effective.slotsEnabled,
  )
  const [initialSlots, setInitialSlots] = useState(
    initialOverride.initialSlots !== undefined && initialOverride.initialSlots !== null
      ? String(initialOverride.initialSlots)
      : effective.initialSlots !== null
        ? String(effective.initialSlots)
        : '',
  )
  const [refillThreshold, setRefillThreshold] = useState(
    initialOverride.refillThresholdQualified !== undefined && initialOverride.refillThresholdQualified !== null
      ? String(initialOverride.refillThresholdQualified)
      : effective.refillThresholdQualified !== null
        ? String(effective.refillThresholdQualified)
        : '',
  )
  const [refillAmount, setRefillAmount] = useState(
    initialOverride.refillAmount !== undefined && initialOverride.refillAmount !== null
      ? String(initialOverride.refillAmount)
      : effective.refillAmount !== null
        ? String(effective.refillAmount)
        : '',
  )
  const [dirty, setDirty] = useState(false)

  // VIP bypass — persists independently of `useGlobalSettings`: a user can ride
  // the global referral limits yet still skip the platform invite gate.
  const [bypassInviteGate, setBypassInviteGate] = useState(
    initialOverride.bypassInviteGate ?? false,
  )

  const parseNullableInt = (raw: string): number | null => {
    if (raw.trim() === '') return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? Math.max(0, n) : null
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      if (useGlobal) {
        return api.patch(`/admin/users/${telegramId}/invite-settings`, {
          useGlobalSettings: true,
          bypassInviteGate,
        })
      }
      return api.patch(`/admin/users/${telegramId}/invite-settings`, {
        useGlobalSettings: false,
        linkTtlEnabled,
        linkTtlSeconds: linkTtlEnabled ? parseNullableInt(linkTtlSeconds) : null,
        slotsEnabled,
        initialSlots: slotsEnabled ? parseNullableInt(initialSlots) : null,
        refillThresholdQualified: slotsEnabled ? parseNullableInt(refillThreshold) : null,
        refillAmount: slotsEnabled ? parseNullableInt(refillAmount) : null,
        bypassInviteGate,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.invites.saved'))
      setDirty(false)
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('userDetailPanel.invites.saveFailed'))),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('userDetailPanel.invites.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">{t('userDetailPanel.invites.useGlobal')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('userDetailPanel.invites.useGlobalHint')}
            </p>
          </div>
          <Switch
            checked={useGlobal}
            onCheckedChange={(v) => {
              setUseGlobal(v)
              setDirty(true)
            }}
          />
        </div>

        {/* VIP bypass — independent of the global/override referral limits. */}
        <div className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <div className="pr-3">
            <Label className="text-sm">{t('userDetailPanel.invites.bypassToggleLabel')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('userDetailPanel.invites.bypassToggleHint')}
            </p>
          </div>
          <Switch
            checked={bypassInviteGate}
            onCheckedChange={(v) => {
              setBypassInviteGate(v)
              setDirty(true)
            }}
            aria-label={t('userDetailPanel.invites.bypassToggleLabel')}
          />
        </div>

        <Separator />

        <fieldset disabled={useGlobal} className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t('userDetailPanel.invites.linkTtlEnabled')}</Label>
              <Switch
                checked={linkTtlEnabled}
                onCheckedChange={(v) => {
                  setLinkTtlEnabled(v)
                  setDirty(true)
                }}
              />
            </div>
            {linkTtlEnabled && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('userDetailPanel.invites.linkTtlSeconds')}</Label>
                <Input
                  type="number"
                  min="0"
                  className="h-9"
                  value={linkTtlSeconds}
                  onChange={(e) => {
                    setLinkTtlSeconds(e.target.value)
                    setDirty(true)
                  }}
                />
              </div>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t('userDetailPanel.invites.slotsEnabled')}</Label>
              <Switch
                checked={slotsEnabled}
                onCheckedChange={(v) => {
                  setSlotsEnabled(v)
                  setDirty(true)
                }}
              />
            </div>
            {slotsEnabled && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('userDetailPanel.invites.initialSlots')}</Label>
                  <Input
                    type="number"
                    min="0"
                    className="h-9"
                    value={initialSlots}
                    onChange={(e) => {
                      setInitialSlots(e.target.value)
                      setDirty(true)
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('userDetailPanel.invites.refillThreshold')}</Label>
                  <Input
                    type="number"
                    min="0"
                    className="h-9"
                    value={refillThreshold}
                    onChange={(e) => {
                      setRefillThreshold(e.target.value)
                      setDirty(true)
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('userDetailPanel.invites.refillAmount')}</Label>
                  <Input
                    type="number"
                    min="0"
                    className="h-9"
                    value={refillAmount}
                    onChange={(e) => {
                      setRefillAmount(e.target.value)
                      setDirty(true)
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </fieldset>

        <Separator />

        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            {t('userDetailPanel.invites.effectiveTitle')}
          </p>
          <p>
            TTL: {effective.linkTtlEnabled
              ? effective.linkTtlSeconds !== null
                ? `${effective.linkTtlSeconds}s`
                : t('userDetailPanel.invites.unlimited')
              : t('userDetailPanel.invites.disabled')}
          </p>
          <p>
            Slots: {effective.slotsEnabled
              ? `${effective.initialSlots ?? '—'} + ${effective.refillAmount ?? 0}/${effective.refillThresholdQualified ?? '—'}`
              : t('userDetailPanel.invites.disabled')}
          </p>
        </div>

        {dirty && (
          <PermissionGate resource="users" action="edit">
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="w-full"
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t('userDetailPanel.invites.save')}
          </Button>
          </PermissionGate>
        )}
      </CardContent>
    </Card>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// Transactions Tab
// ══════════════════════════════════════════════════════════════════════════════

function TransactionsTab({ user }: { user: UserDetail }) {
  const { t } = useTranslation()
  const txs = user.transactions ?? []
  if (!txs.length) return <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{t('userDetailPage.transactions.empty')}</CardContent></Card>

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">{t('userDetailPage.transactions.columns.paymentId')}</th>
                <th className="px-3 py-2 text-left">{t('userDetailPage.transactions.columns.status')}</th>
                <th className="px-3 py-2 text-left">{t('userDetailPage.transactions.columns.amount')}</th>
                <th className="px-3 py-2 text-left">{t('userDetailPage.transactions.columns.gateway')}</th>
                <th className="px-3 py-2 text-left">{t('userDetailPage.transactions.columns.date')}</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((tx) => (
                <tr key={tx.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{tx.paymentId?.slice(0, 10)}…</td>
                  <td className="px-3 py-2"><Badge variant={tx.status === 'COMPLETED' ? 'success' : 'secondary'} className="text-[10px]">{tx.status}</Badge></td>
                  <td className="px-3 py-2 font-mono">{tx.amount} {tx.currency}</td>
                  <td className="px-3 py-2 text-xs uppercase">{tx.gatewayType}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(tx.createdAt).toLocaleDateString('ru-RU')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Merge accounts — operator consolidation of two accounts into one
// ══════════════════════════════════════════════════════════════════════════════

function MergeAccountsCard({
  currentUserId,
  queryKey,
}: {
  currentUserId: string
  queryKey: string[]
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [refValue, setRefValue] = useState('')
  const [preview, setPreview] = useState<AccountMergePreview | null>(null)
  const [survivor, setSurvivor] = useState<'current' | 'counterpart'>('current')
  const [keepLogin, setKeepLogin] = useState<'current' | 'counterpart'>('current')
  const [keepTelegram, setKeepTelegram] = useState<'current' | 'counterpart'>('current')
  const [keepEmail, setKeepEmail] = useState<'current' | 'counterpart'>('current')
  const [confirmText, setConfirmText] = useState('')

  const previewMutation = useMutation({
    mutationFn: () => usersApi.getAccountMergePreview({ userId: currentUserId, ref: refValue.trim() }),
    onSuccess: (data) => {
      setPreview(data)
      setSurvivor('current')
      setKeepLogin('current')
      setKeepTelegram('current')
      setKeepEmail('current')
      setConfirmText('')
    },
    onError: (err) => {
      setPreview(null)
      toast.error(getErrorMessage(err, t('userDetailPanel.web.merge.notFound')))
    },
  })

  const mergeMutation = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error('no preview')
      const targetId = survivor === 'current' ? preview.current.userId : preview.counterpart.userId
      const sourceId = survivor === 'current' ? preview.counterpart.userId : preview.current.userId
      const toSide = (side: 'current' | 'counterpart'): 'source' | 'target' =>
        side === survivor ? 'target' : 'source'
      const choices: AccountMergeChoices = {
        ...(preview.conflicts.includes('login') ? { keepLogin: toSide(keepLogin) } : {}),
        ...(preview.conflicts.includes('telegram') ? { keepTelegram: toSide(keepTelegram) } : {}),
        ...(preview.conflicts.includes('email') ? { keepEmail: toSide(keepEmail) } : {}),
      }
      return usersApi.mergeAccounts({ sourceId, targetId, choices, confirm: true })
    },
    onSuccess: (res) => {
      toast.success(
        t('userDetailPanel.web.merge.success', {
          subscriptions: res.movedCounts.subscriptions,
          transactions: res.movedCounts.transactions,
        }),
      )
      setPreview(null)
      setRefValue('')
      setConfirmText('')
      queryClient.invalidateQueries({ queryKey })
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.web.merge.failed'))),
  })

  const confirmed = confirmText.trim().toUpperCase() === 'MERGE'
  const conflictFields = (['login', 'telegram', 'email'] as const).filter((c) =>
    preview?.conflicts.includes(c),
  )

  const renderColumn = (side: 'current' | 'counterpart', acc: AccountMergePreview['current']) => (
    <button
      type="button"
      onClick={() => setSurvivor(side)}
      className={cn(
        'space-y-0.5 rounded-lg border p-2 text-left text-[11px] transition-colors',
        survivor === side ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40',
      )}
    >
      <p className="font-semibold">
        {survivor === side
          ? `✓ ${t('userDetailPanel.web.merge.survivor')}`
          : t('userDetailPanel.web.merge.willDelete')}
      </p>
      <p className="truncate text-muted-foreground">{t('userDetailPanel.web.merge.loginField')}: {acc.login ?? '—'}</p>
      <p className="truncate text-muted-foreground">TG: {acc.telegramId ?? '—'}</p>
      <p className="truncate text-muted-foreground">{acc.email ?? '—'}</p>
      <p className="text-muted-foreground">
        {t('userDetailPanel.web.merge.subs')}: {acc.subscriptions.total} · {t('userDetailPanel.web.merge.tx')}: {acc.transactionsCount}
      </p>
      {acc.partner.isPartner && (
        <p className="text-muted-foreground">
          {t('userDetailPanel.web.merge.partner')}: {(acc.partner.balanceMinor / 100).toFixed(0)}₽
        </p>
      )}
    </button>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('userDetailPanel.web.merge.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('userDetailPanel.web.merge.description')}</p>
        <div className="flex gap-2">
          <Input
            value={refValue}
            onChange={(e) => setRefValue(e.target.value)}
            placeholder={t('userDetailPanel.web.merge.refPlaceholder')}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={refValue.trim().length === 0 || previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {t('userDetailPanel.web.merge.find')}
          </Button>
        </div>

        {preview && (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">{t('userDetailPanel.web.merge.pickSurvivor')}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {renderColumn('current', preview.current)}
              {renderColumn('counterpart', preview.counterpart)}
            </div>

            {conflictFields.length > 0 && (
              <div className="space-y-1.5 rounded-md border border-border p-2">
                <p className="text-[11px] font-medium">{t('userDetailPanel.web.merge.conflictsTitle')}</p>
                {conflictFields.map((c) => {
                  const value = c === 'login' ? keepLogin : c === 'telegram' ? keepTelegram : keepEmail
                  const setValue =
                    c === 'login' ? setKeepLogin : c === 'telegram' ? setKeepTelegram : setKeepEmail
                  return (
                    <div key={c} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-muted-foreground">{t(`userDetailPanel.web.merge.conflict.${c}`)}</span>
                      <div className="flex gap-1">
                        {(['current', 'counterpart'] as const).map((sideOpt) => (
                          <button
                            key={sideOpt}
                            type="button"
                            onClick={() => setValue(sideOpt)}
                            className={cn(
                              'rounded border px-2 py-0.5',
                              value === sideOpt ? 'border-primary bg-primary/10' : 'border-border',
                            )}
                          >
                            {sideOpt === 'current'
                              ? t('userDetailPanel.web.merge.thisAccount')
                              : t('userDetailPanel.web.merge.otherAccount')}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {t('userDetailPanel.web.merge.warning')}
            </div>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={t('userDetailPanel.web.merge.confirmPlaceholder')}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={!confirmed || mergeMutation.isPending}
              onClick={() => mergeMutation.mutate()}
            >
              {t('userDetailPanel.web.merge.execute')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Web Cabinet Tab — DEV-only operations on the linked WebAccount
// ══════════════════════════════════════════════════════════════════════════════

function WebCabinetTab({
  user,
  telegramId,
  queryKey,
}: {
  user: UserDetail
  telegramId: string
  queryKey: string[]
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [tempCredentials, setTempCredentials] = useState<{
    login: string | null
    temporaryPassword: string
    expiresAt: string
  } | null>(null)
  const [newLogin, setNewLogin] = useState(user.webAccount?.login ?? '')
  const [telegramInput, setTelegramInput] = useState(
    user.telegramId !== undefined && user.telegramId !== null ? String(user.telegramId) : '',
  )

  // Auto-copies "login / password" together. Used right after issuing a temp
  // password so the operator can paste both into the user's chat in one go.
  const copyCredentials = (login: string | null, password: string) => {
    const text = `${t('userDetailPanel.web.currentLogin')}: ${login ?? '—'}\n${t('userDetailPanel.web.tempPasswordLabel')}: ${password}`
    navigator.clipboard.writeText(text).then(
      () => toast.success(t('userDetailPanel.web.credentialsCopied')),
      () => {/* clipboard blocked — the modal still shows the values */},
    )
  }

  const resetMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/web/reset-password`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ['admin', 'user-temp-password', telegramId] })
      const creds = {
        login: res.data.login,
        temporaryPassword: res.data.temporaryPassword,
        expiresAt: res.data.expiresAt,
      }
      setTempCredentials(creds)
      // Auto-copy login+password for hand-off (requirement).
      copyCredentials(creds.login, creds.temporaryPassword)
      toast.success(t('userDetailPanel.web.passwordReset'))
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('userDetailPanel.web.passwordResetFailed'))),
  })

  const renameMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/users/${telegramId}/web/login`, { login: newLogin }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.web.renamed'))
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('userDetailPanel.web.renameFailed'))),
  })

  const bindTelegramMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/users/${telegramId}/telegram-binding`, { telegramId: telegramInput.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.web.telegramBound'))
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('userDetailPanel.web.telegramBindFailed'))),
  })

  // Current operator-viewable temporary password (persists in cache until the
  // user changes their password or the 24h TTL lapses).
  const tempPwQuery = useQuery({
    queryKey: ['admin', 'user-temp-password', telegramId],
    queryFn: async () =>
      (await api.get(`/admin/users/${telegramId}/web/temp-password`)).data as {
        temporaryPassword: string | null
        expiresAt: string | null
      },
    enabled: !!user.webAccount,
    staleTime: 30_000,
  })

  const webAccount = user.webAccount
  const currentTelegramId =
    user.telegramId !== undefined && user.telegramId !== null ? String(user.telegramId) : null

  return (
    <div className="space-y-3">
      {/* ── Telegram binding (always available) ─────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('userDetailPanel.web.telegramTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('userDetailPanel.web.telegramHint')}
          </p>
          <InfoRow
            label={t('userDetailPanel.web.currentTelegram')}
            value={currentTelegramId ?? '—'}
            mono
          />
          <PermissionGate resource="users" action="edit">
          <div className="flex gap-2">
            <Input
              value={telegramInput}
              onChange={(e) => setTelegramInput(e.target.value.replace(/[^\d]/g, ''))}
              placeholder={t('userDetailPanel.web.telegramPlaceholder')}
              inputMode="numeric"
              className="h-9"
            />
            <Button
              onClick={() => bindTelegramMutation.mutate()}
              disabled={
                bindTelegramMutation.isPending
                || telegramInput.trim() === ''
                || telegramInput.trim() === (currentTelegramId ?? '')
              }
            >
              {bindTelegramMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t('userDetailPanel.web.telegramBindButton')}
            </Button>
          </div>
          </PermissionGate>
        </CardContent>
      </Card>

      {webAccount ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('userDetailPanel.web.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <InfoRow
                label={t('userDetailPanel.web.currentLogin')}
                value={webAccount.login ?? '—'}
                mono
              />
              {webAccount.email && (
                <InfoRow label="Email" value={webAccount.email} mono />
              )}
              {webAccount.requiresPasswordChange && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  {t('userDetailPanel.web.requiresChangeNotice')}
                </div>
              )}
              {webAccount.temporaryPasswordExpiresAt &&
                new Date(webAccount.temporaryPasswordExpiresAt).getTime() > Date.now() && (
                  <InfoRow
                    label={t('userDetailPanel.web.tempUntil')}
                    value={new Date(webAccount.temporaryPasswordExpiresAt).toLocaleString(
                      i18n.language === 'ru' ? 'ru-RU' : 'en-US',
                    )}
                  />
                )}
              {tempPwQuery.data?.temporaryPassword && (
                <div className="space-y-1">
                  <Label className="text-xs">{t('userDetailPanel.web.currentTempPassword')}</Label>
                  <div className="flex gap-2">
                    <code className="flex-1 rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm">
                      {tempPwQuery.data.temporaryPassword}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        copyCredentials(webAccount.login ?? null, tempPwQuery.data!.temporaryPassword!)
                      }
                      aria-label={t('userDetailPanel.web.credentialsCopied')}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t('userDetailPanel.web.currentTempPasswordHint')}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t('userDetailPanel.web.resetPasswordTitle')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('userDetailPanel.web.resetPasswordHint')}
              </p>
              <PermissionGate resource="users" action="edit">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={resetMutation.isPending} variant="destructive">
                    {resetMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {t('userDetailPanel.web.resetPasswordButton')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('userDetailPanel.web.resetConfirmTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('userDetailPanel.web.resetConfirmText')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('userDetailPanel.actions.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => resetMutation.mutate()}>
                      {t('userDetailPanel.web.resetPasswordButton')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              </PermissionGate>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t('userDetailPanel.web.renameLoginTitle')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('userDetailPanel.web.renameLoginHint')}
              </p>
              <PermissionGate resource="users" action="edit">
              <div className="flex gap-2">
                <Input
                  value={newLogin}
                  onChange={(e) => setNewLogin(e.target.value)}
                  placeholder={t('userDetailPanel.web.newLoginPlaceholder')}
                  className="h-9"
                />
                <Button
                  onClick={() => renameMutation.mutate()}
                  disabled={
                    renameMutation.isPending
                    || newLogin.trim() === ''
                    || newLogin === webAccount.login
                  }
                >
                  {renameMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  {t('userDetailPanel.web.renameButton')}
                </Button>
              </div>
              </PermissionGate>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="py-4 text-xs text-muted-foreground">
            {t('userDetailPanel.web.noWebAccount')}
          </CardContent>
        </Card>
      )}

      <MergeAccountsCard currentUserId={user.id} queryKey={queryKey} />

      {/* Temp password modal */}
      <Dialog
        open={tempCredentials !== null}
        onOpenChange={(open) => {
          if (!open) setTempCredentials(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('userDetailPanel.web.tempIssuedTitle')}</DialogTitle>
          </DialogHeader>
          {tempCredentials && (
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">
                {t('userDetailPanel.web.tempIssuedHint')}
              </p>
              <div className="space-y-1">
                <Label className="text-xs">{t('userDetailPanel.web.currentLogin')}</Label>
                <div className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm">
                  {tempCredentials.login ?? '—'}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('userDetailPanel.web.tempPasswordLabel')}</Label>
                <div className="flex gap-2">
                  <code className="flex-1 rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm">
                    {tempCredentials.temporaryPassword}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() =>
                      copyCredentials(tempCredentials.login, tempCredentials.temporaryPassword)
                    }
                    aria-label={t('userDetailPanel.web.credentialsCopied')}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() =>
                  copyCredentials(tempCredentials.login, tempCredentials.temporaryPassword)
                }
              >
                <Copy className="mr-2 h-4 w-4" />
                {t('userDetailPanel.web.copyCredentials')}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('userDetailPanel.web.tempExpires', {
                  expiresAt: new Date(tempCredentials.expiresAt).toLocaleString(
                    i18n.language === 'ru' ? 'ru-RU' : 'en-US',
                  ),
                })}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}


// ══════════════════════════════════════════════════════════════════════════════
// Action buttons (header)
// ══════════════════════════════════════════════════════════════════════════════

function BlockButton({ telegramId, isBlocked, queryKey }: { telegramId: string; isBlocked: boolean; queryKey: string[] }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/${isBlocked ? 'unblock' : 'block'}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(isBlocked ? t('userDetailPanel.toasts.unblocked') : t('userDetailPanel.toasts.userBlocked')) },
  })

  if (isBlocked) {
    return <Button size="sm" variant="outline" onClick={() => mutation.mutate()}><UserCheck className="mr-1 h-3.5 w-3.5" /> {t('userDetailPanel.actions.unblock')}</Button>
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive"><UserX className="mr-1 h-3.5 w-3.5" /> {t('userDetailPanel.actions.block')}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('userDetailPanel.actions.blockTitle')}</AlertDialogTitle><AlertDialogDescription>{t('userDetailPanel.actions.blockDescription')}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>{t('userDetailPanel.actions.cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => mutation.mutate()}>{t('userDetailPanel.actions.block')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DeleteButton({ telegramId }: { telegramId: string }) {
  const { t } = useTranslation()
  const [confirmText, setConfirmText] = useState('')
  const mutation = useMutation({
    mutationFn: () => api.delete(`/admin/users/${telegramId}`),
    onSuccess: () => toast.success(t('userDetailPanel.toasts.userDeleted')),
    onError: () => toast.error(t('userDetailPanel.toasts.deleteFailed')),
  })

  // Gate the irreversible delete (also wipes the Remnawave panel profile)
  // behind a typed confirmation so a stray click can't nuke a subscriber.
  const confirmed = confirmText.trim().toUpperCase() === 'DELETE'

  return (
    <AlertDialog onOpenChange={(open) => { if (!open) setConfirmText('') }}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive" aria-label={t('userDetailPanel.actions.deleteTitle')}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('userDetailPanel.actions.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('userDetailPanel.actions.deleteDescription')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('userDetailPanel.actions.deleteWarning')}</span>
        </div>
        <div className="space-y-2">
          <Label htmlFor="delete-confirm-input">{t('userDetailPanel.actions.deleteConfirmLabel')}</Label>
          <Input
            id="delete-confirm-input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={t('userDetailPanel.actions.deleteConfirmPlaceholder')}
            autoComplete="off"
            autoCapitalize="characters"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('userDetailPanel.actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!confirmed || mutation.isPending}
            onClick={(e) => {
              if (!confirmed) {
                e.preventDefault()
                return
              }
              mutation.mutate()
            }}
            className="bg-destructive text-destructive-foreground"
          >
            {t('userDetailPanel.actions.deleteForever')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function NotifyButton({ telegramId }: { telegramId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/notify`, { message }),
    onSuccess: () => { toast.success(t('userDetailPanel.toasts.notifySent')); setOpen(false); setMessage('') },
    onError: () => toast.error(t('userDetailPanel.toasts.notifyFailed')),
  })

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Send className="mr-1 h-3.5 w-3.5" /> {t('userDetailPanel.actions.notify')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('userDetailPanel.actions.sendNotification')}</DialogTitle></DialogHeader>
          <textarea
            className="w-full rounded-md border p-3 text-sm"
            rows={4}
            placeholder={t('userDetailPanel.actions.messagePlaceholder')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>{t('userDetailPanel.actions.cancel')}</Button>
            <Button onClick={() => mutation.mutate()} disabled={!message.trim() || mutation.isPending}>
              {t('userDetailPanel.actions.send')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
