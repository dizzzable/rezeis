import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export function ApiTokensPage(): JSX.Element {
  const { t } = useTranslation()
  const columns: string[] = t('settings.apiTokens.columns', { returnObjects: true }) as string[]
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <Badge className="w-fit">{t('settings.badge')}</Badge>
          <CardTitle className="mt-4 text-2xl">{t('settings.apiTokens.title')}</CardTitle>
          <CardDescription className="mt-2 max-w-3xl">{t('settings.apiTokens.summary')}</CardDescription>
        </CardHeader>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('common.filtersTitle')}</CardTitle>
            <CardDescription>{t('settings.apiTokens.summary')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tokenName">{t('settings.apiTokens.form.nameLabel')}</Label>
              <Input id="tokenName" placeholder={t('settings.apiTokens.form.namePlaceholder')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tokenScope">{t('settings.apiTokens.form.scopeLabel')}</Label>
              <Textarea id="tokenScope" placeholder={t('settings.apiTokens.form.scopePlaceholder')} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('common.tableTitle')}</CardTitle>
            <CardDescription>{t('common.emptyDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 rounded-2xl border border-border/70 bg-background/60 p-4 md:grid-cols-4">
              {columns.map((column: string) => (
                <div key={column} className="rounded-xl bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm">
                  {column}
                </div>
              ))}
            </div>
            <div className="rounded-3xl border border-dashed border-border/80 bg-background/80 px-6 py-12 text-center">
              <p className="text-base font-semibold">{t('common.emptyTitle')}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('common.emptyDescription')}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
