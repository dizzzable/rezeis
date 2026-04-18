import { useEffect, useMemo, type ReactElement, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowRight, CircleOff, CreditCard, ShieldCheck, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuthRequiredState } from '@/features/auth/auth-required-state'
import { useAuthSession } from '@/features/auth/auth-provider'
import { usePlansQuery } from '@/features/plans/use-plans-query'
import { platformPolicyApi } from '@/features/platform-policy/platform-policy-api'
import { usePlatformPolicyQuery } from '@/features/platform-policy/use-platform-policy-query'
import { sessionApi, type SessionWebAccountEmailVerificationChallenge } from '@/features/session/session-api'
import { useWebAccountEmailVerificationChallengeState } from '@/features/session/web-account-email-verification-challenge-state'
import { getSubscriptionDiagnostics } from '@/features/subscription/get-subscription-diagnostics'
import { subscriptionApi } from '@/features/subscription/subscription-api'
import { useSubscriptionQuery } from '@/features/subscription/use-subscription-query'
import { useTimeBoundary } from '@/features/time/use-time-boundary'
import { getSupportedEmailVerificationChallenge, getWebAccountEmailAddress, getWebAccountLogin, getWebAccountVisibilityState, reconcileSessionAfterEmailVerificationChallenge, shouldClearEmailVerificationChallengeForError } from '@/features/web-account/get-web-account-visibility-state'
import { getApiErrorMessage, isApiUnauthorizedError } from '@/lib/api'

interface MetricState {
  readonly value: string
  readonly detail: string
}

type SessionData = Awaited<ReturnType<typeof sessionApi.getSession>>

