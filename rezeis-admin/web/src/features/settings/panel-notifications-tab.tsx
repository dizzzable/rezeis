/**
 * Panel Notifications tab — browser/phone push opt-in for the current admin.
 *
 * Phase 2: a single opt-in toggle that subscribes the device to admin
 * web-push (gated server-side by the admin's role permissions). Phase 3 adds
 * per-category preference toggles below this card.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Bell, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { expectArray, unwrapPayload } from '@/lib/api-utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  PUSH_OPTOUT_KEY,
  detectPushSupport,
  disablePush,
  enablePush,
  ensurePushSubscription,
  getCurrentSubscription,
  hasPushOptOut,
  isPushConfigured,
} from '@/lib/push'

type NotificationCategory = 'support' | 'payment' | 'fraud' | 'withdrawal' | 'system'

interface CategoryPreference {
  category: NotificationCategory
  enabled: boolean
}

async function getPreferences(): Promise<CategoryPreference[]> {
  const { data } = await api.get('/admin/notifications/preferences')
  return expectArray<CategoryPreference>(unwrapPayload(data).categories ?? [])
}

async function setPreference(category: string, enabled: boolean): Promise<CategoryPreference[]> {
  const { data } = await api.put('/admin/notifications/preferences', { category, enabled })
  // Written into the query cache by the caller's `onSuccess`, so it needs the
  // same guard the read path has.
  return expectArray<CategoryPreference>(unwrapPayload(data).categories ?? [])
}

export default function PanelNotificationsTab() {
  const { t } = useTranslation()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const support = detectPushSupport()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ok = await isPushConfigured()
      if (cancelled) return
      setConfigured(ok)
      if (!ok) return
      const sub = await getCurrentSubscription()
      if (cancelled) return
      if (sub !== null) {
        setEnabled(true)
        return
      }
      // Default-on: once the operator granted notification permission, make
      // sure a subscription exists — unless they explicitly turned push off on
      // this device. Saves the "I granted permission but forgot the toggle"
      // footgun.
      const optedOut = hasPushOptOut()
      if (
        support === 'ready' &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        !optedOut
      ) {
        const outcome = await ensurePushSubscription()
        if (cancelled) return
        if (outcome === 'subscribed') setEnabled(true)
        // `endpoint-taken` deliberately leaves the toggle off: the browser is
        // bound to another admin's row, so push genuinely is not on for this
        // account. Pressing the toggle mints a fresh endpoint and clears it —
        // that path reports the reason (see `onToggle`); this one is a silent
        // page load and must not open with an error toast.
        else if (outcome === 'endpoint-taken') setEnabled(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [support])

  async function onToggle(next: boolean) {
    setBusy(true)
    try {
      if (next) {
        const result = await enablePush()
        if (result === 'subscribed') {
          setEnabled(true)
          try { localStorage.removeItem(PUSH_OPTOUT_KEY) } catch { /* ignore */ }
          toast.success(t('pushNotifications.enabled'))
        } else if (result === 'permission-denied') {
          toast.error(t('pushNotifications.permissionDenied'))
        } else if (result === 'push-disabled') {
          toast.error(t('pushNotifications.disabledServer'))
        } else if (result === 'subscribe-failed') {
          toast.error(t('pushNotifications.subscribeFailed'))
        } else if (result === 'endpoint-taken') {
          // Recoverable and self-inflicted-looking, so it gets its own line:
          // the local subscription was already dropped, and pressing the
          // toggle again mints an endpoint nobody else holds.
          toast.error(t('pushNotifications.endpointTaken'))
        } else {
          toast.error(t('pushNotifications.unsupported'))
        }
      } else {
        await disablePush()
        setEnabled(false)
        // Remember the explicit opt-out so we don't auto-re-enable on reload.
        try { localStorage.setItem(PUSH_OPTOUT_KEY, '1') } catch { /* ignore */ }
        toast.success(t('pushNotifications.disabled'))
      }
    } catch {
      toast.error(t('pushNotifications.error'))
    } finally {
      setBusy(false)
    }
  }

  // Hidden entirely when push is disabled server-side (no VAPID key) — no
  // useful action surface.
  if (configured === false) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            {t('pushNotifications.title')}
          </CardTitle>
          <CardDescription>{t('pushNotifications.disabledServer')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            {t('pushNotifications.title')}
          </CardTitle>
          <CardDescription>{t('pushNotifications.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {support === 'unsupported-browser' ? (
            <p className="text-sm text-muted-foreground">{t('pushNotifications.unsupported')}</p>
          ) : support === 'ios-needs-install' ? (
            <p className="text-sm text-muted-foreground">{t('pushNotifications.iosInstall')}</p>
          ) : (
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t('pushNotifications.toggleLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('pushNotifications.toggleHint')}</p>
              </div>
              <div className="flex items-center gap-2">
                {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                <Switch
                  checked={enabled}
                  disabled={busy || configured === null}
                  onCheckedChange={onToggle}
                  aria-label={t('pushNotifications.toggleLabel')}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {enabled && <CategoryPreferences />}
    </div>
  )
}

/**
 * Per-category opt-in toggles. Only categories the admin's role permits are
 * returned by the server. A short legend explains the role→category linkage.
 */
function CategoryPreferences() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: categories, isLoading } = useQuery({
    queryKey: ['admin-notification-preferences'],
    queryFn: getPreferences,
    staleTime: 60_000,
  })

  const mutation = useMutation({
    mutationFn: ({ category, enabled }: { category: string; enabled: boolean }) =>
      setPreference(category, enabled),
    onSuccess: (next) => {
      queryClient.setQueryData(['admin-notification-preferences'], next)
    },
    onError: () => toast.error(t('pushNotifications.error')),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pushNotifications.categoriesTitle')}</CardTitle>
        <CardDescription>{t('pushNotifications.categoriesSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !categories || categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pushNotifications.noCategories')}</p>
        ) : (
          categories.map((c) => (
            <div
              key={c.category}
              className="flex items-center justify-between gap-4 rounded-lg border p-3"
            >
              <div className="space-y-0.5">
                <p className="text-sm font-medium">
                  {t(`pushNotifications.categories.${c.category}`)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`pushNotifications.categoryHints.${c.category}`)}
                </p>
              </div>
              <Switch
                checked={c.enabled}
                disabled={mutation.isPending}
                onCheckedChange={(next) => mutation.mutate({ category: c.category, enabled: next })}
                aria-label={t(`pushNotifications.categories.${c.category}`)}
              />
            </div>
          ))
        )}
        <p className="pt-1 text-xs text-muted-foreground">{t('pushNotifications.roleLegend')}</p>
      </CardContent>
    </Card>
  )
}
