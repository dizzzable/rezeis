import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { PlaceholderPage } from '@/components/layout/placeholder-page'

interface SectionPlaceholderPageProps {
  readonly sectionKey: 'broadcast' | 'promocodes' | 'accessMode' | 'remnawave' | 'ruid' | 'imports'
}

export function SectionPlaceholderPage({ sectionKey }: SectionPlaceholderPageProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <PlaceholderPage
      badge={t(`sections.${sectionKey}.badge`)}
      title={t(`sections.${sectionKey}.title`)}
      summary={t(`sections.${sectionKey}.summary`)}
      filtersTitle={t('common.filtersTitle')}
      filters={t(`sections.${sectionKey}.filters`, { returnObjects: true }) as string[]}
      tableTitle={t('common.tableTitle')}
      columns={t(`sections.${sectionKey}.columns`, { returnObjects: true }) as string[]}
      emptyTitle={t('common.emptyTitle')}
      emptyDescription={t('common.emptyDescription')}
    />
  )
}