export function DashboardPage(): ReactElement {
  const authSession = useAuthSession()
  const queryClient = useQueryClient()
  const webAccountEmailVerificationChallengeState = useWebAccountEmailVerificationChallengeState()
  const sessionQuery = authSession.sessionQuery
  const plansQuery = usePlansQuery()
  const subscriptionQuery = useSubscriptionQuery({ enabled: authSession.status === 'authenticated' })
  const platformPolicyQuery = usePlatformPolicyQuery()
  const acceptRulesMutation = useMutation({
    mutationFn: () => sessionApi.acceptRules(),
    onSuccess: async (session): Promise<void> => {
      saveSessionQueryData({ queryClient, session })
    },
    onError: async (error: unknown): Promise<void> => {
      await handleUnauthorizedSessionMutationError({ error, queryClient })
    },
  })
  const snoozeWebAccountLinkPromptMutation = useMutation({
    mutationFn: () => sessionApi.snoozeWebAccountLinkPrompt(),
    onSuccess: async (session): Promise<void> => {
      saveSessionQueryData({ queryClient, session })
    },
    onError: async (error: unknown): Promise<void> => {
      await handleUnauthorizedSessionMutationError({ error, queryClient })
    },
  })
  const issueWebAccountEmailVerificationChallengeMutation = useMutation({
    mutationFn: () => sessionApi.issueWebAccountEmailVerificationChallenge(),
    onSuccess: async (challenge): Promise<void> => {
      queryClient.setQueryData<SessionData | undefined>(['session'], (currentSession: SessionData | undefined) => reconcileSessionAfterEmailVerificationChallenge({
        session: currentSession,
        challenge,
      }))
      webAccountEmailVerificationChallengeState.saveChallenge(challenge)
    },
    onError: async (error: unknown): Promise<void> => {
      if (shouldClearEmailVerificationChallengeForError(error)) {
        webAccountEmailVerificationChallengeState.saveChallenge(null)
      }
      await handleUnauthorizedSessionMutationError({ error, queryClient })
    },
  })
  const now: number = useTimeBoundary([
    webAccountEmailVerificationChallengeState.challenge?.challengeExpiresAt,
    sessionQuery.data?.webAccount?.linkPromptSnoozeUntil,
  ])
  const supportedChallenge = useMemo(() => getSupportedEmailVerificationChallenge({
    authStatus: authSession.status,
    webAccount: sessionQuery.data?.webAccount ?? null,
    challenge: webAccountEmailVerificationChallengeState.challenge,
    now,
  }), [authSession.status, now, sessionQuery.data?.webAccount, webAccountEmailVerificationChallengeState.challenge])
  useEffect(() => {
    if (webAccountEmailVerificationChallengeState.challenge === supportedChallenge) {
      return
    }
    webAccountEmailVerificationChallengeState.saveChallenge(supportedChallenge)
  }, [supportedChallenge, webAccountEmailVerificationChallengeState.challenge, webAccountEmailVerificationChallengeState.saveChallenge])
  const webAccountVisibilityState = useMemo(() => getWebAccountVisibilityState({
    webAccount: sessionQuery.data?.webAccount ?? null,
    challenge: supportedChallenge,
    now,
  }), [now, sessionQuery.data?.webAccount, supportedChallenge])
  const sessionCard = getSessionCardState({ authStatus: authSession.status, sessionQuery })
  const subscriptionCard = getSubscriptionCardState({ authStatus: authSession.status, subscriptionQuery })
  const rulesCard = getRulesCardState({ authStatus: authSession.status, sessionQuery })
  const plansCard = getPlansCardState({ plansQuery })
  const shouldShowRulesAcceptanceCta: boolean = authSession.status === 'authenticated' && platformPolicyQuery.data?.rulesRequired === true && sessionQuery.data?.isRulesAccepted === false
  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
          <p className="text-sm font-medium text-primary">User shell</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">RUID now ships the first user-facing shell slice.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
            This shell reads account, plan, subscription, and platform-policy data from `/api/v1`. Five narrow write paths are now live: rules acceptance, linked web-account login and password handoff, web-account readiness snooze, linked email-verification challenge issuance, and linked email-verification completion. The dedicated plans and subscription routes remain the primary read surfaces, while this dashboard also shows compact summaries and diagnostics from those same read models.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/plans">
                Browse plans
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/subscription">View subscription</Link>
            </Button>
          </div>
        </article>
        <article className="rounded-3xl border border-border/70 bg-background/85 p-6 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">Current auth</p>
          <p className="mt-3 text-lg font-semibold">{getAuthHeadline(authSession)}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{getAuthDescription(authSession)}</p>
        </article>
      </section>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<UserRound className="size-4 text-primary" />} label="Session" value={sessionCard.value} detail={sessionCard.detail} />
        <MetricCard icon={<CreditCard className="size-4 text-primary" />} label="Subscription" value={subscriptionCard.value} detail={subscriptionCard.detail} />
        <MetricCard icon={<ShieldCheck className="size-4 text-primary" />} label="Rules acceptance" value={rulesCard.value} detail={rulesCard.detail} />
        <MetricCard icon={<CircleOff className="size-4 text-primary" />} label="Plans" value={plansCard.value} detail={plansCard.detail} />
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <QueryPanel
          title="Session snapshot"
          description="Current account context returned by the user edge."
          error={getVisiblePanelError({ authStatus: authSession.status, error: authSession.status === 'error' ? authSession.bootstrapError ?? sessionQuery.error : sessionQuery.error })}
          isPending={authSession.status === 'loading'}
        >
          {authSession.status === 'authentication-required'
            ? <AuthRequiredState />
            : authSession.status === 'error'
              ? null
              : <SessionDetails query={sessionQuery.data} rulesAcceptanceCta={shouldShowRulesAcceptanceCta ? {
                isPending: acceptRulesMutation.isPending,
                error: acceptRulesMutation.error,
                rulesHref: getSafeExternalHref(platformPolicyQuery.data?.rulesLink ?? null),
                onAccept: () => acceptRulesMutation.mutate(),
              } : null} webAccountReadinessCta={getWebAccountReadinessCta({
                authStatus: authSession.status,
                session: sessionQuery.data,
                isVisible: webAccountVisibilityState.isReadinessPromptVisible,
                isPending: snoozeWebAccountLinkPromptMutation.isPending,
                error: snoozeWebAccountLinkPromptMutation.error,
                onSnooze: () => snoozeWebAccountLinkPromptMutation.mutate(),
              })} webAccountEmailVerificationCta={getWebAccountEmailVerificationCta({
                authStatus: authSession.status,
                session: sessionQuery.data,
                canIssue: webAccountVisibilityState.canIssueEmailVerification,
                challenge: webAccountVisibilityState.visibleEmailVerificationChallenge,
                isPending: issueWebAccountEmailVerificationChallengeMutation.isPending,
                error: issueWebAccountEmailVerificationChallengeMutation.error,
                onIssue: () => issueWebAccountEmailVerificationChallengeMutation.mutate(),
              })} />}
        </QueryPanel>
        <QueryPanel
          title="Current subscription"
          description="Read-only subscription state returned by the user API."
          error={getVisiblePanelError({ authStatus: authSession.status, error: authSession.status === 'error' ? authSession.bootstrapError ?? subscriptionQuery.error : subscriptionQuery.error })}
          isPending={authSession.status === 'loading' || (authSession.status === 'authenticated' && subscriptionQuery.isPending)}
        >
          {authSession.status === 'authentication-required'
            ? <AuthRequiredState />
            : authSession.status === 'error'
              ? null
              : <SubscriptionDetails query={subscriptionQuery.data} />}
        </QueryPanel>
        <QueryPanel
          title="Platform policy"
          description="Admin-owned rules, channel, access, and currency defaults exposed to the user shell."
          error={platformPolicyQuery.error}
          isPending={platformPolicyQuery.isPending}
        >
          <PlatformPolicyDetails query={platformPolicyQuery.data} />
        </QueryPanel>
      </section>
    </div>
  )
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly value: string
  readonly detail: string
}): ReactElement {
  return (
    <article className="rounded-2xl border border-border/70 bg-card/95 p-5 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-4 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
    </article>
  )
}

