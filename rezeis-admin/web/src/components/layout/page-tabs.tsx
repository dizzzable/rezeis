import type { JSX } from 'react'
import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

function isItemActive(currentLocation: string, pathname: string, item: PageTabItem): boolean {
  if (item.to.includes('?')) {
    return currentLocation === item.to
  }

  if (item.end) {
    return pathname === item.to
  }

  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

export interface PageTabItem {
  readonly to: string
  readonly label: string
  readonly end?: boolean
}

interface PageTabsProps {
  readonly items: readonly PageTabItem[]
}

export function PageTabs({ items }: PageTabsProps): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const currentLocation: string = `${location.pathname}${location.search}`
  const activeItem: PageTabItem = useMemo((): PageTabItem => {
    return items.find((item: PageTabItem) => isItemActive(currentLocation, location.pathname, item)) ?? items[0]
  }, [currentLocation, items, location.pathname])

  function handleValueChange(nextValue: string): void {
    if (!nextValue || nextValue === activeItem?.to) {
      return
    }

    navigate(nextValue)
  }

  return (
    <Tabs value={activeItem?.to} onValueChange={handleValueChange} className="overflow-x-auto rounded-[24px] border border-border/80 bg-card/90 p-2 shadow-sm backdrop-blur">
      <TabsList variant="line" className="flex min-w-max gap-2 bg-transparent p-0">
        {items.map((item: PageTabItem) => {
          return (
            <TabsTrigger
              key={item.to}
              value={item.to}
              className="min-w-max rounded-2xl px-4 py-2.5 text-sm font-medium text-muted-foreground after:hidden data-[state=active]:bg-accent data-[state=active]:text-accent-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-accent"
            >
              {item.label}
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
