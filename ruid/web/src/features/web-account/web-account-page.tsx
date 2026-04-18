import { useEffect, useId, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeft, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuthRequiredState } from '@/features/auth/auth-required-state'
import { useAuthSession } from '@/features/auth/auth-provider'
import { sessionApi, type SessionWebAccountEmailVerificationChallenge, type SessionWebAccountEmailVerificationCompletionInput, type SessionWebAccountPasswordInput } from '@/features/session/session-api'
import { useWebAccountEmailVerificationChallengeState } from '@/features/session/web-account-email-verification-challenge-state'
import { useTimeBoundary } from '@/features/time/use-time-boundary'
import { getSupportedEmailVerificationChallenge, getWebAccountEmailAddress, getWebAccountLogin, getWebAccountVisibilityState, reconcileSessionAfterEmailVerificationChallenge, shouldClearEmailVerificationChallengeForError } from '@/features/web-account/get-web-account-visibility-state'
import { getApiErrorMessage, isApiUnauthorizedError } from '@/lib/api'

type SessionData = Awaited<ReturnType<typeof sessionApi.getSession>>
type SessionWebAccountData = NonNullable<SessionData['webAccount']>
const EMAIL_VERIFICATION_CODE_PATTERN: RegExp = /^\d{6}$/
const EMAIL_VERIFICATION_CODE_ERROR = 'Enter the 6-digit verification code from your email.'
const LOGIN_REQUIRED_ERROR = 'Login is required before you continue.'
const LOGIN_PATTERN: RegExp = /^[A-Za-z0-9._-]{3,64}$/
const LOGIN_VALIDATION_ERROR = 'Enter a login with 3-64 letters, numbers, dots, underscores, or hyphens.'

interface EmailVerificationMutationState {
  readonly error: unknown
  readonly isPending: boolean
  readonly mutate: () => void
}

interface EmailVerificationCompletionMutationState {
  readonly error: unknown
  readonly isPending: boolean
  readonly mutate: (input: SessionWebAccountEmailVerificationCompletionInput) => void
}

