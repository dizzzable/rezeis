import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Search, LoaderCircle, Link2, CreditCard, ShieldCheck, UserRound, ExternalLink } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { usersApi } from '@/features/users/users-api'
import { createUserSearchSchema } from '@/features/users/user-search-schema'
import { translateErrorMessage } from '@/lib/translate-error'

interface SummaryItem {
  readonly label: string
  readonly value: ReactNode
}

type UserSearchFormValues = z.infer<ReturnType<typeof createUserSearchSchema>>
type UserSearchResult = Awaited<ReturnType<typeof usersApi.searchUser>>

const EXACTLY_ONE_IDENTIFIER_ERROR: string = 'users.searchPage.form.errors.exactlyOneIdentifier'

function readTrimmedValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalizedValue: string = value.trim()
  return normalizedValue.length > 0 ? normalizedValue : null
}

function formatDateTimeValue(value: string | null | undefined, locale: string, fallback: string): string {
  const normalizedValue: string | null = readTrimmedValue(value)
  if (!normalizedValue) {
    return fallback
  }
  const date: Date = new Date(normalizedValue)
  if (Number.isNaN(date.getTime())) {
    return normalizedValue
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatTextValue(value: string | null | undefined, fallback: string): string {
  return readTrimmedValue(value) ?? fallback
}

function formatNumberValue(value: number | null | undefined, fallback: string): string {
  return typeof value === 'number' ? String(value) : fallback
}

function formatBooleanValue(value: boolean, yesLabel: string, noLabel: string): string {
  return value ? yesLabel : noLabel
}

function readFormErrorMessage(message: string | undefined): string | null {
  return typeof message === 'string' ? message : null
}

function renderSummaryItems(items: readonly SummaryItem[]): JSX.Element {
  return (
    <dl className="space-y-3">
      {items.map((item: SummaryItem) => (
        <div key={item.label} className="grid gap-1 rounded-2xl border border-border/70 bg-background/70 p-4">
          <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{item.label}</dt>
          <dd className="text-sm font-medium break-all text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url: URL = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function renderConfigLink(configUrl: string | null, fallback: string, linkLabel: string): ReactNode {
  const normalizedValue: string | null = readTrimmedValue(configUrl)
  if (!normalizedValue) {
    return fallback
  }
  if (!isSafeHttpUrl(normalizedValue)) {
    return normalizedValue
  }
  return (
    <a className="inline-flex items-center gap-1 text-primary underline underline-offset-4" href={normalizedValue} rel="noreferrer" target="_blank">
      {linkLabel}
      <ExternalLink className="size-3.5" />
    </a>
  )
}

function renderPlaceholderCard(title: string, description: string, emptyTitle: string, emptyDescription: string, icon: JSX.Element): JSX.Element {
  return (
    <Card className="border-border/70">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">{icon}</div>
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-3xl border border-dashed border-border/80 bg-background/80 px-6 py-12 text-center">
          <p className="text-base font-semibold">{emptyTitle}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{emptyDescription}</p>
        </div>
      </CardContent>
    </Card>
  )
}

export function UserSearchPage(): JSX.Element {
  const { t, i18n } = useTranslation()
  const userSearchSchema = createUserSearchSchema()
  const locale: string = i18n.language === 'ru' ? 'ru-RU' : 'en-US'
  const fallbackValue: string = t('users.searchPage.values.notAvailable')
  const yesLabel: string = t('users.searchPage.values.yes')
  const noLabel: string = t('users.searchPage.values.no')
  const [currentResult, setCurrentResult] = useState<UserSearchResult | null>(null)
  const form = useForm<UserSearchFormValues>({
    resolver: zodResolver(userSearchSchema),
    defaultValues: {
      userId: '',
      telegramId: '',
      email: '',
      login: '',
    },
  })
  const searchMutation = useMutation<UserSearchResult, Error, UserSearchFormValues>({
    mutationFn: usersApi.searchUser,
    onMutate: (): void => {
      setCurrentResult(null)
    },
    onSuccess: (result: UserSearchResult): void => {
      setCurrentResult(result)
    },
  })
  const hasResolvedSearch: boolean = currentResult !== null
  const generalIdentifierErrorMessage: string | null = [form.formState.errors.userId, form.formState.errors.telegramId, form.formState.errors.email, form.formState.errors.login]
    .map((error) => readFormErrorMessage(error?.message))
    .find((message: string | null): boolean => message === EXACTLY_ONE_IDENTIFIER_ERROR) ?? null
  const sessionSummaryItems: readonly SummaryItem[] | null = currentResult
    ? [
        { label: t('users.searchPage.fields.userId'), value: currentResult.session.id },
        { label: t('users.searchPage.fields.telegramId'), value: formatTextValue(currentResult.session.telegramId, fallbackValue) },
        { label: t('users.searchPage.fields.username'), value: formatTextValue(currentResult.session.username, fallbackValue) },
        { label: t('users.searchPage.fields.displayName'), value: formatTextValue(currentResult.session.name, fallbackValue) },
        { label: t('users.searchPage.fields.email'), value: formatTextValue(currentResult.session.email, fallbackValue) },
        { label: t('users.searchPage.fields.role'), value: formatTextValue(currentResult.session.role, fallbackValue) },
        { label: t('users.searchPage.fields.language'), value: formatTextValue(currentResult.session.language, fallbackValue) },
        { label: t('users.searchPage.fields.personalDiscount'), value: formatNumberValue(currentResult.session.personalDiscount, fallbackValue) },
        { label: t('users.searchPage.fields.purchaseDiscount'), value: formatNumberValue(currentResult.session.purchaseDiscount, fallbackValue) },
        { label: t('users.searchPage.fields.points'), value: formatNumberValue(currentResult.session.points, fallbackValue) },
        { label: t('users.searchPage.fields.maxSubscriptions'), value: formatNumberValue(currentResult.session.maxSubscriptions, fallbackValue) },
        { label: t('users.searchPage.fields.isBlocked'), value: formatBooleanValue(currentResult.session.isBlocked, yesLabel, noLabel) },
        { label: t('users.searchPage.fields.isBotBlocked'), value: formatBooleanValue(currentResult.session.isBotBlocked, yesLabel, noLabel) },
        { label: t('users.searchPage.fields.isRulesAccepted'), value: formatBooleanValue(currentResult.session.isRulesAccepted, yesLabel, noLabel) },
        { label: t('users.searchPage.fields.createdAt'), value: formatDateTimeValue(currentResult.session.createdAt, locale, fallbackValue) },
        { label: t('users.searchPage.fields.updatedAt'), value: formatDateTimeValue(currentResult.session.updatedAt, locale, fallbackValue) },
      ]
    : null
  const webAccountSummaryItems: readonly SummaryItem[] | null = currentResult?.session.webAccount
    ? [
        { label: t('users.searchPage.fields.webAccountId'), value: currentResult.session.webAccount.id },
        { label: t('users.searchPage.fields.login'), value: formatTextValue(currentResult.session.webAccount.login, fallbackValue) },
        { label: t('users.searchPage.fields.loginNormalized'), value: formatTextValue(currentResult.session.webAccount.loginNormalized, fallbackValue) },
        { label: t('users.searchPage.fields.email'), value: formatTextValue(currentResult.session.webAccount.email, fallbackValue) },
        { label: t('users.searchPage.fields.emailNormalized'), value: formatTextValue(currentResult.session.webAccount.emailNormalized, fallbackValue) },
        { label: t('users.searchPage.fields.emailVerifiedAt'), value: formatDateTimeValue(currentResult.session.webAccount.emailVerifiedAt, locale, fallbackValue) },
        {
          label: t('users.searchPage.fields.requiresPasswordChange'),
          value: formatBooleanValue(currentResult.session.webAccount.requiresPasswordChange, yesLabel, noLabel),
        },
        {
          label: t('users.searchPage.fields.linkPromptSnoozeUntil'),
          value: formatDateTimeValue(currentResult.session.webAccount.linkPromptSnoozeUntil, locale, fallbackValue),
        },
        {
          label: t('users.searchPage.fields.credentialsBootstrappedAt'),
          value: formatDateTimeValue(currentResult.session.webAccount.credentialsBootstrappedAt, locale, fallbackValue),
        },
        { label: t('users.searchPage.fields.createdAt'), value: formatDateTimeValue(currentResult.session.webAccount.createdAt, locale, fallbackValue) },
        { label: t('users.searchPage.fields.updatedAt'), value: formatDateTimeValue(currentResult.session.webAccount.updatedAt, locale, fallbackValue) },
      ]
    : null
  const subscriptionSummaryItems: readonly SummaryItem[] | null = currentResult?.subscription
    ? [
        { label: t('users.searchPage.fields.subscriptionId'), value: currentResult.subscription.id },
        { label: t('users.searchPage.fields.status'), value: formatTextValue(currentResult.subscription.status, fallbackValue) },
        { label: t('users.searchPage.fields.isTrial'), value: formatBooleanValue(currentResult.subscription.isTrial, yesLabel, noLabel) },
        { label: t('users.searchPage.fields.planName'), value: formatTextValue(currentResult.subscription.plan?.name, fallbackValue) },
        { label: t('users.searchPage.fields.planType'), value: formatTextValue(currentResult.subscription.plan?.type, fallbackValue) },
        { label: t('users.searchPage.fields.trafficLimit'), value: formatNumberValue(currentResult.subscription.trafficLimit, fallbackValue) },
        { label: t('users.searchPage.fields.deviceLimit'), value: formatNumberValue(currentResult.subscription.deviceLimit, fallbackValue) },
        {
          label: t('users.searchPage.fields.configUrl'),
          value: renderConfigLink(currentResult.subscription.configUrl, fallbackValue, t('users.searchPage.values.openLink')),
        },
        { label: t('users.searchPage.fields.startedAt'), value: formatDateTimeValue(currentResult.subscription.startedAt, locale, fallbackValue) },
        { label: t('users.searchPage.fields.expiresAt'), value: formatDateTimeValue(currentResult.subscription.expiresAt, locale, fallbackValue) },
        { label: t('users.searchPage.fields.createdAt'), value: formatDateTimeValue(currentResult.subscription.createdAt, locale, fallbackValue) },
        { label: t('users.searchPage.fields.updatedAt'), value: formatDateTimeValue(currentResult.subscription.updatedAt, locale, fallbackValue) },
      ]
    : null
  function handleSubmit(values: UserSearchFormValues): void {
    searchMutation.mutate(values)
  }
  return (
    <div className="space-y-4">
      <Card className="border-border/70">
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Badge className="w-fit">{t('users.badge')}</Badge>
                <Badge variant="outline">{t('users.searchPage.readOnly')}</Badge>
              </div>
              <CardTitle className="text-2xl">{t('users.pages.search.title')}</CardTitle>
              <CardDescription className="max-w-3xl">{t('users.searchPage.summary')}</CardDescription>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">{t('users.searchPage.dataSource')}</div>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-6" onSubmit={form.handleSubmit(handleSubmit)}>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="userId">{t('users.searchPage.form.userIdLabel')}</Label>
                <Input id="userId" placeholder={t('users.searchPage.form.userIdPlaceholder')} {...form.register('userId')} />
                {form.formState.errors.userId && form.formState.errors.userId.message !== EXACTLY_ONE_IDENTIFIER_ERROR ? (
                  <p className="text-sm text-destructive">{t(form.formState.errors.userId.message)}</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="telegramId">{t('users.searchPage.form.telegramIdLabel')}</Label>
                <Input id="telegramId" inputMode="numeric" placeholder={t('users.searchPage.form.telegramIdPlaceholder')} {...form.register('telegramId')} />
                {form.formState.errors.telegramId && form.formState.errors.telegramId.message !== EXACTLY_ONE_IDENTIFIER_ERROR ? (
                  <p className="text-sm text-destructive">{t(form.formState.errors.telegramId.message)}</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{t('users.searchPage.form.emailLabel')}</Label>
                <Input id="email" autoComplete="email" placeholder={t('users.searchPage.form.emailPlaceholder')} {...form.register('email')} />
                {form.formState.errors.email && form.formState.errors.email.message !== EXACTLY_ONE_IDENTIFIER_ERROR ? (
                  <p className="text-sm text-destructive">{t(form.formState.errors.email.message)}</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="login">{t('users.searchPage.form.loginLabel')}</Label>
                <Input id="login" autoComplete="username" placeholder={t('users.searchPage.form.loginPlaceholder')} {...form.register('login')} />
                {form.formState.errors.login && form.formState.errors.login.message !== EXACTLY_ONE_IDENTIFIER_ERROR ? (
                  <p className="text-sm text-destructive">{t(form.formState.errors.login.message)}</p>
                ) : null}
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4 text-sm text-muted-foreground">{t('users.searchPage.form.hint')}</div>
            {generalIdentifierErrorMessage ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive">{t(generalIdentifierErrorMessage)}</div>
            ) : null}
            {searchMutation.error ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive">
                <p className="font-medium">{t('users.searchPage.state.lookupFailedTitle')}</p>
                <p className="mt-1">{translateErrorMessage(t, searchMutation.error.message)}</p>
                <p className="mt-2 text-destructive/80">{t('users.searchPage.state.lookupFailedDescription')}</p>
              </div>
            ) : null}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{searchMutation.isPending ? t('users.searchPage.state.searching') : t('users.searchPage.state.ready')}</p>
              <Button type="submit" disabled={searchMutation.isPending}>
                {searchMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
                {t('users.searchPage.form.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
        <CardFooter className="pt-0 text-sm text-muted-foreground">{t('users.searchPage.form.description')}</CardFooter>
      </Card>
      <div className="grid gap-4 xl:grid-cols-3">
        {sessionSummaryItems ? (
          <Card className="border-border/70">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                  <UserRound className="size-5" />
                </div>
                <div>
                  <CardTitle>{t('users.searchPage.cards.sessionTitle')}</CardTitle>
                  <CardDescription>{t('users.searchPage.cards.sessionDescription')}</CardDescription>
                </div>
              </div>
              <CardAction className="flex gap-2">
                <Badge variant={currentResult?.session.isBlocked ? 'destructive' : 'secondary'}>
                  {currentResult?.session.isBlocked ? t('users.searchPage.values.blocked') : t('users.searchPage.values.active')}
                </Badge>
                <Badge variant={currentResult?.session.isRulesAccepted ? 'secondary' : 'outline'}>
                  {currentResult?.session.isRulesAccepted ? t('users.searchPage.values.rulesAccepted') : t('users.searchPage.values.rulesPending')}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent>{renderSummaryItems(sessionSummaryItems)}</CardContent>
          </Card>
        ) : (
          renderPlaceholderCard(
            t('users.searchPage.cards.sessionTitle'),
            t('users.searchPage.cards.sessionDescription'),
            t('users.searchPage.state.idleTitle'),
            t('users.searchPage.state.idleDescription'),
            <UserRound className="size-5" />,
          )
        )}
        {webAccountSummaryItems ? (
          <Card className="border-border/70">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                  <Link2 className="size-5" />
                </div>
                <div>
                  <CardTitle>{t('users.searchPage.cards.webAccountTitle')}</CardTitle>
                  <CardDescription>{t('users.searchPage.cards.webAccountDescription')}</CardDescription>
                </div>
              </div>
              <CardAction className="flex gap-2">
                <Badge variant={currentResult?.session.webAccount?.emailVerifiedAt ? 'secondary' : 'outline'}>
                  {currentResult?.session.webAccount?.emailVerifiedAt ? t('users.searchPage.values.verified') : t('users.searchPage.values.notVerified')}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent>{renderSummaryItems(webAccountSummaryItems)}</CardContent>
          </Card>
        ) : hasResolvedSearch ? (
          renderPlaceholderCard(
            t('users.searchPage.cards.webAccountTitle'),
            t('users.searchPage.cards.webAccountDescription'),
            t('users.searchPage.values.noWebAccountTitle'),
            t('users.searchPage.values.noWebAccountDescription'),
            <Link2 className="size-5" />,
          )
        ) : (
          renderPlaceholderCard(
            t('users.searchPage.cards.webAccountTitle'),
            t('users.searchPage.cards.webAccountDescription'),
            t('users.searchPage.state.idleLinkedAccountTitle'),
            t('users.searchPage.state.idleLinkedAccountDescription'),
            <Link2 className="size-5" />,
          )
        )}
        {subscriptionSummaryItems ? (
          <Card className="border-border/70">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                  <CreditCard className="size-5" />
                </div>
                <div>
                  <CardTitle>{t('users.searchPage.cards.subscriptionTitle')}</CardTitle>
                  <CardDescription>{t('users.searchPage.cards.subscriptionDescription')}</CardDescription>
                </div>
              </div>
              <CardAction className="flex gap-2">
                <Badge variant="outline">{formatTextValue(currentResult?.subscription?.status, fallbackValue)}</Badge>
                <Badge variant={currentResult?.subscription?.isTrial ? 'secondary' : 'outline'}>
                  {currentResult?.subscription?.isTrial ? t('users.searchPage.values.trial') : t('users.searchPage.values.paid')}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent>{renderSummaryItems(subscriptionSummaryItems)}</CardContent>
          </Card>
        ) : hasResolvedSearch ? (
          renderPlaceholderCard(
            t('users.searchPage.cards.subscriptionTitle'),
            t('users.searchPage.cards.subscriptionDescription'),
            t('users.searchPage.values.noSubscriptionTitle'),
            t('users.searchPage.values.noSubscriptionDescription'),
            <ShieldCheck className="size-5" />,
          )
        ) : (
          renderPlaceholderCard(
            t('users.searchPage.cards.subscriptionTitle'),
            t('users.searchPage.cards.subscriptionDescription'),
            t('users.searchPage.state.idleSubscriptionTitle'),
            t('users.searchPage.state.idleSubscriptionDescription'),
            <ShieldCheck className="size-5" />,
          )
        )}
      </div>
    </div>
  )
}
