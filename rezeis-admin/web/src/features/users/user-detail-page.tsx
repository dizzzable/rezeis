/**
 * User Detail Page (`/users/:telegramId`).
 *
 * Thin wrapper around the canonical `UserDetailPanel`. The page used
 * to maintain its own ~1200-line clone of the panel — including
 * Profile / Subscriptions / Transactions / Referrals / Partner
 * sub-components — which drifted out of sync with the panel mounted
 * inside the two-pane `UsersPage`. Both implementations rendered the
 * same data; the duplicate has been removed.
 *
 * Today this page exists only as a deep-link target (e.g. clicking a
 * subscription row in `subscriptions-page.tsx` calls
 * `navigate('/users/:telegramId')`). It adds a "back" affordance and
 * delegates all rendering and mutations to the panel, ensuring there
 * is exactly one source of truth for user-detail UX.
 */
import { lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

const UserDetailPanel = lazy(() => import('./user-detail-panel'))

export default function UserDetailPage() {
  const { t } = useTranslation()
  const { telegramId } = useParams<{ telegramId: string }>()
  const navigate = useNavigate()

  if (!telegramId) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        {t('userDetailPage.notFound')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/users')}
          aria-label={t('userDetailPage.header.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="text-sm text-muted-foreground">
          {t('userDetailPage.header.deepLink', { telegramId })}
        </div>
      </div>

      <Suspense
        fallback={
          <div className="space-y-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-48 w-full" />
          </div>
        }
      >
        <UserDetailPanel telegramId={telegramId} />
      </Suspense>
    </div>
  )
}
