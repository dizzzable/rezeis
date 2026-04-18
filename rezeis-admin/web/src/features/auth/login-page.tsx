import type { JSX } from 'react'
import { ArrowRight, ShieldCheck, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LoginForm } from '@/features/auth/login-form'

export function LoginPage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <main className="min-h-screen px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto grid min-h-[calc(100vh-2rem)] max-w-6xl gap-4 lg:grid-cols-[1.1fr_0.9fr] lg:gap-6">
        <section className="relative overflow-hidden rounded-[32px] border border-border/80 bg-[linear-gradient(135deg,oklch(0.56_0.147_248.72)_0%,oklch(0.62_0.104_214.88)_48%,oklch(0.36_0.058_229.13)_100%)] p-8 text-primary-foreground shadow-sm sm:p-10">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.22),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(255,255,255,0.14),transparent_26%)]" />
          <div className="relative flex h-full flex-col justify-between gap-10">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary-foreground/70">{t('auth.loginPage.eyebrow')}</p>
              <h1 className="mt-5 max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl">{t('auth.loginPage.title')}</h1>
              <p className="mt-5 max-w-lg text-sm leading-7 text-primary-foreground/80 sm:text-base">{t('auth.loginPage.description')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <article className="rounded-3xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm">
                <ShieldCheck className="size-5" />
                <p className="mt-4 text-sm font-semibold">{t('auth.loginPage.cards.auth.title')}</p>
                <p className="mt-2 text-sm text-primary-foreground/75">{t('auth.loginPage.cards.auth.description')}</p>
              </article>
              <article className="rounded-3xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm">
                <Sparkles className="size-5" />
                <p className="mt-4 text-sm font-semibold">{t('auth.loginPage.cards.shell.title')}</p>
                <p className="mt-2 text-sm text-primary-foreground/75">{t('auth.loginPage.cards.shell.description')}</p>
              </article>
              <article className="rounded-3xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm">
                <ArrowRight className="size-5" />
                <p className="mt-4 text-sm font-semibold">{t('auth.loginPage.cards.foundation.title')}</p>
                <p className="mt-2 text-sm text-primary-foreground/75">{t('auth.loginPage.cards.foundation.description')}</p>
              </article>
            </div>
          </div>
        </section>
        <section className="flex items-center justify-center rounded-[32px] border border-border/80 bg-background/75 p-4 shadow-sm backdrop-blur sm:p-6 lg:p-8">
          <div className="w-full max-w-md">
            <LoginForm />
          </div>
        </section>
      </div>
    </main>
  )
}
