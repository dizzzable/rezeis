import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface PlaceholderPageProps {
  readonly badge: string
  readonly title: string
  readonly summary: string
  readonly filtersTitle: string
  readonly filters: readonly string[]
  readonly tableTitle: string
  readonly columns: readonly string[]
  readonly emptyTitle: string
  readonly emptyDescription: string
}

export function PlaceholderPage({
  badge,
  title,
  summary,
  filtersTitle,
  filters,
  tableTitle,
  columns,
  emptyTitle,
  emptyDescription,
}: PlaceholderPageProps): JSX.Element {
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden bg-[linear-gradient(135deg,oklch(0.995_0.004_84.6)_0%,oklch(0.938_0.03_206.87/0.68)_100%)]">
        <CardHeader className="gap-4">
          <Badge className="w-fit">{badge}</Badge>
          <div>
            <CardTitle className="text-2xl">{title}</CardTitle>
            <CardDescription className="mt-2 max-w-3xl">{summary}</CardDescription>
          </div>
        </CardHeader>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.36fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{filtersTitle}</CardTitle>
            <CardDescription>{summary}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {filters.map((filter: string) => (
              <div key={filter} className="rounded-2xl border border-dashed border-border/80 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
                {filter}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{tableTitle}</CardTitle>
            <CardDescription>{summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 rounded-2xl border border-border/70 bg-background/60 p-4 md:grid-cols-4">
              {columns.map((column: string) => (
                <div key={column} className="rounded-xl bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm">
                  {column}
                </div>
              ))}
            </div>
            <div className="rounded-3xl border border-dashed border-border/80 bg-background/80 px-6 py-12 text-center">
              <p className="text-base font-semibold">{emptyTitle}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{emptyDescription}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
