import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { PlaceholderPage } from '@/components/layout/placeholder-page'
import { UserSearchPage } from '@/features/users/user-search-page'

interface UsersRoutePageProps {
  readonly pageKey: 'search' | 'recentRegistered' | 'recentActive' | 'blacklist' | 'invited'
}

export function UsersRoutePage({ pageKey }: UsersRoutePageProps): JSX.Element {
  const { t } = useTranslation()
  if (pageKey === 'search') {
    return <UserSearchPage />
  }
  return (
    <PlaceholderPage
      badge={t('users.badge')}
      title={t(`users.pages.${pageKey}.title`)}
      summary={t(`users.pages.${pageKey}.summary`)}
      filtersTitle={t('common.filtersTitle')}
      filters={t(`users.pages.${pageKey}.filters`, { returnObjects: true }) as string[]}
      tableTitle={t('common.tableTitle')}
      columns={t(`users.pages.${pageKey}.columns`, { returnObjects: true }) as string[]}
      emptyTitle={t('common.emptyTitle')}
      emptyDescription={t('common.emptyDescription')}
    />
  )
}
