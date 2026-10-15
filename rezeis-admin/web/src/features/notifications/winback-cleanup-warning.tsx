import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import {
  CLEANUP_SETTINGS_QUERY_KEY,
  REMNAWAVE_SETTINGS_PATH,
  winbackCleanupConflict,
  type CleanupPolicy,
} from '@/lib/winback-cleanup'

/**
 * Beside the «Возврат покупателя» switches: the reminders switched on that the
 * Remnawave clean-up would cut short, and the two ways out — wait long enough,
 * one tap, or open the setting (the owner, 15.10.2026: «либо 15 дней надо
 * выставить либо выключить данный функционал»). Nothing is shown while every
 * reminder switched on can still arrive, nor when the clean-up cannot be read
 * (an operator without that permission sees the switches alone).
 */
export function WinbackCleanupWarning({ toggles }: { readonly toggles: Readonly<Record<string, unknown>> }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: policy } = useQuery({
    queryKey: CLEANUP_SETTINGS_QUERY_KEY,
    queryFn: async () => (await api.get<CleanupPolicy>('/admin/settings/remnawave-cleanup')).data,
    retry: false,
  })
  const setDays = useMutation({
    mutationFn: async (graceDays: number) =>
      (await api.patch<CleanupPolicy>('/admin/settings/remnawave-cleanup', { graceDays })).data,
    onSuccess: (next) => {
      queryClient.setQueryData(CLEANUP_SETTINGS_QUERY_KEY, next)
      toast.success(t('notificationsPage.winback.saved', { count: next.graceDays }))
    },
    onError: () => toast.error(t('notificationsPage.winback.saveFailed')),
  })

  if (policy === undefined) return null
  const conflict = winbackCleanupConflict(toggles, policy)
  if (conflict === null) return null
  const reminders = conflict.cutShort.map((key) => t(`notificationsPage.winback.short.${key}`)).join(', ')

  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">{t('notificationsPage.winback.conflictTitle')}</p>
          <p className="text-xs text-muted-foreground">
            {t('notificationsPage.winback.conflict', {
              count: conflict.graceDays,
              reminders,
              needed: conflict.needed,
            })}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-6">
        <Button size="sm" onClick={() => setDays.mutate(conflict.needed)} disabled={setDays.isPending}>
          {t('notificationsPage.winback.setDays', { count: conflict.needed })}
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to={REMNAWAVE_SETTINGS_PATH}>{t('notificationsPage.winback.openSettings')}</Link>
        </Button>
      </div>
    </div>
  )
}
