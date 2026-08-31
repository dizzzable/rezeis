/**
 * Subscriptions pointing at a squad the panel no longer serves.
 * ─────────────────────────────────────────────────────────────
 * The third and last surface for one failure, and the only one an operator can
 * open on purpose.
 *
 * A squad deleted or RECREATED in Remnawave keeps its old uuid on every
 * subscription sold against it. The panel validates squad uuids for SHAPE only,
 * so the dead one passes and then throws inside the panel's own service:
 * `HTTP 500 A039 Update user error`, naming neither the field nor the value.
 * Reproduced against a live 3.3.2 panel.
 *
 * The other two surfaces both arrive too late or only once:
 *
 *  • the sync failure now names the offending uuid — but only after it has
 *    already failed, for one customer at a time;
 *  • saving a plan warns how many subscriptions the squad propagation could not
 *    move — but that is a toast, and an operator who was not looking never sees
 *    it again.
 *
 * This answers for the whole install, at any moment, and writes nothing.
 *
 * WHY IT LIVES HERE. Same page as the two repair panels, same population — the
 * rows are subscriptions and the tiles at the top of this page count the states
 * those rows are in. It asks for `plans:view`, which is what its endpoint
 * demands, and renders nothing without it.
 *
 * THE PLANS ARE LISTED TOO, and that is not padding: repairing subscriptions
 * one at a time while the plan still holds the dead uuid means the next
 * purchase recreates the problem. The plan is the fix; the subscriptions are
 * the damage already done.
 *
 * AN UNREACHABLE PANEL IS AN ERROR, NOT AN EMPTY LIST. The endpoint refuses
 * rather than answering, and this surface shows that refusal as a refusal. An
 * empty list here would read as "nothing is wrong" — the single most
 * misleading thing this screen could say.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useHasPermission } from '@/features/rbac'
import { fetchUnknownSquads } from './unknown-squad-api'

export function UnknownSquadPanel() {
  const { t } = useTranslation()
  const allowed = useHasPermission('plans', 'view')

  const query = useQuery({
    queryKey: ['plans', 'unknown-squads'],
    queryFn: fetchUnknownSquads,
    // Not on mount: this walks the subscription table and asks the panel for
    // its squads. The operator opens it when they are looking for this.
    enabled: false,
    retry: false,
    // A verdict has no timestamp on screen, so a cached one shown on a later
    // visit would read as current. `gcTime: 0` makes "Check" the only way a
    // verdict ever appears, which is what the line above promises.
    gcTime: 0,
  })

  if (!allowed) return null

  const report = query.data
  // ── EVERY condition that makes an all-clear a lie ──────────────────────
  //
  //  - `isError`: TanStack keeps the previous data through a failed refetch, so
  //    a panel that went down between two checks rendered the destructive "the
  //    panel did not answer" alert AND the reassuring line, together.
  //  - `truncated`: the scan stopped early, so "nothing found" means "nothing
  //    found so far". Saying it plainly is the whole point of this screen.
  const clean =
    report !== undefined &&
    !query.isError &&
    !report.truncated &&
    report.rows.length === 0 &&
    report.affectedPlans.length === 0

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="h-4 w-4" />
              {t('unknownSquads.title')}
            </div>
            <p className="text-xs text-muted-foreground">{t('unknownSquads.subtitle')}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('unknownSquads.check')}
          </Button>
        </div>

        {query.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{t('unknownSquads.unavailableTitle')}</AlertTitle>
            <AlertDescription>{t('unknownSquads.unavailableBody')}</AlertDescription>
          </Alert>
        ) : null}

        {clean ? (
          <p className="text-xs text-muted-foreground">{t('unknownSquads.clean')}</p>
        ) : null}

        {/* Outside the "there are rows" branch, where it used to live: a scan
            that stopped early having found nothing is exactly the case where
            the operator most needs to be told it stopped early. */}
        {report !== undefined && report.truncated && report.rows.length === 0 ? (
          <Alert>
            <AlertTitle>{t('unknownSquads.partialTitle')}</AlertTitle>
            <AlertDescription className="text-xs">
              {t('unknownSquads.summary', { affected: report.affected, scanned: report.scanned })}{' '}
              {t('unknownSquads.truncated')}
            </AlertDescription>
          </Alert>
        ) : null}

        {report !== undefined && report.affectedPlans.length > 0 ? (
          <Alert>
            <AlertTitle>{t('unknownSquads.plansTitle')}</AlertTitle>
            <AlertDescription className="space-y-1">
              <p className="text-xs">{t('unknownSquads.plansBody')}</p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {report.affectedPlans.map((plan) => (
                  <Badge key={plan.id} variant="destructive" className="font-normal">
                    {plan.name}
                  </Badge>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {report !== undefined && report.rows.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t('unknownSquads.summary', {
                affected: report.affected ?? report.rows.length,
                scanned: report.scanned ?? report.rows.length,
              })}
              {report.truncated ? ` ${t('unknownSquads.truncated')}` : ''}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1.5 pr-3 text-left font-normal">
                      {t('unknownSquads.columns.subscription')}
                    </th>
                    <th className="py-1.5 pr-3 text-left font-normal">
                      {t('unknownSquads.columns.plan')}
                    </th>
                    <th className="py-1.5 pr-3 text-left font-normal">
                      {t('unknownSquads.columns.status')}
                    </th>
                    <th className="py-1.5 text-left font-normal">
                      {t('unknownSquads.columns.squads')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.subscriptionId} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono">{row.subscriptionId}</td>
                      <td className="py-1.5 pr-3">{row.planName ?? '—'}</td>
                      <td className="py-1.5 pr-3">{row.status}</td>
                      <td className="py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {row.unknownSquads.map((uuid) => (
                            <Badge
                              key={uuid}
                              variant="destructive"
                              className="font-mono font-normal"
                            >
                              {uuid.slice(0, 8)}
                            </Badge>
                          ))}
                          {row.externalSquadMissing ? (
                            <Badge variant="outline" className="font-normal">
                              {t('unknownSquads.external')}
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{t('unknownSquads.howToFix')}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
