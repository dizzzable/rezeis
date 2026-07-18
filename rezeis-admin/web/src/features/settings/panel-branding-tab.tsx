/**
 * Panel Branding tab — admin panel customization (Rezeis Admin specific).
 *
 * Reiwa-facing branding (support links, channels, public messages) lives
 * elsewhere — this tab only controls the admin panel's own appearance:
 *   - Panel display name (header / browser tab)
 *   - Panel logo URL (sidebar)
 *   - Remnawave profile naming template (since admin operates the profiles)
 */

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, Paintbrush, Save, Upload, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { api } from '@/lib/api'
import { applyAdminPwaIcon } from '@/lib/admin-pwa-icon'

interface BrandingSettings {
  readonly projectName?: string | null
  readonly brandName?: string | null
  readonly logoUrl?: string | null
  readonly adminPwaIconUrl?: string | null
  readonly profileNaming?: {
    readonly prefix?: string
    readonly separator?: string
    readonly suffixBase?: string
  } | null
}

interface AdminSettingsPayload {
  readonly branding?: BrandingSettings | null
}

export default function PanelBrandingTab() {
  const settingsQuery = useQuery<AdminSettingsPayload>({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get<AdminSettingsPayload>('/admin/settings')).data,
  })

  if (settingsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const branding = settingsQuery.data?.branding ?? {}
  return <PanelBrandingForm branding={branding} />
}

interface PanelBrandingFormProps {
  readonly branding: BrandingSettings
}

function PanelBrandingForm({ branding }: PanelBrandingFormProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const schema = z.object({
    brandName: z.string().trim(),
    logoUrl: z.string().trim(),
    adminPwaIconUrl: z.string().trim(),
    namingPrefix: z.string().trim(),
    namingSeparator: z.string().max(2),
    namingSuffixBase: z.string().trim(),
  })
  type FormValues = z.infer<typeof schema>

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      brandName: branding.projectName ?? branding.brandName ?? '',
      logoUrl: branding.logoUrl ?? '',
      adminPwaIconUrl: branding.adminPwaIconUrl ?? '',
      namingPrefix: branding.profileNaming?.prefix ?? 'rz',
      namingSeparator: branding.profileNaming?.separator ?? '_',
      namingSuffixBase: branding.profileNaming?.suffixBase ?? 'sub',
    },
  })

  // react-hook-form's `form.watch()` integration is not yet recognised by react-doctor.
  // eslint-disable-next-line react-hooks/incompatible-library
  const namingPrefix = form.watch('namingPrefix')
  const namingSeparator = form.watch('namingSeparator')
  const namingSuffixBase = form.watch('namingSuffixBase')
  // eslint-disable-next-line react-hooks/incompatible-library
  const adminPwaIconUrl = form.watch('adminPwaIconUrl')

  // Apply the saved admin PWA icon on mount so the installed-app icon reflects
  // the operator's choice even before they touch the form.
  useEffect(() => {
    applyAdminPwaIcon(branding.adminPwaIconUrl ?? null)
  }, [branding.adminPwaIconUrl])

  const iconUpload = useMutation({
    mutationFn: async (file: File): Promise<string> => {
      const fd = new FormData()
      fd.append('file', file)
      const { data } = await api.post<{ url: string }>('/admin/settings/branding/logo-upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return data.url
    },
    onSuccess: (url) => {
      form.setValue('adminPwaIconUrl', url, { shouldDirty: true })
      toast.success(t('panelBrandingTab.pwaIcon.uploaded'))
    },
    onError: () => toast.error(t('panelBrandingTab.pwaIcon.uploadFailed')),
  })
  const iconInputRef = useRef<HTMLInputElement>(null)

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) =>
      api.patch('/admin/settings/branding', {
        brandName: values.brandName,
        logoUrl: values.logoUrl,
        adminPwaIconUrl: values.adminPwaIconUrl.trim() === '' ? null : values.adminPwaIconUrl.trim(),
        profileNaming: {
          prefix: values.namingPrefix,
          separator: values.namingSeparator,
          suffixBase: values.namingSuffixBase,
        },
      }),
    onSuccess: (_data, values) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] })
      applyAdminPwaIcon(values.adminPwaIconUrl.trim() === '' ? null : values.adminPwaIconUrl.trim())
      toast.success(t('panelBrandingTab.saved'))
    },
    onError: () => toast.error(t('panelBrandingTab.saveFailed')),
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
        className="space-y-6"
      >
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
              <FormField
                control={form.control}
                name="brandName"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>{t('panelBrandingTab.panelName')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t('panelBrandingTab.panelNamePlaceholder')}
                      />
                    </FormControl>
                    <FormDescription className="text-[11px]">
                      {t('panelBrandingTab.panelNameHint')}
                    </FormDescription>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="logoUrl"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>{t('panelBrandingTab.logoUrl')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t('panelBrandingTab.logoUrlPlaceholder')}
                      />
                    </FormControl>
                    <FormDescription className="text-[11px]">
                      {t('panelBrandingTab.logoUrlHint')}
                    </FormDescription>
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            <div className="space-y-2">
              <div>
                <p className="text-sm font-semibold">{t('panelBrandingTab.pwaIcon.title')}</p>
                <p className="text-xs text-muted-foreground">{t('panelBrandingTab.pwaIcon.hint')}</p>
              </div>
              <div className="flex items-start gap-4">
                <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-muted/40">
                  {adminPwaIconUrl ? (
                    <img src={adminPwaIconUrl} alt={t('panelBrandingTab.pwaIcon.title')} className="h-full w-full object-contain" />
                  ) : (
                    <span className="px-2 text-center text-[10px] text-muted-foreground">
                      {t('panelBrandingTab.pwaIcon.previewEmpty')}
                    </span>
                  )}
                </div>
                <div className="flex-1 space-y-2">
                  <Label className="text-xs">{t('panelBrandingTab.pwaIcon.urlLabel')}</Label>
                  <div className="flex gap-2">
                    <FormField
                      control={form.control}
                      name="adminPwaIconUrl"
                      render={({ field }) => (
                        <FormItem className="flex-1 space-y-0">
                          <FormControl>
                            <Input {...field} placeholder={t('panelBrandingTab.pwaIcon.urlPlaceholder')} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <input
                      ref={iconInputRef}
                      type="file"
                      accept="image/png,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) iconUpload.mutate(file)
                        e.target.value = ''
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={iconUpload.isPending}
                      onClick={() => iconInputRef.current?.click()}
                    >
                      {iconUpload.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="mr-2 h-4 w-4" />
                      )}
                      {t('panelBrandingTab.pwaIcon.upload')}
                    </Button>
                    {adminPwaIconUrl ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={t('panelBrandingTab.pwaIcon.remove')}
                        onClick={() => form.setValue('adminPwaIconUrl', '', { shouldDirty: true })}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t('panelBrandingTab.pwaIcon.note')}</p>
                </div>
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
                <FormField
                  control={form.control}
                  name="namingPrefix"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs">
                        {t('panelBrandingTab.naming.prefix')}
                      </FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="rz" className="h-9" />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="namingSeparator"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs">
                        {t('panelBrandingTab.naming.separator')}
                      </FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="_" className="h-9" maxLength={2} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="namingSuffixBase"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs">
                        {t('panelBrandingTab.naming.suffixBase')}
                      </FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="sub" className="h-9" />
                      </FormControl>
                    </FormItem>
                  )}
                />
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

            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t('panelBrandingTab.save')}
            </Button>
          </CardContent>
        </Card>
      </form>
    </Form>
  )
}