function QueryPanel({
  title,
  description,
  error,
  isPending,
  children,
}: {
  readonly title: string
  readonly description: string
  readonly error: unknown
  readonly isPending: boolean
  readonly children: ReactNode
}): ReactElement {
  return (
    <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {error ? <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(error)}</p> : null}
      {isPending ? <p className="mt-4 text-sm text-muted-foreground">Loading...</p> : <div className="mt-4">{children}</div>}
    </article>
  )
}

function SessionDetails({
  query,
  rulesAcceptanceCta,
  webAccountReadinessCta,
  webAccountEmailVerificationCta,
}: {
  readonly query: Awaited<ReturnType<typeof sessionApi.getSession>> | undefined
  readonly rulesAcceptanceCta: {
    readonly isPending: boolean
    readonly error: unknown
    readonly rulesHref: string | null
    readonly onAccept: () => void
  } | null
  readonly webAccountReadinessCta: {
    readonly isPending: boolean
    readonly error: unknown
    readonly onSnooze: () => void
  } | null
  readonly webAccountEmailVerificationCta: {
    readonly emailAddress: string
    readonly challenge: SessionWebAccountEmailVerificationChallenge | null
    readonly isPending: boolean
    readonly error: unknown
    readonly onIssue: () => void
  } | null
}): ReactElement {
  if (!query) {
    return <p className="text-sm text-muted-foreground">No session payload loaded yet.</p>
  }
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <DetailItem label="Name" value={query.name ?? 'Not set'} />
        <DetailItem label="Email" value={query.email ?? 'Not set'} />
        <DetailItem label="Language" value={query.language} />
        <DetailItem label="Role" value={query.role} />
        <DetailItem label="Points" value={String(query.points)} />
        <DetailItem label="Max subscriptions" value={String(query.maxSubscriptions)} />
      </dl>
      {rulesAcceptanceCta ? <RulesAcceptanceCta {...rulesAcceptanceCta} /> : null}
      <AccountReadinessDetails query={query} cta={webAccountReadinessCta} emailVerificationCta={webAccountEmailVerificationCta} />
    </div>
  )
}

