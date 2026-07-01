import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info, KeyRound, Loader2, Save, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FadeIn } from '@/lib/motion'
import { useHasPermission } from '@/features/rbac'
import { ProviderIcon } from './provider-icons'
import {
  DISPOSABLE_MODES,
  externalAuthApi,
  type DisposableMode,
  type ExternalAuthPolicy,
  type ExternalProviderConfig,
} from './external-auth-api'

const PROVIDERS_KEY = ['admin', 'external-auth', 'providers'] as const
const POLICY_KEY = ['admin', 'external-auth', 'policy'] as const

export default function ExternalAuthPage() {
  const { t } = useTranslation()
  const canView = useHasPermission('external_auth', 'view')
  const canEdit = useHasPermission('external_auth', 'edit')

  const { data: providers, isLoading } = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: externalAuthApi.listProviders,
    enabled: canView,
  })

  if (!canView) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('externalAuthPage.accessDeniedTitle')}</CardTitle>
          <CardDescription>{t('externalAuthPage.accessDeniedDescription')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <KeyRound className="h-6 w-6" /> {t('externalAuthPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('externalAuthPage.subtitle')}</p>
        </div>
      </FadeIn>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(providers ?? []).map((provider) => (
            <ProviderCard key={provider.provider} config={provider} canEdit={canEdit} />
          ))}
        </div>
      )}

      <PolicyCard canView={canView} canEdit={canEdit} />
    </div>
  )
}

function ProviderHelp({ provider, redirectPath }: { provider: string; redirectPath: string }) {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
          aria-label={t('externalAuthPage.helpAria')}
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs whitespace-pre-line text-xs leading-relaxed">
        {t(`externalAuthPage.help.${provider}`)}
        {'\n\n'}
        {t('externalAuthPage.redirectUriHint', { path: redirectPath })}
      </TooltipContent>
    </Tooltip>
  )
}

function ProviderCard({ config, canEdit }: { config: ExternalProviderConfig; canEdit: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [displayName, setDisplayName] = useState(config.displayName)
  const [clientId, setClientId] = useState(config.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [usePkce, setUsePkce] = useState(config.usePkce)
  const [useOidc, setUseOidc] = useState(config.useOidc)
  const [scopes, setScopes] = useState(config.scopes ?? '')

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof externalAuthApi.updateProvider>[1]) =>
      externalAuthApi.updateProvider(config.provider, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY })
      toast.success(t('externalAuthPage.saved'))
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(message ?? t('externalAuthPage.saveFailed'))
    },
  })

  const isTelegram = config.usesBotToken
  // OAuth credential fields show for the pure-OAuth providers, and for Telegram
  // once the operator switches it to OIDC mode.
  const showCredentialFields = !isTelegram || useOidc
  const redirectPath = `/api/v1/auth/ext/${config.provider.toLowerCase()}/callback`

  function handleSave(): void {
    update.mutate({
      ...(isTelegram ? {} : { displayName }),
      clientId: clientId.trim() === '' ? null : clientId.trim(),
      ...(clientSecret !== '' ? { clientSecret } : {}),
      usePkce,
      ...(isTelegram ? { useOidc } : {}),
      scopes: scopes.trim() === '' ? null : scopes.trim(),
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-2.5">
          <ProviderIcon provider={config.provider} className="mt-0.5 h-6 w-6 shrink-0" />
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-1.5 text-base">
              {config.displayName}
              <ProviderHelp provider={config.provider} redirectPath={redirectPath} />
            </CardTitle>
            <CardDescription>
              {isTelegram
                ? useOidc
                  ? t('externalAuthPage.telegramOidcNote')
                  : t('externalAuthPage.telegramNote')
                : t('externalAuthPage.oauthNote')}
            </CardDescription>
          </div>
        </div>
        <Switch
          checked={config.isEnabled}
          disabled={!canEdit || update.isPending}
          onCheckedChange={(next) => update.mutate({ isEnabled: next })}
          aria-label={t('externalAuthPage.enable')}
        />
      </CardHeader>

      <CardContent className="space-y-3">
        {isTelegram && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="space-y-0.5">
              <Label className="text-xs">{t('externalAuthPage.telegramUseOidc')}</Label>
              <p className="text-[11px] text-muted-foreground">{t('externalAuthPage.telegramUseOidcHint')}</p>
            </div>
            <Switch
              checked={useOidc}
              disabled={!canEdit}
              onCheckedChange={setUseOidc}
              aria-label={t('externalAuthPage.telegramUseOidc')}
            />
          </div>
        )}

        {showCredentialFields && (
          <>
            {!isTelegram && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('externalAuthPage.displayName')}</Label>
                <Input value={displayName} disabled={!canEdit} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('externalAuthPage.clientId')}</Label>
              <Input value={clientId} disabled={!canEdit} onChange={(e) => setClientId(e.target.value)} placeholder="client-id" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('externalAuthPage.clientSecret')}</Label>
              <Input
                type="password"
                value={clientSecret}
                disabled={!canEdit}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={config.hasSecret ? '••••••••' : t('externalAuthPage.secretPlaceholder')}
              />
              <p className="text-[11px] text-muted-foreground">{t('externalAuthPage.secretHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('externalAuthPage.scopes')}</Label>
              <Input
                value={scopes}
                disabled={!canEdit}
                onChange={(e) => setScopes(e.target.value)}
                placeholder={isTelegram ? 'openid profile' : 'openid email profile'}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('externalAuthPage.redirectUri')}</Label>
              <code className="block truncate rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
                {`{origin}${redirectPath}`}
              </code>
              <p className="text-[11px] text-muted-foreground">{t('externalAuthPage.redirectUriRegisterHint')}</p>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <Label className="text-xs">{t('externalAuthPage.usePkce')}</Label>
              <Switch checked={usePkce} disabled={!canEdit} onCheckedChange={setUsePkce} aria-label={t('externalAuthPage.usePkce')} />
            </div>
          </>
        )}

        <Button size="sm" className="w-full" disabled={!canEdit || update.isPending} onClick={handleSave}>
          {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {t('externalAuthPage.save')}
        </Button>
      </CardContent>
    </Card>
  )
}

