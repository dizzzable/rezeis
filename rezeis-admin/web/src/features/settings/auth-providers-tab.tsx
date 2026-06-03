import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Shield, Loader2, Eye, EyeOff, ChevronDown } from 'lucide-react'
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
      const res = await api.get<ProviderConfig[]>('/admin/oauth/config')
      return res.data
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

function ProviderCard({ provider, canEdit }: { provider: ProviderConfig; canEdit: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [isOpen, setIsOpen] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [formData, setFormData] = useState({
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
  })

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
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        clientId: formData.clientId || null,
        frontendDomain: formData.frontendDomain || null,
        backendDomain: formData.backendDomain || null,
      }
      if (formData.clientSecret) payload['clientSecret'] = formData.clientSecret
      if (provider.type === 'GENERIC_OAUTH2') {
        payload['authorizationUrl'] = formData.authorizationUrl || null
        payload['tokenUrl'] = formData.tokenUrl || null
        payload['usePkce'] = formData.usePkce
      }
      if (provider.type === 'KEYCLOAK') {
        payload['realm'] = formData.realm || null
        payload['providerDomain'] = formData.providerDomain || null
      }
      if (provider.type === 'POCKETID') {
        payload['providerDomain'] = formData.providerDomain || null
      }
      if (formData.allowedEmails.trim()) {
        payload['allowedEmails'] = formData.allowedEmails.split(',').map((e) => e.trim()).filter(Boolean)
      } else {
        payload['allowedEmails'] = []
      }
      if (provider.type === 'TELEGRAM' && formData.allowedTelegramIds.trim()) {
        payload['allowedTelegramIds'] = formData.allowedTelegramIds.split(',').map((id) => id.trim()).filter(Boolean)
      }
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
            {/* Client ID */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Client ID</Label>
              <p className="text-xs text-muted-foreground">
                {provider.type === 'TELEGRAM' ? t('authProviders.fields.botToken') : t('authProviders.fields.clientIdHint')}
              </p>
              <Input
                value={formData.clientId}
                onChange={(e) => setFormData({ ...formData, clientId: e.target.value })}
                placeholder={provider.type === 'TELEGRAM' ? '1234567890:ABCdef...' : t('authProviders.fields.clientIdPlaceholder')}
                disabled={!canEdit}
              />
            </div>

            {/* Client Secret (not for Telegram) */}
            {provider.type !== 'TELEGRAM' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Client Secret</Label>
                <p className="text-xs text-muted-foreground">{t('authProviders.fields.clientSecretHint')}</p>
                <div className="relative">
                  <Input
                    type={showSecret ? 'text' : 'password'}
                    value={formData.clientSecret}
                    onChange={(e) => setFormData({ ...formData, clientSecret: e.target.value })}
                    placeholder={t('authProviders.fields.clientSecretPlaceholder')}
                    disabled={!canEdit}
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
              </div>
            )}

            {/* Frontend Domain */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Frontend Domain</Label>
              <p className="text-xs text-muted-foreground">{t('authProviders.fields.frontendDomainHint')}</p>
              <Input
                value={formData.frontendDomain}
                onChange={(e) => setFormData({ ...formData, frontendDomain: e.target.value })}
                placeholder="example.com"
                disabled={!canEdit}
              />
            </div>

            {/* Backend Domain */}
            {provider.type !== 'TELEGRAM' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Backend Domain</Label>
                <p className="text-xs text-muted-foreground">{t('authProviders.fields.backendDomainHint')}</p>
                <Input
                  value={formData.backendDomain}
                  onChange={(e) => setFormData({ ...formData, backendDomain: e.target.value })}
                  placeholder="https://api.example.com"
                  disabled={!canEdit}
                />
              </div>
            )}

            {/* Keycloak-specific fields */}
            {provider.type === 'KEYCLOAK' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Realm</Label>
                  <Input
                    value={formData.realm}
                    onChange={(e) => setFormData({ ...formData, realm: e.target.value })}
                    placeholder="master"
                    disabled={!canEdit}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('authProviders.fields.keycloakDomain')}</Label>
                  <Input
                    value={formData.providerDomain}
                    onChange={(e) => setFormData({ ...formData, providerDomain: e.target.value })}
                    placeholder="keycloak.example.com"
                    disabled={!canEdit}
                  />
                </div>
              </>
            )}

            {/* PocketID domain */}
            {provider.type === 'POCKETID' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('authProviders.fields.pocketidDomain')}</Label>
                <Input
                  value={formData.providerDomain}
                  onChange={(e) => setFormData({ ...formData, providerDomain: e.target.value })}
                  placeholder="pocket.yoursite.com"
                  disabled={!canEdit}
                />
              </div>
            )}

            {/* Generic OAuth2 fields */}
            {provider.type === 'GENERIC_OAUTH2' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Authorization URL</Label>
                  <Input
                    value={formData.authorizationUrl}
                    onChange={(e) => setFormData({ ...formData, authorizationUrl: e.target.value })}
                    placeholder="https://example.com/oauth2/authorize"
                    disabled={!canEdit}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Token URL</Label>
                  <Input
                    value={formData.tokenUrl}
                    onChange={(e) => setFormData({ ...formData, tokenUrl: e.target.value })}
                    placeholder="https://example.com/oauth2/token"
                    disabled={!canEdit}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={formData.usePkce}
                    onCheckedChange={(checked) => setFormData({ ...formData, usePkce: checked })}
                    disabled={!canEdit}
                    aria-label="PKCE"
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
                  value={formData.allowedEmails}
                  onChange={(e) => setFormData({ ...formData, allowedEmails: e.target.value })}
                  placeholder="admin@example.com, dev@example.com"
                  disabled={!canEdit}
                />
              </div>
            )}

            {/* Allowed Telegram IDs */}
            {provider.type === 'TELEGRAM' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('authProviders.fields.allowedTelegramIds')}</Label>
                <p className="text-xs text-muted-foreground">{t('authProviders.fields.allowedTelegramIdsHint')}</p>
                <Input
                  value={formData.allowedTelegramIds}
                  onChange={(e) => setFormData({ ...formData, allowedTelegramIds: e.target.value })}
                  placeholder="123456789, 987654321"
                  disabled={!canEdit}
                />
              </div>
            )}

            {/* Save button */}
            {canEdit ? (
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                size="sm"
              >
                {saveMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                {t('authProviders.save')}
              </Button>
            ) : null}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
