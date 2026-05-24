import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getUpdateStatus } from '@/features/update-checker/update-checker-api'

import { GitHubIcon } from './brand-icons'

/**
 * Topbar widget that polls the GitHub release endpoint and shows a
 * small badge when a new version is available. Polls only while the
 * tab is in the foreground (`refetchIntervalInBackground: false`).
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

  const hasUpdate = data?.hasUpdate && data.latest
  const currentVersion = data?.current ?? '0.1.3'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={t('adminShell.github.label')}
        >
          <GitHubIcon className={cn('h-4 w-4', hasUpdate && 'text-[#2dd4bf]')} />
          {hasUpdate && (
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-[#2dd4bf] animate-pulse" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('adminShell.github.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <span className="text-xs text-muted-foreground">
            {t('adminShell.github.current')}: <code className="font-mono">{currentVersion}</code>
          </span>
        </DropdownMenuItem>
        {hasUpdate && (
          <>
            <DropdownMenuItem disabled>
              <span className="text-xs text-[#2dd4bf] font-medium">
                {t('adminShell.github.available')}: <code className="font-mono">{data.latest}</code>
              </span>
            </DropdownMenuItem>
            {data.htmlUrl && (
              <DropdownMenuItem asChild>
                <a href={data.htmlUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2">
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('adminShell.github.releaseNotes')}
                </a>
              </DropdownMenuItem>
            )}
          </>
        )}
        {!hasUpdate && (
          <DropdownMenuItem disabled>
            <span className="text-xs text-green-500">{t('adminShell.github.upToDate')}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="https://github.com/dizzzable/rezeis" target="_blank" rel="noreferrer" className="flex items-center gap-2">
            <GitHubIcon className="h-3.5 w-3.5" />
            {t('adminShell.github.repo')}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