function PolicyCard({ canView, canEdit }: { canView: boolean; canEdit: boolean }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: policy } = useQuery({
    queryKey: POLICY_KEY,
    queryFn: externalAuthApi.getPolicy,
    enabled: canView,
  })

  const [draft, setDraft] = useState<ExternalAuthPolicy | null>(null)
  const current = draft ?? policy ?? null

  const update = useMutation({
    mutationFn: (input: Partial<ExternalAuthPolicy>) => externalAuthApi.updatePolicy(input),
    onSuccess: (saved) => {
      queryClient.setQueryData(POLICY_KEY, saved)
      setDraft(null)
      toast.success(t('externalAuthPage.policySaved'))
    },
    onError: () => toast.error(t('externalAuthPage.saveFailed')),
  })

  if (!current) return null

  const set = (patch: Partial<ExternalAuthPolicy>) => setDraft({ ...current, ...patch })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" /> {t('externalAuthPage.policyTitle')}
        </CardTitle>
        <CardDescription>{t('externalAuthPage.policySubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('externalAuthPage.policyMode')}</Label>
          <Select
            value={current.mode}
            onValueChange={(v) => set({ mode: v as DisposableMode })}
          >
            <SelectTrigger className="h-10" aria-label={t('externalAuthPage.policyMode')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {DISPOSABLE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`externalAuthPage.modes.${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('externalAuthPage.blocklist')}</Label>
          <Textarea
            className="min-h-24 text-xs"
            disabled={!canEdit}
            value={current.customBlocklist.join('\n')}
            onChange={(e) => set({ customBlocklist: splitDomains(e.target.value) })}
            placeholder="mailinator.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('externalAuthPage.allowlist')}</Label>
          <Textarea
            className="min-h-24 text-xs"
            disabled={!canEdit}
            value={current.allowlist.join('\n')}
            onChange={(e) => set({ allowlist: splitDomains(e.target.value) })}
            placeholder="gmail.com"
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2 md:col-span-2 xl:col-span-3">
          <Label className="text-xs">{t('externalAuthPage.gateByEmail')}</Label>
          <Switch
            checked={current.gateProvidersByEmailModule}
            disabled={!canEdit}
            onCheckedChange={(v) => set({ gateProvidersByEmailModule: v })}
            aria-label={t('externalAuthPage.gateByEmail')}
          />
        </div>
        <div className="md:col-span-2 xl:col-span-3">
          <Button
            size="sm"
            disabled={!canEdit || draft === null || update.isPending}
            onClick={() => draft && update.mutate(draft)}
          >
            {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {t('externalAuthPage.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function splitDomains(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0),
    ),
  )
}
