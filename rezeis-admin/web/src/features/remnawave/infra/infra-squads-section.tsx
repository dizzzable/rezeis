/**
 * Squads — internal + external in two compact cards side-by-side. Counts
 * come from the detail-shape backend endpoints we wired earlier.
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Users2 } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { remnawaveApi } from '../remnawave-api'
import { KEYS } from '../remnawave-query-keys'

export function InfraSquadsSection() {
  const { t } = useTranslation()
  const { data: internal, isLoading: iLoading } = useQuery({
    queryKey: KEYS.internalSquads,
    queryFn: remnawaveApi.getInternalSquads,
  })
  const { data: external, isLoading: eLoading } = useQuery({
    queryKey: KEYS.externalSquads,
    queryFn: remnawaveApi.getExternalSquads,
  })
  const isLoading = iLoading || eLoading

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex h-32 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Users2 className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('remnaWavePage.squads.internal')}
          </CardTitle>
          <CardDescription className="text-xs">
            {t('remnaWavePage.squads.internalDescription', { count: internal?.length ?? 0 })}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {!internal || internal.length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">{t('remnaWavePage.squads.noInternal')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('remnaWavePage.squads.columns.name')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.squads.columns.members')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.squads.columns.inbounds')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {internal.map((squad) => (
                  <TableRow key={squad.uuid}>
                    <TableCell>
                      <p className="font-medium">{squad.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground/70">{squad.uuid.slice(0, 8)}…</p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{squad.membersCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{squad.inboundsCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Users2 className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('remnaWavePage.squads.external')}
          </CardTitle>
          <CardDescription className="text-xs">
            {t('remnaWavePage.squads.externalDescription', { count: external?.length ?? 0 })}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {!external || external.length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">{t('remnaWavePage.squads.noExternal')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('remnaWavePage.squads.columns.name')}</TableHead>
                  <TableHead className="text-right">{t('remnaWavePage.squads.columns.members')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {external.map((squad) => (
                  <TableRow key={squad.uuid}>
                    <TableCell>
                      <p className="font-medium">{squad.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground/70">{squad.uuid.slice(0, 8)}…</p>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{squad.membersCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
