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

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  AtSign,
  Apple,
  AlertTriangle,
  Calendar,
  ChevronDown,
  Copy,
  Flag,
  Globe,
  Hash,
  Infinity as InfinityIcon,
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
  Undo2,
  UserCheck,
  UserX,
  Wallet,
  Wifi,
  Wrench,
  ClipboardList,
  History,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { expectArray, isRecord } from '@/lib/api-utils'
import { cn, truncate } from '@/lib/utils'
import { plansQueryKeys, usePlans } from '@/features/plans/plans-api'
import { getErrorMessage } from '@/lib/http-errors'
import { RemnawaveIcon } from '@/features/remnawave/remnawave-icon'
import type {
  UserDetail,
  UserPartner,
  UserSubscription,
  UserReferralEntry,
  UserPartnerTransaction,
  UserReviewFlag,
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
import { Textarea } from '@/components/ui/textarea'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import { PermissionGate, useHasPermission } from '@/features/rbac'
import { usersApi, type AccountMergePreview, type AccountMergeChoices, type UserOperation } from './users-api'
import { PointsLedgerSheet } from './points-ledger-sheet'

/** The reason codes the backend accepts for a manual points adjustment; the subscriber sees the label. */
const POINTS_ADJUSTMENT_REASONS = ['COMPENSATION', 'PROMOTION', 'CORRECTION', 'VIOLATION', 'OTHER'] as const
type PointsAdjustmentReason = (typeof POINTS_ADJUSTMENT_REASONS)[number]
import {
  SYNC_REFUSAL_BY_CODE,
  SYNC_REFUSAL_BY_MESSAGE,
} from './subscription-sync-refusals'
import {
  readSubscriptionDeleteRefusal,
  type SubscriptionDeleteRefusal,
} from './subscription-delete-refusals'
import { panelTrafficLimitToGb } from './panel-traffic-limit'
import {
  useCreateReferralInviteMutation,
  useIssueReferralRewardMutation,
  useReferralInviteCapacityQuery,
  useReferralInvitesQuery,
  useReferralRewardsQuery,
  useRevokeReferralInviteMutation,
  type ReferralInviteCapacity,
} from '@/features/referrals/referrals-queries'

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
          <TabsTrigger value="operations">{t('userDetailPanel.tabs.operations')}</TabsTrigger>
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
        <TabsContent value="operations">
          <OperationsTab telegramId={telegramId} />
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
  const [pointsReason, setPointsReason] = useState<PointsAdjustmentReason>('OTHER')
  const [pointsNote, setPointsNote] = useState('')
  const [ledgerOpen, setLedgerOpen] = useState(false)
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
    // The reason is a code the subscriber sees in their own history; the note
    // is free text that stays in the panel. An empty note is not sent at all —
    // the DTO whitelists fields, and "no note" is the absence of the key.
    mutationFn: (input: { delta: number; reason: PointsAdjustmentReason; note: string }) =>
      api.post(`/admin/users/${telegramId}/points`, {
        delta: input.delta,
        reason: input.reason,
        ...(input.note.trim().length > 0 ? { note: input.note.trim() } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setPointsNote('')
      setPointsReason('OTHER')
      toast.success(t('userDetailPanel.toasts.pointsUpdated'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.profileFailed'))),
  })
  const submitPointsAdjustment = () => {
    const delta = parseInt(pointsDelta, 10)
    if (Number.isFinite(delta) && delta !== 0) {
      pointsMutation.mutate({ delta, reason: pointsReason, note: pointsNote })
      setPointsDelta('')
    }
  }

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
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <InfoRow icon={<Wallet className="h-3 w-3" />} label={t('userDetailPanel.profile.points')} value={String(user.points ?? 0)} mono />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  aria-label={t('userDetailPanel.pointsLedger.open')}
                  onClick={() => setLedgerOpen(true)}
                >
                  <History className="mr-1 h-3 w-3" />
                  {t('userDetailPanel.pointsLedger.open')}
                </Button>
              </div>
              <PointsLedgerSheet
                telegramId={telegramId}
                balance={Number(user.points ?? 0)}
                open={ledgerOpen}
                onOpenChange={setLedgerOpen}
              />
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
                  value={
                    // Absent means UNLIMITED, not unknown — the long note on the
                    // subscription card below has the wire detail. `null` folds in
                    // as the other spelling of the same state; an empty string does
                    // NOT, because it is broken rather than unlimited.
                    currentSub.expireAt === undefined || currentSub.expireAt === null
                      ? t('userDetailPanel.profile.unlimitedExpiry')
                      : new Date(currentSub.expireAt).toLocaleDateString(locale)
                  }
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

          {/* Points: the delta, WHY (a code the subscriber sees), and a note that stays here. */}
          <div className="space-y-2">
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
                    e.preventDefault()
                    submitPointsAdjustment()
                  }
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">{t('userDetailPanel.pointsLedger.reason')}</span>
              <Select value={pointsReason} onValueChange={(value) => setPointsReason(value as PointsAdjustmentReason)}>
                <SelectTrigger className="h-7 w-40 text-xs" aria-label={t('userDetailPanel.pointsLedger.reasonAria')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POINTS_ADJUSTMENT_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason} className="text-xs">
                      {t(`userDetailPanel.pointsLedger.reasons.${reason}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Textarea
              className="min-h-[3rem] text-xs"
              rows={2}
              maxLength={500}
              placeholder={t('userDetailPanel.pointsLedger.notePlaceholder')}
              aria-label={t('userDetailPanel.pointsLedger.noteAria')}
              value={pointsNote}
              onChange={(e) => setPointsNote(e.target.value)}
            />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={pointsMutation.isPending || !Number.isFinite(parseInt(pointsDelta, 10)) || parseInt(pointsDelta, 10) === 0}
                onClick={submitPointsAdjustment}
              >
                {t('userDetailPanel.profile.applyPoints')}
              </Button>
            </div>
          </div>

          {/*
            PARTNER LIFECYCLE, AND NOT A `users:edit` CONTROL.

            `POST /admin/users/:telegramId/create-partner` and
            `.../partner/toggle` are both `@RequirePermission('partners',
            'edit')` (`admin-user-management.controller.ts`), because what they
            write is a `Partner` row — the partner ledger, not the user profile.
            The Actions card around this block is gated on `users:edit`, and the
            shipped `operator` role holds `users:edit` while holding merely
            `partners:view` (`rbac.resources.ts`). That role was therefore shown
            a live "Activate" button whose only possible answer is a 403.

            HIDDEN RATHER THAN DELETED. A control that vanishes can read as a
            bug, so the choice needs a reason: this is the only create-partner
            control the panel can actually reach, and now the only one it has at
            all. `PartnerTab` used to carry a second copy in a `!user.partner`
            early return that never rendered — the Partner tab exists only
            `{user.partner && …}` — and that dead branch has since been deleted,
            so removing this block would take partner creation off the panel
            entirely, for the roles that ARE entitled to it as much as for the
            ones that are not. Nesting the gate is the same idiom the
            subscription card and `PartnerTab` already use, and it makes true
            the claim `admin-user-management.controller.ts` makes about this
            file: all five partner routes sit behind
            `<PermissionGate resource="partners" action="edit">`.
          */}
          <PermissionGate resource="partners" action="edit">
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
          </PermissionGate>

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

// ── Panel identity: two shapes, one per panel era ────────────────────────────
//
// Remnawave 2.7.x/2.8.x key a user by UUID. Remnawave 3.x dropped that column
// entirely and names a user by its numeric `id` (e.g. `4471`). `remnawaveId`
// carries whichever form the panel gave, so nothing here may assume 36 hex
// characters — not the preview, and not the link dialog's gate.

/**
 * How much of a panel identity the collapsed row shows before it cuts.
 * The full value is always on the `title` attribute and on the Copy button.
 */
const REMNAWAVE_ID_PREVIEW_LENGTH = 8

/** Mirrors `REMNAWAVE_UUID_PATTERN` in `admin-user-subscriptions.controller.ts`. */
const REMNAWAVE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** A decimal integer, no sign, no separators — a 3.x panel id. */
const REMNAWAVE_NUMERIC_ID_PATTERN = /^\d+$/
/** A UUID's 36 characters; the widest either form ever needs. */
const REMNAWAVE_ID_MAX_LENGTH = 36

/**
 * The same accept-rule the backend applies in `linkRemnawaveProfile`, restated
 * here rather than shared — nothing crosses the SPA/Nest boundary but JSON.
 *
 * The server stays the authority and re-checks; this exists only so a typo
 * comes back as a sentence next to the field instead of a bare 400 toast that
 * does not say what the field wanted. Keep the two in step: if the backend
 * widens, this must widen too, or the dialog will refuse an identifier the
 * panel would have accepted.
 */
function isLinkableRemnawaveId(value: string): boolean {
  if (value.length === 0 || value.length > REMNAWAVE_ID_MAX_LENGTH) return false
  return REMNAWAVE_UUID_PATTERN.test(value) || REMNAWAVE_NUMERIC_ID_PATTERN.test(value)
}

/**
 * `remnawaveSyncState` answers TWO independent questions with one enum, and that
 * is why a single chip beside the profile name and id could not be honest:
 *
 *   • "is the profile there?"  — UNLINKED / MISSING / UNAVAILABLE, decided by
 *     the panel lookup (`getPanelUserOutcome`);
 *   • "did the last job land?" — PENDING / FAILED / SYNCED, decided by the
 *     newest live `ProfileSyncJob` row.
 *
 * A chip sitting next to an identity can only be read as answering the first, so
 * a failed UPDATE — stale limits or expiry on a profile that is present and
 * reachable — rendered as "Sync failed" next to the profile id, which reads as
 * "this link is broken". 16 of the 21 places that enqueue a job enqueue exactly
 * that kind of update.
 *
 * The wire field is upstream's contract and is untouched. These two readers
 * split it back apart for RENDERING only, so each statement can sit where its
 * subject is. The split is lossless rather than a guess because the job answer
 * is on the wire in its own right, as `remnawaveSyncJob`.
 */
type RemnawaveProfilePresence = 'LINKED' | 'UNLINKED' | 'MISSING' | 'UNAVAILABLE'

function remnawaveProfilePresence(sub: UserSubscription): RemnawaveProfilePresence {
  // The only two states that are statements about the profile itself.
  if (sub.remnawaveSyncState === 'MISSING') return 'MISSING'
  if (sub.remnawaveSyncState === 'UNAVAILABLE') return 'UNAVAILABLE'
  // Everything else means either the lookup answered ok — SYNCED, PENDING and
  // FAILED on a linked row all imply `outcome.kind === 'ok'` — or there was no
  // identity to look up at all. `remnawaveId` is what separates those two, and
  // it is the same column the backend branches on.
  return sub.remnawaveId ? 'LINKED' : 'UNLINKED'
}

type SubscriptionSyncActivity = 'IDLE' | 'PENDING' | 'FAILED'

function subscriptionSyncActivity(sub: UserSubscription): SubscriptionSyncActivity {
  const status = sub.remnawaveSyncJob?.status
  if (status === 'PENDING' || status === 'RUNNING') return 'PENDING'
  if (status === 'FAILED') return 'FAILED'
  // `null` is a definite "no live job for this subscription". `undefined` is a
  // backend older than the field, where the conflated enum is the only signal
  // there is — and losing the failure entirely would be the one outcome this
  // whole change is not allowed to produce.
  if (sub.remnawaveSyncJob === undefined) {
    if (sub.remnawaveSyncState === 'PENDING') return 'PENDING'
    if (sub.remnawaveSyncState === 'FAILED') return 'FAILED'
  }
  return 'IDLE'
}

// ── What `POST …/sync` actually said ───────────────────────────────────────
//
// The endpoint answers HTTP 200 for its REFUSALS as well as its successes, and
// this panel used to fire `toast.success` on the status code alone. An operator
// pressed sync, saw green, and nothing had been written: the mental model
// "press sync and the panel is current" was being CONFIRMED by the UI at
// exactly the moments it was false.
//
// The backend goes out of its way to keep three refusals apart, and says why in
// its own comment: conflating "the panel merely blinked" with "the profile is
// genuinely gone" is what makes an operator start repairing a link that was
// never broken. Reading only the status code threw that distinction away.
// Reading the body and then collapsing the three into one sentence would throw
// it away one level up. So each refusal is its own member, because the
// operator's NEXT ACTION differs for each one.

const PANEL_REFRESH_KEYS = [
  'configUrl',
  'remnawavePanelId',
  'remnawavePanelUsername',
  'expiresAt',
] as const

type PanelRefreshKey = (typeof PANEL_REFRESH_KEYS)[number]

/**
 * The panel's own reading of the two columns rezeis OWNS and the sync
 * deliberately refuses to adopt.
 *
 * Echoed by the backend so the drift is visible; shown here for the same
 * reason. Only the two limits an operator ASSIGNED are read: `status`
 * duplicates the card's own status dot, and `internalSquads` is a list of
 * uuids that means nothing to a human without a name lookup this card has no
 * business performing.
 */
interface PanelReportedLimits {
  readonly trafficLimitBytes: number | null
  readonly hwidDeviceLimit: number | null
}

type SubscriptionSyncOutcome =
  | {
      readonly kind: 'synced'
      /** Only the keys the panel positively stated and the backend wrote. */
      readonly refreshed: readonly PanelRefreshKey[]
      readonly panelReports: PanelReportedLimits | null
    }
  /** No panel profile is linked. Nothing to sync — NOT an error condition. */
  | { readonly kind: 'notLinked' }
  /** Transient. Retry. Nothing here says any link is broken. */
  | { readonly kind: 'panelUnavailable' }
  /** The link IS broken. Repairing it is the right next step. */
  | { readonly kind: 'profileMissing' }
  /** A refusal this build does not recognise; the server's own words are shown. */
  | { readonly kind: 'refused'; readonly message: string }

function readReportedLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Reads the BODY, never the status code. */
function readSyncOutcome(payload: unknown): SubscriptionSyncOutcome {
  const body = isRecord(payload) ? payload : {}
  // `=== true`, not truthy and not "the key is present": `{ synced: false }` is
  // the shape of every refusal, and anything looser reads a refusal as a win.
  if (body.synced === true) {
    const refreshed = isRecord(body.refreshed) ? body.refreshed : {}
    const reports = isRecord(body.panelReports) ? body.panelReports : null
    return {
      kind: 'synced',
      refreshed: PANEL_REFRESH_KEYS.filter((key) => refreshed[key] !== undefined),
      panelReports:
        reports === null
          ? null
          : {
              trafficLimitBytes: readReportedLimit(reports.trafficLimitBytes),
              hwidDeviceLimit: readReportedLimit(reports.hwidDeviceLimit),
            },
    }
  }
  const message = typeof body.message === 'string' ? body.message : ''
  const code = typeof body.code === 'string' ? body.code : ''
  // THE CODE FIRST, and the sentence only if there was no code this build
  // recognises. A backend that sends a code has already told us which of the
  // three refusals this is in a form no copy-edit can move, so its own English
  // prose is not consulted at all — it may have been reworded, and it is a
  // diagnostic line, never the thing that decides a branch.
  //
  // The fallback is reached in two cases and both are meant: a backend too old
  // to send a code (a rolling deploy, see `SYNC_REFUSAL_BY_MESSAGE`), and a code
  // this build has never heard of, where an older sentence it does understand is
  // still better guidance than `refused`. Neither matching is `refused`,
  // unchanged.
  const known = SYNC_REFUSAL_BY_CODE.get(code) ?? SYNC_REFUSAL_BY_MESSAGE.get(message)
  return known === undefined ? { kind: 'refused', message } : { kind: known }
}

const PRESENCE_TONE: Record<RemnawaveProfilePresence, string> = {
  LINKED: 'text-muted-foreground',
  UNLINKED: 'text-muted-foreground',
  MISSING: 'text-destructive',
  UNAVAILABLE: 'text-amber-600 dark:text-amber-500',
}

const SYNC_JOB_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'TRAFFIC_RESET'] as const

/**
 * The verdict of the LAST sync press, rendered on the card it was pressed from.
 *
 * A toast is gone in four seconds; "did anything actually happen" outlives it.
 * This block is the durable half of the same answer, and it is deliberately not
 * green for anything except a write that landed — the defect it replaces was a
 * success toast on all three refusals, which confirmed the operator's mental
 * model at exactly the moments it was false.
 */
function SubscriptionSyncOutcomeNotice({
  sub,
  outcome,
}: {
  sub: UserSubscription
  outcome: SubscriptionSyncOutcome
}) {
  const { t } = useTranslation()
  const base = 'mx-3 mb-1.5 rounded border px-2 py-1.5 text-[10px]'

  if (outcome.kind === 'synced') {
    // The panel's own reading of the two columns rezeis OWNS. SHOWN, never
    // adopted: an operator who assigned three devices needs to see the panel
    // enforcing twelve, and that is a drift to investigate — not a value to
    // copy back over the plan.
    const reports = outcome.panelReports
    const panelDevices = reports === null ? null : reports.hwidDeviceLimit
    // TRAFFIC IS A THREE-STATE ANSWER ON BOTH SIDES, and flattening it to two
    // is how this block used to invent drift out of thin air:
    //
    //   `undefined`  nobody stated a cap. The panel payload had no
    //                `trafficLimitBytes`, or the subscription row did not carry
    //                `trafficLimit`. Nothing to compare — say nothing.
    //   `null`       UNLIMITED, positively stated.
    //   a number     that many whole gigabytes. `0` is a legitimate one of
    //                these: genuinely no traffic at all.
    //
    // Absence is checked HERE, before the converter runs, and deliberately:
    // `panelTrafficLimitToGb` answers `null` for garbage as a floor against
    // `NaN`, which is not the same statement as "the panel said unlimited". Its
    // own docblock says the caller has to make that distinction, and this is a
    // caller that must.
    //
    // Then the conversion itself is the SHARED rule, not a seventh local
    // re-typing of it. The re-typing was `Math.round(bytes / 1024 ** 3)` with
    // no floor, so once the server grew its `Math.max(1, …)` the two sides
    // disagreed by construction: a 0.4 GB panel cap stored as `1`, rendered as
    // `0`, and reported to the operator as a drift between two agreeing sides.
    const panelTrafficGb: number | null | undefined =
      reports === null || reports.trafficLimitBytes === null
        ? undefined
        : panelTrafficLimitToGb(reports.trafficLimitBytes)
    const assignedDevices = sub.deviceLimit ?? 0
    // NOT `?? 0`. That spelling made an UNLIMITED row and a genuine ZERO-GB row
    // the same number, which is the one distinction this column is required to
    // keep: `trafficLimit === null` is unlimited, `0` is no traffic at all.
    // With `?? 0`, a panel reporting unlimited against an unlimited row read as
    // "panel 0, assigned 0" — silence — and a panel reporting unlimited against
    // a real zero-GB row read the same way. Both drifts vanished into one lie.
    //
    // (`assignedDevices` above keeps its `?? 0` on purpose. `deviceLimit <= 0`
    // IS the product's canonical unlimited and matches the panel's own
    // `hwidDeviceLimit: 0`. The asymmetry between the two columns is deliberate
    // and documented on the server — do not harmonise them.)
    const assignedTrafficGb: number | null | undefined = sub.trafficLimit
    const deviceDrift = panelDevices !== null && panelDevices !== assignedDevices
    const trafficDrift =
      panelTrafficGb !== undefined &&
      assignedTrafficGb !== undefined &&
      panelTrafficGb !== assignedTrafficGb

    return (
      <div role="status" className={`${base} border-border bg-muted/40`}>
        <p className="font-medium text-foreground">
          {outcome.refreshed.length === 0
            ? t('userDetailPanel.subscriptions.syncOutcome.synced.nothingStated')
            : t('userDetailPanel.subscriptions.syncOutcome.synced.refreshed', {
                fields: outcome.refreshed
                  .map((key) => t(`userDetailPanel.subscriptions.syncOutcome.field.${key}`))
                  .join(', '),
              })}
        </p>
        {!deviceDrift && !trafficDrift ? null : (
          <p className="mt-0.5 text-muted-foreground">
            {t('userDetailPanel.subscriptions.syncOutcome.drift.headline')}
          </p>
        )}
        {!deviceDrift ? null : (
          <p className="mt-0.5 pl-2 text-amber-600 dark:text-amber-500">
            {t('userDetailPanel.subscriptions.syncOutcome.drift.devices', {
              panel: panelDevices,
              assigned: assignedDevices,
            })}
          </p>
        )}
        {!trafficDrift ? null : (
          <p className="mt-0.5 pl-2 text-amber-600 dark:text-amber-500">
            {/*
              Three sentences, because "unlimited" cannot be interpolated into
              one that ends in " GB". Reaching this branch means both sides
              stated a cap and the two disagree, so at most one of them is
              unlimited — if both were, they would agree and there would be no
              drift to print.
            */}
            {t(
              panelTrafficGb === null
                ? 'userDetailPanel.subscriptions.syncOutcome.drift.trafficPanelUnlimited'
                : assignedTrafficGb === null
                  ? 'userDetailPanel.subscriptions.syncOutcome.drift.trafficAssignedUnlimited'
                  : 'userDetailPanel.subscriptions.syncOutcome.drift.traffic',
              { panel: panelTrafficGb, assigned: assignedTrafficGb },
            )}
          </p>
        )}
      </div>
    )
  }

  // Three refusals, three next actions, three tones — and not one of them green.
  let tone = 'border-border bg-muted/40'
  let text = 'text-muted-foreground'
  let headline = t('userDetailPanel.subscriptions.syncOutcome.notLinked.headline')
  let hint = t('userDetailPanel.subscriptions.syncOutcome.notLinked.hint')
  if (outcome.kind === 'panelUnavailable') {
    tone = 'border-amber-500/40 bg-amber-500/5'
    text = 'text-amber-600 dark:text-amber-500'
    headline = t('userDetailPanel.subscriptions.syncOutcome.panelUnavailable.headline')
    hint = t('userDetailPanel.subscriptions.syncOutcome.panelUnavailable.hint')
  } else if (outcome.kind === 'profileMissing') {
    tone = 'border-destructive/40 bg-destructive/5'
    text = 'text-destructive'
    headline = t('userDetailPanel.subscriptions.syncOutcome.profileMissing.headline')
    hint = t('userDetailPanel.subscriptions.syncOutcome.profileMissing.hint')
  } else if (outcome.kind === 'refused') {
    tone = 'border-destructive/40 bg-destructive/5'
    text = 'text-destructive'
    headline = t('userDetailPanel.subscriptions.syncOutcome.refused.headline')
    hint = t('userDetailPanel.subscriptions.syncOutcome.refused.hint')
  }

  return (
    <div role="status" className={`${base} ${tone}`}>
      <p className={`flex items-start gap-1 font-medium ${text}`}>
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{headline}</span>
      </p>
      {hint.length === 0 ? null : (
        <p className="mt-0.5 pl-4 text-muted-foreground">{hint}</p>
      )}
      {/* The server's own sentence, for a refusal this build does not
          recognise. DEMOTED, never promoted to operator copy: every sentence an
          operator is asked to READ comes from the dictionaries, in their own
          language. This is the same shape `SubscriptionSyncFailureNotice` gives
          `lastError` — a mono diagnostic line, so the reason is not lost while
          the prose around it stays translated. */}
      {outcome.kind !== 'refused' || outcome.message.length === 0 ? null : (
        <p
          className="mt-0.5 truncate pl-4 font-mono text-muted-foreground"
          title={outcome.message}
        >
          {outcome.message}
        </p>
      )}
    </div>
  )
}

/**
 * The 409 the delete endpoint answers with when this row’s stored panel
 * identity can no longer be trusted — turned into the one next step that
 * clears it.
 *
 * WHY A LINK AND NOT A BUTTON THAT RUNS THE REPAIR HERE. Three facts decided
 * this, and none of them is a style preference:
 *
 *  • The remedy is `POST /admin/profile-sync/panel-link-reconciliation`, and
 *    that endpoint takes NO subscription id. It is a sweep over a population,
 *    bounded by `limit` / `chunkSize` / `startAfterId`. So there is nothing to
 *    deep-link with this subscription pre-filled; a control that appeared to
 *    do that would be describing a request the backend cannot receive.
 *  • An inline “repair it now” button would be a second, unconfirmed path to
 *    a BULK write, fired from a screen that shows one customer. The
 *    reconciliation surface exists to hold the opposite guarantee — preview
 *    first, then a confirmation that names the scope — and a shortcut around
 *    it is the shortcut that eventually gets used by accident.
 *  • The refusal is not “something went wrong”. It is “do this specific thing
 *    and the delete will work”, and an operator handed a sentence and left to
 *    find the page will not go.
 *
 * So: one press to the surface that owns the write, and the sequence spelled
 * out on the card — preview, real run, delete again — rather than left to be
 * remembered across two screens.
 */
function SubscriptionDeleteRefusalNotice({
  refusal,
}: {
  refusal: SubscriptionDeleteRefusal
}) {
  const { t } = useTranslation()
  // The refusal NAMES its own copy. A second refusal added to
  // `subscription-delete-refusals.ts` therefore renders its own guidance or
  // renders nothing recognisable — it can never silently inherit this one’s
  // remedy, which points at a repair that would not have helped it.
  const key = `userDetailPanel.subscriptions.deleteRefusal.${refusal}`
  return (
    <div
      role="status"
      className="mx-3 mb-1.5 rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[10px]"
    >
      <p className="flex items-start gap-1 font-medium text-destructive">
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{t(`${key}.headline`)}</span>
      </p>
      <p className="mt-0.5 pl-4 text-muted-foreground">{t(`${key}.body`)}</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-8 text-muted-foreground">
        <li>{t(`${key}.step1`)}</li>
        <li>{t(`${key}.step2`)}</li>
        <li>{t(`${key}.step3`)}</li>
      </ol>
      <div className="mt-1 pl-4">
        <Button asChild size="sm" variant="outline" className="h-6 px-2 text-[10px]">
          <Link to="/subscriptions">
            <Wrench className="mr-1 h-3 w-3" aria-hidden="true" />
            {t('userDetailPanel.subscriptions.deleteRefusal.openReconciliation')}
          </Link>
        </Button>
      </div>
    </div>
  )
}

/**
 * What the last sync JOB did, rendered at CARD level where the subscription's
 * sync activity is described — not beside the profile identity, whose subject it
 * is not.
 *
 * The wording names the CHANGE that did not land rather than the profile, and
 * when the profile is known-good it says so in as many words. That sentence is
 * the actual repair: the operator keeps the failure signal PR #40 added (the
 * owner rejected filtering these out precisely because it is the only warning
 * that limits, expiry or squads are not reaching the panel) without it reading
 * as a claim about the link.
 */
function SubscriptionSyncFailureNotice({ sub }: { sub: UserSubscription }) {
  const { t } = useTranslation()
  const job = sub.remnawaveSyncJob
  const action = SYNC_JOB_ACTIONS.find((known) => known === job?.action) ?? 'unknown'
  const attempts = job?.attempts ?? null
  const lastError = job?.lastError ?? null

  return (
    <div
      role="status"
      className="mx-3 mb-1.5 rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[10px]"
    >
      <p className="flex items-start gap-1 font-medium text-destructive">
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          {t('userDetailPanel.subscriptions.syncFailure.headline', {
            what: t(`userDetailPanel.subscriptions.syncFailure.what.${action}`),
          })}
        </span>
      </p>
      {remnawaveProfilePresence(sub) === 'LINKED' ? (
        <p className="mt-0.5 pl-4 text-muted-foreground">
          {t('userDetailPanel.subscriptions.syncFailure.linkIntact')}
        </p>
      ) : null}
      {attempts !== null ? (
        <p className="mt-0.5 pl-4 text-muted-foreground">
          {t('userDetailPanel.subscriptions.syncFailure.attempts', { attempts })}
        </p>
      ) : null}
      {lastError !== null ? (
        <p className="mt-0.5 truncate pl-4 font-mono text-muted-foreground" title={lastError}>
          {lastError}
        </p>
      ) : null}
    </div>
  )
}

/**
 * One-row Remnawave profile reveal for the subscription card. Shows:
 *   • the live `username` from Remnawave (e.g. `rz_user_sub`),
 *   • a Copy button that yanks the panel identity to the clipboard,
 *   • a tiny tooltip-like underline with the (possibly cut) identity below.
 *
 * If we don't yet know the profile (no remnawaveId or upstream errored),
 * we render an "—" placeholder rather than hiding the row, because the
 * row's vertical rhythm is what makes the card legible.
 *
 * Painted in pink to read as a Remnawave-link affordance distinct from
 * the rest of the plain InfoRow stack.
 */
function RemnawaveProfileRow({
  sub,
  onLinkProfile,
  isLinkingProfile,
}: {
  sub: UserSubscription
  onLinkProfile: (remnawaveId: string) => void
  isLinkingProfile: boolean
}) {
  const { t } = useTranslation()
  const profileName = sub.remnawaveProfileName?.trim()
  const remnawaveId = sub.remnawaveId
  const presence = remnawaveProfilePresence(sub)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [candidateId, setCandidateId] = useState('')
  const candidate = candidateId.trim()
  const candidateIsLinkable = isLinkableRemnawaveId(candidate)
  // Only complain about something the operator has actually typed: an empty
  // field is "not started", not "wrong".
  const showCandidateError = candidate.length > 0 && !candidateIsLinkable

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
            {truncate(remnawaveId, REMNAWAVE_ID_PREVIEW_LENGTH)}
          </span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        )}
        <span className={cn('text-[10px]', PRESENCE_TONE[presence])}>
          {t(`userDetailPanel.subscriptions.remnawaveProfile.presence.${presence}`)}
        </span>
        {remnawaveId ? (
          <button
            type="button"
            onClick={handleCopy}
            className="text-pink-500/60 transition hover:text-pink-500 dark:text-pink-400/60 dark:hover:text-pink-400"
            aria-label={t('userDetailPanel.subscriptions.remnawaveProfile.copyAria')}
          >
            <Copy className="h-3 w-3" />
          </button>
        ) : (
          <PermissionGate resource="subscriptions" action="edit">
            <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]">
                  <Link2 className="mr-1 h-3 w-3" />
                  {t('userDetailPanel.subscriptions.remnawaveProfile.link')}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>{t('userDetailPanel.subscriptions.remnawaveProfile.linkTitle')}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <p id={`remnawave-profile-hint-${sub.id}`} className="text-sm text-muted-foreground">
                    {t('userDetailPanel.subscriptions.remnawaveProfile.linkHint')}
                  </p>
                  <Label htmlFor={`remnawave-profile-${sub.id}`} className="sr-only">
                    {t('userDetailPanel.subscriptions.remnawaveProfile.linkLabel')}
                  </Label>
                  <Input
                    id={`remnawave-profile-${sub.id}`}
                    value={candidateId}
                    onChange={(event) => setCandidateId(event.target.value)}
                    placeholder={t('userDetailPanel.subscriptions.remnawaveProfile.linkPlaceholder')}
                    aria-describedby={
                      showCandidateError
                        ? `remnawave-profile-hint-${sub.id} remnawave-profile-error-${sub.id}`
                        : `remnawave-profile-hint-${sub.id}`
                    }
                    aria-invalid={showCandidateError}
                    autoComplete="off"
                  />
                  {showCandidateError ? (
                    <p
                      id={`remnawave-profile-error-${sub.id}`}
                      className="text-sm text-destructive"
                      role="alert"
                    >
                      {t('userDetailPanel.subscriptions.remnawaveProfile.linkInvalid')}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>
                      {t('userDetailPanel.subscriptions.cancel')}
                    </Button>
                    <Button
                      onClick={() => {
                        onLinkProfile(candidate)
                        setLinkDialogOpen(false)
                      }}
                      disabled={!candidateIsLinkable || isLinkingProfile}
                    >
                      {isLinkingProfile ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                      {t('userDetailPanel.subscriptions.remnawaveProfile.linkAction')}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </PermissionGate>
        )}
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

function useCurrentTime() {
  const [currentTime, setCurrentTime] = useState<number | null>(null)

  useEffect(() => {
    const refresh = () => setCurrentTime(Date.now())
    const initialTimer = window.setTimeout(refresh, 0)
    const interval = window.setInterval(refresh, 60_000)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [])

  return currentTime
}

function isFutureTimestamp(value: string | null | undefined, currentTime: number | null) {
  if (!value || currentTime === null) return false
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) && timestamp > currentTime
}

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
  const currentTime = useCurrentTime()

  const identityKey = (user.identityKind ?? 'LOCAL_ONLY') as IdentityKind
  const identityLabel = t(`userDetailPanel.header.identityKind.${identityKey}`)

  const tempPasswordExpiresAt: string | null = user.webAccount?.temporaryPasswordExpiresAt ?? null
  // The badge is "active" only while the timestamp is in the future. Without
  // this guard the amber notice lingers forever after expiry, even though the
  // back-end has long since rejected the temp password.
  const tempPasswordActive: boolean =
    tempPasswordExpiresAt !== null &&
    isFutureTimestamp(tempPasswordExpiresAt, currentTime)

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
      <ReviewFlags telegramId={telegramId} flags={user.reviewFlags ?? []} queryKey={queryKey} />
      <SharedAddresses rows={user.ipObservations ?? []} />
    </div>
  )
}

/**
 * Quiet marks asking an operator to look at this account.
 *
 * ── Why this is an alert and not a tab ─────────────────────────────────
 *
 * It is a question with a short shelf life: somebody has to decide whether
 * this is a ban evader or a family sharing a laptop, and then it is done.
 * Filed behind a tab it would be seen by nobody, which is the same as not
 * raising it.
 *
 * ── Why it never says the account is guilty ────────────────────────────
 *
 * A device match proves the same MACHINE, not the same person. The wording
 * and the amber (rather than destructive) treatment are load-bearing: an
 * operator who reads this as a verdict will ban a household, and the
 * customer will never be told why.
 *
 * Cleared flags are kept and shown greyed rather than hidden — "was this
 * account ever flagged, and what did we decide" is the question that gets
 * asked the second time somebody looks.
 */
/**
 * Addresses this account connects from, and whether a blocked one was there too.
 *
 * ── Shown ONLY when something is shared ───────────────────────────────────
 *
 * A list of a customer's addresses on every card would be a location history
 * an operator reads out of habit, and nobody asked for that. What is worth
 * seeing is the overlap: an address a blocked account was also seen from.
 * Everything else stays collected and unrendered.
 *
 * ── It says "same place", never "same person" ─────────────────────────────
 *
 * Households, offices and shared connections are ordinary. The sighting count
 * is what an operator weighs first: a home connection and somewhere passed
 * through once are the difference between a match worth acting on and a
 * coincidence, and only the count separates them.
 */
function SharedAddresses({
  rows,
}: {
  readonly rows: ReadonlyArray<{
    readonly address: string
    readonly hits: number
    readonly sharedWithBlocked: readonly string[]
  }>
}) {
  const { t } = useTranslation()
  const shared = rows.filter((row) => row.sharedWithBlocked.length > 0)
  if (shared.length === 0) return null

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <p className="font-medium text-amber-600">{t('userDetailPanel.sharedAddresses.title')}</p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {shared.map((row) => (
          <li key={row.address}>
            <code className="text-[11px]">{row.address}</code>
            {' — '}
            {t('userDetailPanel.sharedAddresses.line', {
              blocked: row.sharedWithBlocked.length,
              hits: row.hits,
            })}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {t('userDetailPanel.sharedAddresses.caveat')}
      </p>
    </div>
  )
}

function ReviewFlags({
  telegramId,
  flags,
  queryKey,
}: {
  telegramId: string
  flags: ReadonlyArray<UserReviewFlag>
  queryKey: string[]
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const clear = useMutation({
    mutationFn: (flagId: string) =>
      api.post(`/admin/users/${telegramId}/review-flags/${flagId}/clear`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.reviewFlags.cleared'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.reviewFlags.clearError'))),
  })

  if (flags.length === 0) return null

  return (
    <div className="space-y-1.5">
      {flags.map((flag) => (
        <div
          key={flag.id}
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            flag.clearedAt === null
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
              : 'border-muted bg-muted/30 text-muted-foreground',
          )}
        >
          <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p>{t('userDetailPanel.reviewFlags.deviceMatch')}</p>
            {flag.relatedUserId !== null && (
              <p className="mt-0.5 break-all opacity-80">
                {t('userDetailPanel.reviewFlags.relatedUser', { userId: flag.relatedUserId })}
              </p>
            )}
            <p className="mt-0.5 opacity-70">
              {flag.clearedAt === null
                ? t('userDetailPanel.reviewFlags.openSince', {
                    date: new Date(flag.createdAt).toLocaleString(),
                  })
                : t('userDetailPanel.reviewFlags.clearedOn', {
                    date: new Date(flag.clearedAt).toLocaleString(),
                  })}
            </p>
          </div>
          {flag.clearedAt === null && (
            <PermissionGate resource="users" action="edit">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-xs"
                disabled={clear.isPending}
                onClick={() => clear.mutate(flag.id)}
              >
                {t('userDetailPanel.reviewFlags.clear')}
              </Button>
            </PermissionGate>
          )}
        </div>
      ))}
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

/**
 * A plan's traffic cap in the picker, as THREE distinct strings.
 *
 * The picker used to write `plan.trafficLimit ? '(' + trafficLimit + ' GB)' :
 * ''`, which is a two-state reading of a three-state column, and it printed the
 * two states that are OPPOSITES identically:
 *
 *   `null`      UNLIMITED, positively stated. The plan has no cap.
 *   `0`         a cap of ZERO gigabytes — no traffic at all. A state that must
 *               never exist (the DTO has been `@Min(1)` for a while) but that
 *               DOES exist on rows authored before it was raised.
 *   a number    that many whole gigabytes.
 *
 * Both falsy spellings fell into the `''` branch, so a legacy zero rendered as
 * a bare plan name — exactly the way an uncapped plan renders — and an operator
 * picking it handed the customer a subscription carrying no traffic while the
 * picker said, as loudly as it says anything, "no cap". This is the same
 * distinction the sync-drift block above is required to keep; see the `?? 0`
 * comment there.
 *
 * `trafficLimit` is declared `number` on the SPA wire type (`plans-api.ts`)
 * while the server's `AdminPlanInterface` declares it `number | null`, so the
 * value really can be `null` at runtime whatever the local type claims. The
 * parameter here is widened to the TRUE domain rather than to the narrower
 * declaration — trusting that declaration is what erased the case.
 *
 * Non-positive folds into the zero state deliberately: a negative cap is the
 * same product fact (no traffic), and printing `(-5 GB)` invites someone to
 * read it as a discount.
 */
function planTrafficSuffix(trafficLimit: number | null | undefined, zeroLabel: string): string {
  if (trafficLimit === null || trafficLimit === undefined) return '(∞)'
  if (trafficLimit <= 0) return `(${zeroLabel})`
  return `(${trafficLimit} GB)`
}

function SubscriptionsTab({ user, telegramId, queryKey }: { user: UserDetail; telegramId: string; queryKey: string[] }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showGiveSub, setShowGiveSub] = useState(false)
  const [showAssignPlan, setShowAssignPlan] = useState(false)
  const [assignPlanId, setAssignPlanId] = useState('')
  const [selectedSubIds, setSelectedSubIds] = useState<string[]>([])
  const [openSubId, setOpenSubId] = useState<string | null>(null)

  // WHO THE SUBSCRIPTION BELONGS TO, in the words the operator is already
  // reading at the top of this panel — same order of preference as
  // `UserHeader`, so the delete confirmation names the customer the same way
  // the screen does. The telegram id is the last resort rather than `'—'`: a
  // dash names nobody, and this string's whole job is to be checkable against
  // the person the operator thinks they are acting on.
  const customerLabel =
    user.name || user.username || user.webAccount?.login || telegramId

  const grantTrialMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/grant-trial`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.trialGranted')) },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPage.subscriptionUpdateFailed'))),
  })

  const updateSubMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.patch(`/admin/users/subscriptions/${id}`, data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey })
      if ((response.data as { remnawaveLinkRequired?: boolean }).remnawaveLinkRequired === true) {
        toast.warning(t('userDetailPanel.toasts.remnawaveLinkRequired'))
        return
      }
      toast.success(t('userDetailPanel.toasts.subUpdated'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPage.subscriptionUpdateFailed'))),
  })

  const linkRemnawaveProfileMutation = useMutation({
    mutationFn: ({ id, remnawaveId }: { id: string; remnawaveId: string }) =>
      api.patch(`/admin/users/subscriptions/${id}/remnawave-link`, { remnawaveId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(t('userDetailPanel.toasts.remnawaveLinked'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.syncFailed'))),
  })

  // Keyed by subscription id: the operator syncs one card at a time and the
  // verdict belongs on THAT card, not in a toast that is gone in four seconds
  // while the card still shows nothing about what happened.
  const [syncOutcomes, setSyncOutcomes] = useState<Record<string, SubscriptionSyncOutcome>>({})

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/subscriptions/${id}/sync`),
    // The previous verdict is cleared the moment a new press starts, so a stale
    // "synced" cannot sit under a request that is still in flight.
    onMutate: (id: string) => {
      setSyncOutcomes((previous) => {
        if (previous[id] === undefined) return previous
        const next = { ...previous }
        delete next[id]
        return next
      })
    },
    onSuccess: (response, id) => {
      void queryClient.invalidateQueries({ queryKey })
      // THE BODY, NOT THE STATUS CODE. All three refusals arrive as HTTP 200.
      const outcome = readSyncOutcome(response.data)
      setSyncOutcomes((previous) => ({ ...previous, [id]: outcome }))
      if (outcome.kind === 'synced') {
        toast.success(t('userDetailPanel.toasts.synced'))
        return
      }
      // Three refusals, three different next actions, three different toast
      // severities — and not one of them green.
      if (outcome.kind === 'notLinked') {
        toast.info(t('userDetailPanel.subscriptions.syncOutcome.toast.notLinked'))
        return
      }
      if (outcome.kind === 'panelUnavailable') {
        toast.warning(t('userDetailPanel.subscriptions.syncOutcome.toast.panelUnavailable'))
        return
      }
      if (outcome.kind === 'profileMissing') {
        toast.error(t('userDetailPanel.subscriptions.syncOutcome.toast.profileMissing'))
        return
      }
      toast.error(t('userDetailPanel.subscriptions.syncOutcome.toast.refused'))
    },
    onError: () => toast.error(t('userDetailPanel.toasts.syncFailed')),
  })

  const resetTrafficMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/subscriptions/${id}/reset-traffic`),
    onSuccess: () => toast.success(t('userDetailPanel.toasts.trafficReset')),
    onError: () => toast.error(t('userDetailPanel.toasts.trafficResetFailed')),
  })

  // Keyed by subscription id, exactly like `syncOutcomes` above: the operator
  // deletes one card at a time and a refusal belongs on THAT card. A toast is
  // gone in four seconds; the three-step remedy this particular refusal names
  // is not something anyone completes inside four seconds.
  const [deleteRefusals, setDeleteRefusals] = useState<Record<string, SubscriptionDeleteRefusal>>({})

  const deleteSubMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/subscriptions/${id}`),
    // The previous refusal is cleared the moment a new press starts, so a stale
    // "repair the link first" cannot sit under a request that is still in flight.
    onMutate: (id: string) => {
      setDeleteRefusals((previous) => {
        if (previous[id] === undefined) return previous
        const next = { ...previous }
        delete next[id]
        return next
      })
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.subDeleted')) },
    // THE CODE DECIDES, NEVER THE SENTENCE. `DELETE` answers 409 with
    // `code: 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK'` when the row’s stored
    // identity is a 2.x uuid on a proven-3.x panel, and until this branch
    // existed the mutation had no `onError` at all — so the operator got a
    // generic failure with no route to the one thing that clears it. Matching
    // the backend’s English paragraph instead would put the whole branch one
    // copy-edit away from silently degrading to that generic failure again.
    onError: (error: unknown, id: string) => {
      const refusal = readSubscriptionDeleteRefusal(error)
      if (refusal === null) {
        toast.error(getErrorMessage(error, t('userDetailPanel.toasts.subDeleteFailed')))
        return
      }
      setDeleteRefusals((previous) => ({ ...previous, [id]: refusal }))
      toast.error(t('userDetailPanel.toasts.subDeleteRefusedStaleLink'))
    },
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
                          {plan.name}{' '}
                          {planTrafficSuffix(
                            plan.trafficLimit,
                            t('userDetailPanel.subscriptions.planTrafficZero'),
                          )}
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
              onUpdate={(data) =>
                updateSubMutation
                  .mutateAsync({ id: sub.id, data })
                  .then((response) => (response.data ?? {}) as SubscriptionWriteResult)
              }
              onSync={() => syncMutation.mutate(sub.id)}
              isSyncing={syncMutation.isPending && syncMutation.variables === sub.id}
              syncOutcome={syncOutcomes[sub.id] ?? null}
              onResetTraffic={() => resetTrafficMutation.mutate(sub.id)}
              onDelete={() => deleteSubMutation.mutate(sub.id)}
              deleteRefusal={deleteRefusals[sub.id] ?? null}
              customer={customerLabel}
              onAssignPlan={(planId) => assignPlanMutation.mutate({ id: sub.id, planId })}
              onLinkRemnawaveProfile={(remnawaveId) => linkRemnawaveProfileMutation.mutate({ id: sub.id, remnawaveId })}
              isLinkingRemnawaveProfile={
                linkRemnawaveProfileMutation.isPending
                && linkRemnawaveProfileMutation.variables?.id === sub.id
              }
            />
          ))}
        </div>
      )}

      {/* ── Plan Access toggles ─────────────────────────────────── */}
      <PlanAccessSection
        telegramId={telegramId}
        userId={user.id}
        queryKey={queryKey}
        plans={assignablePlans}
      />

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

