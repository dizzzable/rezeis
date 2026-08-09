import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Shield, Loader2, Eye, EyeOff, ChevronDown } from 'lucide-react'
import { Controller, useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'
import { cn } from '@/lib/utils'
import { useHasPermission } from '@/features/rbac'

import {
  type AuthProviderIconType,
  getAuthProviderIcon,
} from './auth-provider-icons'

interface ProviderConfig {
  id: string
  type: string
  isEnabled: boolean
  displayName: string
  clientId: string | null
  frontendDomain: string | null
  backendDomain: string | null
  authorizationUrl: string | null
  tokenUrl: string | null
  realm: string | null
  providerDomain: string | null
  usePkce: boolean
  allowedEmails: string[]
  allowedTelegramIds: bigint[]
}

const PROVIDER_META: Record<AuthProviderIconType, { color: string; description: string }> = {
  TELEGRAM: { color: 'text-sky-500', description: 'Telegram Login Widget (HMAC-SHA256)' },
  GITHUB: { color: 'text-foreground', description: 'GitHub OAuth2 (user:email scope)' },
  YANDEX: { color: 'text-red-500', description: 'Yandex OAuth2' },
  KEYCLOAK: { color: 'text-purple-500', description: 'Keycloak OpenID Connect' },
  POCKETID: { color: 'text-orange-500', description: 'PocketID self-hosted identity' },
  GENERIC_OAUTH2: { color: 'text-emerald-500', description: 'Custom OAuth2 provider' },
}

interface AuthProvidersTabProps {
  /**
   * When true, renders without the page-level header because the parent
   * settings tab already shows a heading.
   */
  readonly embedded?: boolean
}

export default function AuthProvidersTab({ embedded = false }: AuthProvidersTabProps = {}) {
  const { t } = useTranslation()
  const canViewAuthProviders = useHasPermission('auth_providers', 'view')
  const canEditAuthProviders = useHasPermission('auth_providers', 'edit')
  const { data: providers, isLoading } = useQuery({
    queryKey: ['oauth', 'config'],
    queryFn: async () => {
      const res = await api.get('/admin/oauth/config')
      return expectArray<ProviderConfig>(res.data)
    },
    enabled: canViewAuthProviders,
  })

  if (!canViewAuthProviders) {
    return (
      <div className={embedded ? 'space-y-3' : 'space-y-4 pt-4'}>
        <Card>
          <CardHeader>
            <CardTitle>{t('authProviders.accessDeniedTitle')}</CardTitle>
            <CardDescription>{t('authProviders.accessDeniedDescription')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className={embedded ? 'space-y-3' : 'space-y-4 pt-4'}>
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    )
  }

  return (
    <div className={embedded ? 'space-y-3' : 'space-y-4 pt-4'}>
      {!embedded && (
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t('authProviders.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('authProviders.subtitle')}</p>
        </div>
      )}

      {/* Password (always enabled, not configurable) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
              <KeyRound className="h-4 w-4 text-emerald-500" />
            </div>
            <div>
              <CardTitle className="text-sm">{t('authProviders.password.title')}</CardTitle>
              <CardDescription className="text-xs">{t('authProviders.password.description')}</CardDescription>
            </div>
          </div>
          <Badge variant="success">{t('authProviders.enabled')}</Badge>
        </CardHeader>
      </Card>

      {/* Dynamic providers */}
      {providers?.map((provider) => (
        <ProviderCard key={provider.type} provider={provider} canEdit={canEditAuthProviders} />
      ))}
    </div>
  )
}

interface ProviderFormValues {
  readonly clientId: string
  readonly clientSecret: string
  readonly frontendDomain: string
  readonly backendDomain: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly realm: string
  readonly providerDomain: string
  readonly usePkce: boolean
  readonly allowedEmails: string
  readonly allowedTelegramIds: string
}

interface ProviderValidationMessages {
  readonly domain: string
  readonly url: string
  readonly emails: string
  readonly telegramIds: string
}

function createProviderDefaults(provider: ProviderConfig): ProviderFormValues {
  return {
    clientId: provider.clientId ?? '',
    clientSecret: '',
    frontendDomain: provider.frontendDomain ?? '',
    backendDomain: provider.backendDomain ?? '',
    authorizationUrl: provider.authorizationUrl ?? '',
    tokenUrl: provider.tokenUrl ?? '',
    realm: provider.realm ?? '',
    providerDomain: provider.providerDomain ?? '',
    usePkce: provider.usePkce,
    allowedEmails: provider.allowedEmails.join(', '),
    allowedTelegramIds: provider.allowedTelegramIds.map(String).join(', '),
  }
}

function createProviderFormSchema(providerType: string, messages: ProviderValidationMessages) {
  return z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    frontendDomain: z.string(),
    backendDomain: z.string(),
    authorizationUrl: z.string(),
    tokenUrl: z.string(),
    realm: z.string(),
    providerDomain: z.string(),
    usePkce: z.boolean(),
    allowedEmails: z.string(),
    allowedTelegramIds: z.string(),
  }).superRefine((values, ctx) => {
    addDomainIssue(ctx, ['frontendDomain'], values.frontendDomain, messages.domain)

    if (providerType !== 'TELEGRAM') {
      addUrlIssue(ctx, ['backendDomain'], values.backendDomain, messages.url)
      addEmailListIssue(ctx, ['allowedEmails'], values.allowedEmails, messages.emails)
    }

    if (providerType === 'GENERIC_OAUTH2') {
      addUrlIssue(ctx, ['authorizationUrl'], values.authorizationUrl, messages.url)
      addUrlIssue(ctx, ['tokenUrl'], values.tokenUrl, messages.url)
    }

    if (providerType === 'KEYCLOAK' || providerType === 'POCKETID') {
      addDomainIssue(ctx, ['providerDomain'], values.providerDomain, messages.domain)
    }

    if (providerType === 'TELEGRAM') {
      addTelegramIdsIssue(ctx, ['allowedTelegramIds'], values.allowedTelegramIds, messages.telegramIds)
    }
  })
}

function addDomainIssue(ctx: z.RefinementCtx, path: string[], value: string, message: string): void {
  const trimmed = value.trim()
  if (trimmed.length === 0 || isDomainLike(trimmed)) return
  ctx.addIssue({ code: 'custom', path, message })
}

function addUrlIssue(ctx: z.RefinementCtx, path: string[], value: string, message: string): void {
  const trimmed = value.trim()
  if (trimmed.length === 0 || isHttpUrl(trimmed)) return
  ctx.addIssue({ code: 'custom', path, message })
}

function addEmailListIssue(ctx: z.RefinementCtx, path: string[], value: string, message: string): void {
  const emails = splitCommaList(value)
  if (emails.every((email) => z.string().email().safeParse(email).success)) return
  ctx.addIssue({ code: 'custom', path, message })
}

function addTelegramIdsIssue(ctx: z.RefinementCtx, path: string[], value: string, message: string): void {
  const ids = splitCommaList(value)
  if (ids.every((id) => /^\d+$/.test(id) && BigInt(id) > 0n)) return
  ctx.addIssue({ code: 'custom', path, message })
}

function isDomainLike(value: string): boolean {
  if (value.includes('://') || value.includes('/') || /\s/.test(value)) return false
  const [host, port, ...rest] = value.split(':')
  if (!host || rest.length > 0) return false
  if (port !== undefined) {
    const portNumber = Number(port)
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) return false
  }
  return host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function splitCommaList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

function optionalString(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildProviderPayload(providerType: string, values: ProviderFormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    clientId: optionalString(values.clientId),
    frontendDomain: optionalString(values.frontendDomain),
    backendDomain: optionalString(values.backendDomain),
  }
  if (values.clientSecret.length > 0) payload['clientSecret'] = values.clientSecret
  if (providerType === 'GENERIC_OAUTH2') {
    payload['authorizationUrl'] = optionalString(values.authorizationUrl)
    payload['tokenUrl'] = optionalString(values.tokenUrl)
    payload['usePkce'] = values.usePkce
  }
  if (providerType === 'KEYCLOAK') {
    payload['realm'] = optionalString(values.realm)
    payload['providerDomain'] = optionalString(values.providerDomain)
  }
  if (providerType === 'POCKETID') {
    payload['providerDomain'] = optionalString(values.providerDomain)
  }
  payload['allowedEmails'] = splitCommaList(values.allowedEmails)
  if (providerType === 'TELEGRAM' && values.allowedTelegramIds.trim()) {
    payload['allowedTelegramIds'] = splitCommaList(values.allowedTelegramIds)
  }
  return payload
}

function FieldError({ message }: { readonly message?: string }): JSX.Element | null {
  if (!message) return null
  return <p className="text-[10px] text-destructive" role="alert">{message}</p>
}

function ProviderCard({ provider, canEdit }: { provider: ProviderConfig; canEdit: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [isOpen, setIsOpen] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const form = useForm<ProviderFormValues>({
    defaultValues: createProviderDefaults(provider),
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
    resolver: zodResolver(createProviderFormSchema(provider.type, {
      domain: t('authProviders.validation.domain'),
      url: t('authProviders.validation.url'),
      emails: t('authProviders.validation.emails'),
      telegramIds: t('authProviders.validation.telegramIds'),
    })) as Resolver<ProviderFormValues>,
  })
  const errors = form.formState.errors

  const providerType = provider.type as AuthProviderIconType
  const meta = PROVIDER_META[providerType] ?? PROVIDER_META.GENERIC_OAUTH2
  const Icon = getAuthProviderIcon(providerType)

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await api.put(`/admin/oauth/config/${provider.type}`, { isEnabled: enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oauth', 'config'] })
      toast.success(t('authProviders.toasts.toggled'))
    },
    onError: () => toast.error(t('authProviders.toasts.toggleFailed')),
  })

  const saveMutation = useMutation({
    mutationFn: async (values: ProviderFormValues) => {
      const payload = buildProviderPayload(provider.type, values)
      await api.put(`/admin/oauth/config/${provider.type}`, payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oauth', 'config'] })
      toast.success(t('authProviders.toasts.saved'))
    },
    onError: () => toast.error(t('authProviders.toasts.saveFailed')),
  })

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className={cn('transition-colors duration-200', isOpen && 'border-primary/40')}>
        <CardHeader className="flex flex-row items-center justify-between py-4">
          <CollapsibleTrigger className="group flex items-center gap-3 cursor-pointer hover:opacity-80">
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
                isOpen ? 'rotate-0' : '-rotate-90',
              )}
              aria-hidden
            />
            <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-muted`}>
              {/* eslint-disable-next-line react-hooks/static-components */}
              <Icon className={`h-4 w-4 ${meta.color}`} />
            </div>
            <div className="text-left">
              <CardTitle className="text-sm">{provider.displayName}</CardTitle>
              <CardDescription className="text-xs">{meta.description}</CardDescription>
            </div>
          </CollapsibleTrigger>
          <div className="flex items-center gap-3">
            <Badge variant={provider.isEnabled ? 'success' : 'secondary'}>
              {provider.isEnabled ? t('authProviders.enabled') : t('authProviders.disabled')}
            </Badge>
            {canEdit ? (
              <Switch
                checked={provider.isEnabled}
                onCheckedChange={(checked) => toggleMutation.mutate(checked)}
                disabled={toggleMutation.isPending}
                aria-label={t('authProviders.toggleAria', { name: provider.displayName })}
              />
            ) : null}
          </div>
        </CardHeader>

        <CollapsibleContent className="collapsible-animate overflow-hidden">
          <CardContent className="space-y-4 border-t pt-4">
            <form className="space-y-4" onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}>
            {/* Client ID */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Client ID</Label>
              <p className="text-xs text-muted-foreground">
                {provider.type === 'TELEGRAM' ? t('authProviders.fields.botToken') : t('authProviders.fields.clientIdHint')}
              </p>
              <Input
                {...form.register('clientId')}
                placeholder={provider.type === 'TELEGRAM' ? '1234567890:ABCdef...' : t('authProviders.fields.clientIdPlaceholder')}
                disabled={!canEdit}
                aria-invalid={!!errors.clientId}
              />
              <FieldError message={errors.clientId?.message} />
            </div>

            {/* Client Secret (not for Telegram) */}
            {provider.type !== 'TELEGRAM' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Client Secret</Label>
                <p className="text-xs text-muted-foreground">{t('authProviders.fields.clientSecretHint')}</p>
                <div className="relative">
                  <Input
                    type={showSecret ? 'text' : 'password'}
                    {...form.register('clientSecret')}
                    placeholder={t('authProviders.fields.clientSecretPlaceholder')}
                    disabled={!canEdit}
                    aria-invalid={!!errors.clientSecret}
                  />
                  {canEdit ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => setShowSecret(!showSecret)}
                      aria-label={showSecret ? 'Hide' : 'Show'}
                    >
                      {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                  ) : null}
                </div>
                <FieldError message={errors.clientSecret?.message} />
              </div>
            )}

            {/* Frontend Domain */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Frontend Domain</Label>
              <p className="text-xs text-muted-foreground">{t('authProviders.fields.frontendDomainHint')}</p>
              <Input
                {...form.register('frontendDomain')}
                placeholder="example.com"
                disabled={!canEdit}
                aria-invalid={!!errors.frontendDomain}
              />
              <FieldError message={errors.frontendDomain?.message} />
            </div>

            {/* Backend Domain */}
            {provider.type !== 'TELEGRAM' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Backend Domain</Label>
                <p className="text-xs text-muted-foreground">{t('authProviders.fields.backendDomainHint')}</p>
                <Input
                  {...form.register('backendDomain')}
                  placeholder="https://api.example.com"
                  disabled={!canEdit}
                  aria-invalid={!!errors.backendDomain}
                />
                <FieldError message={errors.backendDomain?.message} />
              </div>
            )}

            {/* Keycloak-specific fields */}
            {provider.type === 'KEYCLOAK' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Realm</Label>
                  <Input
                    {...form.register('realm')}
                    placeholder="master"
                    disabled={!canEdit}
                    aria-invalid={!!errors.realm}
                  />
                  <FieldError message={errors.realm?.message} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('authProviders.fields.keycloakDomain')}</Label>
                  <Input
                    {...form.register('providerDomain')}
                    placeholder="keycloak.example.com"
                    disabled={!canEdit}
                    aria-invalid={!!errors.providerDomain}
                  />
                  <FieldError message={errors.providerDomain?.message} />
                </div>
              </>
            )}

            {/* PocketID domain */}
            {provider.type === 'POCKETID' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('authProviders.fields.pocketidDomain')}</Label>
                <Input
                  {...form.register('providerDomain')}
                  placeholder="pocket.yoursite.com"
                  disabled={!canEdit}
                  aria-invalid={!!errors.providerDomain}
                />
                <FieldError message={errors.providerDomain?.message} />
              </div>
            )}

            {/* Generic OAuth2 fields */}
            {provider.type === 'GENERIC_OAUTH2' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Authorization URL</Label>
                  <Input
                    {...form.register('authorizationUrl')}
                    placeholder="https://example.com/oauth2/authorize"
                    disabled={!canEdit}
                    aria-invalid={!!errors.authorizationUrl}
                  />
                  <FieldError message={errors.authorizationUrl?.message} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Token URL</Label>
                  <Input
                    {...form.register('tokenUrl')}
                    placeholder="https://example.com/oauth2/token"
                    disabled={!canEdit}
                    aria-invalid={!!errors.tokenUrl}
                  />
                  <FieldError message={errors.tokenUrl?.message} />
                </div>
                <div className="flex items-center gap-2">
                  <Controller
                    control={form.control}
                    name="usePkce"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={!canEdit}
                        aria-label="PKCE"
                      />
                    )}
                  />
                  <Label className="text-xs">With PKCE</Label>
                </div>
              </>
            )}

            {/* Allowed Emails */}
            {provider.type !== 'TELEGRAM' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('authProviders.fields.allowedEmails')}</Label>
                <p className="text-xs text-muted-foreground">{t('authProviders.fields.allowedEmailsHint')}</p>
                <Input
                  {...form.register('allowedEmails')}
                  placeholder="admin@example.com, dev@example.com"
                  disabled={!canEdit}
                  aria-invalid={!!errors.allowedEmails}
                />
                <FieldError message={errors.allowedEmails?.message} />
              </div>
            )}

            {/* Allowed Telegram IDs */}
            {provider.type === 'TELEGRAM' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('authProviders.fields.allowedTelegramIds')}</Label>
                <p className="text-xs text-muted-foreground">{t('authProviders.fields.allowedTelegramIdsHint')}</p>
                <Input
                  {...form.register('allowedTelegramIds')}
                  placeholder="123456789, 987654321"
                  disabled={!canEdit}
                  aria-invalid={!!errors.allowedTelegramIds}
                />
                <FieldError message={errors.allowedTelegramIds?.message} />
              </div>
            )}

            {/* Save button */}
            {canEdit ? (
              <Button
                type="submit"
                disabled={saveMutation.isPending}
                size="sm"
              >
                {saveMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                {t('authProviders.save')}
              </Button>
            ) : null}
            </form>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
