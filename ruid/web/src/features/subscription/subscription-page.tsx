import type { ReactElement } from 'react'
import { AuthRequiredState } from '@/features/auth/auth-required-state'
import { useAuthSession } from '@/features/auth/auth-provider'
import { getSubscriptionDiagnostics } from '@/features/subscription/get-subscription-diagnostics'
import { useSubscriptionQuery } from '@/features/subscription/use-subscription-query'
import { getWebAccountLogin } from '@/features/web-account/get-web-account-visibility-state'
import { getApiErrorMessage, isApiUnauthorizedError } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'

export function SubscriptionPage(): ReactElement {
  const authSession = useAuthSession()
  const subscriptionQuery = useSubscriptionQuery({ enabled: authSession.status === 'authenticated' })
  const visibleError: unknown = getVisibleSubscriptionError({ authStatus: authSession.status, error: authSession.status === 'error' ? authSession.bootstrapError ?? subscriptionQuery.error : subscriptionQuery.error })
  const currentSubscription = authSession.status === 'authenticated' ? subscriptionQuery.data ?? null : null
  const diagnostics = currentSubscription ? getSubscriptionDiagnostics(currentSubscription) : null
  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">Subscription</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Current subscription status for the authenticated Telegram or cookie-backed session. This route remains a read-only surface; rules acceptance is the shell's only live write path.
        </p>
        <p className="mt-4 text-sm font-medium text-primary">{getSubscriptionContextLabel(authSession)}</p>
        <p className="mt-2 text-sm text-muted-foreground">URL identity parameters are no longer used on this route.</p>
      </section>
      {visibleError ? <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(visibleError)}</p> : null}
      {authSession.status === 'authentication-required' ? <AuthRequiredState /> : null}
      {authSession.status === 'loading' ? <p className="text-sm text-muted-foreground">Loading subscription...</p> : null}
      {authSession.status === 'authenticated' && subscriptionQuery.isPending ? <p className="text-sm text-muted-foreground">Loading subscription details...</p> : null}
      {authSession.status === 'authenticated' && subscriptionQuery.data === null ? <EmptyState message="This user does not have a current subscription." /> : null}
      {currentSubscription ? (
        <div className="space-y-4">
          <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
            <p className="text-sm font-medium text-primary">Subscription diagnostics</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">{diagnostics?.stateLabel ?? 'Subscription state unavailable'}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{diagnostics?.stateDescription}</p>
            <p className="mt-4 text-sm font-medium text-foreground">{diagnostics?.entitlementSummary}</p>
            <p className="mt-1 text-sm text-muted-foreground">{diagnostics?.entitlementDescription}</p>
          </article>
          <section className="grid gap-4 xl:grid-cols-4">
            <DiagnosticCard title="Current state" label={diagnostics?.stateLabel ?? 'Unknown'} description={diagnostics?.stateDescription ?? 'State diagnostics are unavailable.'} />
            <DiagnosticCard title="Timing" label={diagnostics?.timingLabel ?? 'Unknown'} description={diagnostics?.timingDescription ?? 'Timing diagnostics are unavailable.'} />
            <DiagnosticCard title="Trial" label={diagnostics?.trialLabel ?? 'Unknown'} description={diagnostics?.trialDescription ?? 'Trial diagnostics are unavailable.'} />
            <DiagnosticCard title="Config URL" label={diagnostics?.configLabel ?? 'Unknown'} description={diagnostics?.configDescription ?? 'Config diagnostics are unavailable.'} href={diagnostics?.safeConfigUrl ?? null} />
          </section>
          <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
              <h2 className="text-xl font-semibold tracking-tight">Subscription details</h2>
              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <SubscriptionFact label="Status" value={currentSubscription.status} />
                <SubscriptionFact label="Plan" value={currentSubscription.plan?.name ?? 'Unknown plan'} />
                <SubscriptionFact label="Type" value={currentSubscription.plan?.type ?? 'Unknown type'} />
                <SubscriptionFact label="Trial" value={currentSubscription.isTrial ? 'Yes' : 'No'} />
                <SubscriptionFact label="Traffic limit" value={formatTrafficLimit(currentSubscription.trafficLimit)} />
                <SubscriptionFact label="Device limit" value={String(currentSubscription.deviceLimit)} />
              </dl>
            </article>
            <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
              <h2 className="text-xl font-semibold tracking-tight">Lifecycle</h2>
              <dl className="mt-5 grid gap-3">
                <SubscriptionFact label="Started" value={formatDate(currentSubscription.startedAt)} />
                <SubscriptionFact label="Expires" value={formatDate(currentSubscription.expiresAt)} />
                <SubscriptionFact label="Created" value={formatDate(currentSubscription.createdAt)} />
                <SubscriptionFact label="Updated" value={formatDate(currentSubscription.updatedAt)} />
                <SubscriptionFact label="Config URL" value={diagnostics?.safeConfigUrl ?? 'Not available'} />
              </dl>
            </article>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function DiagnosticCard({
  title,
  label,
  description,
  href = null,
}: {
  readonly title: string
  readonly label: string
  readonly description: string
  readonly href?: string | null
}): ReactElement {
  return (
    <article className="rounded-3xl border border-border/70 bg-card/95 p-5 shadow-sm">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
      <p className="mt-3 text-lg font-semibold text-foreground">{label}</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      {href ? (
        <a className="mt-3 inline-block break-all text-sm font-medium text-primary underline-offset-4 hover:underline" href={href} target="_blank" rel="noreferrer">
          {href}
        </a>
      ) : null}
    </article>
  )
}

function SubscriptionFact({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="rounded-2xl bg-secondary/50 px-4 py-3">
      <dt className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm font-medium text-foreground">{value}</dd>
    </div>
  )
}

function EmptyState({ message }: { readonly message: string }): ReactElement {
  return <p className="rounded-2xl border border-dashed border-border/80 bg-background/70 px-4 py-6 text-sm text-muted-foreground">{message}</p>
}

function formatTrafficLimit(trafficLimit: number | null): string {
  if (trafficLimit === null) {
    return 'Unlimited'
  }
  return formatBytes(trafficLimit)
}

function formatDate(value: string | null): string {
  if (!value) {
    return 'Not set'
  }
  const parsedDate: Date = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) {
    return 'Invalid timestamp'
  }
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsedDate)
}

function getSubscriptionContextLabel(authSession: ReturnType<typeof useAuthSession>): string {
  if (authSession.status === 'authenticated' && authSession.sessionQuery.data) {
    return getWebAccountLogin(authSession.sessionQuery.data.webAccount) ?? authSession.sessionQuery.data.username ?? authSession.sessionQuery.data.email ?? authSession.sessionQuery.data.id
  }
  if (authSession.status === 'loading') {
    return 'Bootstrapping authenticated session'
  }
  if (authSession.status === 'error') {
    return 'Session bootstrap error'
  }
  return 'Authentication required'
}

function getVisibleSubscriptionError({
  authStatus,
  error,
}: {
  readonly authStatus: ReturnType<typeof useAuthSession>['status']
  readonly error: unknown
}): unknown {
  if (authStatus === 'authentication-required' && isApiUnauthorizedError(error)) {
    return null
  }
  return error
}
