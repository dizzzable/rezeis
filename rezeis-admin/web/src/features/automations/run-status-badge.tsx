import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'

import { statusText } from './run-result-copy'

/** An execution's status as a badge, in the operator's language — the run log and the run dialog alike. */
export function ExecutionStatusBadge({ status }: { readonly status: string | null }) {
  const { t } = useTranslation()
  if (!status) return <Badge variant="outline">{t('automationsPage.statuses.UNKNOWN')}</Badge>
  const label = statusText(t, status)
  switch (status) {
    case 'SUCCEEDED':
      return <Badge variant="success">{label}</Badge>
    case 'FAILED':
      return <Badge variant="destructive">{label}</Badge>
    case 'RUNNING':
    case 'PENDING':
      return <Badge variant="warning">{label}</Badge>
    default:
      return <Badge variant="secondary">{label}</Badge>
  }
}
