/**
 * Panel Branding tab — admin panel customization (Rezeis Admin specific).
 *
 * Reiwa-facing branding (support links, channels, public messages) lives
 * elsewhere — this tab only controls the admin panel's own appearance:
 *   - Panel display name (header / browser tab)
 *   - Panel logo URL (sidebar)
 *   - Remnawave profile naming template (since admin operates the profiles)
 */

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useForm, type FieldErrors } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, Paintbrush, Save, Upload, X } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
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
  FormMessage,
} from '@/components/ui/form'
import { api } from '@/lib/api'
import { applyAdminPwaIcon } from '@/lib/admin-pwa-icon'
import { getErrorMessage } from '@/lib/http-errors'
import {
  effectiveNamingPart,
  NAMING_ALPHABET,
  NAMING_PREFIX,
  NAMING_SEPARATOR,
  NAMING_SUFFIX,
} from './profile-naming-rule'

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

/** The naming inputs, in the order they appear — the first invalid one is where the operator is taken. */
const NAMING_FIELD_NAMES = ['namingPrefix', 'namingSeparator', 'namingSuffixBase'] as const
type NamingFieldName = (typeof NAMING_FIELD_NAMES)[number]

/**
 * How the server names each naming part in a 400 (`ProfileNamingDto`, flattened
 * by the global `ValidationPipe` as `profileNaming.<part> must be …`), and the
 * input and the words that say the same thing here.
 */
const NAMING_SERVER_FIELDS: ReadonlyArray<readonly [string, NamingFieldName, string]> = [
  ['profileNaming.prefix', 'namingPrefix', 'panelBrandingTab.naming.errors.prefix'],
  ['profileNaming.separator', 'namingSeparator', 'panelBrandingTab.naming.errors.separator'],
  ['profileNaming.suffixBase', 'namingSuffixBase', 'panelBrandingTab.naming.errors.suffixBase'],
]

/**
 * What the last press of «Save» came to, when it did not simply succeed.
 *
 *  • `refused` — nothing was saved: the form's own check refused it, or the
 *    server answered with a refusal (any 4xx but 408). `field` says whether a
 *    naming field is to blame; only then is the operator sent to "the field
 *    above".
 *  • `uncertain` — the server never said: no answer at all, a 408 (the panel
 *    cuts a request at 30 seconds while the handler goes on and commits), or
 *    a 5xx. The save may well have happened, and «Nothing was saved» would be
 *    a false statement the operator acts on.
 */
type SaveOutcome =
  | { readonly kind: 'refused'; readonly problems: readonly string[]; readonly field: boolean }
  | { readonly kind: 'uncertain' }

/** A failed save that may have been committed all the same. */
function saveMayHaveCommitted(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status
  return typeof status !== 'number' || status === 408 || status >= 500
}

