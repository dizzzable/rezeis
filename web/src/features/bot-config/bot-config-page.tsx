import { lazy, Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

const BotFlowPage = lazy(() => import('@/features/bot-flow/bot-flow-page'))

export default function BotConfigPage() {
  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-background">
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        <BotFlowPage />
      </Suspense>
    </div>
  )
}