function RulesAcceptanceCta({
  isPending,
  error,
  rulesHref,
  onAccept,
}: {
  readonly isPending: boolean
  readonly error: unknown
  readonly rulesHref: string | null
  readonly onAccept: () => void
}): ReactElement {
  return (
    <section className="rounded-2xl border border-border/70 bg-background/70 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Rules acceptance</p>
      <p className="mt-2 text-sm font-medium text-foreground">Rules acceptance is still required for this session.</p>
      <p className="mt-1 text-sm text-muted-foreground">Accept the current rules to update the session state in place.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button onClick={onAccept} disabled={isPending}>
          {isPending ? 'Accepting rules...' : 'Accept rules'}
        </Button>
        {rulesHref ? (
          <Button asChild variant="outline">
            <a href={rulesHref} target="_blank" rel="noreferrer">Read rules</a>
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(error)}</p> : null}
    </section>
  )
}

function AccountReadinessDetails({
  query,
  cta,
  emailVerificationCta,
}: {
  readonly query: Awaited<ReturnType<typeof sessionApi.getSession>>
  readonly cta: {
    readonly isPending: boolean
    readonly error: unknown
    readonly onSnooze: () => void
  } | null
  readonly emailVerificationCta: {
    readonly emailAddress: string
    readonly challenge: SessionWebAccountEmailVerificationChallenge | null
    readonly isPending: boolean
    readonly error: unknown
    readonly onIssue: () => void
  } | null
}): ReactElement {
  if (query.webAccount === null) {
    return (
      <section className="rounded-2xl border border-border/70 bg-background/70 p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Account readiness</p>
        <p className="mt-2 text-sm font-medium text-foreground">Web account not linked</p>
        <p className="mt-1 text-sm text-muted-foreground">
          No linked web account is present in the current session payload yet.
        </p>
      </section>
    )
  }
  const readinessLabel = getWebAccountReadinessLabel(query.webAccount)
  const readinessDescription = getWebAccountReadinessDescription(query.webAccount)
  const webAccountLogin: string | null = getWebAccountLogin(query.webAccount)
  const webAccountEmailAddress: string | null = getWebAccountEmailAddress(query.webAccount)
  return (
    <section className="rounded-2xl border border-border/70 bg-background/70 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Account readiness</p>
      <p className="mt-2 text-sm font-medium text-foreground">{readinessLabel}</p>
      <p className="mt-1 text-sm text-muted-foreground">{readinessDescription}</p>
       {cta ? <WebAccountReadinessCta {...cta} /> : null}
       {emailVerificationCta ? <WebAccountEmailVerificationCta {...emailVerificationCta} /> : null}
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <DetailItem label="Web account login" value={webAccountLogin ?? 'Not set'} />
        <DetailItem label="Linked email" value={webAccountEmailAddress ?? 'Not set'} />
        <DetailItem label="Email verified" value={formatDate(query.webAccount.emailVerifiedAt)} />
        <DetailItem label="Password change required" value={booleanLabel(query.webAccount.requiresPasswordChange)} />
        <DetailItem label="Link prompt snooze" value={formatDate(query.webAccount.linkPromptSnoozeUntil)} />
        <DetailItem label="Credentials bootstrapped" value={formatDate(query.webAccount.credentialsBootstrappedAt)} />
      </dl>
    </section>
  )
}