/** The lines of a refused request's `message`: one per field for a `ValidationPipe` 400. */
function serverMessageLines(error: unknown): string[] {
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data
    ?.message
  if (Array.isArray(message)) {
    return message.filter((line): line is string => typeof line === 'string' && line.length > 0)
  }
  return typeof message === 'string' && message.length > 0 ? [message] : []
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
    namingPrefix: z.string().trim().regex(NAMING_PREFIX, t('panelBrandingTab.naming.errors.prefix')),
    namingSeparator: z.string().regex(NAMING_SEPARATOR, t('panelBrandingTab.naming.errors.separator')),
    namingSuffixBase: z
      .string()
      .trim()
      .regex(NAMING_SUFFIX, t('panelBrandingTab.naming.errors.suffixBase')),
  })
  type FormValues = z.infer<typeof schema>

  // A value stored before the alphabet was checked (or carried in by a config
  // import) keeps the form from saving until it is corrected — the field says
  // why. Meanwhile the server repairs it for every new profile, so the warning
  // shows the name new profiles actually get.
  const storedNaming: NonNullable<BrandingSettings['profileNaming']> = branding.profileNaming ?? {}
  const storedNamingInvalid = (['prefix', 'separator', 'suffixBase'] as const).some((part) => {
    const value = storedNaming[part]
    return typeof value === 'string' && value.length > 0 && !NAMING_ALPHABET.test(value)
  })
  const effectiveNamingExample = [
    effectiveNamingPart(storedNaming.prefix, 'prefix'),
    'john',
    effectiveNamingPart(storedNaming.suffixBase, 'suffixBase'),
  ].join(effectiveNamingPart(storedNaming.separator, 'separator'))

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    // Focus is moved by `revealField` below, which also scrolls the field to
    // the middle of the screen; two competing focus moves would fight.
    shouldFocusError: false,
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

  // ── The save gate says WHY ────────────────────────────────────────────────
  //
  // One «Save» covers the whole tab, so an invalid naming value also stops the
  // panel name and the icon from saving. A refusal — the form's own check or
  // the server's 400 — therefore takes the operator to the field and says, at
  // the button, which field and why. Five silent gates were found in this very
  // save before; this one is not allowed to be the sixth. And it says only
  // what is true: a save the server never answered may have gone through.
  //
  // Cleared in ONE place, when «Save» is pressed again: the verdict belongs to
  // the attempt it describes, and a second place would only hide the first.
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome | null>(null)
  const namingInputs = useRef<Partial<Record<NamingFieldName, HTMLInputElement | null>>>({})

  const revealField = (name: NamingFieldName) => {
    const input = namingInputs.current[name]
    if (input === null || input === undefined) return
    input.scrollIntoView({ behavior: 'smooth', block: 'center' })
    input.focus({ preventScroll: true })
  }

  const onInvalid = (errors: FieldErrors<FormValues>) => {
    const invalidNaming = NAMING_FIELD_NAMES.filter((name) => errors[name] !== undefined)
    const problems = invalidNaming
      .map((name) => errors[name]?.message)
      .filter((message): message is string => typeof message === 'string' && message.length > 0)
    setSaveOutcome({
      kind: 'refused',
      problems: problems.length > 0 ? problems : [t('panelBrandingTab.saveFailed')],
      field: invalidNaming.length > 0,
    })
    if (invalidNaming.length > 0) revealField(invalidNaming[0])
  }

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
    // The server's refusal, in its own words when this form does not know the
    // field, and on the field itself when it does — never a bare "failed".
    onError: (error) => {
      if (saveMayHaveCommitted(error)) {
        setSaveOutcome({ kind: 'uncertain' })
        toast.error(t('panelBrandingTab.saveUncertain.title'), {
          description: t('panelBrandingTab.saveUncertain.hint'),
        })
        return
      }
      const problems: string[] = []
      let firstField: NamingFieldName | null = null
      for (const line of serverMessageLines(error)) {
        const known = NAMING_SERVER_FIELDS.find(([path]) => line.startsWith(`${path} `))
        if (known === undefined) {
          problems.push(line)
          continue
        }
        const [, name, messageKey] = known
        const message = String(t(messageKey))
        form.setError(name, { type: 'server', message })
        problems.push(message)
        firstField ??= name
      }
      if (problems.length === 0) problems.push(getErrorMessage(error, t('panelBrandingTab.saveFailed')))
      setSaveOutcome({ kind: 'refused', problems, field: firstField !== null })
      if (firstField !== null) revealField(firstField)
      toast.error(t('panelBrandingTab.saveFailed'), { description: problems[0] })
    },
  })

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          setSaveOutcome(null)
          saveMutation.mutate(values)
        }, onInvalid)}
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
              <div className="space-y-1">
                <p className="text-sm font-semibold">{t('panelBrandingTab.naming.title')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('panelBrandingTab.naming.hint')}{' '}
                  <code className="rounded bg-muted px-1">{t('panelBrandingTab.naming.pattern')}</code>
                </p>
                <p className="text-xs text-muted-foreground">{t('panelBrandingTab.naming.identity')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('panelBrandingTab.naming.existingKept')}
                </p>
              </div>
              {storedNamingInvalid ? (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">
                    {t('panelBrandingTab.naming.storedInvalid', { example: effectiveNamingExample })}
                  </AlertDescription>
                </Alert>
              ) : null}
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
                        <Input
                          {...field}
                          ref={(input) => {
                            field.ref(input)
                            namingInputs.current.namingPrefix = input
                          }}
                          placeholder="rz"
                          className="h-9"
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
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
                        <Input
                          {...field}
                          ref={(input) => {
                            field.ref(input)
                            namingInputs.current.namingSeparator = input
                          }}
                          placeholder="_"
                          className="h-9"
                          maxLength={2}
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
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
                        <Input
                          {...field}
                          ref={(input) => {
                            field.ref(input)
                            namingInputs.current.namingSuffixBase = input
                          }}
                          placeholder="sub"
                          className="h-9"
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
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

            {saveOutcome?.kind === 'refused' ? (
              <Alert variant="destructive" aria-label={t('panelBrandingTab.saveBlocked.title')}>
                <AlertDescription className="space-y-1 text-xs">
                  <p className="font-semibold">{t('panelBrandingTab.saveBlocked.title')}</p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {saveOutcome.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                  <p>
                    {saveOutcome.field
                      ? t('panelBrandingTab.saveBlocked.hint')
                      : t('panelBrandingTab.saveBlocked.refusedHint')}
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}
            {saveOutcome?.kind === 'uncertain' ? (
              <Alert aria-label={t('panelBrandingTab.saveUncertain.title')}>
                <AlertDescription className="space-y-1 text-xs">
                  <p className="font-semibold">{t('panelBrandingTab.saveUncertain.title')}</p>
                  <p>{t('panelBrandingTab.saveUncertain.hint')}</p>
                </AlertDescription>
              </Alert>
            ) : null}

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