export function WebAccountPage(): ReactElement {
  const authSession = useAuthSession()
  const queryClient = useQueryClient()
  const loginInputId = useId()
  const passwordInputId = useId()
  const confirmPasswordInputId = useId()
  const webAccountEmailVerificationChallengeState = useWebAccountEmailVerificationChallengeState()
  const [login, setLogin] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [confirmPassword, setConfirmPassword] = useState<string>('')
  const [confirmationError, setConfirmationError] = useState<string | null>(null)
  const [verificationCode, setVerificationCode] = useState<string>('')
  const [verificationCodeError, setVerificationCodeError] = useState<string | null>(null)
  const handoffMutation = useMutation({
    mutationFn: (input: SessionWebAccountPasswordInput) => sessionApi.handoffWebAccountPassword(input),
    onSuccess: async (session: SessionData): Promise<void> => {
      saveSessionQueryData({ queryClient, session })
      setLogin(getWebAccountLogin(session.webAccount) ?? '')
      setPassword('')
      setConfirmPassword('')
      setConfirmationError(null)
    },
    onError: async (error: unknown): Promise<void> => {
      await handleUnauthorizedSessionMutationError({ error, queryClient })
    },
  })
  const issueEmailVerificationChallengeMutation = useMutation({
    mutationFn: () => sessionApi.issueWebAccountEmailVerificationChallenge(),
    onSuccess: async (challenge): Promise<void> => {
      queryClient.setQueryData<SessionData | undefined>(['session'], (currentSession: SessionData | undefined) => reconcileSessionAfterEmailVerificationChallenge({
        session: currentSession,
        challenge,
      }))
      webAccountEmailVerificationChallengeState.saveChallenge(challenge)
      setVerificationCode('')
      setVerificationCodeError(null)
    },
    onError: async (error: unknown): Promise<void> => {
      if (shouldClearEmailVerificationChallengeForError(error)) {
        webAccountEmailVerificationChallengeState.saveChallenge(null)
      }
      await handleUnauthorizedSessionMutationError({ error, queryClient })
    },
  })
  const completeEmailVerificationMutation = useMutation({
    mutationFn: (input: SessionWebAccountEmailVerificationCompletionInput) => sessionApi.completeWebAccountEmailVerification(input),
    onSuccess: async (session: SessionData): Promise<void> => {
      saveSessionQueryData({ queryClient, session })
      webAccountEmailVerificationChallengeState.saveChallenge(null)
      setVerificationCode('')
      setVerificationCodeError(null)
    },
    onError: async (error: unknown): Promise<void> => {
      if (shouldClearEmailVerificationChallengeForError(error)) {
        webAccountEmailVerificationChallengeState.saveChallenge(null)
      }
      await handleUnauthorizedSessionMutationError({ error, queryClient })
    },
  })
  const session: SessionData | undefined = authSession.status === 'authenticated' ? authSession.sessionQuery.data : undefined
  const now: number = useTimeBoundary([webAccountEmailVerificationChallengeState.challenge?.challengeExpiresAt])
  const supportedChallenge = useMemo(() => getSupportedEmailVerificationChallenge({
    authStatus: authSession.status,
    webAccount: session?.webAccount ?? null,
    challenge: webAccountEmailVerificationChallengeState.challenge,
    now,
  }), [authSession.status, now, session?.webAccount, webAccountEmailVerificationChallengeState.challenge])
  useEffect(() => {
    if (webAccountEmailVerificationChallengeState.challenge === supportedChallenge) {
      return
    }
    webAccountEmailVerificationChallengeState.saveChallenge(supportedChallenge)
  }, [supportedChallenge, webAccountEmailVerificationChallengeState.challenge, webAccountEmailVerificationChallengeState.saveChallenge])
  useEffect(() => {
    if (!session?.webAccount) {
      setLogin('')
      return
    }
    setLogin(getWebAccountLogin(session.webAccount) ?? '')
  }, [session?.webAccount])
  const webAccountVisibilityState = useMemo(() => getWebAccountVisibilityState({
    webAccount: session?.webAccount ?? null,
    challenge: supportedChallenge,
    now,
  }), [now, session?.webAccount, supportedChallenge])
  const visibleError: unknown = authSession.status === 'error' ? authSession.bootstrapError ?? authSession.sessionQuery.error : null
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (handoffMutation.isPending) {
      return
    }
    const sanitizedLogin: string = login.trim()
    setConfirmationError(null)
    if (!sanitizedLogin) {
      setConfirmationError(LOGIN_REQUIRED_ERROR)
      return
    }
    if (!LOGIN_PATTERN.test(sanitizedLogin)) {
      setConfirmationError(LOGIN_VALIDATION_ERROR)
      return
    }
    if (password !== confirmPassword) {
      setConfirmationError('Passwords must match before you continue.')
      return
    }
    if (sanitizedLogin !== login) {
      setLogin(sanitizedLogin)
    }
    handoffMutation.mutate({ login: sanitizedLogin, password })
  }
  const handleEmailVerificationSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (completeEmailVerificationMutation.isPending) {
      return
    }
    const sanitizedVerificationCode: string = verificationCode.trim()
    setVerificationCodeError(null)
    if (!EMAIL_VERIFICATION_CODE_PATTERN.test(sanitizedVerificationCode)) {
      setVerificationCodeError(EMAIL_VERIFICATION_CODE_ERROR)
      return
    }
    if (sanitizedVerificationCode !== verificationCode) {
      setVerificationCode(sanitizedVerificationCode)
    }
    completeEmailVerificationMutation.mutate({ code: sanitizedVerificationCode })
  }
  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
        <p className="text-sm font-medium text-primary">Linked web account</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Set or update the login and password for your linked web account.</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          This authenticated handoff stays inside the existing Telegram or cookie-backed session. It only updates the linked web-account login and password for the current user.
        </p>
      </section>
      {authSession.status === 'authentication-required' ? <AuthRequiredState /> : null}
      {authSession.status === 'loading' ? <PageStateCard message="Loading linked web-account state..." /> : null}
      {authSession.status === 'error' && visibleError ? <ErrorCard error={visibleError} /> : null}
      {authSession.status === 'authenticated' && !session ? <PageStateCard message="Session data is not available." /> : null}
      {authSession.status === 'authenticated' && session ? (
        session.webAccount === null
          ? <UnlinkedState />
          : (
            <div className="space-y-4">
              {isWebAccountPasswordActionable(session.webAccount)
           ? (
             <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
               <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-primary/10 p-3 text-primary">
                    <KeyRound className="size-5" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight">Credential handoff required</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{getActionDescription(session.webAccount)}</p>
                  </div>
                </div>
                <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground" htmlFor={loginInputId}>Login</label>
                    <input
                      id={loginInputId}
                      className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      type="text"
                      autoComplete="username"
                      minLength={3}
                      maxLength={64}
                      pattern="[A-Za-z0-9._-]{3,64}"
                      required
                      value={login}
                      onChange={(event) => setLogin(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground" htmlFor={passwordInputId}>Password</label>
                    <input
                      id={passwordInputId}
                      className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground" htmlFor={confirmPasswordInputId}>Confirm password</label>
                    <input
                      id={confirmPasswordInputId}
                      className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                    />
                  </div>
                  {confirmationError ? <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{confirmationError}</p> : null}
                  {handoffMutation.error && !isApiUnauthorizedError(handoffMutation.error) ? <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(handoffMutation.error)}</p> : null}
                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" disabled={handoffMutation.isPending}>
                      {handoffMutation.isPending ? 'Saving login and password...' : 'Save login and password'}
                    </Button>
                    <Button asChild variant="outline">
                      <Link to="/">
                        <ArrowLeft className="size-4" />
                        Back to dashboard
                      </Link>
                    </Button>
                  </div>
                </form>
              </article>
                <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
                  <h2 className="text-xl font-semibold tracking-tight">Current linked account state</h2>
                   <dl className="mt-5 grid gap-3">
                     <DetailItem label="Web account login" value={getWebAccountLogin(session.webAccount) ?? 'Not set'} />
                     <DetailItem label="Linked email" value={getWebAccountEmailAddress(session.webAccount) ?? 'Not set'} />
                     <DetailItem label="Email verified" value={formatDate(session.webAccount?.emailVerifiedAt ?? null)} />
                    <DetailItem label="Password change required" value={booleanLabel(session.webAccount?.requiresPasswordChange ?? false)} />
                    <DetailItem label="Credentials bootstrapped" value={formatDate(session.webAccount?.credentialsBootstrappedAt ?? null)} />
                 </dl>
               </article>
             </div>
            )
           : <CompletedState session={session} />}
              <EmailVerificationStateCard
                webAccount={session.webAccount}
                emailAddress={getWebAccountEmailAddress(session.webAccount)}
                canIssueChallenge={webAccountVisibilityState.canIssueEmailVerification}
                challenge={webAccountVisibilityState.visibleEmailVerificationChallenge}
                isSecondary={isWebAccountPasswordActionable(session.webAccount)}
                mutation={issueEmailVerificationChallengeMutation}
                completionMutation={completeEmailVerificationMutation}
                verificationCode={verificationCode}
                verificationCodeError={verificationCodeError}
                onVerificationCodeChange={(nextVerificationCode: string): void => {
                  setVerificationCode(nextVerificationCode)
                  if (verificationCodeError !== null) {
                    setVerificationCodeError(null)
                  }
                }}
                onVerificationSubmit={handleEmailVerificationSubmit}
              />
             </div>
          )
      ) : null}
    </div>
  )
}

