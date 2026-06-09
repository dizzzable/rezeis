import { useEffect, type JSX, type ReactNode } from 'react'
import { LoaderCircle, Shield } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAuthMe } from '@/features/auth/use-auth-me'
import { translateErrorMessage } from '@/lib/translate-error'
import { useAuthStore } from '@/stores/auth-store'
import { captureReturnTo } from '@/lib/return-to'

interface AuthGuardProps {
  readonly children: ReactNode
}

export function AuthGuard({ children }: AuthGuardProps): JSX.Element {
  const { t } = useTranslation()
  const token: string = useAuthStore((state) => state.token)
  const sessionRevision: number = useAuthStore((state) => state.sessionRevision)
  const verifiedSessionRevision: number | null = useAuthStore((state) => state.verifiedSessionRevision)
  const pendingLoginRevision: number | null = useAuthStore((state) => state.pendingLoginRevision)
  const authMeQuery = useAuthMe()
  const isSessionVerified: boolean = verifiedSessionRevision === sessionRevision
  useEffect((): void => {
    if (!authMeQuery.data || pendingLoginRevision !== sessionRevision || isSessionVerified) {
      return
    }
    toast.success(t('auth.loginSuccess'))
  }, [authMeQuery.data, isSessionVerified, pendingLoginRevision, sessionRevision, t])
  if (!token) {
    captureReturnTo(window.location.pathname + window.location.search + window.location.hash)
    return <Navigate replace to="/login" />
  }
  if (!isSessionVerified && (authMeQuery.isLoading || authMeQuery.isRefetching || authMeQuery.isSuccess)) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="flex w-full max-w-sm flex-col items-center rounded-3xl border border-border/80 bg-card/95 p-8 text-center shadow-sm">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-primary">
            {authMeQuery.isRefetching ? <LoaderCircle className="size-5 animate-spin" /> : <Shield className="size-5" />}
          </div>
          <p className="mt-5 text-lg font-semibold">{authMeQuery.isRefetching ? t('auth.sessionCheckRetryingTitle') : t('auth.sessionCheckTitle')}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{authMeQuery.isRefetching ? t('auth.sessionCheckRetryingDescription') : t('auth.sessionCheckDescription')}</p>
        </div>
      </div>
    )
  }
  if (authMeQuery.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="flex w-full max-w-sm flex-col items-center rounded-3xl border border-border/80 bg-card/95 p-8 text-center shadow-sm">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-primary">
            <Shield className="size-5" />
          </div>
          <p className="mt-5 text-lg font-semibold">{t('auth.sessionCheckFailedTitle')}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('auth.sessionCheckFailedDescription')}</p>
          <p className="mt-4 text-sm text-destructive">{translateErrorMessage(t, authMeQuery.error.message)}</p>
          <Button type="button" className="mt-6" onClick={(): void => void authMeQuery.refetch()} disabled={authMeQuery.isRefetching}>
            {authMeQuery.isRefetching ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {authMeQuery.isRefetching ? t('auth.sessionCheckRetryingAction') : t('auth.sessionCheckRetry')}
          </Button>
        </div>
      </div>
    )
  }
  return <>{children}</>
}
