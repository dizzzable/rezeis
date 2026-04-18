import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { PlaceholderPage } from '@/components/layout/placeholder-page'

export function PanelSettingsPage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <PlaceholderPage
      badge={t('settings.badge')}
      title={t('settings.panel.title')}
      summary={t('settings.panel.summary')}
      filtersTitle={t('common.filtersTitle')}
      filters={t('settings.panel.filters', { returnObjects: true }) as string[]}
      tableTitle={t('common.tableTitle')}
      columns={t('settings.panel.columns', { returnObjects: true }) as string[]}
      emptyTitle={t('common.emptyTitle')}
      emptyDescription={t('common.emptyDescription')}
    />
  )
}
