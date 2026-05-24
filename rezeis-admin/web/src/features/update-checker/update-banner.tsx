import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { safeGetItem, safeSetItem } from '@/lib/safe-storage'

import { getUpdateStatus } from './update-checker-api'

const DISMISS_KEY = 'rezeis-admin:update-banner:dismissed-version'

/**
 * Compact banner shown at the top of the admin shell when a newer
 * release is available on the configured GitHub repo.
 *
 * The banner is fully client-side opt-out: dismissing it stores the
 * dismissed version in `localStorage` so the same release won't pester
 * the operator on every page load. A new release re-shows the banner.
 *
 * The component renders nothing in three cases:
 *   - the backend reports `source: 'unknown'` (REZEIS_UPDATE_REPO is unset),
 *   - `hasUpdate` is false,
 *   - the operator dismissed this exact version.
 */
export function UpdateBanner() {
  const { t, i18n } = useTranslation()
  const status = useQuery({
    queryKey: ['update-checker', 'status'],
    queryFn: () => getUpdateStatus(false),
    staleTime: 5 * 60 * 1_000,
    refetchInterval: 30 * 60 * 1_000,
    refetchIntervalInBackground: false,
    retry: false,
  })

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    safeGetItem(DISMISS_KEY),
  )

  if (!status.data) return null
  if (status.data.source === 'unknown') return null
  if (!status.data.hasUpdate || !status.data.latest) return null
  if (dismissedVersion === status.data.latest) return null

  const dismiss = () => {
    const latest = status.data?.latest
    if (!latest) return
    safeSetItem(DISMISS_KEY, latest)
    setDismissedVersion(latest)
  }

  const url = status.data.htmlUrl ?? null

  return (
    <div className="flex items-center justify-between gap-3 border-b border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
      <div className="flex flex-1 items-center gap-2">
        <span className="font-medium">
          {t('updateBanner.available', { current: status.data.current, latest: status.data.latest })}
        </span>
        {status.data.publishedAt && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {t('updateBanner.publishedAt', {
              date: new Date(status.data.publishedAt).toLocaleDateString(
                i18n.language === 'ru' ? 'ru-RU' : 'en-US',
              ),
            })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {url && (
          <Button asChild size="sm" variant="outline">
            <a href={url} target="_blank" rel="noreferrer">
              {t('updateBanner.releaseNotes')}
              <ArrowUpRight className="ml-1 h-3 w-3" />
            </a>
          </Button>
        )}
        <Button size="icon" variant="ghost" onClick={dismiss} title={t('updateBanner.dismissTitle')} aria-label={t('updateBanner.dismissTitle')}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
