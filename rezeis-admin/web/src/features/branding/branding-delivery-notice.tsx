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
import { usePlans, type Plan } from '@/features/plans/plans-api'

import {
  BRANDING_DELIVERY_FIELD_LABELS,
  BRANDING_DELIVERY_QUERY_KEY,
  DELIVERY_RECHECKS_AFTER_SAVE_MS,
  brandingDeliveryEntryIdOf,
  brandingDeliveryEntryOf,
  brandingDeliveryEntryReasonText,
  brandingDeliveryFieldOf,
  brandingDeliveryReasonText,
  brandingFormFieldOf,
  readBrandingDeliveryNotice,
  type BrandingDeliveryEntry,
} from './branding-delivery-fields'
import { BRANDING_NAV_DESTINATIONS } from './branding-form-schema'
import { DASHBOARD_ICONS } from './dashboard-icons-section'

async function fetchBrandingDelivery(): Promise<unknown> {
  const { data } = await api.get<unknown>('/admin/settings/branding/delivery')
  return data
}

type Translate = (key: string, values?: Record<string, unknown>) => string

/**
 * The refused entry itself, in words: the plan by its name (by its id when the
 * plan list no longer has it), the dashboard icon and the menu section by the
 * names this page gives them, a custom icon by its id, a card by its place.
 * A key or an id this page does not know is shown as it is — never looked up
 * as a translation key (a refused entry's key is often exactly the wrong one).
 */
function entryName(t: Translate, entry: BrandingDeliveryEntry, value: string, plans: readonly Plan[] | undefined): string {
  switch (entry.kind) {
    case 'plan': {
      const plan = plans?.find((candidate) => candidate.id === entry.planId)
      return plan === undefined
        ? t('brandingPage.deliveryNotice.entries.planById', { id: entry.planId })
        : t('brandingPage.deliveryNotice.entries.plan', { name: plan.name })
    }
    case 'icon': {
      const known = DASHBOARD_ICONS.some((icon) => icon.key === entry.iconKey)
      const name = known ? t(`brandingPage.sections.dashboardIcons.icons.${entry.iconKey}`) : entry.iconKey
      return t('brandingPage.deliveryNotice.entries.icon', { name })
    }
    case 'customIcon': {
      const id = brandingDeliveryEntryIdOf(value)
      return id === null
        ? t('brandingPage.deliveryNotice.entries.customIconAt', { position: entry.position })
        : t('brandingPage.deliveryNotice.entries.customIcon', { id })
    }
    case 'cardSlot':
      return t('brandingPage.deliveryNotice.entries.cardSlot', { position: entry.position })
    case 'navItem': {
      const id = brandingDeliveryEntryIdOf(value)
      return id !== null && (BRANDING_NAV_DESTINATIONS as readonly string[]).includes(id)
        ? t('brandingPage.deliveryNotice.entries.navItem', {
            position: entry.position,
            name: t(`brandingPage.sections.nav.dest.${id}`),
          })
        : t('brandingPage.deliveryNotice.entries.navItemAt', { position: entry.position })
    }
  }
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
  // The plans' names, only when a plan's card style is among the refused: the
  // plan-cards section's own query and cache, never asked for anything else.
  const hasPlanEntry = rejected.some((entry) => brandingDeliveryEntryOf(entry.path)?.kind === 'plan')
  const { data: plans } = usePlans(undefined, { enabled: hasPlanEntry })
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
            // One entry of a field taken entry by entry: named itself, and why
            // in words about it — not the whole field's.
            const one = brandingDeliveryEntryOf(entry.path)
            const reason = one === null ? brandingDeliveryReasonText(entry.reason) : brandingDeliveryEntryReasonText(entry.reason)
            const title =
              label === undefined
                ? null
                : one === null
                  ? t(label.labelKey)
                  : `${t(label.labelKey)} — ${entryName(t, one, entry.value, plans)}`
            return (
              <li
                key={`${entry.path}|${entry.reason}`}
                className="rounded-md border border-amber-500/20 bg-background/60 p-3"
                data-testid="branding-delivery-field"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{title === null ? <code>{entry.path}</code> : title}</span>
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
