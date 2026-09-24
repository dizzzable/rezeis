/**
 * Info hover that explains which anti-fraud detectors are active on the
 * currently-detected Remnawave panel version. Some detectors (IP-sharing,
 * per-user node traffic) rely on panel APIs this build reads only from a
 * Remnawave 3.x, so they self-activate once the panel reports them — this
 * surfaces that to the operator.
 *
 * Both rows are rendered from the capability the backend reports, never from a
 * version comparison here. IP-sharing reads live connections from
 * `connections/*`, which every 3.x serves; a 2.x panel is refused outright, so
 * the floor stated to the operator when a capability is off — 3.x — is the
 * same floor for both rows.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Info, Lock } from 'lucide-react'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { remnawaveApi } from '@/features/remnawave/remnawave-api'
import { KEYS } from '@/features/remnawave/remnawave-query-keys'

export function FraudVersionInfo() {
  const { t } = useTranslation()
  // Same key the Remnawave page uses, imported rather than retyped: a
  // hand-copied tuple here silently forked the capability cache in two.
  const { data: caps } = useQuery({
    queryKey: KEYS.version,
    queryFn: remnawaveApi.getCapabilities,
    staleTime: 5 * 60_000,
    retry: 1,
  })

  const live = caps?.liveIpControl ?? false
  const bandwidth = caps?.bandwidthNodesUsers ?? false
  // The HWID detector needs no special capability, but a 2.x panel is refused
  // on every path, its HWID reads included — "active" would be a lie there.
  // An unreadable version is not refused, so it keeps the row on.
  const hwid = caps?.tooOld !== true

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center text-muted-foreground/70 transition hover:text-foreground"
            aria-label={t('fraudPage.versionInfo.label')}
          >
            <Info className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-2 p-3 text-left">
          <p className="text-xs font-semibold">{t('fraudPage.versionInfo.title')}</p>
          <p className="text-[11px] text-muted-foreground">
            {caps?.version
              ? t('fraudPage.versionInfo.detected', { version: caps.version })
              : t('fraudPage.versionInfo.unknown')}
          </p>
          <ul className="space-y-1.5">
            <DetectorRow active={hwid} label={t('fraudPage.versionInfo.hwid')} note={t('fraudPage.versionInfo.allVersions')} />
            <DetectorRow active={live} label={t('fraudPage.versionInfo.ipSharing')} note={t('fraudPage.versionInfo.needs3x')} />
            <DetectorRow active={bandwidth} label={t('fraudPage.versionInfo.perUserTraffic')} note={t('fraudPage.versionInfo.needs3x')} />
          </ul>
          <p className="text-[11px] text-muted-foreground">{t('fraudPage.versionInfo.note')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function DetectorRow({ active, label, note }: { active: boolean; label: string; note: string }) {
  const { t } = useTranslation()
  return (
    <li className="flex items-start gap-2">
      {active ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
      ) : (
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
      )}
      <span className="text-[11px]">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {' — '}
          {active ? t('fraudPage.versionInfo.active') : note}
        </span>
      </span>
    </li>
  )
}