function WebAccountReadinessCta({
  isPending,
  error,
  onSnooze,
}: {
  readonly isPending: boolean
  readonly error: unknown
  readonly onSnooze: () => void
}): ReactElement {
  return (
    <section className="mt-4 rounded-2xl border border-border/70 bg-card/95 p-4">
      <p className="text-sm font-medium text-foreground">Linked web account still needs follow-up.</p>
      <p className="mt-1 text-sm text-muted-foreground">Open the authenticated handoff page to finish the linked web login and password handoff, or hide this reminder for now.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button asChild>
          <Link to="/web-account">Set login and password</Link>
        </Button>
        <Button variant="outline" onClick={onSnooze} disabled={isPending}>
          {isPending ? 'Saving reminder...' : 'Remind me later'}
        </Button>
      </div>
      {error ? <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(error)}</p> : null}
    </section>
  )
}

function WebAccountEmailVerificationCta({
  emailAddress,
  challenge,
  isPending,
  error,
  onIssue,
}: {
  readonly emailAddress: string
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly isPending: boolean
  readonly error: unknown
  readonly onIssue: () => void
}): ReactElement {
  const actionLabel: string = challenge ? 'Resend verification email' : 'Issue verification challenge'
  const followUpLabel: string = challenge ? 'Enter verification code' : 'Manage linked account'
  return (
    <section className="mt-4 rounded-2xl border border-border/70 bg-card/95 p-4">
      <p className="text-sm font-medium text-foreground">Optional linked email follow-up is available.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {challenge
          ? `Verification email issued for ${challenge.email ?? emailAddress}. Check that mailbox later, then complete the code entry on the linked-account page. The current challenge expires ${formatDate(challenge.challengeExpiresAt)}.`
          : 'Issue or re-issue the current linked-account verification email without leaving the authenticated shell. Login and password handoff remain the primary credential step.'}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="outline" onClick={onIssue} disabled={isPending}>
          {isPending ? 'Issuing verification...' : actionLabel}
        </Button>
        <Button asChild variant="outline">
          <Link to="/web-account">{followUpLabel}</Link>
        </Button>
      </div>
      {error ? <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(error)}</p> : null}
    </section>
  )
}

function SubscriptionDetails({ query }: { readonly query: Awaited<ReturnType<typeof subscriptionApi.getSubscription>> | undefined }): ReactElement {
  if (query === undefined) {
    return <p className="text-sm text-muted-foreground">No subscription payload loaded yet.</p>
  }
  if (query === null) {
    return <p className="text-sm text-muted-foreground">This user does not currently have a subscription.</p>
  }
  const diagnostics = getSubscriptionDiagnostics(query)
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/70 bg-background/70 p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Diagnostics</p>
        <p className="mt-2 text-sm font-medium text-foreground">{diagnostics.compactValue}</p>
        <p className="mt-1 text-sm text-muted-foreground">{diagnostics.compactDetail}</p>
      </section>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <DetailItem label="Plan" value={query.plan?.name ?? 'Unknown plan'} />
        <DetailItem label="Trial" value={booleanLabel(query.isTrial)} />
        <DetailItem label="Timing" value={diagnostics.timingLabel} />
        <DetailItem label="Traffic / devices" value={diagnostics.entitlementSummary} />
      </dl>
    </div>
  )
}

function PlatformPolicyDetails({ query }: { readonly query: Awaited<ReturnType<typeof platformPolicyApi.getPlatformPolicy>> | undefined }): ReactElement {
  if (!query) {
    return <p className="text-sm text-muted-foreground">No platform policy payload loaded yet.</p>
  }
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <DetailItem label="Rules acceptance required" value={booleanLabel(query.rulesRequired)} />
        <DetailItem label="Channel joining required" value={booleanLabel(query.channelRequired)} />
        <DetailItem label="Access mode" value={formatAccessMode(query.accessMode)} />
        <DetailItem label="Default currency" value={query.defaultCurrency} />
        <DetailItem label="Invite mode start" value={formatInviteModeDate({ accessMode: query.accessMode, inviteModeStartedAt: query.inviteModeStartedAt })} />
      </dl>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <PolicyLinkItem label="Rules link" href={query.rulesLink} />
        <PolicyLinkItem label="Channel link" href={query.channelLink} />
      </div>
      <section className="rounded-2xl border border-border/70 bg-background/70 p-4">
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Access mode context</p>
        <p className="mt-2 text-sm text-foreground">{getAccessModeDescription(query.accessMode)}</p>
      </section>
    </div>
  )
}

