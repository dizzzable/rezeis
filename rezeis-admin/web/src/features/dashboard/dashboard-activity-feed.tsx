import { type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Rss } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

import { dashboardApi, type ActivityFeedItem } from './dashboard-api'

const EVENT_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  'user.created': 'secondary',
  'user.updated': 'outline',
  'user.deleted': 'destructive',
  'user.limited': 'default',
  'user.expired': 'default',
  'node.offline': 'destructive',
  'node.online': 'secondary',
  'node.created': 'outline',
}

export function DashboardActivityFeed(): JSX.Element {
  const { t } = useTranslation()

  const { data: events, isLoading } = useQuery({
    queryKey: ['admin', 'remnawave', 'activity-feed'],
    queryFn: () => dashboardApi.getActivityFeed(20),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rss className="h-4 w-4" />
            {t('dashboardPage.activityFeed.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rss className="h-4 w-4" />
          {t('dashboardPage.activityFeed.title')}
        </CardTitle>
        <CardDescription>{t('dashboardPage.activityFeed.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {!events || events.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t('dashboardPage.activityFeed.empty')}
          </p>
        ) : (
          <ul className="space-y-2 max-h-80 overflow-y-auto">
            {events.map((event: ActivityFeedItem) => (
              <li key={event.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant={EVENT_BADGE_VARIANT[event.eventType] ?? 'outline'} className="text-[10px] shrink-0">
                    {event.eventType}
                  </Badge>
                  <span className="text-xs text-muted-foreground truncate">
                    {extractEventLabel(event)}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                  {new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function extractEventLabel(event: ActivityFeedItem): string {
  const p = event.payload
  if (typeof p['username'] === 'string') return p['username']
  if (typeof p['name'] === 'string') return p['name']
  if (typeof p['uuid'] === 'string') return (p['uuid'] as string).slice(0, 8) + '…'
  return event.eventType
}
