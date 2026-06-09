import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { consumeReturnTo } from '@/lib/return-to'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'

import { getErrorMessage } from '@/lib/http-errors'
import { RezeisLogo } from '@/components/branding/rezeis-logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Aurora } from '@/components/effects/Aurora'
import { SplitText } from '@/components/effects/SplitText'

import { useAuth } from './auth-provider'
import { getAuthStatus, loginApi, registerApi } from './auth-api'
import { OAuthButtons } from './oauth-buttons'

// ── Schemas (returned from a hook so error messages can be localized) ──────

function useLoginSchema() {
  const { t } = useTranslation()
  return z.object({
    username: z.string().min(1, t('signInPage.login.usernameRequired')),
    password: z.string().min(1, t('signInPage.login.passwordRequired')),
  })
}

function useRegisterSchema() {
  const { t } = useTranslation()
  return z
    .object({
      username: z.string().min(3, t('signInPage.register.usernameMin')).max(64),
      password: z.string().min(8, t('signInPage.register.passwordMin')).max(128),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t('signInPage.register.confirmMismatch'),
      path: ['confirmPassword'],
    })
}

type LoginFormData = { username: string; password: string }
type RegisterFormData = { username: string; password: string; confirmPassword: string }

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SignInPage() {
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    retry: 2,
    staleTime: 30_000,
  })

  if (statusLoading) {
    return (
      <PageShell>
        <Skeleton className="h-80 w-full max-w-md" />
      </PageShell>
    )
  }

  const needsRegister = status?.hasAdmins === false

  return (
    <PageShell>
      {needsRegister ? <RegisterForm /> : <LoginForm />}
    </PageShell>
  )
}

// ── Layout Shell ─────────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="relative min-h-screen overflow-hidden">
      <Aurora />
      <div className="relative z-10 flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-14 w-14 items-center justify-center">
              <RezeisLogo className="h-12 w-12" alt={t('signInPage.appName')} />
            </div>
            <h1 className="text-xl font-bold">
              <SplitText text={t('signInPage.appName')} />
            </h1>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Login Form ───────────────────────────────────────────────────────────────

function LoginForm() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { login } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [totpRequired, setTotpRequired] = useState(false)
  const [totpCode, setTotpCode] = useState('')
  const [pendingCredentials, setPendingCredentials] = useState<LoginFormData | null>(null)

  const loginSchema = useLoginSchema()
  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  })

  const mutation = useMutation({
    mutationFn: loginApi,
    onSuccess: (data) => {
      login(data.accessToken)
      navigate(consumeReturnTo() ?? '/', { replace: true })
    },
    onError: (err: unknown) => {
      const responseData = (err as { response?: { data?: { code?: string; message?: string } } }).response?.data
      if (responseData?.code === 'totp_required') {
        setTotpRequired(true)
        setError(null)
        return
      }
      if (totpRequired) {
        setError(t('signInPage.totp.invalidCode'))
      } else {
        setError(responseData?.message ?? t('signInPage.login.genericError'))
      }
    },
  })

  const onSubmit = (data: LoginFormData) => {
    setError(null)
    setPendingCredentials(data)
    mutation.mutate(data)
  }

  const onSubmitTotp = (event: React.FormEvent) => {
    event.preventDefault()
    if (!pendingCredentials) return
    setError(null)
    mutation.mutate({ ...pendingCredentials, totpCode: totpCode.trim() })
  }

  const cancelTotpStep = () => {
    setTotpRequired(false)
    setTotpCode('')
    setPendingCredentials(null)
    setError(null)
  }

  if (totpRequired) {
    return (
      <Card data-glass-card>
        <CardHeader className="text-center">
          <CardTitle>{t('signInPage.totp.title')}</CardTitle>
          <CardDescription>{t('signInPage.totp.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmitTotp} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="totp">{t('signInPage.totp.codeLabel')}</Label>
              <Input
                id="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                maxLength={20}
                placeholder="123456"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive text-center">{error}</p>}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={cancelTotpStep}
                disabled={mutation.isPending}
              >
                {t('signInPage.totp.back')}
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={mutation.isPending || totpCode.trim().length === 0}
                data-glass-press
              >
                {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('signInPage.totp.verify')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-glass-card>
      <CardHeader className="text-center">
        <CardTitle>{t('signInPage.login.title')}</CardTitle>
        <CardDescription>{t('signInPage.login.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">{t('signInPage.login.usernameLabel')}</Label>
            <Input
              id="username"
              autoComplete="username"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              {...form.register('username')}
            />
            {form.formState.errors.username && (
              <p className="text-xs text-destructive">{form.formState.errors.username.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{t('signInPage.login.passwordLabel')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
            {form.formState.errors.password && (
              <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={mutation.isPending} data-glass-press>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('signInPage.login.submit')}
          </Button>
        </form>

        <OAuthButtons />
      </CardContent>
    </Card>
  )
}

// ── Register Form ────────────────────────────────────────────────────────────

function RegisterForm() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { login } = useAuth()
  const [error, setError] = useState<string | null>(null)

  const registerSchema = useRegisterSchema()
  const form = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: { username: '', password: '', confirmPassword: '' },
  })

  const mutation = useMutation({
    mutationFn: registerApi,
    onSuccess: (data) => {
      login(data.accessToken)
      navigate(consumeReturnTo() ?? '/', { replace: true })
    },
    onError: (err) => {
      setError(getErrorMessage(err, t('signInPage.register.genericError')))
    },
  })

  const onSubmit = (data: RegisterFormData) => {
    setError(null)
    mutation.mutate({ username: data.username, password: data.password })
  }

  return (
    <Card data-glass-card>
      <CardHeader className="text-center">
        <CardTitle>{t('signInPage.register.title')}</CardTitle>
        <CardDescription>{t('signInPage.register.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reg-username">{t('signInPage.register.usernameLabel')}</Label>
            <Input
              id="reg-username"
              autoComplete="username"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              placeholder={t('signInPage.register.usernamePlaceholder')}
              {...form.register('username')}
            />
            {form.formState.errors.username && (
              <p className="text-xs text-destructive">{form.formState.errors.username.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reg-password">{t('signInPage.register.passwordLabel')}</Label>
            <Input
              id="reg-password"
              type="password"
              autoComplete="new-password"
              placeholder={t('signInPage.register.passwordPlaceholder')}
              {...form.register('password')}
            />
            {form.formState.errors.password && (
              <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reg-confirm">{t('signInPage.register.confirmLabel')}</Label>
            <Input
              id="reg-confirm"
              type="password"
              autoComplete="new-password"
              {...form.register('confirmPassword')}
            />
            {form.formState.errors.confirmPassword && (
              <p className="text-xs text-destructive">{form.formState.errors.confirmPassword.message}</p>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={mutation.isPending} data-glass-press>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('signInPage.register.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