function DetailItem({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="rounded-2xl bg-secondary/50 px-4 py-3">
      <dt className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{value}</dd>
    </div>
  )
}

function PolicyLinkItem({ label, href }: { readonly label: string; readonly href: string | null }): ReactElement {
  const safeHref: string | null = getSafeExternalHref(href)
  return (
    <div className="rounded-2xl bg-secondary/50 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      {safeHref ? (
        <a className="mt-1 block break-all text-sm font-medium text-primary underline-offset-4 hover:underline" href={safeHref} target="_blank" rel="noreferrer">
          {safeHref}
        </a>
      ) : (
        <p className="mt-1 text-sm font-medium text-foreground">Not set</p>
      )}
    </div>
  )
}

function getWebAccountReadinessCta({
  authStatus,
  session,
  isVisible,
  isPending,
  error,
  onSnooze,
}: {
  readonly authStatus: ReturnType<typeof useAuthSession>['status']
  readonly session: Awaited<ReturnType<typeof sessionApi.getSession>> | undefined
  readonly isVisible: boolean
  readonly isPending: boolean
  readonly error: unknown
  readonly onSnooze: () => void
}): {
  readonly isPending: boolean
  readonly error: unknown
  readonly onSnooze: () => void
} | null {
  if (authStatus !== 'authenticated' || !session || !isVisible) {
    return null
  }
  return {
    isPending,
    error,
    onSnooze,
  }
}

function getWebAccountEmailVerificationCta({
  authStatus,
  session,
  canIssue,
  challenge,
  isPending,
  error,
  onIssue,
}: {
  readonly authStatus: ReturnType<typeof useAuthSession>['status']
  readonly session: Awaited<ReturnType<typeof sessionApi.getSession>> | undefined
  readonly canIssue: boolean
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly isPending: boolean
  readonly error: unknown
  readonly onIssue: () => void
}): {
  readonly emailAddress: string
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly isPending: boolean
  readonly error: unknown
  readonly onIssue: () => void
} | null {
  if (authStatus !== 'authenticated' || !session || session.webAccount === null || !canIssue) {
    return null
  }
  if (isWebAccountCredentialActionable(session.webAccount)) {
    return null
  }
  const emailAddress: string | null = getWebAccountEmailAddress(session.webAccount)
  if (emailAddress === null) {
    return null
  }
  return {
    emailAddress,
    challenge,
    isPending,
    error,
    onIssue,
  }
}

function getWebAccountReadinessLabel(webAccount: NonNullable<Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']>): string {
  if (getWebAccountLogin(webAccount) === null) {
    return 'Login setup required'
  }
  if (webAccount.requiresPasswordChange) {
    return 'Password update required'
  }
  if (webAccount.credentialsBootstrappedAt === null) {
    return 'Credentials setup required'
  }
  return 'Linked credentials ready'
}

function getWebAccountReadinessDescription(webAccount: NonNullable<Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']>): string {
  if (getWebAccountLogin(webAccount) === null) {
    return 'The linked web account exists, but it still needs a login before linked credentials are complete.'
  }
  if (webAccount.requiresPasswordChange) {
    return 'The linked web account exists, but it still requires a password update in this linked credential flow.'
  }
  if (webAccount.credentialsBootstrappedAt === null) {
    return 'The linked web account exists, but linked credentials have not been bootstrapped yet.'
  }
  if (webAccount.emailVerifiedAt === null && getWebAccountEmailAddress(webAccount) !== null) {
    return 'The linked web account has login and password credentials in place. Linked email verification remains an optional follow-up.'
  }
  return 'The linked web account exists and does not currently require a password change.'
}

