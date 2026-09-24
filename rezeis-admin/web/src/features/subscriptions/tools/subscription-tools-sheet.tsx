/**
 * «Подписки» → «Инструменты»: the header button and the sheet it opens.
 * ─────────────────────────────────────────────────────────────────────
 * Five tools that act on many subscriptions at once, gathered behind one
 * button instead of stacked as cards above the subscription list:
 *
 *   «Слияние подписок-дубликатов»                `subscriptions:edit`
 *   «Подписки на сквадах, которых нет в панели»  `plans:view`
 *   «Подписки без привязки к Remnawave»          `subscriptions:edit`
 *   «Лишние профили в Remnawave»                 `subscriptions:edit`
 *   «Бессрочные подписки с датой»                `subscriptions:edit`
 *
 * THE ADDRESS IS THE STATE. The sheet is open exactly while the page address
 * carries `?tools=<tab>`, and shows that tab. That is what lets another screen
 * send the operator straight to a tab — the user card's delete refusal links
 * to `/subscriptions?tools=unlinked` — and what makes the browser's Back button
 * close the sheet. Nothing is copied from the address into component state, so
 * the two cannot disagree: opening writes the parameter, switching tabs
 * rewrites it, closing removes it. `subscription-tools.ts` decides which tab a
 * value opens, including the ones it must not.
 *
 * Each tab keeps its own permission, and the tab components check it again
 * themselves: the sheet hides what the admin may not open, and a component
 * rendered by any other route still renders nothing without it.
 */
import { useCallback, useMemo, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Wrench } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { holdsPermission, usePermissionStore } from '@/features/rbac/use-permission-store'
import { DuplicateSubscriptionMergePanel } from '../duplicate-subscription-merge-panel'
import { UnknownSquadPanel } from '../unknown-squad-panel'
import { ExtraProfilesTab } from './extra-profiles-tab'
import { LifetimeRestoreTab } from './lifetime-restore-tab'
import {
  allowedToolTabs,
  resolveToolTab,
  SUBSCRIPTION_TOOLS_PARAM,
  type SubscriptionToolTab,
} from './subscription-tools'
import { UnlinkedSubscriptionsTab } from './unlinked-subscriptions-tab'

export function SubscriptionTools(): JSX.Element | null {
  const { t } = useTranslation()
  // The grants themselves, not the store's stable `hasPermission`: selecting
  // that function would never re-render when the grants arrive or change.
  const role = usePermissionStore((state) => state.role)
  const granted = usePermissionStore((state) => state.granted)
  const allowed = useMemo(
    () => allowedToolTabs((resource, action) => holdsPermission({ role, granted }, resource, action)),
    [role, granted],
  )

  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get(SUBSCRIPTION_TOOLS_PARAM)
  const active = resolveToolTab(requested, allowed)
  const open = requested !== null && active !== null

  /**
   * Writes the tab into the address, or removes it. Only this parameter is
   * touched — anything else on the address stays. Opening PUSHES, so Back
   * closes the sheet; switching tabs and closing REPLACE, so the history is not
   * a list of every tab the operator looked at.
   */
  const showTab = useCallback(
    (tab: SubscriptionToolTab | null, mode: 'push' | 'replace') => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          if (tab === null) next.delete(SUBSCRIPTION_TOOLS_PARAM)
          else next.set(SUBSCRIPTION_TOOLS_PARAM, tab)
          return next
        },
        { replace: mode === 'replace' },
      )
    },
    [setSearchParams],
  )

  // No tab this admin may open → no button: a sheet with nothing in it is a
  // dead end, and a tab that 403s reads as a broken tool.
  const first = allowed[0]
  if (first === undefined) return null

  return (
    <>
      <Button variant="outline" className="gap-2" onClick={() => showTab(first, 'push')}>
        <Wrench className="h-4 w-4" aria-hidden="true" />
        {t('subscriptionTools.button')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) showTab(null, 'replace')
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-5xl">
          <SheetHeader className="border-b px-6 pb-4 pt-6 pr-12">
            <SheetTitle>{t('subscriptionTools.sheet.title')}</SheetTitle>
            <SheetDescription>{t('subscriptionTools.sheet.description')}</SheetDescription>
          </SheetHeader>
          {active === null ? null : (
            <Tabs
              value={active}
              onValueChange={(value) => showTab(resolveToolTab(value, allowed), 'replace')}
              className="flex flex-1 flex-col"
            >
              <TabsList className="min-h-10 flex-wrap justify-start gap-1 rounded-none border-b bg-transparent px-6 py-2">
                {allowed.map((tab) => (
                  <TabsTrigger key={tab} value={tab} className="whitespace-normal text-left">
                    {t(`subscriptionTools.tabs.${tab}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="p-6">
                {allowed.map((tab) => (
                  <TabsContent key={tab} value={tab} className="m-0">
                    <ToolTab tab={tab} onOpenMerge={() => showTab('merge', 'replace')} />
                  </TabsContent>
                ))}
              </div>
            </Tabs>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}

function ToolTab({
  tab,
  onOpenMerge,
}: {
  readonly tab: SubscriptionToolTab
  readonly onOpenMerge: () => void
}): JSX.Element {
  switch (tab) {
    case 'merge':
      return <DuplicateSubscriptionMergePanel />
    case 'squads':
      return <UnknownSquadPanel />
    case 'unlinked':
      return <UnlinkedSubscriptionsTab onOpenMerge={onOpenMerge} />
    case 'extraProfiles':
      return <ExtraProfilesTab />
    case 'lifetime':
      return <LifetimeRestoreTab />
  }
}
