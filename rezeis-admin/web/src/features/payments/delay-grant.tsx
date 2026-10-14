import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'

import type { DelayGrant } from './payment-records'

/**
 * The mark beside a payment that is the plan granted for the delay of an SBP
 * subscription's first charge («Отсрочка первого списания по СБП»): the row
 * reads COMPLETED for 0, and without the mark it looks like a free purchase of
 * nothing. The first charge comes later, as a payment of its own.
 */
export function DelayGrantBadge({ grant }: { readonly grant: DelayGrant }) {
  const { t } = useTranslation()
  return (
    <Badge
      variant="secondary"
      title={t('paymentsPage.delayGrant.hint', { days: grant.days, amount: grant.originalAmount })}
    >
      {t('paymentsPage.delayGrant.badge')}
    </Badge>
  )
}