function isWebAccountCredentialActionable(webAccount: NonNullable<Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']>): boolean {
  return getWebAccountLogin(webAccount) === null || webAccount.requiresPasswordChange || webAccount.credentialsBootstrappedAt === null
}

async function handleUnauthorizedSessionMutationError({
  error,
  queryClient,
}: {
  readonly error: unknown
  readonly queryClient: ReturnType<typeof useQueryClient>
}): Promise<void> {
  if (!isApiUnauthorizedError(error)) {
    return
  }
  await queryClient.invalidateQueries({ queryKey: ['session'] })
}

function saveSessionQueryData({
  queryClient,
  session,
}: {
  readonly queryClient: ReturnType<typeof useQueryClient>
  readonly session: SessionData
}): void {
  queryClient.setQueryData<SessionData>(['session'], session)
}

function getSessionCardState({
  authStatus,
  sessionQuery,
}: {
  readonly authStatus: ReturnType<typeof useAuthSession>['status']
  readonly sessionQuery: ReturnType<typeof useAuthSession>['sessionQuery']
}): MetricState {
  if (authStatus === 'authentication-required') {
    return { value: 'Auth required', detail: 'Open the Mini App in Telegram or reuse an existing cookie session.' }
  }
  if (authStatus === 'loading') {
    return { value: 'Loading', detail: 'Checking account session.' }
  }
  if (sessionQuery.error) {
    return { value: 'Unavailable', detail: getApiErrorMessage(sessionQuery.error) }
  }
  if (!sessionQuery.data) {
    return { value: 'Unavailable', detail: 'Session data is not available.' }
  }
  return {
    value: sessionQuery.data.role,
    detail: getPrimarySessionIdentity(sessionQuery.data),
  }
}

function getSubscriptionCardState({
  authStatus,
  subscriptionQuery,
}: {
  readonly authStatus: ReturnType<typeof useAuthSession>['status']
  readonly subscriptionQuery: ReturnType<typeof useSubscriptionQuery>
}): MetricState {
  if (authStatus === 'authentication-required') {
    return { value: 'Auth required', detail: 'Subscription data becomes available after Telegram bootstrap.' }
  }
  if (authStatus === 'loading') {
    return { value: 'Loading', detail: 'Waiting for authenticated session.' }
  }
  if (subscriptionQuery.error) {
    return { value: 'Unavailable', detail: getApiErrorMessage(subscriptionQuery.error) }
  }
  if (subscriptionQuery.isPending) {
    return { value: 'Loading', detail: 'Loading subscription details.' }
  }
  if (subscriptionQuery.data === null) {
    return { value: 'None', detail: 'No current subscription on record.' }
  }
  if (!subscriptionQuery.data) {
    return { value: 'Unavailable', detail: 'Subscription data is not available.' }
  }
  const diagnostics = getSubscriptionDiagnostics(subscriptionQuery.data)
  return {
    value: diagnostics.compactValue,
    detail: diagnostics.compactDetail,
  }
}

function getRulesCardState({
  authStatus,
  sessionQuery,
}: {
  readonly authStatus: ReturnType<typeof useAuthSession>['status']
  readonly sessionQuery: ReturnType<typeof useAuthSession>['sessionQuery']
}): MetricState {
  if (authStatus === 'authentication-required') {
    return { value: 'Auth required', detail: 'Rules state is only available for an authenticated session.' }
  }
  if (authStatus === 'loading') {
    return { value: 'Loading', detail: 'Waiting for authenticated session.' }
  }
  if (sessionQuery.error) {
    return { value: 'Unavailable', detail: getApiErrorMessage(sessionQuery.error) }
  }
  if (!sessionQuery.data) {
    return { value: 'Unavailable', detail: 'Rules state is not available.' }
  }
  return {
    value: booleanLabel(sessionQuery.data.isRulesAccepted),
    detail: `Blocked: ${booleanLabel(sessionQuery.data.isBlocked)}`,
  }
}