/**
 * The confirmation that stands between a click and a panel DELETE.
 *
 * WHY THIS CONTROL AND NOT THE OTHERS ON THIS CARD. Deleting a subscription is
 * the only action here that reaches OUT of the database:
 * `SubscriptionDeletionService.deleteSubscription` writes a
 * `SyncAction.DELETE` job whenever the row names a profile, and
 * `ProfileSyncProcessor.handleDelete` turns that job into `deletePanelUser`
 * against the live panel. Sync, reset-traffic and the limit edits are all
 * recoverable; this one ends a paying customer's service, and until now a
 * single misclick on a 24px icon did it with no question asked — beside a
 * device-revoke control on the same card that has always asked one.
 *
 * IT NAMES THE SUBJECT, NOT THE VERB. "Are you sure?" is not a statement an
 * operator can check anything against, and the mistake this guards is not
 * "I did not mean to press delete" — it is "I pressed delete on the wrong
 * card". So the body names the PLAN and the CUSTOMER, which are the two facts
 * that differ between the card they meant and the card they hit, and it says
 * whether a panel profile is going with it.
 *
 * BOTH ENTRY POINTS USE THIS ONE COMPONENT. The card offers delete twice — an
 * icon in the header and a text button inside the collapsible — and a guard on
 * one of them is worse than a guard on neither: it teaches the operator the
 * button asks first.
 */
