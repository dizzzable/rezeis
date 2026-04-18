import type { ReactElement } from 'react'
import { usePlansQuery } from '@/features/plans/use-plans-query'
import { getApiErrorMessage } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'

export function PlansPage(): ReactElement {
  const plansQuery = usePlansQuery()
  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">Plans</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Available subscription plans loaded through the user API. This route remains a read-only plan catalog while rules acceptance stays the shell's only live write path.
        </p>
      </section>
      {plansQuery.error ? <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(plansQuery.error)}</p> : null}
      {plansQuery.isPending ? <p className="text-sm text-muted-foreground">Loading plans...</p> : null}
      <section className="grid gap-4 xl:grid-cols-2">
        {plansQuery.data?.map((plan) => (
          <article key={plan.id} className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-2xl font-semibold tracking-tight">{plan.name}</h2>
                  {plan.tag ? <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{plan.tag}</span> : null}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{plan.description ?? 'No public description provided.'}</p>
              </div>
              <div className="rounded-2xl bg-secondary/50 px-4 py-3 text-right">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Plan type</p>
                <p className="mt-1 text-sm font-medium">{plan.type}</p>
              </div>
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2">
              <PlanFact label="Traffic limit" value={formatTrafficLimit(plan.trafficLimit)} />
              <PlanFact label="Device limit" value={String(plan.deviceLimit)} />
            </dl>
            <div className="mt-5 space-y-3">
              <p className="text-sm font-medium text-muted-foreground">Durations and prices</p>
              {plan.durations.map((duration) => (
                <div key={duration.id} className="rounded-2xl border border-border/70 bg-background/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">{duration.days} days</p>
                    <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{duration.prices.length} prices</p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {duration.prices.map((price) => (
                      <span key={`${duration.id}-${price.currency}`} className="rounded-full bg-secondary px-3 py-1 text-sm font-medium text-secondary-foreground">
                        {price.currency} {price.price}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}

function PlanFact({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="rounded-2xl bg-secondary/50 px-4 py-3">
      <dt className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{value}</dd>
    </div>
  )
}

function formatTrafficLimit(trafficLimit: number | null): string {
  if (trafficLimit === null) {
    return 'Unlimited'
  }
  return formatBytes(trafficLimit)
}
