import type { JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AlertCircle, LoaderCircle, LockKeyhole, UserRound } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi } from '@/features/auth/auth-api'
import { authLoginResponseSchema } from '@/features/auth/auth-user'
import { createLoginSchema } from '@/features/auth/login-schema'
import { translateErrorMessage } from '@/lib/translate-error'
import { useAuthStore } from '@/stores/auth-store'

type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>
type LoginFormValues = z.infer<ReturnType<typeof createLoginSchema>>

export function LoginForm(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const startSession = useAuthStore((state) => state.startSession)
  const loginSchema = createLoginSchema()
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      login: '',
      password: '',
    },
  })
  const loginMutation = useMutation<AuthLoginResponse, Error, LoginFormValues>({
    mutationFn: authApi.login,
    onSuccess: (response: AuthLoginResponse): void => {
      startSession({ token: response.accessToken, user: response.admin })
      toast.message(t('auth.loginAcceptedTitle'), {
        description: t('auth.loginAcceptedDescription'),
      })
      navigate('/dashboard', { replace: true })
    },
  })
  function handleSubmit(values: LoginFormValues): void {
    loginMutation.mutate(values)
  }
  return (
    <Card className="border-border/70 bg-card/95">
      <CardHeader className="pb-4">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-primary shadow-sm">
          <LockKeyhole className="size-5" />
        </div>
        <CardTitle className="mt-4 text-2xl">{t('auth.loginPage.form.title')}</CardTitle>
        <CardDescription>{t('auth.loginPage.form.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={form.handleSubmit(handleSubmit)}>
          <div className="space-y-2">
            <Label htmlFor="login">{t('auth.loginPage.form.loginLabel')}</Label>
            <div className="relative">
              <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="login" autoComplete="username" className="h-11 pl-10" placeholder={t('auth.loginPage.form.loginPlaceholder')} {...form.register('login')} />
            </div>
            {form.formState.errors.login ? <p className="text-sm text-destructive">{t(form.formState.errors.login.message ?? '')}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('auth.loginPage.form.passwordLabel')}</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                className="h-11 pl-10"
                placeholder={t('auth.loginPage.form.passwordPlaceholder')}
                {...form.register('password')}
              />
            </div>
            {form.formState.errors.password ? <p className="text-sm text-destructive">{t(form.formState.errors.password.message ?? '')}</p> : null}
          </div>
          {loginMutation.error ? (
            <div className="flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{translateErrorMessage(t, loginMutation.error.message)}</span>
            </div>
          ) : null}
          <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
            {loginMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {t('auth.loginPage.form.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
