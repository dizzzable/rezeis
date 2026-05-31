import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getUpdateStatus,
  type UpdateCheckResult,
} from '@/features/update-checker/update-checker-api'

import { GitHubIcon } from './brand-icons'

/**
 * Topbar widget that polls the update-checker and shows a small badge when a
 * new version of any tracked component (admin panel or reiwa cabinet) is
 * available. Polls only while the tab is in the foreground.
 */
export function UpdateIndicator() {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['update-checker', 'status'],
    queryFn: () => getUpdateStatus(false),
    staleTime: 5 * 60_000,
    refetchInterval: 30 * 60_000,
    refetchIntervalInBackground: false,
  })

  // Panel fields are spread at the top level (legacy shape); the reiwa
  // component lives under `components.reiwa` when the backend reports it.
  const panel: UpdateCheckResult | undefined = data?.components?.panel ?? data
  const reiwa: UpdateCheckResult | undefined = data?.components?.reiwa

  const panelHasUpdate = Boolean(panel?.hasUpdate && panel.latest)
  const reiwaHasUpdate = Boolean(reiwa?.hasUpdate && reiwa.latest)
  const anyUpdate = panelHasUpdate || reiwaHasUpdate

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={t('adminShell.github.label')}
        >
          <GitHubIcon className={cn('h-4 w-4', anyUpdate && 'text-[#2dd4bf]')} />
          {anyUpdate && (
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[#2dd4bf] animate-pulse" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t('adminShell.github.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <ComponentRow
          label={t('adminShell.github.panelName')}
          result={panel}
          fallbackCurrent="0.0.0"
        />

        {reiwa && reiwa.source !== 'unknown' && (
          <>
            <DropdownMenuSeparator />
            <ComponentRow
              label={t('adminShell.github.reiwaName')}
              result={reiwa}
              fallbackCurrent="—"
            />
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a
            href="https://github.com/dizzzable/rezeis"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            {t('adminShell.github.repo')}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One component's version block: name + current version, an "update
 * available" line with the latest version, and a release-notes link.
 */
function ComponentRow({
  label,
  result,
  fallbackCurrent,
}: {
  label: string
  result: UpdateCheckResult | undefined
  fallbackCurrent: string
}) {
  const { t } = useTranslation()
  const hasUpdate = Boolean(result?.hasUpdate && result.latest)

  return (
    <>
      <DropdownMenuItem disabled className="opacity-100">
        <span className="text-xs">
          <span className="font-medium">{label}</span>{' '}
          <code className="font-mono text-muted-foreground">
            {result?.current ?? fallbackCurrent}
          </code>
        </span>
      </DropdownMenuItem>
      {hasUpdate ? (
        <>
          <DropdownMenuItem disabled className="opacity-100">
            <span className="text-xs text-[#2dd4bf] font-medium">
              {t('adminShell.github.available')}:{' '}
              <code className="font-mono">{result?.latest}</code>
            </span>
          </DropdownMenuItem>
          {result?.htmlUrl && (
            <DropdownMenuItem asChild>
              <a
                href={result.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('adminShell.github.releaseNotes')}
              </a>
            </DropdownMenuItem>
          )}
        </>
      ) : (
        <DropdownMenuItem disabled className="opacity-100">
          <span className="text-xs text-green-500">
            {t('adminShell.github.upToDate')}
          </span>
        </DropdownMenuItem>
      )}
    </>
  )
}
