import type { JSX } from 'react'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, LoaderCircle, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useHasPermission } from '@/features/rbac'
import { settingsApi } from '@/features/settings/settings-api'

interface ApiTokenFormValues {
  readonly name: string
}

interface CreatedTokenState {
  readonly tokenValue: string
  readonly tokenName: string
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

export function ApiTokensPage(): JSX.Element {
  const { t } = useTranslation()
  const [createdToken, setCreatedToken] = useState<CreatedTokenState | null>(null)
  const [tokenToRevoke, setTokenToRevoke] = useState<{ readonly id: string; readonly name: string } | null>(null)
  const queryClient = useQueryClient()
  const canViewTokens = useHasPermission('api_tokens', 'view')
  const canCreateTokens = useHasPermission('api_tokens', 'create')
  const canDeleteTokens = useHasPermission('api_tokens', 'delete')

  const tokensQuery = useQuery({
    queryKey: ['settings', 'apiTokens'],
    queryFn: settingsApi.listApiTokens,
    enabled: canViewTokens,
  })

  const form = useForm<ApiTokenFormValues>({
    defaultValues: { name: '' },
  })

  const createMutation = useMutation({
    mutationFn: settingsApi.createApiToken,
    onSuccess: (response): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'apiTokens'] })
      setCreatedToken({
        tokenValue: response.token,
        tokenName: response.name,
      })
      form.reset({ name: '' })
      toast.success(t('settings.apiTokens.createSuccess'))
    },
    onError: (): void => {
      toast.error(t('settings.apiTokens.errors.create'))
    },
  })

  const revokeMutation = useMutation({
    mutationFn: settingsApi.revokeApiToken,
    onSuccess: (): void => {
      void queryClient.invalidateQueries({ queryKey: ['settings', 'apiTokens'] })
      toast.success(t('settings.apiTokens.revokeSuccess'))
      setTokenToRevoke(null)
    },
    onError: (): void => {
      toast.error(t('settings.apiTokens.errors.revoke'))
      setTokenToRevoke(null)
    },
  })

  function handleSubmit(values: ApiTokenFormValues): void {
    const trimmedName = values.name.trim()
    if (trimmedName.length === 0) {
      toast.error(t('settings.apiTokens.errors.nameRequired'))
      return
    }
    if (canCreateTokens) {
      createMutation.mutate({ name: trimmedName })
    }
  }

  function handleCopyToken(): void {
    if (!createdToken) {
      return
    }
    void navigator.clipboard.writeText(createdToken.tokenValue).then((): void => {
      toast.success(t('settings.apiTokens.copySuccess'))
    })
  }

  const tokens = tokensQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-[28px] border border-border/80 bg-card/90 px-5 py-5 shadow-sm backdrop-blur sm:px-6">
        <Badge className="w-fit">{t('settings.badge')}</Badge>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">{t('settings.apiTokens.title')}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('settings.apiTokens.summary')}</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-xs text-muted-foreground">
            <code>POST /api/admin/api-tokens</code>
          </div>
        </div>
      </div>

      {!canViewTokens ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.apiTokens.accessDeniedTitle')}</CardTitle>
            <CardDescription>{t('settings.apiTokens.accessDeniedDescription')}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {canViewTokens ? (
      <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
        {canCreateTokens ? (
          <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                <KeyRound className="size-5" />
              </div>
              <div>
                <CardTitle>{t('settings.apiTokens.createTitle')}</CardTitle>
                <CardDescription>{t('settings.apiTokens.createDescription')}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={form.handleSubmit(handleSubmit)}>
              <div className="space-y-2">
                <Label htmlFor="tokenName">{t('settings.apiTokens.form.nameLabel')}</Label>
                <Input
                  id="tokenName"
                  placeholder={t('settings.apiTokens.form.namePlaceholder')}
                  autoComplete="off"
                  {...form.register('name', { required: true, minLength: 1, maxLength: 80 })}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.apiTokens.form.nameHint')}
                </p>
              </div>

              <Button type="submit" className="w-full gap-2" disabled={createMutation.isPending}>
                {createMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {t('settings.apiTokens.submit')}
              </Button>

              {createdToken ? (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="mt-0.5 size-5 text-emerald-600 dark:text-emerald-400" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="text-sm font-semibold">
                        {t('settings.apiTokens.secretTitle')}: <span className="font-mono">{createdToken.tokenName}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{t('settings.apiTokens.secretDescription')}</p>
                      <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background px-3 py-2 font-mono text-xs">
                        <code className="min-w-0 flex-1 truncate">{createdToken.tokenValue}</code>
                        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={handleCopyToken}>
                          <Copy className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </form>
          </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t('settings.apiTokens.listTitle')}</CardTitle>
            <CardDescription>{t('settings.apiTokens.listDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tokensQuery.isLoading ? (
              <div className="rounded-2xl border border-border/70 bg-background/70 p-4 text-sm text-muted-foreground">
                {t('settings.apiTokens.state.loading')}
              </div>
            ) : null}

            {tokensQuery.error ? (
              <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                {t('settings.apiTokens.errors.list')}
              </div>
            ) : null}

            {!tokensQuery.isLoading && !tokensQuery.error && tokens.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-border/80 bg-background/60 px-6 py-12 text-center">
                <p className="text-base font-semibold">{t('settings.apiTokens.emptyTitle')}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('settings.apiTokens.emptyDescription')}</p>
              </div>
            ) : null}

            {tokens.map((token) => (
              <div
                key={token.id}
                className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/80 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{token.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono">
                      {token.prefix ? `${token.prefix}…` : t('settings.apiTokens.values.prefixHidden')}
                    </span>
                    <span>·</span>
                    <span>
                      {t('settings.apiTokens.values.createdAt', { value: formatDateTime(token.createdAt) })}
                    </span>
                    <span>·</span>
                    <span>
                      {token.lastUsedAt
                        ? t('settings.apiTokens.values.lastUsedAt', {
                            value: formatDateTime(token.lastUsedAt),
                          })
                        : t('settings.apiTokens.values.neverUsed')}
                    </span>
                  </div>
                </div>
                {canDeleteTokens ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-destructive hover:text-destructive"
                    onClick={(): void => setTokenToRevoke({ id: token.id, name: token.name })}
                    disabled={revokeMutation.isPending}
                  >
                    <Trash2 className="size-3.5" />
                    {t('settings.apiTokens.revokeAction')}
                  </Button>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      ) : null}

      <Dialog open={canDeleteTokens && tokenToRevoke !== null} onOpenChange={(open): void => { if (!open) setTokenToRevoke(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.apiTokens.confirmation.title')}</DialogTitle>
            <DialogDescription>{t('settings.apiTokens.confirmation.revokeDescription')}</DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl border border-border/70 bg-background/70 p-3 text-sm">
            <p className="font-medium">{tokenToRevoke?.name}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => setTokenToRevoke(null)}>
              {t('settings.apiTokens.confirmation.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={(): void => {
                if (tokenToRevoke) {
                  revokeMutation.mutate(tokenToRevoke.id)
                }
              }}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? (
                <LoaderCircle className="mr-2 size-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 size-4" />
              )}
              {t('settings.apiTokens.revokeAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
