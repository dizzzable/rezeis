/**
 * «Кабинет не принял часть оформления» — the owner's rule of 24.09.2026:
 * «всё новое применяется, кроме него, и панель пишет, что не принято».
 *
 * The cabinet judges each field of the appearance alone. A field it refuses
 * keeps the value customers saw before the save, everything else goes live,
 * and the cabinet reports which fields it kept (once per version). This card
 * shows that report — only while it belongs to the version the panel serves
 * NOW (`GET /admin/settings/branding/delivery`), so a fixed value clears it and
 * an old report never comes back. A cabinet older than this release reports
 * nothing, and then nothing shows.
 *
 * The cabinet answers about a second after the save's webhook, or within 20–40
 * seconds by its own poll, so after each save the page asks again a few times;
 * and on open.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'

import api from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import {
  BRANDING_DELIVERY_FIELD_LABELS,
  BRANDING_DELIVERY_QUERY_KEY,
  DELIVERY_RECHECKS_AFTER_SAVE_MS,
  brandingDeliveryFieldOf,
  brandingDeliveryReasonText,
  brandingFormFieldOf,
  readBrandingDeliveryNotice,
} from './branding-delivery-fields'

async function fetchBrandingDelivery(): Promise<unknown> {
  const { data } = await api.get<unknown>('/admin/settings/branding/delivery')
  return data
}

export function BrandingDeliveryNotice({
  savedAt,
  tabLabelOf,
  onOpenField,
}: {
  /** When the last save succeeded; each new value starts the re-checks again. */
  readonly savedAt: number | null
  /** The label of the tab a form field is on (`tabForBrandingField` on the page). */
  readonly tabLabelOf: (formField: string) => string
  /** Take the operator to that field's tab. */
  readonly onOpenField: (formField: string) => void
}) {
  const { t } = useTranslation()
  const { data, refetch } = useQuery({
    queryKey: BRANDING_DELIVERY_QUERY_KEY,
    queryFn: fetchBrandingDelivery,
    staleTime: 0,
    retry: false,
  })

  useEffect(() => {
    if (savedAt === null) return
    const timers = DELIVERY_RECHECKS_AFTER_SAVE_MS.map((delay) =>
      window.setTimeout(() => {
        void refetch()
      }, delay),
    )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [savedAt, refetch])

  const rejected = readBrandingDeliveryNotice(data)
  if (rejected.length === 0) return null

  return (
    <Alert
      className="border-amber-500/40 bg-amber-500/10 [&>svg]:text-amber-500"
      data-testid="branding-delivery-notice"
    >
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>{t('brandingPage.deliveryNotice.title')}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t('brandingPage.deliveryNotice.body')}</p>
        <ul className="space-y-2">
          {rejected.map((entry) => {
            const field = brandingDeliveryFieldOf(entry.path)
            const label = BRANDING_DELIVERY_FIELD_LABELS[field]
            const formField = label?.onPage === true ? brandingFormFieldOf(field) : null
            const reason = brandingDeliveryReasonText(entry.reason)
            return (
              <li
                key={`${entry.path}|${entry.reason}`}
                className="rounded-md border border-amber-500/20 bg-background/60 p-3"
                data-testid="branding-delivery-field"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {label === undefined ? <code>{entry.path}</code> : t(label.labelKey)}
                  </span>
                  {formField !== null && (
                    <Button type="button" variant="outline" size="sm" onClick={() => onOpenField(formField)}>
                      {t('brandingPage.deliveryNotice.openTab', { tab: tabLabelOf(formField) })}
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-muted-foreground">{t(reason.key, reason.values ?? {})}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {t('brandingPage.deliveryNotice.sent')} <code>{entry.value}</code>
                </p>
              </li>
            )
          })}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