function EmailVerificationStateCard({
  webAccount,
  emailAddress,
  canIssueChallenge,
  challenge,
  isSecondary,
  mutation,
  completionMutation,
  verificationCode,
  verificationCodeError,
  onVerificationCodeChange,
  onVerificationSubmit,
}: {
  readonly webAccount: SessionWebAccountData
  readonly emailAddress: string | null
  readonly canIssueChallenge: boolean
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly isSecondary: boolean
  readonly mutation: EmailVerificationMutationState
  readonly completionMutation: EmailVerificationCompletionMutationState
  readonly verificationCode: string
  readonly verificationCodeError: string | null
  readonly onVerificationCodeChange: (value: string) => void
  readonly onVerificationSubmit: (event: FormEvent<HTMLFormElement>) => void
}): ReactElement {
  const isPendingStateVisible: boolean = challenge !== null
  const canShowIssueButton: boolean = canIssueChallenge && (!isSecondary || isPendingStateVisible)
  const verificationCodeInputId = useId()
  return (
    <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
      <p className="text-sm font-medium text-primary">Linked email verification</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">
        {webAccount.emailVerifiedAt !== null
          ? 'Linked email already verified.'
          : emailAddress === null
            ? 'Linked email is not available.'
          : isPendingStateVisible
            ? 'Verification email issued.'
            : isSecondary
              ? 'Optional email follow-up comes after the credential handoff.'
              : 'Optional email verification is available.'}
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        {webAccount.emailVerifiedAt !== null
          ? 'The linked web-account email is already verified in the current session state.'
          : emailAddress === null
            ? 'This linked web account does not currently expose an email address, so an optional verification challenge cannot be issued yet.'
          : isPendingStateVisible
            ? `Verification email issued for ${challenge.email ?? emailAddress}. Check that mailbox later. The current challenge expires ${formatDate(challenge.challengeExpiresAt)}.`
            : isSecondary
              ? 'Finish the linked login and password handoff first. Optional linked-email verification can follow afterward without leaving the authenticated shell.'
              : 'Issue or re-issue optional linked-email verification without leaving the authenticated shell after the linked credentials are already in place.'}
      </p>
      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        <DetailItem label="Linked email" value={emailAddress ?? 'Not set'} />
        <DetailItem label="Email verified" value={formatDate(webAccount.emailVerifiedAt)} />
        <DetailItem label="Pending challenge expires" value={challenge ? formatDate(challenge.challengeExpiresAt) : 'Not issued'} />
      </dl>
      {canShowIssueButton ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Issuing verification...' : challenge ? 'Resend verification email' : 'Issue verification challenge'}
          </Button>
        </div>
      ) : null}
      {isPendingStateVisible ? (
        <form className="mt-5 space-y-4 rounded-2xl border border-border/70 bg-background/70 p-4" onSubmit={onVerificationSubmit}>
          <div>
            <h3 className="text-sm font-medium text-foreground">Complete verification</h3>
            <p className="mt-1 text-sm text-muted-foreground">Enter the 6-digit code from the verification email to refresh the linked-account session state in place.</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor={verificationCodeInputId}>Verification code</label>
            <input
              id={verificationCodeInputId}
              className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              placeholder="123456"
              required
              value={verificationCode}
              onChange={(event) => onVerificationCodeChange(event.target.value)}
            />
          </div>
          {verificationCodeError ? <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{verificationCodeError}</p> : null}
          {completionMutation.error && !isApiUnauthorizedError(completionMutation.error) ? <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(completionMutation.error)}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={completionMutation.isPending}>
              {completionMutation.isPending ? 'Verifying code...' : 'Complete email verification'}
            </Button>
          </div>
        </form>
      ) : null}
      {mutation.error && !isApiUnauthorizedError(mutation.error) ? <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(mutation.error)}</p> : null}
    </article>
  )
}

