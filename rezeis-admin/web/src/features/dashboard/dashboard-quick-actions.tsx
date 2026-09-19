import { type ComponentType, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  Send,
  Upload,
  CreditCard,
  Users,
  Settings,
  BarChart3,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { HoverEffect } from '@/components/effects/HoverEffect'
import { canShowNavItem, type NavItem, navItemMap } from '@/components/layout/admin-nav-config'
import { holdsPermission, usePermissionStore } from '@/features/rbac/use-permission-store'

/**
 * Each button is a side-menu item: `nav` names it in `admin-nav-config.ts`, and
 * the button takes its PATH and its PERMISSION from there — so a button can
 * neither lead somewhere the menu does not, nor show to an operator the menu
 * hides the page from. «Аналитика» used to show to every role and open a page
 * of five «Не удалось загрузить данные» for anyone without `analytics:view`;
 * «Импорт» led to «Платформа» (`/settings`) instead of the imports page.
 */
const QUICK_ACTIONS: ReadonlyArray<{
  readonly label: string
  readonly nav: string
  readonly icon: ComponentType<{ className?: string }>
}> = [
  { label: 'createBroadcast', nav: 'broadcast', icon: Send },
  { label: 'viewPayments', nav: 'payments', icon: CreditCard },
  { label: 'manageUsers', nav: 'users', icon: Users },
  { label: 'importUsers', nav: 'imports', icon: Upload },
  { label: 'analytics', nav: 'analytics', icon: BarChart3 },
  { label: 'settings', nav: 'platform', icon: Settings },
]

export function DashboardQuickActions(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The grants themselves, not the store's stable `hasPermission`: a role
  // refreshed while the dashboard is open must redraw the row.
  const loaded = usePermissionStore((s) => s.loaded)
  const role = usePermissionStore((s) => s.role)
  const granted = usePermissionStore((s) => s.granted)

  const actions = QUICK_ACTIONS.flatMap((action) => {
    const item: NavItem | undefined = navItemMap.get(action.nav)
    if (item === undefined) return []
    const allowed = canShowNavItem(item, loaded, (resource, verb) => holdsPermission({ role, granted }, resource, verb))
    return allowed ? [{ ...action, path: item.path }] : []
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">
          {t('dashboardPage.quickActions.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            // Was a hard-coded `<GlareHover>`, which is why this row looked the
            // same under all three menu choices — and why the KPI tiles above
            // and these buttons could never match. Both now ask the store the
            // same question. Note the visible consequence: with the shipped
            // default (`spotlight`) these buttons glow rather than glint.
            <HoverEffect key={action.nav} className="rounded-md">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => navigate(action.path)}
                aria-label={t(`dashboardPage.quickActions.${action.label}`)}
              >
                <action.icon className="h-4 w-4" />
                {t(`dashboardPage.quickActions.${action.label}`)}
              </Button>
            </HoverEffect>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
