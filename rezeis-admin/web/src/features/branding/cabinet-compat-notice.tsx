/**
 * «Кабинет Reiwa» at the top of «WEB Reiwa» (pair reliability, 26.09.2026).
 *
 * The panel and the cabinet are two images an operator updates in either
 * order. This block says which cabinet the panel is talking to — the site and
 * API, and the bot: version, when each was last heard from, and whether it
 * said what it can do (0.9.7.54 and later) or the panel placed it by the
 * evidence it left (0.9.7.53 and older: «сообщает версию, но не возможности»).
 *
 * When the cabinet is older than this panel expects, the block turns amber and
 * lists what does not work until it is updated — the sales the panel withholds
 * first — the same list the card «🧩 Кабинет старше панели» sends. The words
 * come from the panel's registry (`GET /admin/reiwa-peers`), in both
 * languages, so the page, the card and the release notes say the same thing.
 *
 * Asked on open and every minute while the page is open: the operator may be
 * updating the cabinet with this page in front of them. An answer it cannot
 * read shows nothing.
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Puzzle, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { formatNotificationAge } from '@/features/notification-centre/notification-view'
import { activeLocale } from '@/lib/utils'

import {
  CABINET_COMPAT_QUERY_KEY,
  CABINET_COMPAT_REFRESH_MS,
  CABINET_SURFACES,
  fetchCabinetCompat,
  missingWhileBehind,
  readCabinetCompat,
  withheldUntilHeard,
  type CabinetMissing,
  type CabinetSurface,
  type CabinetSurfaceReport,
} from './cabinet-compat-api'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** «Reiwa 0.9.7.54 · был на связи 5 минут назад», or where the panel stands with it. */
function surfaceLine(t: Translate, surface: CabinetSurface, report: CabinetSurfaceReport, now: number): string {
  // Never heard from is not «never ran» (review R1, round 2): the bot of Reiwa
  // 0.9.7.52 and older sends nothing at all, and its site reports its version
  // once an hour — so right after the panel's update a working cabinet reads
  // exactly like a missing one.
  if (report.state === 'never') return t(surface === 'bot' ? 'brandingPage.cabinetCompat.neverBot' : 'brandingPage.cabinetCompat.never')
  if (report.state === 'unavailable') return t('brandingPage.cabinetCompat.unavailable')
  const version = report.version ?? t('brandingPage.cabinetCompat.unknownVersion')
  const ago =
    report.lastSeenAt === null
      ? '—'
      : formatNotificationAge(report.lastSeenAt, now, t('brandingPage.cabinetCompat.justNow'))
  const line = t(report.state === 'live' ? 'brandingPage.cabinetCompat.seen' : 'brandingPage.cabinetCompat.seenQuiet', {
    version,
    ago,
  })
  return report.declared ? line : `${line} · ${t('brandingPage.cabinetCompat.silent')}`
}

export function CabinetCompatNotice({ now = Date.now }: { readonly now?: () => number } = {}) {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: CABINET_COMPAT_QUERY_KEY,
    queryFn: fetchCabinetCompat,
    staleTime: 0,
    refetchInterval: CABINET_COMPAT_REFRESH_MS,
    retry: false,
  })

  const compat = readCabinetCompat(data)
  if (compat === null) return null

  // The panel's own rule for the operator's language (`activeLocale`): Russian
  // when the panel is in Russian, English otherwise.
  const russian = activeLocale() === 'ru-RU'
  const textOf = (row: CabinetMissing): string => (russian ? row.operatorText : row.operatorTextEn)
  const missing = missingWhileBehind(compat)
  const behind = missing.length > 0
  // A surface never heard from is judged by the floor, and its sales are
  // already withheld: said, rather than a neutral «ещё не выходил на связь»
  // over a sale the customer cannot find (review R1-12).
  const withheld = withheldUntilHeard(compat).filter((row) => !missing.some((shown) => shown.id === row.id))
  const amber = behind || withheld.length > 0
  const newer = Math.max(...CABINET_SURFACES.map((surface) => compat.surfaces[surface].unknownToPanel))
  const at = now()

  return (
    <Alert
      className={
        amber ? 'border-amber-500/40 bg-amber-500/10 [&>svg]:text-amber-500' : 'border-border bg-muted/30'
      }
      data-testid="cabinet-compat-notice"
      data-behind={behind ? 'true' : 'false'}
      data-withheld={withheld.length > 0 ? 'true' : 'false'}
    >
      {amber ? <TriangleAlert className="h-4 w-4" /> : <Puzzle className="h-4 w-4" />}
      <AlertTitle>
        {behind
          ? t('brandingPage.cabinetCompat.behindTitle', { panel: compat.panelVersion })
          : t('brandingPage.cabinetCompat.title')}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <ul className="space-y-1">
          {CABINET_SURFACES.map((surface) => (
            <li key={surface} data-testid={`cabinet-compat-${surface}`}>
              <span className="font-medium">{t(`brandingPage.cabinetCompat.surfaces.${surface}`)}:</span>{' '}
              {surfaceLine(t, surface, compat.surfaces[surface], at)}
            </li>
          ))}
        </ul>
        {behind && (
          <>
            <p>{t('brandingPage.cabinetCompat.untilUpdated')}</p>
            <ul className="list-disc space-y-1 pl-5">
              {missing.map((row) => (
                <li
                  key={row.id}
                  data-testid="cabinet-compat-missing"
                  data-kind={row.kind}
                  className={row.kind === 'gate' ? 'font-medium' : undefined}
                >
                  {textOf(row)}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">{t('brandingPage.cabinetCompat.nothingCharged')}</p>
          </>
        )}
        {withheld.length > 0 && (
          <>
            <p>{t('brandingPage.cabinetCompat.untilHeard', { floor: compat.floorVersion ?? '—' })}</p>
            <ul className="list-disc space-y-1 pl-5">
              {withheld.map((row) => (
                <li key={row.id} data-testid="cabinet-compat-withheld" className="font-medium">
                  {textOf(row)}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">{t('brandingPage.cabinetCompat.untilHeardFooter')}</p>
          </>
        )}
        {newer > 0 && (
          <p data-testid="cabinet-compat-newer">{t('brandingPage.cabinetCompat.newer', { count: newer })}</p>
        )}
      </AlertDescription>
    </Alert>
  )
}