function CompletedState({ session }: { readonly session: SessionData }): ReactElement {
  return (
    <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
      <p className="text-sm font-medium text-primary">Linked web account</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">No credential handoff is currently required.</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        This linked web account already has a login and bootstrapped credentials, and it does not currently require a password change.
      </p>
      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        <DetailItem label="Web account login" value={getWebAccountLogin(session.webAccount) ?? 'Not set'} />
        <DetailItem label="Linked email" value={getWebAccountEmailAddress(session.webAccount) ?? 'Not set'} />
        <DetailItem label="Email verified" value={formatDate(session.webAccount?.emailVerifiedAt ?? null)} />
        <DetailItem label="Password change required" value={booleanLabel(session.webAccount?.requiresPasswordChange ?? false)} />
        <DetailItem label="Credentials bootstrapped" value={formatDate(session.webAccount?.credentialsBootstrappedAt ?? null)} />
        <DetailItem label="Link prompt snooze" value={formatDate(session.webAccount?.linkPromptSnoozeUntil ?? null)} />
      </dl>
      <div className="mt-5">
        <Button asChild variant="outline">
          <Link to="/">
            <ArrowLeft className="size-4" />
            Back to dashboard
          </Link>
        </Button>
      </div>
    </article>
  )
}

function UnlinkedState(): ReactElement {
  return (
    <article className="rounded-3xl border border-border/70 bg-card/95 p-6 shadow-sm">
      <p className="text-sm font-medium text-primary">Linked web account</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">No linked web account is available for credential handoff.</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        This authenticated page only handles login and password follow-up for an already linked web account. The current session does not include a linked web-account payload.
      </p>
      <div className="mt-5">
        <Button asChild variant="outline">
          <Link to="/">
            <ArrowLeft className="size-4" />
            Back to dashboard
          </Link>
        </Button>
      </div>
    </article>
  )
}

function ErrorCard({ error }: { readonly error: unknown }): ReactElement {
  return <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{getApiErrorMessage(error)}</p>
}

function PageStateCard({ message }: { readonly message: string }): ReactElement {
  return <p className="rounded-2xl border border-dashed border-border/80 bg-background/70 px-4 py-6 text-sm text-muted-foreground">{message}</p>
}

function DetailItem({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="rounded-2xl bg-secondary/50 px-4 py-3">
      <dt className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm font-medium text-foreground">{value}</dd>
    </div>
  )
}

function isWebAccountPasswordActionable(webAccount: SessionWebAccountData): boolean {
  return getWebAccountLogin(webAccount) === null || webAccount.requiresPasswordChange || webAccount.credentialsBootstrappedAt === null
}

function getActionDescription(webAccount: SessionWebAccountData): string {
  if (getWebAccountLogin(webAccount) === null) {
    return 'Your linked web account still needs a login before web credentials are ready. Set the login and password together to complete the handoff.'
  }
  if (webAccount.requiresPasswordChange) {
    return 'Your linked web account exists, but it still requires a password update before linked credentials are complete.'
  }
  return 'Your linked web account exists, but credentials have not been bootstrapped yet. Confirm the login and set a password to complete the first handoff.'
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
