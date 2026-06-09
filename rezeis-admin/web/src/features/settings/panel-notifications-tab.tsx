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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  detectPushSupport,
  disablePush,
  enablePush,
  getCurrentSubscription,
  isPushConfigured,
} from '@/lib/push'

type NotificationCategory = 'support' | 'payment' | 'fraud' | 'withdrawal' | 'system'

interface CategoryPreference {
  category: NotificationCategory
  enabled: boolean
}

async function getPreferences(): Promise<CategoryPreference[]> {
  const { data } = await api.get<{ categories: CategoryPreference[] }>(
    '/admin/notifications/preferences',
  )
  return data.categories ?? []
}

async function setPreference(category: string, enabled: boolean): Promise<CategoryPreference[]> {
  const { data } = await api.put<{ categories: CategoryPreference[] }>(
    '/admin/notifications/preferences',
    { category, enabled },
  )
  return data.categories ?? []
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
      if (ok) {
        const sub = await getCurrentSubscription()
        if (!cancelled) setEnabled(sub !== null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function onToggle(next: boolean) {
    setBusy(true)
    try {
      if (next) {
        const result = await enablePush()
        if (result === 'subscribed') {
          setEnabled(true)
          toast.success(t('pushNotifications.enabled'))
        } else if (result === 'permission-denied') {
          toast.error(t('pushNotifications.permissionDenied'))
        } else if (result === 'push-disabled') {
          toast.error(t('pushNotifications.disabledServer'))
        } else {
          toast.error(t('pushNotifications.unsupported'))
        }
      } else {
        await disablePush()
        setEnabled(false)
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
