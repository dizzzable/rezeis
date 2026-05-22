import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
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

export function DashboardQuickActions(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const actions = [
    {
      label: t('dashboardPage.quickActions.createBroadcast'),
      icon: Send,
      path: '/broadcast',
    },
    {
      label: t('dashboardPage.quickActions.viewPayments'),
      icon: CreditCard,
      path: '/payments',
    },
    {
      label: t('dashboardPage.quickActions.manageUsers'),
      icon: Users,
      path: '/users',
    },
    {
      label: t('dashboardPage.quickActions.importUsers'),
      icon: Upload,
      path: '/settings',
    },
    {
      label: t('dashboardPage.quickActions.analytics'),
      icon: BarChart3,
      path: '/analytics',
    },
    {
      label: t('dashboardPage.quickActions.settings'),
      icon: Settings,
      path: '/settings',
    },
  ]

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
            <Button
              key={action.path + action.label}
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => navigate(action.path)}
              aria-label={action.label}
            >
              <action.icon className="h-4 w-4" />
              {action.label}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