function SubscriptionDeleteConfirmation({
  sub,
  customer,
  onConfirm,
  children,
}: {
  sub: UserSubscription
  /** Who this subscription belongs to, as the rest of the panel names them. */
  customer: string
  onConfirm: () => void
  /** The trigger. Rendered `asChild`, so it keeps its own styling and label. */
  children: ReactNode
}) {
  const { t } = useTranslation()
  // The plan the operator recognises, falling back to the row's own id rather
  // than to an empty quote — a confirmation that names nothing is the "are you
  // sure?" this replaces.
  const plan =
    sub.plan?.name ?? sub.planSnapshot?.name ?? `#${truncate(sub.id, 8)}`

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('userDetailPanel.subscriptions.deleteConfirm.title')}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block font-medium text-foreground">
              {t('userDetailPanel.subscriptions.deleteConfirm.subject', { plan, customer })}
            </span>
            <span className="block">
              {sub.remnawaveId
                ? t('userDetailPanel.subscriptions.deleteConfirm.panelLinked')
                : t('userDetailPanel.subscriptions.deleteConfirm.panelUnlinked')}
            </span>
            <span className="block">
              {t('userDetailPanel.subscriptions.deleteConfirm.irreversible')}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('userDetailPanel.actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t('userDetailPanel.subscriptions.deleteConfirm.action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * THE DAY THE OPERATOR IS LOOKING AT, as a comparable key.
 *
 * A `Date` carries two calendars and this screen only ever shows one of them.
 * react-day-picker hands back LOCAL midnight, the picker's own trigger renders
 * `format(value, 'dd.MM.yyyy')` from LOCAL parts, and the read-only "Expires"
 * row above it renders `toLocaleDateString()` — also local. The change
 * detector alone used `.toISOString().slice(0, 10)`, which is the UTC day, and
 * for this product's operators (Moscow, UTC+3) those two calendars disagree
 * for three hours out of every twenty-four.
 *
 * Both consequences were silent, and they are not each other's mirror:
 *   • re-picking the day ALREADY on screen registered as a change and sent a
 *     patch — stored 10:00Z is UTC day D, local midnight of D is D-1;
 *   • moving the expiry one day FORWARD registered as no change at all and
 *     produced the "No changes to save" toast — stored 10:00Z is D, and local
 *     midnight of D+1 is 21:00Z on D, which is D again.
 *
 * So the comparison happens in the calendar the operator can see. An Invalid
 * Date answers `''` instead of throwing: `new Date('nonsense').toISOString()`
 * raises `RangeError`, and `expireAt` is `string | null | undefined` on the
 * wire with nothing promising the string parses.
 */
// Exported for `subscription-expiry-day.test.tsx`, which drives the rule
// directly — including the no-expiry branch no fixture in this file reaches.
// The repo's usual escape hatch for the fast-refresh rule (`permission-gate.tsx`,
// `auth-provider.tsx` spell it the same way).
// eslint-disable-next-line react-refresh/only-export-components
export function localCalendarDay(value: Date): string {
  if (Number.isNaN(value.getTime())) return ''
  const year = String(value.getFullYear()).padStart(4, '0')
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The instant to STORE for a day the operator picked in the calendar.
 *
 * The picker produces LOCAL MIDNIGHT of the chosen day, and sending that
 * instant verbatim was the defect: at UTC+3 it is 21:00 on the PREVIOUS day in
 * UTC, so the row's `expires_at` — and every UTC-based reading of it — names
 * the day before the one on screen, and the subscriber's service ends at the
 * first second of the day they were told they still had.
 *
 * The rule is MOVE THE DAY, KEEP EVERYTHING ELSE:
 *
 *   • a subscription that already has an expiry keeps its exact local
 *     time-of-day, so only the calendar day the operator touched moves. The
 *     renewal clock is not silently shifted, no hours are granted or taken
 *     that nobody asked for, and re-picking the day that is already stored
 *     reproduces the stored instant exactly — which is what makes the change
 *     detector above and this function agree instead of fighting;
 *   • with no expiry on record there is nothing to keep, and "expires on the
 *     30th" means the subscriber has service THROUGH the 30th — so the end of
 *     that day, locally: 23:59:59.999.
 *
 * Local on both paths, via the `new Date(y, m, d, …)` constructor. The server
 * does `new Date(String(body.expiresAt))` and stores the instant it gets, so
 * the calendar this function builds in is the only thing that decides which
 * day the operator turns out to have chosen.
 */
// Exported for `subscription-expiry-day.test.tsx`, which drives the rule
// directly — including the no-expiry branch no fixture in this file reaches.
// The repo's usual escape hatch for the fast-refresh rule (`permission-gate.tsx`,
// `auth-provider.tsx` spell it the same way).
// eslint-disable-next-line react-refresh/only-export-components
export function subscriptionExpiryInstant(
  pickedDay: Date,
  storedExpiry: string | null | undefined,
): string {
  const stored =
    storedExpiry === undefined || storedExpiry === null || storedExpiry === ''
      ? null
      : new Date(storedExpiry)
  const year = pickedDay.getFullYear()
  const month = pickedDay.getMonth()
  const day = pickedDay.getDate()
  const moved =
    stored !== null && !Number.isNaN(stored.getTime())
      ? new Date(
          year,
          month,
          day,
          stored.getHours(),
          stored.getMinutes(),
          stored.getSeconds(),
          stored.getMilliseconds(),
        )
      : new Date(year, month, day, 23, 59, 59, 999)
  return moved.toISOString()
}

/**
 * What `PATCH /admin/users/subscriptions/:id` answers with.
 *
 * The controller returns `{ ...updated, syncPending, remnawaveLinkRequired }`
 * where `updated` is the Prisma row it just wrote — so the field names here
 * are the COLUMN's (`expiresAt`), not the read model's (`expireAt`, which is
 * what `GET /admin/users/:telegramId` maps it to). Narrow on purpose: only the
 * three fields this editor is able to send are read back off it.
 */
interface SubscriptionWriteResult {
  readonly trafficLimit?: number | null
  readonly deviceLimit?: number | null
  readonly expiresAt?: string | null
}

function SubscriptionCard({
  sub,
  isOpen,
  onToggleOpen,
  assignablePlans,
  onUpdate,
  onSync,
  isSyncing,
  syncOutcome,
  onResetTraffic,
  onDelete,
  deleteRefusal,
  customer,
  onAssignPlan,
  onLinkRemnawaveProfile,
  isLinkingRemnawaveProfile,
}: {
  sub: UserSubscription
  isOpen: boolean
  onToggleOpen: () => void
  assignablePlans: ReadonlyArray<import('@/features/plans/plans-api').Plan>
  /**
   * Sends the patch and RESOLVES WITH THE ROW THE SERVER WROTE.
   *
   * It used to be `=> void`, which is why this card could show two different
   * numbers for one field: the read-only rows above re-render from the
   * refetched user while the inputs below keep whatever was typed, and nothing
   * ever told the inputs what was actually stored. Rejects like any other
   * promise; the mutation's own `onError` has already reported it by then.
   */
  onUpdate: (data: Record<string, unknown>) => Promise<SubscriptionWriteResult>
  onSync: () => void
  isSyncing: boolean
  /** What the LAST press of this card's sync button actually did. */
  syncOutcome: SubscriptionSyncOutcome | null
  onResetTraffic: () => void
  onDelete: () => void
  /** Why the LAST press of this card’s delete button was refused, if it was. */
  deleteRefusal: SubscriptionDeleteRefusal | null
  /** Who owns this subscription — named in the delete confirmation. */
  customer: string
  onAssignPlan: (planId: string) => void
  onLinkRemnawaveProfile: (remnawaveId: string) => void
  isLinkingRemnawaveProfile: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US'
  const syncActivity = subscriptionSyncActivity(sub)

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
  // "Unlimited traffic" is a STATE OF ITS OWN, not an empty text field.
  //
  // The patch below only carries a field the operator actually moved, so an
  // empty traffic input means "leave it alone" — which left `trafficLimit: null`
  // (the backend's spelling of unlimited) unsendable from this screen at all:
  // there was no keystroke that produced it. Blanking the field looked like it
  // should, and did nothing.
  //
  // A toggle rather than a sentinel value in the number field, because the two
  // states have to be told apart AT A GLANCE. "I left it alone" and "I removed
  // this customer's traffic cap" must never render identically, and an empty
  // box cannot say which one it is. It also matches the form: the partner block
  // below already spells a binary this way.
  const trafficWasUnlimited = sub.trafficLimit === null || sub.trafficLimit === undefined
  const [unlimitedTraffic, setUnlimitedTraffic] = useState(trafficWasUnlimited)
  const [dirty, setDirty] = useState(false)

  // Whether there is an expiry here to LOSE — the same test the `expiresAt`
  // initialiser above already makes, named so `handleSave` can tell the two
  // ways of arriving at `expiresAt === undefined` apart:
  //
  //   • the subscription never had one, and the operator did not touch the
  //     picker — genuinely no change;
  //   • the subscription HAD one and the operator cleared it. `calendar.tsx`
  //     does not set `required`, so react-day-picker's `mode="single"`
  //     DESELECTS on a second click of the selected day and fires
  //     `onSelect(undefined)`. That is a real gesture with a real intent, and
  //     `if (expiresAt)` used to discard it in silence.
  //
  // Absent, `null` and the deliberately-unabsorbed empty string all read as
  // "no date on record", exactly as the initialiser reads them.
  const expiryOnRecord = Boolean(sub.expireAt)

  /**
   * THE SERVER'S ANSWER WINS — over the fields this save actually sent, and
   * only while the operator has not moved on.
   *
   * `SubscriptionCard` is keyed by `sub.id`, so these `useState` initialisers
   * run once per card lifetime. `onSuccess` invalidates the query but does not
   * remount the card, so after a save the read-only rows re-render from the
   * server while the inputs still hold what was typed. When the two differ —
   * `parseInt` truncating a typed `5.7` down to the `5` that is sent and then
   * stored is the live example, and there is NO server-side floor to point at:
   * `readOperatorTrafficLimitGb` refuses a sub-gigabyte cap with a 400 rather
   * than rounding it up — one card showed one field two ways, and the operator
   * had no way to tell which number was real.
   *
   * Keying the card on a changing value would fix that by remounting, and is
   * worse: any background refetch would then blow away a half-typed number
   * mid-keystroke. So this reconciles instead of remounting, under two rules:
   *
   *   1. ONLY FIELDS THIS SAVE SENT. A field the patch never mentioned is not
   *      the save's business, and a refetch that moved it is not this card's
   *      cue to overwrite what the operator is holding.
   *   2. ONLY IF THE INPUT STILL HOLDS WHAT WAS SENT. The comparison happens
   *      inside a functional updater, so it reads the value at COMMIT time,
   *      not the one captured when Save was pressed. Anything typed between
   *      the press and the response therefore wins outright — in-progress
   *      input cannot be eaten, because the guard sees it.
   */
  const adoptSavedValues = (
    sent: Record<string, unknown>,
    saved: SubscriptionWriteResult,
    typed: {
      readonly traffic: string
      readonly unlimited: boolean
      readonly devices: string
      readonly pickedDay: number | null
    },
  ): void => {
    if ('trafficLimit' in sent && saved.trafficLimit !== undefined) {
      const storedTraffic = saved.trafficLimit
      if (storedTraffic === null) {
        setUnlimitedTraffic((current) => (current === typed.unlimited ? true : current))
      } else {
        const storedText = String(storedTraffic)
        setTrafficLimit((current) => (current === typed.traffic ? storedText : current))
        setUnlimitedTraffic((current) => (current === typed.unlimited ? false : current))
      }
    }
    if ('deviceLimit' in sent && typeof saved.deviceLimit === 'number') {
      const storedText = String(saved.deviceLimit)
      setDeviceLimit((current) => (current === typed.devices ? storedText : current))
    }
    if ('expiresAt' in sent && typeof saved.expiresAt === 'string') {
      const storedExpiry = new Date(saved.expiresAt)
      if (!Number.isNaN(storedExpiry.getTime())) {
        setExpiresAt((current) =>
          current !== undefined && current.getTime() === typed.pickedDay ? storedExpiry : current,
        )
      }
    }
  }

  const handleSave = () => {
    const data: Record<string, unknown> = {}
    const newTraffic = parseInt(trafficLimit, 10)
    const newDevices = parseInt(deviceLimit, 10)
    if (unlimitedTraffic) {
      // `null`, explicitly — `readOperatorTrafficLimitGb` on the backend takes
      // `null` as unlimited and refuses `0`, because Remnawave spells unlimited
      // traffic as `0` bytes and so cannot express a zero-gigabyte cap.
      if (!trafficWasUnlimited) data.trafficLimit = null
    } else if (trafficWasUnlimited && !Number.isFinite(newTraffic)) {
      // The one incoherent combination: the toggle was switched OFF but no cap
      // was named. Falling through would reach the "no changes" toast, which
      // would be a lie — the operator did change something, it just cannot be
      // sent. Say what is missing instead.
      toast.info(t('userDetailPanel.subscriptions.trafficNeedsValue'))
      return
    } else if (Number.isFinite(newTraffic) && newTraffic !== sub.trafficLimit) {
      data.trafficLimit = newTraffic
    }
    if (Number.isFinite(newDevices) && newDevices !== sub.deviceLimit) data.deviceLimit = newDevices
    // A GESTURE THAT EXISTS AND CANNOT BE HONOURED IS NAMED, NOT SWALLOWED.
    //
    // `calendar.tsx` does not pass `required`, so clicking the selected day a
    // second time deselects it: `onSelect(undefined)` runs, `setExpiresAt(
    // undefined)` and `setDirty(true)` both run, and `if (expiresAt)` below
    // then treated that identically to "the operator never opened the picker".
    // Save stayed lit, and if it was their only edit they were told there were
    // "no changes" about a change they had just made — so they went looking
    // for the button that makes a subscription unlimited, and there is none.
    //
    // There is none because the SERVER cannot clear an expiry: the write is
    // guarded by `if (body.expiresAt !== undefined && body.expiresAt !== null)`
    // (`admin-user-subscriptions.controller.ts:527`), so `null` is explicitly
    // excluded and writes nothing. Building a UI for it needs a backend change.
    // What this screen owes the operator meanwhile is the truth, in the same
    // shape the traffic path a few lines above already uses: refuse by name
    // rather than discard in silence.
    //
    // `dirty` is deliberately left ALONE, exactly as `trafficNeedsValue` leaves
    // it: the way out is to pick a date, and the Save button has to still be
    // there when they do.
    if (expiryOnRecord && expiresAt === undefined) {
      toast.info(t('userDetailPanel.subscriptions.expiryCannotBeCleared'))
      return
    }
    if (expiresAt) {
      // LOCAL on both sides — the calendar the picker, the trigger and the
      // read-only row above all use. See `localCalendarDay`.
      const originalDay = sub.expireAt ? localCalendarDay(new Date(sub.expireAt)) : ''
      const newDay = localCalendarDay(expiresAt)
      if (newDay !== originalDay) {
        data.expiresAt = subscriptionExpiryInstant(expiresAt, sub.expireAt)
      }
    }
    // The same silent no-op as `brandingPage.noChanges`, spelled as a `> 0`
    // wrapper instead of an early return, and worse in one specific way: with
    // `setDirty(false)` trapped inside the guard, a save that produced nothing
    // left the button ENABLED and the card still reading "unsaved". The
    // operator got no request, no toast and no state change, and the one
    // visible signal still said their edit was pending.
    //
    // Unlike the branding page this is genuinely reachable, and cheaply:
    // `setDirty(true)` fires on every keystroke in the traffic/device inputs,
    // and `parseInt('', 10)` is NaN, so simply CLEARING a limit field fails
    // `Number.isFinite` and contributes nothing to `data`. Type a digit and
    // erase it — Save lights up, does nothing, and stays lit.
    //
    // `setDirty(false)` now runs on both paths: once the operator has been told
    // the edits amount to no change, the control must stop advertising work
    // that will never be sent.
    if (Object.keys(data).length === 0) {
      toast.info(t('userDetailPanel.subscriptions.noChanges'))
      setDirty(false)
      return
    }
    // Captured BEFORE the request goes out so `adoptSavedValues` knows what the
    // inputs held at the moment of the press; the guard itself still compares
    // against the live value at commit time.
    const typed = {
      traffic: trafficLimit,
      unlimited: unlimitedTraffic,
      devices: deviceLimit,
      pickedDay: expiresAt === undefined ? null : expiresAt.getTime(),
    }
    onUpdate(data)
      .then((saved) => adoptSavedValues(data, saved, typed))
      .catch(() => {
        // The mutation's own `onError` has already put the failure on screen.
        // Swallowing it here only stops an unhandled rejection; nothing about
        // the editor's state changes, so the operator's edits stay where they
        // are and Save can be pressed again.
      })
    setDirty(false)
  }

  return (
    <Card className={cn('flex flex-col transition-shadow', isSyncing && 'shadow-md ring-1 ring-primary/30')}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
          <span className="truncate text-xs font-medium">{sub.plan?.name ?? `#${truncate(sub.id, 8)}`}</span>
          <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
          {sub.isTrial && <span className="rounded border border-pink-500/50 px-1 py-px text-[9px] uppercase text-pink-400">Trial</span>}
          {isSyncing || syncActivity === 'PENDING' ? (
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
          <SubscriptionDeleteConfirmation sub={sub} customer={customer} onConfirm={onDelete}>
            <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-destructive" aria-label={t('userDetailPanel.subscriptions.deleteTitle')}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </SubscriptionDeleteConfirmation>
          </PermissionGate>
        </div>
      </div>

      {/* Info rows */}
      <div className="grid gap-0 px-3 pb-1.5 text-[11px]">
        <InfoRow icon={<Tag className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.planLabel')} value={sub.plan?.name ?? '—'} />
        <InfoRow icon={<Hash className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.planType')} value={String(t(`userDetailPanel.subscriptions.planTypes.${sub.plan?.type ?? 'BOTH'}`, sub.plan?.type ?? '—'))} />
        <InfoRow icon={<Wifi className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.traffic')} value={sub.trafficLimit ? `${sub.trafficLimit} GB` : '∞'} />
        <InfoRow icon={<Monitor className="h-3 w-3" />} label={t('userDetailPanel.subscriptions.devices')} value={String(sub.deviceLimit || '∞')} />
        {/* ABSENT is a state, and the state is UNLIMITED.

            `GET /admin/users/:telegramId` maps `expireAt: s.expiresAt?.toISOString()`
            and `JSON.stringify` drops `undefined`, so a subscription with no
            expiry arrives here with the key MISSING. The em dash that stood in
            its place said "we do not know" about something we do know:
            `Subscription.expiresAt` is `DateTime?` and the backend reads the
            empty one as the unlimited bucket (`referral-points-exchange.service.ts`
            queries `{ status: ACTIVE, expiresAt: null }` as exactly that).

            Three states, kept apart on purpose:

              • absent / null → unlimited. Both spellings fold in here because
                they are one state on the wire (`user-detail-shape.ts` names
                both). `=== undefined` ALONE would be wrong: an explicit `null`
                would fall through to `new Date(null)` and print a confident
                `01.01.1970` — the exact defect the subscriptions list had.
              • a real ISO string → that date.
              • an EMPTY STRING → deliberately NOT absorbed. It is a broken
                value, not a state, so it renders as `Invalid Date` rather than
                letting us claim an expiry policy we cannot back. A truthiness
                check cannot tell it from unlimited, which is why this is not one.

            Same shape as `trafficWasUnlimited` above, which spells the same
            absent-or-null pair the same way for the traffic cap. */}
        <InfoRow
          icon={<Calendar className="h-3 w-3" />}
          label={t('userDetailPanel.subscriptions.expires')}
          value={
            sub.expireAt === undefined || sub.expireAt === null
              ? t('userDetailPanel.subscriptions.unlimitedExpiry')
              : new Date(sub.expireAt).toLocaleDateString(locale)
          }
        />
        <RemnawaveProfileRow
          sub={sub}
          onLinkProfile={onLinkRemnawaveProfile}
          isLinkingProfile={isLinkingRemnawaveProfile}
        />
      </div>

      {syncActivity === 'FAILED' ? <SubscriptionSyncFailureNotice sub={sub} /> : null}
      {syncOutcome === null ? null : (
        <SubscriptionSyncOutcomeNotice sub={sub} outcome={syncOutcome} />
      )}
      {deleteRefusal === null ? null : (
        <SubscriptionDeleteRefusalNotice refusal={deleteRefusal} />
      )}

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
                {/*
                  `min="1"`, not `min="0"`: the server refuses a zero-gigabyte
                  cap with a 400, because Remnawave spells unlimited traffic as
                  `0` bytes and so cannot express "no traffic at all". An input
                  that advertises `0` invites the operator to type the one value
                  the save will reject. (The device input below keeps `min="0"`
                  — there `0` genuinely means unlimited.)
                */}
                <Input
                  type="number"
                  min="1"
                  className="h-7 w-40 text-xs text-right px-1.5"
                  /*
                    Blanked and DISABLED while the toggle below is on, so the
                    field cannot show a stale number under a state that no
                    longer uses it. Toggling back restores what was typed —
                    `trafficLimit` keeps its own value throughout.
                  */
                  value={unlimitedTraffic ? '' : trafficLimit}
                  placeholder={unlimitedTraffic ? '∞' : undefined}
                  disabled={unlimitedTraffic}
                  onChange={(e) => { setTrafficLimit(e.target.value); setDirty(true) }}
                />
              </div>
              {/*
                THE ONLY WAY THIS SCREEN CAN SAY "UNLIMITED".
                The patch carries a field only when the operator moved it, so an
                empty traffic box means "no change" and always did. That left
                `trafficLimit: null` — which the backend accepts and which is
                what unlimited IS — with no keystroke that produces it.

                A toggle and not a sentinel in the number field: "left alone"
                and "cap removed" have to be distinguishable at a glance, and an
                empty box cannot say which one it is. Conflating them is how an
                operator wipes a limit without meaning to.
              */}
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <InfinityIcon className="h-3 w-3 text-muted-foreground/60" />
                  {t('userDetailPanel.subscriptions.trafficUnlimitedLabel')}
                </span>
                <Switch
                  checked={unlimitedTraffic}
                  onCheckedChange={(checked) => { setUnlimitedTraffic(checked); setDirty(true) }}
                  aria-label={t('userDetailPanel.subscriptions.trafficUnlimitedLabel')}
                />
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
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      // Nothing to reconcile — this button sends `status` and
                      // no editor input reflects it. The `catch` is only here
                      // because `onUpdate` answers with a promise now; the
                      // mutation's `onError` still reports the failure.
                      void onUpdate({ status: statusKey === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }).catch(() => undefined)
                    }}
                  >
                    {statusKey === 'ACTIVE' ? t('userDetailPanel.subscriptions.disableTitle') : t('userDetailPanel.subscriptions.enableTitle')}
                  </Button>
                  </PermissionGate>
                  <PermissionGate resource="subscriptions" action="delete">
                  <SubscriptionDeleteConfirmation sub={sub} customer={customer} onConfirm={onDelete}>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-destructive">
                      {t('userDetailPanel.subscriptions.deleteTitle')}
                    </Button>
                  </SubscriptionDeleteConfirmation>
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


/**
 * The per-user allow-list toggle for `availability === 'ALLOWED'` plans.
 *
 * ── IT READS `userId`, NOT `telegramId` ──────────────────────────────────────
 *
 * `Plan.allowedUserIds` holds REIWA IDS: the grant endpoint pushes `user.id`,
 * and the catalog gate that decides who may buy the plan asks
 * `allowedUserIds.includes(user.id)`. This asked `.includes(telegramId)` — the
 * string in the URL — so on a card opened by telegram id, which is how the
 * users table opens every card, the switch read OFF however many grants the
 * operator had made. Both identifiers reach the same endpoint
 * (`findUserByTelegramId` accepts either), which is why the bug was invisible
 * to anyone testing by reiwa id.
 *
 * ── THE GATE FOLLOWS THE ENDPOINT ────────────────────────────────────────────
 *
 * `plans:edit`. This writes a plan's allow-list, so it is gated on the plan
 * permission — the same one the plan editor requires, and the one the two
 * endpoints below now require. It used to be `subscriptions:edit`: a THIRD
 * permission, agreeing with neither, which offered the control to precisely the
 * shipped `operator` role the corrected endpoint answers 403 to.
 *
 * ── AND IT INVALIDATES THE LIST IT READS ─────────────────────────────────────
 *
 * The checked state comes from the PLANS catalogue, not from the user query, so
 * invalidating only `queryKey` refetched the one query whose answer the switch
 * never consults. Both keys are invalidated.
 */
function PlanAccessSection({
  telegramId,
  userId,
  queryKey,
  plans,
}: {
  telegramId: string
  userId: string
  queryKey: string[]
  plans: ReadonlyArray<import('@/features/plans/plans-api').Plan>
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const refreshAccessState = (): void => {
    void queryClient.invalidateQueries({ queryKey })
    void queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
  }

  const grantMutation = useMutation({
    mutationFn: (planId: string) =>
      api.post(`/admin/users/${telegramId}/plan-access/${planId}`),
    onSuccess: refreshAccessState,
  })

  const revokeMutation = useMutation({
    mutationFn: (planId: string) =>
      api.delete(`/admin/users/${telegramId}/plan-access/${planId}`),
    onSuccess: refreshAccessState,
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
          const hasAccess = (plan.allowedUserIds ?? []).includes(userId)
          return (
            <div key={plan.id} className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">{plan.name}</span>
              <PermissionGate resource="plans" action="edit">
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

  const toggleMutation = useMutation({
    mutationFn: () => api.post(`/admin/users/${telegramId}/partner/toggle`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey }); toast.success(t('userDetailPanel.toasts.statusChanged')) },
    // THE ONE PARTNER MUTATION IN THIS FILE THAT REPORTED NOTHING.
    //
    // `adjustMutation` below and the Profile tab pair all toast through
    // `getErrorMessage`; this one had no `onError` at all. A refused
    // flip — the 403 an admin without `partners:edit` gets, or the service
    // declining it — repainted nothing and said nothing, so the badge still
    // read "Active" and the operator had no way to tell a refusal from a
    // click that missed the button. `getErrorMessage` carries the server's own
    // reason when it sent one, exactly as the other three do.
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.toasts.profileFailed'))),
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

  // THERE IS NO `!user.partner` BRANCH HERE, BECAUSE NOTHING COULD REACH ONE.
  //
  // This component is mounted `{user.partner && (<TabsContent value="partner">
  // …)}`, and the trigger that opens that panel sits behind the same guard —
  // so for a user without a partner row the tab does not exist, and `PartnerTab`
  // never runs. The early return that used to stand here rendered "User is not
  // a partner" and a live "Create partner" button underneath it, and no
  // operator, of any role, could arrive at either. A `createMutation` was
  // declared just above solely to serve it and has gone with it: a mutation
  // wired to an unreachable control reads as a supported feature and is not one.
  //
  // The panel's ONE reachable create-partner control is the Profile tab's,
  // inside `<PermissionGate resource="partners" action="edit">` — see the long
  // comment on it in `ProfileTab`. Removing this branch takes nothing off any
  // operator's screen, because it was never on one.
  //
  // The narrowing below stays. `partner` is optional on `UserDetail`, so the
  // compiler needs it, and the `null` is unreachable for the same reason the
  // branch above was.
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
                      <span className="truncate text-[11px]">{ref.referral?.name || ref.referral?.username || truncate(ref.referralUserId, 8)}</span>
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

  const stealthnetSyncMutation = useMutation({
    mutationFn: async () => (
      await api.post<{ status: string }>(`/admin/users/${telegramId}/referral/sync-stealthnet`)
    ).data,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey })
      if (result.status === 'CREATED') {
        toast.success(t('userDetailPage.referrals.stealthnetSync.success'))
      } else if (result.status === 'ALREADY_EXISTS') {
        toast.info(t('userDetailPage.referrals.stealthnetSync.alreadySynced'))
      } else if (result.status === 'SOURCE_NOT_FOUND') {
        toast.error(t('userDetailPage.referrals.stealthnetSync.notFound'))
      } else {
        toast.error(t('userDetailPage.referrals.stealthnetSync.conflict'))
      }
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPage.referrals.stealthnetSync.failed'))),
  })

  const qualifyMutation = useMutation({
    mutationFn: async () => (
      await api.post<{ qualified: boolean; rewardsCreated: number }>(`/admin/users/${telegramId}/referral/qualify`)
    ).data,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey })
      toast.success(
        result.qualified
          ? t('userDetailPage.referrals.qualification.success', { count: result.rewardsCreated })
          : t('userDetailPage.referrals.qualification.alreadyQualified'),
      )
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPage.referrals.qualification.failed'))),
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">{t('userDetailPage.referrals.referredByTitle')}</CardTitle></CardHeader>
        <CardContent>
          {user.referral ? (
            <>
            <p className="text-sm">
              <span className="text-muted-foreground">{t('userDetailPage.referrals.referrerLabel')} </span>
              <span className="font-medium">{user.referral.referrer?.name ?? user.referral.referrer?.username ?? '—'}</span>
              <span className="ml-2 text-muted-foreground">{t('userDetailPage.referrals.levelLabel')} {user.referral.level}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {user.referral.qualifiedAt
                ? t('userDetailPage.referrals.qualification.qualified')
                : t('userDetailPage.referrals.qualification.pending')}
            </p>
            {!user.referral.qualifiedAt && (
              <PermissionGate resource="referrals" action="edit">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" className="mt-3" disabled={qualifyMutation.isPending}>
                      {qualifyMutation.isPending
                        ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        : <UserCheck className="mr-2 h-3.5 w-3.5" />}
                      {t('userDetailPage.referrals.qualification.action')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('userDetailPage.referrals.qualification.confirmTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('userDetailPage.referrals.qualification.confirmDescription')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('userDetailPanel.actions.cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => qualifyMutation.mutate()}>
                        {t('userDetailPage.referrals.qualification.action')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </PermissionGate>
            )}
            </>
          ) : user.isPartner ? (
            <p className="text-sm text-muted-foreground">{t('userDetailPanel.referrals.partnerHint')}</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('userDetailPage.referrals.noReferrer')}</p>
              <PermissionGate resource="referrals" action="edit">
              <Button
                size="sm"
                variant="outline"
                onClick={() => stealthnetSyncMutation.mutate()}
                disabled={stealthnetSyncMutation.isPending}
              >
                {stealthnetSyncMutation.isPending
                  ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                {t('userDetailPage.referrals.stealthnetSync.action')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('userDetailPage.referrals.stealthnetSync.hint')}</p>
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

      {/* Neither of these comes from the user-detail query above — separate
          endpoints, separate failures, separate empty states. */}
      <UserInvitesCard userId={user.id} />

      <UserRewardsCard userId={user.id} queryKey={queryKey} />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Referral invites & rewards — the two blocks fed by /admin/referrals/*
// ══════════════════════════════════════════════════════════════════════════════

/**
 * WHY THESE ARE SEPARATE COMPONENTS WITH SEPARATE QUERIES.
 *
 * Everything above in `ReferralsTab` is painted from the user-detail query —
 * one request, one failure. These two are not: invites come from
 * `GET /admin/referrals/invites?inviterId=`, rewards from
 * `GET /admin/referrals/rewards?userId=`, and the invite quota from a third
 * endpoint again. They fail independently, so they must fail independently on
 * screen: one being down cannot blank the tab, cannot take the other's rows
 * with it, and has to say WHICH load failed.
 *
 * And a failed load never renders the empty state. "No invites yet" is a claim
 * about the operator's own data; a rejected fetch — transport error, or a body
 * that failed schema validation — establishes nothing of the sort. The same
 * `isError` branch the referrals page settled on, including the header count,
 * which is the same claim with a number on it and is therefore dropped rather
 * than shown as `(0)`.
 */

type UserInviteStatus = 'active' | 'consumed' | 'revoked' | 'expired'

interface InviteLifecycle {
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly consumedAt: string | null
}

/**
 * Ordered the way the server's own live-invite filter is ordered: revoked and
 * consumed are terminal facts about the row, expiry is a fact about the clock,
 * and only an invite that is none of the three is still live — see the
 * `{ revokedAt: null, consumedAt: null, OR: [{ expiresAt: null }, { expiresAt:
 * { gt: now } }] }` count in `ReferralInviteLimitsService.getCapacity`, which
 * is what decides whether the row is still holding a slot.
 *
 * `now` is a PARAMETER rather than a `Date.now()` read inside: one instant is
 * held for the whole list, so two rows rendered a millisecond apart cannot
 * disagree about whether the same moment has passed, and a test can state the
 * clock instead of racing it.
 */
// Exported for `user-referral-invites-rewards.test.tsx`, which drives the rule
// directly — the terminal-before-clock ordering has no fixture that reaches it
// through the DOM. Same escape hatch as `localCalendarDay` above.
// eslint-disable-next-line react-refresh/only-export-components
export function deriveUserInviteStatus(invite: InviteLifecycle, now: number): UserInviteStatus {
  if (invite.revokedAt !== null) return 'revoked'
  if (invite.consumedAt !== null) return 'consumed'
  if (invite.expiresAt !== null && new Date(invite.expiresAt).getTime() <= now) return 'expired'
  return 'active'
}

/**
 * Whether another invite may be minted for this user, and when not, why not.
 *
 * ASKED, not assumed. `GET /admin/referrals/invite-capacity/:userId` computes
 * the answer from the per-user override layered over the global program limits
 * — the same arithmetic `ReferralInviteLimitsService` applies at creation time
 * — and this panel must not re-derive it from the fields on the Invite
 * Settings tab.
 *
 * Asked BEFORE the POST, and it is no longer the ONLY thing between an
 * operator and an over-quota invite. It used to be: the admin create route
 * enforced nothing, `ReferralsService.createInvite` never called
 * `validateCanCreateInvite`, and an over-quota POST from here did not come
 * back 400 — it SUCCEEDED, and handed out a slot the operator's own
 * configuration says does not exist.
 *
 * The server now asks `getCapacity` at the one place a `ReferralInvite` row is
 * written and refuses with `INVITE_SLOT_LIMIT_REACHED`. So this gate keeps the
 * button from being pressed at all, and the server refusal catches what a
 * stale capacity cache lets through — see {@link isInviteQuotaRefusal}, which
 * is how that refusal is told apart from every other 400 on this route.
 */
type InviteCreateGate =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'exhausted'; readonly used: number; readonly total: number }

// Exported for the same reason: the unlimited-quota answer (`totalSlots: null`
// with `canCreateInvite: true`) is the VIP-bypass case, and reading it as a
// number is the defect worth a direct test.
// eslint-disable-next-line react-refresh/only-export-components
export function readInviteCreateGate(capacity: {
  readonly isError: boolean
  readonly data: ReferralInviteCapacity | undefined
}): InviteCreateGate {
  if (capacity.isError) return { kind: 'unknown' }
  if (capacity.data === undefined) return { kind: 'loading' }
  if (capacity.data.canCreateInvite) return { kind: 'allowed' }
  // `totalSlots: null` means UNLIMITED, never zero, and the service only ever
  // refuses from the branch that computed a real number — an
  // unlimited-yet-refused answer would be a server defect. "The quota cannot
  // be read" is the honest reading of it; "a limit of nothing" is not.
  if (capacity.data.totalSlots === null) return { kind: 'unknown' }
  return { kind: 'exhausted', used: capacity.data.usedSlots, total: capacity.data.totalSlots }
}

/**
 * The wire label of the server's invite-quota refusal.
 *
 * Allowlisted in `SAFE_PRODUCT_CODES`, so `AdminSafeExceptionFilter` forwards
 * it as both `code` and `errorCode` instead of stripping it to an untyped 400.
 * Written as a literal rather than imported: nothing the production frontend
 * compiles may reach into the backend tree — the Docker frontend stage copies
 * `web/` and nothing else.
 */
const INVITE_QUOTA_REFUSAL_CODE = 'INVITE_SLOT_LIMIT_REACHED'

/**
 * Is this failed create the quota refusal, rather than any other 400?
 *
 * BRANCH ON THE CODE, NEVER ON THE SENTENCE — the same rule the plan write
 * refusals follow next door. The server's message is an English diagnostic
 * aimed at whoever reads the logs, and printing it verbatim is how a
 * Russian-language panel ends up showing an English sentence in a toast.
 *
 * Both spellings are read, `code` first: the filter always writes the product
 * code into `errorCode`, and adds `code` only when the thrown body carried
 * one. Duck-typed rather than reached through axios so this stays a pure
 * predicate over the rejection shape.
 *
 * Anything it does not recognise keeps the existing fallback, which prints the
 * server's own sentence. An unrecognised refusal must not be dressed up as
 * this one: the remedies differ, and "revoke an invite or raise the limit" is
 * useless advice for a permission failure or a dead host.
 */
function isInviteQuotaRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const body = (error as { response?: { data?: unknown } }).response?.data
  if (typeof body !== 'object' || body === null) return false
  const record = body as { code?: unknown; errorCode?: unknown }
  return (
    record.code === INVITE_QUOTA_REFUSAL_CODE || record.errorCode === INVITE_QUOTA_REFUSAL_CODE
  )
}

function InviteQuotaNotice({
  gate,
  capacity,
}: {
  gate: InviteCreateGate
  capacity: ReferralInviteCapacity | undefined
}) {
  const { t } = useTranslation()

  if (gate.kind === 'exhausted') {
    return (
      <p className="text-xs text-destructive">
        {t('userDetailPage.referrals.invitesBlock.quotaExhausted', {
          total: gate.total,
          used: gate.used,
        })}
      </p>
    )
  }
  if (gate.kind === 'unknown') {
    return (
      <p className="text-xs text-destructive">
        {t('userDetailPage.referrals.invitesBlock.quotaUnknown')}
      </p>
    )
  }
  if (gate.kind === 'loading') {
    return (
      <p className="text-xs text-muted-foreground">
        {t('userDetailPage.referrals.invitesBlock.quotaLoading')}
      </p>
    )
  }
  if (capacity === undefined || capacity.totalSlots === null || capacity.remainingSlots === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('userDetailPage.referrals.invitesBlock.quotaUnlimited')}
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      {t('userDetailPage.referrals.invitesBlock.quotaRemaining', {
        remaining: capacity.remainingSlots,
        total: capacity.totalSlots,
      })}
    </p>
  )
}

function UserInvitesCard({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US'
  const currentTime = useCurrentTime()

  const invitesQuery = useReferralInvitesQuery(userId)
  const capacityQuery = useReferralInviteCapacityQuery(userId)
  const createMutation = useCreateReferralInviteMutation(userId)
  const revokeMutation = useRevokeReferralInviteMutation(userId)

  const gate = readInviteCreateGate(capacityQuery)
  const invites = invitesQuery.data

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">
          {invites === undefined
            ? t('userDetailPage.referrals.invitesBlock.titlePlain')
            : t('userDetailPage.referrals.invitesBlock.title', { count: invites.length })}
        </CardTitle>
        <PermissionGate resource="referrals" action="edit">
          <Button
            size="sm"
            variant="outline"
            disabled={gate.kind !== 'allowed' || createMutation.isPending}
            onClick={() =>
              createMutation.mutate(undefined, {
                onSuccess: () =>
                  toast.success(t('userDetailPage.referrals.invitesBlock.created')),
                onError: (err) =>
                  toast.error(
                    isInviteQuotaRefusal(err)
                      ? t('userDetailPage.referrals.invitesBlock.createRefusedQuota')
                      : getErrorMessage(
                          err,
                          t('userDetailPage.referrals.invitesBlock.createFailed'),
                        ),
                  ),
              })
            }
          >
            {createMutation.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-2 h-3.5 w-3.5" />
            )}
            {t('userDetailPage.referrals.invitesBlock.create')}
          </Button>
        </PermissionGate>
      </CardHeader>
      <CardContent className="space-y-3">
        <InviteQuotaNotice gate={gate} capacity={capacityQuery.data} />

        {invitesQuery.isError ? (
          <p className="text-sm text-destructive">
            {t('userDetailPage.referrals.invitesBlock.loadFailed')}
          </p>
        ) : invites === undefined || currentTime === null ? (
          // `useCurrentTime` starts at null and fills in on its first effect
          // tick. An invite's status is a statement about the clock, and with
          // no clock `expired` cannot be told from `active` — so the list waits
          // one tick rather than guessing at it.
          <Skeleton className="h-16 w-full" />
        ) : invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('userDetailPage.referrals.invitesBlock.empty')}
          </p>
        ) : (
          <ul className="space-y-1">
            {invites.map((invite) => {
              const status = deriveUserInviteStatus(invite, currentTime)
              return (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{invite.token}</p>
                    <p className="text-xs text-muted-foreground">
                      {invite.expiresAt === null
                        ? t('userDetailPage.referrals.invitesBlock.noExpiry')
                        : t('userDetailPage.referrals.invitesBlock.expiresOn', {
                            date: new Date(invite.expiresAt).toLocaleDateString(locale),
                          })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">
                      {t(`userDetailPage.referrals.invitesBlock.status.${status}`)}
                    </Badge>
                    {status === 'active' && (
                      <PermissionGate resource="referrals" action="edit">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-destructive"
                          disabled={revokeMutation.isPending}
                          onClick={() =>
                            revokeMutation.mutate(invite.id, {
                              onSuccess: () =>
                                toast.success(
                                  t('userDetailPage.referrals.invitesBlock.revoked'),
                                ),
                              onError: (err) =>
                                toast.error(
                                  getErrorMessage(
                                    err,
                                    t('userDetailPage.referrals.invitesBlock.revokeFailed'),
                                  ),
                                ),
                            })
                          }
                        >
                          {t('userDetailPage.referrals.invitesBlock.revoke')}
                        </Button>
                      </PermissionGate>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function UserRewardsCard({ userId, queryKey }: { userId: string; queryKey: string[] }) {
  const { t } = useTranslation()
  const rewardsQuery = useReferralRewardsQuery(userId)
  // Issuing APPLIES the reward: `AdminRewardsService.issue` moves
  // `User.points` for a POINTS reward and a subscription expiry for an
  // EXTRA_DAYS one. Both are painted from the user-detail query, which lives
  // under `['admin','users',telegramId]` — a root no referrals key reaches, so
  // it is handed in here explicitly.
  const issueMutation = useIssueReferralRewardMutation(userId, [queryKey])

  const rewards = rewardsQuery.data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {rewards === undefined
            ? t('userDetailPage.referrals.rewardsBlock.titlePlain')
            : t('userDetailPage.referrals.rewardsBlock.title', { count: rewards.length })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rewardsQuery.isError ? (
          <p className="text-sm text-destructive">
            {t('userDetailPage.referrals.rewardsBlock.loadFailed')}
          </p>
        ) : rewards === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : rewards.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('userDetailPage.referrals.rewardsBlock.empty')}
          </p>
        ) : (
          <ul className="space-y-1">
            {rewards.map((reward) => {
              // An unknown reward type prints its own wire value rather than a
              // raw key path — `getRewardTypeMeta` already answers for one with
              // a neutral badge instead of refusing, and the two must not
              // disagree.
              const typeLabel = t(`userDetailPage.referrals.rewardsBlock.types.${reward.type}`, {
                defaultValue: reward.type,
              })
              return (
                <li
                  key={reward.id}
                  className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-muted/50"
                >
                  {/* One text node, not three: a row split across nodes cannot
                      be matched as the sentence an operator reads. */}
                  <span className="text-sm">{`${typeLabel} · ${reward.amount}`}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">
                      {reward.isIssued
                        ? t('userDetailPage.referrals.rewardsBlock.statusIssued')
                        : t('userDetailPage.referrals.rewardsBlock.statusPending')}
                    </Badge>
                    {!reward.isIssued && (
                      <PermissionGate resource="referrals" action="edit">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          disabled={issueMutation.isPending}
                          onClick={() =>
                            issueMutation.mutate(reward.id, {
                              onSuccess: () =>
                                toast.success(t('userDetailPage.referrals.rewardsBlock.issued')),
                              onError: (err) =>
                                toast.error(
                                  getErrorMessage(
                                    err,
                                    t('userDetailPage.referrals.rewardsBlock.issueFailed'),
                                  ),
                                ),
                            })
                          }
                        >
                          {t('userDetailPage.referrals.rewardsBlock.issue')}
                        </Button>
                      </PermissionGate>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
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

  // Mirror of the server's `MIN_LINK_TTL_SECONDS`. The SERVER is the
  // authority - `UpdateUserInviteSettingsDto` rejects anything below it and
  // `ReferralInviteLimitsService` clamps whatever is already stored. This copy
  // exists only so the field can say so before a save round-trips into a 400.
  const MIN_LINK_TTL_SECONDS = 60

  const parseNullableInt = (raw: string): number | null => {
    if (raw.trim() === '') return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? Math.max(0, n) : null
  }

  // The one value this panel can still produce that the server refuses. The
  // box is prefilled from whatever is stored, so an operator opening a legacy
  // sub-minute config and pressing Save used to meet a bare 400. Named inline
  // instead, and Save is held while it stands.
  const linkTtlBelowFloor =
    !useGlobal &&
    linkTtlEnabled &&
    linkTtlSeconds.trim() !== '' &&
    Number(linkTtlSeconds) < MIN_LINK_TTL_SECONDS

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
                <Label className="text-xs" htmlFor="invite-link-ttl-seconds">{t('userDetailPanel.invites.linkTtlSeconds')}</Label>
                <Input
                  id="invite-link-ttl-seconds"
                  type="number"
                  min={MIN_LINK_TTL_SECONDS}
                  className="h-9"
                  value={linkTtlSeconds}
                  aria-invalid={linkTtlBelowFloor}
                  onChange={(e) => {
                    setLinkTtlSeconds(e.target.value)
                    setDirty(true)
                  }}
                />
                <p
                  className={
                    linkTtlBelowFloor
                      ? 'text-xs text-destructive'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {t('userDetailPanel.invites.linkTtlMin', { min: MIN_LINK_TTL_SECONDS })}
                </p>
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
                  <Label className="text-xs" htmlFor="invite-initial-slots">{t('userDetailPanel.invites.initialSlots')}</Label>
                  <Input
                  id="invite-initial-slots"
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
                  <Label className="text-xs" htmlFor="invite-refill-threshold">{t('userDetailPanel.invites.refillThreshold')}</Label>
                  <Input
                  id="invite-refill-threshold"
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
                  <Label className="text-xs" htmlFor="invite-refill-amount">{t('userDetailPanel.invites.refillAmount')}</Label>
                  <Input
                  id="invite-refill-amount"
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
            disabled={saveMutation.isPending || linkTtlBelowFloor}
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

// Kept as a payment-only fallback while OperationsTab owns the active surface.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
                  <td className="px-3 py-2 font-mono text-xs">
                    {truncate(tx.paymentId, 10)}
                  </td>
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

function OperationsTab({ telegramId }: { telegramId: string }) {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState(1)
  const locale = i18n.language?.startsWith('ru') ? 'ru-RU' : 'en-US'
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'users', telegramId, 'operations', page],
    queryFn: () => usersApi.listUserOperations({ userId: telegramId, page, limit: 25 }),
  })

  if (isLoading) return <Skeleton className="h-48 w-full" />

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm text-muted-foreground">{t('userDetailPanel.operations.loadError')}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('userDetailPanel.operations.retry')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.limit))
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('userDetailPanel.operations.title')}</CardTitle>
          <CardDescription>{t('userDetailPanel.operations.hint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.items.length === 0 ? (
            <p className="py-5 text-center text-sm text-muted-foreground">{t('userDetailPanel.operations.empty')}</p>
          ) : (
            data.items.map((operation) => (
              <OperationCard key={`${operation.kind}:${operation.id}`} operation={operation} locale={locale} />
            ))
          )}
        </CardContent>
      </Card>
      {data.total > data.limit && (
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>
            {t('userDetailPanel.operations.previous')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('userDetailPanel.operations.page', { page, total: totalPages, count: data.total })}
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
            {t('userDetailPanel.operations.next')}
          </Button>
        </div>
      )}
    </div>
  )
}

function OperationCard({ operation, locale }: { operation: UserOperation; locale: string }) {
  const { t } = useTranslation()
  const occurredAt = new Date(operation.occurredAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })

  if (operation.kind === 'PAYMENT') {
    return (
      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><Badge variant="success">{t('userDetailPanel.operations.payment')}</Badge><span className="text-xs text-muted-foreground">{occurredAt}</span></div>
          <span className="font-mono text-sm">{operation.payload.amount} {operation.payload.currency}</span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{operation.payload.paymentId ?? t('userDetailPanel.operations.noPaymentId')}</p>
        <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{operation.payload.status}</Badge>
            {operation.payload.gatewayType && <Badge variant="outline">{operation.payload.gatewayType}</Badge>}
            {operation.payload.purchaseType && <Badge variant="outline">{operation.payload.purchaseType}</Badge>}
          </div>
          <RefundPaymentAction
            transactionId={operation.id}
            amount={operation.payload.amount}
            currency={operation.payload.currency}
          />
        </div>
      </div>
    )
  }

  if (operation.kind === 'PROMOCODE_ACTIVATION') {
    const target = operation.payload.targetSubscription?.label ?? operation.payload.targetSubscription?.id
    return (
      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><Badge variant="secondary">{t('userDetailPanel.operations.promocode')}</Badge><span className="text-xs text-muted-foreground">{occurredAt}</span></div>
          <span className="font-mono text-sm">{operation.payload.codeMasked}</span>
        </div>
        <p className="text-sm">
          {t('userDetailPanel.operations.promoReward', {
            type: t(`userDetailPanel.operations.promoRewardTypes.${operation.payload.rewardType.toLowerCase()}`, {
              defaultValue: operation.payload.rewardType,
            }),
            value: operation.payload.rewardValue,
          })}
        </p>
        {target && <p className="text-xs text-muted-foreground">{t('userDetailPanel.operations.subscription', { subscription: target })}</p>}
      </div>
    )
  }

  const target = operation.payload.targetSubscription?.label ?? operation.payload.targetSubscription?.id
  const exchangeTypeKey = operation.payload.type.toLowerCase()
  const syncError = operation.payload.sync?.lastError
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Badge>{t('userDetailPanel.operations.pointsExchange')}</Badge><span className="text-xs text-muted-foreground">{occurredAt}</span></div>
        <span className="font-mono text-sm">−{operation.payload.pointsSpent} {t('userDetailPanel.operations.points')}</span>
      </div>
      <p className="text-sm">{t(`userDetailPanel.operations.exchangeTypes.${exchangeTypeKey}`, { value: operation.payload.rewardValue })}</p>
      {target && <p className="text-xs text-muted-foreground">{t('userDetailPanel.operations.subscription', { subscription: target })}</p>}
      {operation.payload.sync && (
        <p className={cn('text-xs', syncError ? 'text-destructive' : 'text-muted-foreground')}>
          {syncError
            ? t('userDetailPanel.operations.syncFailed', { error: syncError })
            : t('userDetailPanel.operations.syncStatus', {
              status: t(`userDetailPanel.operations.syncStatuses.${operation.payload.sync.status.toLowerCase()}`, {
                defaultValue: operation.payload.sync.status,
              }),
            })}
        </p>
      )}
    </div>
  )
}

/**
 * Operator-issued refund for a single payment.
 *
 * Eligibility is resolved by the backend (gateway support, fulfilment state,
 * remaining refundable balance) and only fetched once the operator actually
 * holds `payments:refund` — so the common case costs no extra request. The
 * money-side reversal is NOT done here: the provider's `refund.succeeded`
 * webhook drives it, which is why the dialog says the refund was *requested*.
 */
function RefundPaymentAction({
  transactionId,
  amount,
  currency,
}: {
  transactionId: string
  amount: string
  currency: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const canRefund = useHasPermission('payments', 'refund')
  const [open, setOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')

  const eligibility = useQuery({
    queryKey: ['admin', 'payments', 'transactions', transactionId, 'refund-eligibility'],
    queryFn: async () => {
      const { data } = await api.get(`/admin/payments/transactions/${transactionId}/refund-eligibility`)
      return data as {
        refundable: boolean
        reason: string | null
        refundableAmount: string
        currency: string
        refundedAmount: string
      }
    },
    enabled: canRefund && open,
    staleTime: 0,
  })

  const refundMutation = useMutation({
    mutationFn: async (payload: { amount?: string }) =>
      api.post(`/admin/payments/transactions/${transactionId}/refund`, payload),
    onSuccess: () => {
      setOpen(false)
      setCustomAmount('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'payments'] })
      toast.success(t('userDetailPanel.refund.requested'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('userDetailPanel.refund.failed'))),
  })

  if (!canRefund) return null

  const blockedReason = eligibility.data && !eligibility.data.refundable ? eligibility.data.reason : null
  // No `?? amount` fallback: if eligibility could not be read we must not
  // present the full payment as refundable — a role holding `payments:refund`
  // without `payments:view` gets a 403 here, and showing an armed form on a
  // guessed amount is exactly how an unintended refund happens.
  const maxAmount = eligibility.data?.refundableAmount ?? null
  const blocked = blockedReason !== null || eligibility.isError || maxAmount === null

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Reset on every close: a leftover partial amount from a cancelled
        // attempt must not be submitted on the next open, where the labels
        // describe a full refund.
        if (!next) setCustomAmount('')
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive">
          <Undo2 className="mr-1 h-3.5 w-3.5" />
          {t('userDetailPanel.refund.action')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('userDetailPanel.refund.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('userDetailPanel.refund.description', { amount, currency })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {eligibility.isLoading ? (
          <p className="text-sm text-muted-foreground">{t('userDetailPanel.refund.checking')}</p>
        ) : eligibility.isError ? (
          <p className="text-sm text-destructive">
            {getErrorMessage(eligibility.error, t('userDetailPanel.refund.checkFailed'))}
          </p>
        ) : blockedReason ? (
          <p className="text-sm text-destructive">
            {t(`userDetailPanel.refund.reasons.${blockedReason}`, {
              defaultValue: t('userDetailPanel.refund.reasons.default'),
            })}
          </p>
        ) : (
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground" htmlFor={`refund-amount-${transactionId}`}>
              {t('userDetailPanel.refund.amountLabel', { max: maxAmount ?? amount, currency })}
            </label>
            <Input
              id={`refund-amount-${transactionId}`}
              inputMode="decimal"
              placeholder={maxAmount ?? amount}
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('userDetailPanel.refund.partialHint')}</p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel', { defaultValue: 'Отмена' })}</AlertDialogCancel>
          <AlertDialogAction
            disabled={refundMutation.isPending || eligibility.isLoading || eligibility.isFetching || blocked}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              // Keep the dialog open until the request settles, so a provider
              // error is shown in place instead of vanishing with the dialog.
              e.preventDefault()
              refundMutation.mutate(
                customAmount.trim().length > 0 ? { amount: customAmount.trim() } : {},
              )
            }}
          >
            {refundMutation.isPending
              ? t('userDetailPanel.refund.submitting')
              : t('userDetailPanel.refund.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

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
  const currentTime = useCurrentTime()
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
  //
  // Gated on `users:edit`, not on `users:view`. The endpoint returns a LIVE
  // credential a subscriber can still sign in with, so it now demands the same
  // permission as the route that issues one. Without this the shipped `support`
  // role — which holds `users:view` and nothing else on users — would fire a
  // 403 on opening any user card at all.
  const canReadTemporaryPassword = useHasPermission('users', 'edit')
  const tempPwQuery = useQuery({
    queryKey: ['admin', 'user-temp-password', telegramId],
    queryFn: async () =>
      (await api.get(`/admin/users/${telegramId}/web/temp-password`)).data as {
        temporaryPassword: string | null
        expiresAt: string | null
      },
    enabled: !!user.webAccount && canReadTemporaryPassword,
    staleTime: 30_000,
  })

  const webAccount = user.webAccount
  const activeTemporaryPasswordExpiresAt = isFutureTimestamp(
    webAccount?.temporaryPasswordExpiresAt,
    currentTime,
  )
    ? webAccount?.temporaryPasswordExpiresAt ?? null
    : null
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
              {activeTemporaryPasswordExpiresAt && (
                  <InfoRow
                    label={t('userDetailPanel.web.tempUntil')}
                    value={new Date(activeTemporaryPasswordExpiresAt).toLocaleString(
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
    onError: (error) => toast.error(getErrorMessage(error, t('userDetailPanel.toasts.deleteFailed'))),
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

type NotifyChannel = 'telegram' | 'webpush'

interface NotifyChannelAvailability {
  channel: NotifyChannel
  available: boolean
  reason: string | null
}

interface NotifyChannelOutcome {
  channel: NotifyChannel
  status: 'delivered' | 'failed' | 'unavailable' | 'notSelected'
  reason: string | null
  delivered: number | null
  attempted: number | null
}

const NOTIFY_CHANNELS: readonly NotifyChannel[] = ['telegram', 'webpush']

/**
 * Send-a-message-to-one-user dialog.
 *
 * Two things here are load-bearing and both replace a control that lied:
 *
 *  1. The channel list is derived from THIS user — the backend answers which
 *     of Telegram / browser push can actually reach them — so a channel that
 *     cannot work is shown disabled WITH the reason, never offered.
 *  2. The result is read out of the response per channel. The previous version
 *     toasted success on any 2xx, which was unconditional: the route returned
 *     `{ sent: true }` before delivery was even attempted. The dialog now stays
 *     open and lists what each channel did whenever something did not land.
 */
function NotifyButton({ telegramId }: { telegramId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [override, setOverride] = useState<readonly NotifyChannel[] | null>(null)
  const [outcomes, setOutcomes] = useState<readonly NotifyChannelOutcome[] | null>(null)

  const channelsQuery = useQuery({
    queryKey: ['user-notify-channels', telegramId],
    queryFn: async () => {
      const res = await api.get<{ channels: unknown }>(
        `/admin/users/${telegramId}/notify/channels`,
      )
      // The dialog decides which channels it may even offer from this list, so
      // a non-array body must not be read as an empty one: silently offering
      // nothing is indistinguishable from 'this user has no channels'.
      return expectArray<NotifyChannelAvailability>(res.data.channels)
    },
    enabled: open,
  })

  const availability = channelsQuery.data ?? []

  // The default selection is everything this user can actually receive on, and
  // it is DERIVED during render rather than copied into state by an effect —
  // the availability answer is server state, and mirroring it into a second
  // source of truth is how the two drift apart. `override` holds only what the
  // operator explicitly changed; `?? ` falls back on null alone, so unchecking
  // every box stays unchecked instead of snapping back to the default.
  const selected: readonly NotifyChannel[] =
    override ?? availability.filter((c) => c.available).map((c) => c.channel)

  const toggle = (channel: NotifyChannel, checked: boolean) => {
    setOverride(
      checked
        ? [...selected.filter((c) => c !== channel), channel]
        : selected.filter((c) => c !== channel),
    )
  }

  const reset = () => { setMessage(''); setOverride(null); setOutcomes(null) }

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ sent: boolean; outcomes: NotifyChannelOutcome[] }>(
        `/admin/users/${telegramId}/notify`,
        { message, channels: selected },
      )
      return res.data
    },
    onSuccess: (data) => {
      const results = data.outcomes ?? []
      setOutcomes(results)
      const attempted = results.filter((o) => o.status !== 'notSelected')
      if (attempted.length === 0) {
        // Feed-only is a legitimate choice, not a failure — but it is also not
        // "notification sent", so it does not get the success wording.
        toast.success(t('userDetailPanel.toasts.notifyFeedOnly'))
        setOpen(false)
        reset()
        return
      }
      if (attempted.every((o) => o.status === 'delivered')) {
        toast.success(t('userDetailPanel.toasts.notifySent'))
        setOpen(false)
        reset()
        return
      }
      // Something did not land. Stay open so the per-channel breakdown below is
      // readable — a toast that disappears is not a report.
      toast.error(t('userDetailPanel.toasts.notifyPartial'))
    },
    onError: () => toast.error(t('userDetailPanel.toasts.notifyFailed')),
  })

  const statusLabel = (outcome: NotifyChannelOutcome) => {
    if (outcome.status === 'delivered') {
      return outcome.channel === 'webpush' && outcome.attempted !== null
        ? t('userDetailPanel.actions.resultPushCount', {
            delivered: outcome.delivered ?? 0,
            attempted: outcome.attempted,
          })
        : t('userDetailPanel.actions.resultDelivered')
    }
    if (outcome.status === 'notSelected') return t('userDetailPanel.actions.resultSkipped')
    const reason = outcome.reason ?? 'error'
    return outcome.status === 'unavailable'
      ? t(`userDetailPanel.actions.channelUnavailable.${reason}`)
      : t(`userDetailPanel.actions.channelFailure.${reason}`)
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Send className="mr-1 h-3.5 w-3.5" /> {t('userDetailPanel.actions.notify')}
      </Button>
      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset() }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('userDetailPanel.actions.sendNotification')}</DialogTitle></DialogHeader>
          <textarea
            className="w-full rounded-md border p-3 text-sm"
            rows={4}
            placeholder={t('userDetailPanel.actions.messagePlaceholder')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('userDetailPanel.actions.channelsLabel')}</legend>
            {channelsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">{t('userDetailPanel.actions.channelsLoading')}</p>
            ) : (
              NOTIFY_CHANNELS.map((channel) => {
                const entry = availability.find((c) => c.channel === channel)
                const available = entry?.available === true
                const checked = selected.includes(channel)
                return (
                  <div key={channel} className="flex items-start gap-2">
                    <Checkbox
                      id={`notify-channel-${channel}`}
                      checked={checked}
                      disabled={!available}
                      onCheckedChange={(value) => toggle(channel, value === true)}
                    />
                    <div className="grid gap-0.5 leading-none">
                      <Label
                        htmlFor={`notify-channel-${channel}`}
                        className={cn('text-sm', !available && 'text-muted-foreground')}
                      >
                        {t(`userDetailPanel.actions.channel_${channel}`)}
                      </Label>
                      {!available && entry !== undefined ? (
                        <span className="text-xs text-muted-foreground">
                          {t(`userDetailPanel.actions.channelUnavailable.${entry.reason ?? 'error'}`)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
            <p className="text-xs text-muted-foreground">{t('userDetailPanel.actions.channelsFeedNote')}</p>
          </fieldset>

          {outcomes !== null ? (
            <div className="rounded-md border p-3">
              <p className="text-sm font-medium">{t('userDetailPanel.actions.resultTitle')}</p>
              <ul className="mt-1 space-y-1">
                {outcomes.map((outcome) => (
                  <li key={outcome.channel} className="text-xs">
                    <span className="font-medium">
                      {t(`userDetailPanel.actions.channel_${outcome.channel}`)}
                    </span>
                    {': '}
                    <span
                      className={cn(
                        outcome.status === 'delivered' && 'text-emerald-600',
                        (outcome.status === 'failed' || outcome.status === 'unavailable') &&
                          'text-destructive',
                        outcome.status === 'notSelected' && 'text-muted-foreground',
                      )}
                    >
                      {statusLabel(outcome)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setOpen(false); reset() }}>{t('userDetailPanel.actions.cancel')}</Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={!message.trim() || mutation.isPending || channelsQuery.isLoading}
            >
              {t('userDetailPanel.actions.send')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
