/**
 * Panel Branding tab — admin panel customization (Rezeis Admin specific).
 *
 * Reiwa-facing branding (support links, channels, public messages) lives
 * elsewhere — this tab only controls the admin panel's own appearance:
 *   - Panel display name (header / browser tab)
 *   - Panel logo URL (sidebar)
 *   - Remnawave profile naming template (since admin operates the profiles)
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Paintbrush, Save } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'

interface BrandingSettings {
  readonly projectName?: string | null
  readonly brandName?: string | null
  readonly logoUrl?: string | null
  readonly profileNaming?: {
    readonly prefix?: string
    readonly separator?: string
    readonly suffixBase?: string
  } | null
}

interface AdminSettingsPayload {
  readonly brandingSettings?: BrandingSettings | null
}

export default function PanelBrandingTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const settingsQuery = useQuery<AdminSettingsPayload>({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get<AdminSettingsPayload>('/admin/settings')).data,
  })

  const branding = settingsQuery.data?.brandingSettings ?? {}

  const [brandName, setBrandName] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [namingPrefix, setNamingPrefix] = useState('rz')
  const [namingSeparator, setNamingSeparator] = useState('_')
  const [namingSuffixBase, setNamingSuffixBase] = useState('sub')

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
    setBrandName(branding.projectName ?? branding.brandName ?? '')
    setLogoUrl(branding.logoUrl ?? '')
    if (branding.profileNaming) {
      setNamingPrefix(branding.profileNaming.prefix ?? 'rz')
      setNamingSeparator(branding.profileNaming.separator ?? '_')
      setNamingSuffixBase(branding.profileNaming.suffixBase ?? 'sub')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsQuery.data])

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch('/admin/settings/platform', {
        brandingSettings: {
          ...branding,
          projectName: brandName,
          brandName,
          logoUrl,
          profileNaming: {
            prefix: namingPrefix,
            separator: namingSeparator,
            suffixBase: namingSuffixBase,
          },
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      toast.success(t('panelBrandingTab.saved'))
    },
    onError: () => toast.error(t('panelBrandingTab.saveFailed')),
  })

  if (settingsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Paintbrush className="h-4 w-4" /> {t('panelBrandingTab.cardTitle')}
          </CardTitle>
          <CardDescription>
            {t('panelBrandingTab.cardDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="panel-brand-name">{t('panelBrandingTab.panelName')}</Label>
              <Input
                id="panel-brand-name"
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder={t('panelBrandingTab.panelNamePlaceholder')}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('panelBrandingTab.panelNameHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="panel-logo-url">{t('panelBrandingTab.logoUrl')}</Label>
              <Input
                id="panel-logo-url"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder={t('panelBrandingTab.logoUrlPlaceholder')}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('panelBrandingTab.logoUrlHint')}
              </p>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">{t('panelBrandingTab.naming.title')}</p>
              <p className="text-xs text-muted-foreground">
                {t('panelBrandingTab.naming.hint')}{' '}
                <code className="rounded bg-muted px-1">{'{prefix}{sep}{login}{sep}{suffix}'}</code>
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="naming-prefix" className="text-xs">
                  {t('panelBrandingTab.naming.prefix')}
                </Label>
                <Input
                  id="naming-prefix"
                  value={namingPrefix}
                  onChange={(e) => setNamingPrefix(e.target.value)}
                  placeholder="rz"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="naming-separator" className="text-xs">
                  {t('panelBrandingTab.naming.separator')}
                </Label>
                <Input
                  id="naming-separator"
                  value={namingSeparator}
                  onChange={(e) => setNamingSeparator(e.target.value)}
                  placeholder="_"
                  className="h-9"
                  maxLength={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="naming-suffix" className="text-xs">
                  {t('panelBrandingTab.naming.suffixBase')}
                </Label>
                <Input
                  id="naming-suffix"
                  value={namingSuffixBase}
                  onChange={(e) => setNamingSuffixBase(e.target.value)}
                  placeholder="sub"
                  className="h-9"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('panelBrandingTab.naming.example')}{' '}
              <code className="rounded bg-muted px-1">
                {namingPrefix}
                {namingSeparator}john{namingSeparator}
                {namingSuffixBase}
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1">
                {namingPrefix}
                {namingSeparator}john{namingSeparator}
                {namingSuffixBase}
                {namingSeparator}1
              </code>
            </p>
          </div>

          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t('panelBrandingTab.save')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