function getPlansCardState({ plansQuery }: { readonly plansQuery: ReturnType<typeof usePlansQuery> }): MetricState {
  if (plansQuery.error) {
    return { value: 'Unavailable', detail: getApiErrorMessage(plansQuery.error) }
  }
  if (plansQuery.isPending || !plansQuery.data) {
    return { value: 'Loading', detail: 'Loading plan catalog.' }
  }
  return {
    value: `${plansQuery.data.length} active`,
    detail: `${plansQuery.data.reduce((count, plan) => count + plan.durations.length, 0)} available durations`,
  }
}

function booleanLabel(value: boolean): string {
  return value ? 'Yes' : 'No'
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

function formatAccessMode(accessMode: Awaited<ReturnType<typeof platformPolicyApi.getPlatformPolicy>>['accessMode']): string {
  switch (accessMode) {
    case 'PUBLIC':
      return 'Public'
    case 'INVITED':
      return 'Invited only'
    case 'PURCHASE_BLOCKED':
      return 'Purchase blocked'
    case 'REG_BLOCKED':
      return 'Registration blocked'
    case 'RESTRICTED':
      return 'Restricted'
  }
}

function formatInviteModeDate({
  accessMode,
  inviteModeStartedAt,
}: {
  readonly accessMode: Awaited<ReturnType<typeof platformPolicyApi.getPlatformPolicy>>['accessMode']
  readonly inviteModeStartedAt: string | null
}): string {
  if (accessMode !== 'INVITED') {
    return 'Not applicable'
  }
  return formatDate(inviteModeStartedAt)
}

function getAccessModeDescription(accessMode: Awaited<ReturnType<typeof platformPolicyApi.getPlatformPolicy>>['accessMode']): string {
  switch (accessMode) {
    case 'PUBLIC':
      return 'The payload marks the platform access mode as public.'
    case 'INVITED':
      return 'The payload marks the platform access mode as invite-only.'
    case 'PURCHASE_BLOCKED':
      return 'The payload marks the platform access mode as purchase-blocked.'
    case 'REG_BLOCKED':
      return 'The payload marks the platform access mode as registration-blocked.'
    case 'RESTRICTED':
      return 'The payload marks the platform access mode as restricted.'
  }
}

function getSafeExternalHref(href: string | null): string | null {
  if (!href) {
    return null
  }
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function getAuthHeadline(authSession: ReturnType<typeof useAuthSession>): string {
  if (authSession.status === 'authenticated' && authSession.sessionQuery.data) {
    return authSession.sessionQuery.data.name ?? getPrimarySessionIdentity(authSession.sessionQuery.data)
  }
  if (authSession.status === 'loading') {
    return 'Bootstrapping session'
  }
  if (authSession.status === 'error') {
    return 'Authentication error'
  }
  return 'Authentication required'
}

function getAuthDescription(authSession: ReturnType<typeof useAuthSession>): string {
  if (authSession.status === 'authenticated') {
    return 'Dashboard and subscription data now resolve from the opaque cookie session created by Telegram bootstrap.'
  }
  if (authSession.status === 'loading') {
    return authSession.canBootstrapWithTelegram ? 'Telegram launch data detected. Waiting for session bootstrap to complete.' : 'Checking whether a cookie-backed session already exists for this browser.'
  }
  if (authSession.status === 'error') {
    return 'The session bootstrap flow failed before account data could be loaded.'
  }
  return 'Open the app from Telegram or restore an existing cookie session. Query-string identity parameters are no longer accepted.'
}

function getPrimarySessionIdentity(session: NonNullable<ReturnType<typeof useAuthSession>['sessionQuery']['data']>): string {
  return getWebAccountLogin(session.webAccount) ?? session.username ?? session.email ?? session.id
}

function getVisiblePanelError({
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
