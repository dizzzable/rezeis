import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  History,
  Plus,
  Rocket,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

import {
  LANDING_ANIMATIONS,
  LANDING_BACKGROUNDS,
  LANDING_BUILDER_KEYS,
  LANDING_SECTION_TYPES,
  LANDING_SURFACE_STYLES,
  LandingDraftConflictError,
  LandingPublishIncompleteError,
  landingBuilderApi,
  type LandingAnimation,
  type LandingBackground,
  type LandingConfig,
  type LandingPublishStrictIssue,
  type LandingRevisionMeta,
  type LandingSectionType,
  type LandingSurfaceStyle,
} from './landing-builder-api'
import { SectionEditor } from './section-editor'
import { buildDefaultSection, cloneSection, configMissingLocales, missingLocales } from './section-defaults'
import { LandingPreview, type PreviewWidth } from './preview/landing-preview'
import { LANDING_TEMPLATES, type LandingTemplate } from './templates'

export default function LandingBuilderPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: LANDING_BUILDER_KEYS.all,
    queryFn: () => landingBuilderApi.get(),
  })

  const [config, setConfig] = useState<LandingConfig | null>(null)
  const [version, setVersion] = useState(0)
  const [publishedSnapshot, setPublishedSnapshot] = useState<string>('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [previewWidth, setPreviewWidth] = useState<PreviewWidth>('mobile')
  const [previewLocale, setPreviewLocale] = useState<string>('ru')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [conflictVersion, setConflictVersion] = useState<number | null>(null)
  const [publishIssues, setPublishIssues] = useState<LandingPublishStrictIssue[] | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null)
  const [templateTarget, setTemplateTarget] = useState<LandingTemplate | null>(null)
  const dirtyRef = useRef(false)

  useEffect(() => {
    if (data?.draft) {
      /* eslint-disable react-hooks/set-state-in-effect -- seed local editor state from the async query */
      setConfig(data.draft)
      setVersion(data.version)
      setPreviewLocale(data.draft.defaultLocale)
      setPublishedSnapshot(
        data.published && 'sections' in data.published ? JSON.stringify(data.published) : '',
      )
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: (payload: { config: LandingConfig; version: number }) =>
      landingBuilderApi.saveDraft(payload.config, payload.version),
    onSuccess: (result) => {
      setVersion(result.version)
      dirtyRef.current = false
    },
    onError: (error) => {
      if (error instanceof LandingDraftConflictError) {
        setConflictVersion(error.currentVersion)
      } else {
        toast.error(t('landingBuilderPage.toasts.saveFailed'))
      }
    },
  })

  // Debounced autosave whenever the local config changes after a user edit.
  useEffect(() => {
    if (config === null || !dirtyRef.current) return
    const handle = setTimeout(() => {
      saveMutation.mutate({ config, version })
    }, 800)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  const publishMutation = useMutation({
    mutationFn: () => landingBuilderApi.publish(),
    onSuccess: () => {
      setPublishIssues(null)
      void queryClient.invalidateQueries({ queryKey: LANDING_BUILDER_KEYS.all })
      toast.success(t('landingBuilderPage.toasts.published'))
    },
    onError: (error) => {
      if (error instanceof LandingPublishIncompleteError) {
        setPublishIssues(error.issues)
      } else {
        toast.error(t('landingBuilderPage.toasts.publishFailed'))
      }
    },
  })

  const rollbackMutation = useMutation({
    mutationFn: (revisionId: string) => landingBuilderApi.rollback(revisionId),
    onSuccess: () => {
      setRollbackTarget(null)
      void queryClient.invalidateQueries({ queryKey: LANDING_BUILDER_KEYS.all })
      toast.success(t('landingBuilderPage.toasts.rolledBack'))
    },
    onError: () => toast.error(t('landingBuilderPage.toasts.rollbackFailed')),
  })

  const update = (next: LandingConfig): void => {
    dirtyRef.current = true
    setConfig(next)
  }

  const hasDraftChanges = useMemo(() => {
    if (config === null) return false
    return publishedSnapshot === '' || JSON.stringify(config) !== publishedSnapshot
  }, [config, publishedSnapshot])

  const publishBlocked = config !== null && configMissingLocales(config.sections, config.locales)

  if (isLoading || config === null) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  const addSection = (type: LandingSectionType): void => {
    update({ ...config, sections: [...config.sections, buildDefaultSection(type, config.locales)] })
  }
  const moveSection = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= config.sections.length) return
    const next = [...config.sections]
    const [removed] = next.splice(index, 1)
    next.splice(target, 0, removed)
    update({ ...config, sections: next })
  }
  const duplicateSection = (index: number): void => {
    const next = [...config.sections]
    next.splice(index + 1, 0, cloneSection(config.sections[index]))
    update({ ...config, sections: next })
  }
  const deleteSection = (index: number): void => {
    update({ ...config, sections: config.sections.filter((_, i) => i !== index) })
  }
  const toggleVisible = (index: number): void => {
    update({
      ...config,
      sections: config.sections.map((s, i) => (i === index ? { ...s, visible: !s.visible } : s)),
    })
  }
  const reorderSection = (from: number, to: number): void => {
    if (from === to || from < 0 || to < 0 || from >= config.sections.length) return
    const next = [...config.sections]
    const [removed] = next.splice(from, 1)
    next.splice(to, 0, removed)
    update({ ...config, sections: next })
  }
  // Select a section from the preview: highlight it and expand its editor card.
  const selectSection = (id: string): void => {
    setSelectedId(id)
    setCollapsed((c) => ({ ...c, [id]: false }))
  }
  const applyTemplate = (template: LandingTemplate): void => {
    update({
      ...config,
      theme: template.theme,
      sections: template.sections.map((s) => ({ ...s, id: `${s.type}-${Math.random().toString(36).slice(2, 8)}` })),
    })
  }

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('landingBuilderPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('landingBuilderPage.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => update({ ...config, enabled: checked })}
              aria-label={t('landingBuilderPage.enabledToggle')}
            />
            <span className="text-sm">{t('landingBuilderPage.enabledToggle')}</span>
          </div>
          <TemplatePicker onPick={(tpl) => setTemplateTarget(tpl)} />
          <RevisionsDrawer
            onRollback={(id) => setRollbackTarget(id)}
          />
          <Button
            onClick={() => publishMutation.mutate()}
            disabled={publishMutation.isPending || publishBlocked}
          >
            <Rocket className="mr-1 h-4 w-4" aria-hidden />
            {publishMutation.isPending ? t('landingBuilderPage.publishing') : t('landingBuilderPage.publish')}
          </Button>
        </div>
      </header>

      {hasDraftChanges && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          {t('landingBuilderPage.draftDiffersBanner')}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <Tabs defaultValue="sections">
            <TabsList>
              <TabsTrigger value="sections">{t('landingBuilderPage.tabs.sections')}</TabsTrigger>
              <TabsTrigger value="theme">{t('landingBuilderPage.tabs.theme')}</TabsTrigger>
              <TabsTrigger value="json">{t('landingBuilderPage.tabs.json')}</TabsTrigger>
            </TabsList>

            <TabsContent value="sections" className="space-y-3">
              <SectionCatalog onAdd={addSection} />
              {config.sections.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t('landingBuilderPage.sectionList.empty')}
                </p>
              ) : (
                config.sections.map((section, index) => {
                  const missing = missingLocales(section, config.locales)
                  const isCollapsed = collapsed[section.id] ?? true
                  return (
                    <Card key={section.id}>
                      <CardHeader className="flex flex-row items-center justify-between gap-2 py-3">
                        <button
                          type="button"
                          className="flex items-center gap-2 text-left"
                          onClick={() => setCollapsed((c) => ({ ...c, [section.id]: !isCollapsed }))}
                          aria-label={isCollapsed ? t('landingBuilderPage.sectionList.expand') : t('landingBuilderPage.sectionList.collapse')}
                        >
                          {isCollapsed ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronUp className="h-4 w-4" aria-hidden />}
                          <CardTitle className="text-sm">
                            {t(`landingBuilderPage.sectionCatalog.${section.type}`)}
                          </CardTitle>
                          {missing.length > 0 && section.visible && (
                            <Badge variant="outline" className="text-[10px] text-amber-500">
                              {missing.map((l) => t('landingBuilderPage.sectionList.missingTranslation', { locale: l })).join(', ')}
                            </Badge>
                          )}
                        </button>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" aria-label={t('landingBuilderPage.sectionList.moveUp')} onClick={() => moveSection(index, -1)}>
                            <ChevronUp className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button variant="ghost" size="icon" aria-label={t('landingBuilderPage.sectionList.moveDown')} onClick={() => moveSection(index, 1)}>
                            <ChevronDown className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button variant="ghost" size="icon" aria-label={t('landingBuilderPage.sectionList.toggleVisible')} onClick={() => toggleVisible(index)}>
                            {section.visible ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
                          </Button>
                          <Button variant="ghost" size="icon" aria-label={t('landingBuilderPage.sectionList.duplicate')} onClick={() => duplicateSection(index)}>
                            <Copy className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button variant="ghost" size="icon" aria-label={t('landingBuilderPage.sectionList.delete')} onClick={() => deleteSection(index)}>
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        </div>
                      </CardHeader>
                      {!isCollapsed && (
                        <CardContent className="space-y-3">
                          <div className="flex items-center gap-2">
                            <Label className="text-xs text-muted-foreground">
                              {t('landingBuilderPage.sectionList.animation', { defaultValue: 'Анимация появления' })}
                            </Label>
                            <Select
                              value={section.animation ?? 'none'}
                              onValueChange={(v) =>
                                update({
                                  ...config,
                                  sections: config.sections.map((s, i) =>
                                    i === index ? { ...s, animation: v === 'none' ? undefined : (v as LandingAnimation) } : s,
                                  ),
                                })
                              }
                            >
                              <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {LANDING_ANIMATIONS.map((a) => (
                                  <SelectItem key={a} value={a}>
                                    {t(`landingBuilderPage.animations.${a}`, { defaultValue: a })}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <SectionEditor
                            section={section}
                            locales={config.locales}
                            editorLocale={previewLocale}
                            onChange={(nextData) =>
                              update({
                                ...config,
                                sections: config.sections.map((s, i) =>
                                  i === index ? { ...s, data: nextData } : s,
                                ),
                              })
                            }
                          />
                        </CardContent>
                      )}
                    </Card>
                  )
                })
              )}
            </TabsContent>

            <TabsContent value="theme">
              <ThemePanel config={config} onChange={update} />
            </TabsContent>

            <TabsContent value="json">
              <JsonPanel config={config} onImport={update} />
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('landingBuilderPage.preview.title')}</span>
            <div className="flex items-center gap-2">
              <Select value={previewLocale} onValueChange={setPreviewLocale}>
                <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {config.locales.map((locale) => (
                    <SelectItem key={locale} value={locale}>{locale.toUpperCase()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={previewWidth} onValueChange={(v) => setPreviewWidth(v as PreviewWidth)}>
                <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mobile">{t('landingBuilderPage.preview.widthMobile')}</SelectItem>
                  <SelectItem value="tablet">{t('landingBuilderPage.preview.widthTablet')}</SelectItem>
                  <SelectItem value="desktop">{t('landingBuilderPage.preview.widthDesktop')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <LandingPreview
            config={config}
            locale={previewLocale}
            width={previewWidth}
            selectedId={selectedId}
            onSelect={selectSection}
            onMove={moveSection}
            onToggleVisible={toggleVisible}
            onDelete={deleteSection}
            onReorder={reorderSection}
          />
        </div>
      </div>

      {/* Conflict dialog */}
      <AlertDialog open={conflictVersion !== null} onOpenChange={(open) => !open && setConflictVersion(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('landingBuilderPage.conflict.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('landingBuilderPage.conflict.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                setConflictVersion(null)
                void queryClient.invalidateQueries({ queryKey: LANDING_BUILDER_KEYS.all })
              }}
            >
              {t('landingBuilderPage.conflict.reload')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Publish-blocked dialog */}
      <AlertDialog open={publishIssues !== null} onOpenChange={(open) => !open && setPublishIssues(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('landingBuilderPage.publishBlocked.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('landingBuilderPage.publishBlocked.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 space-y-1 overflow-auto text-xs text-muted-foreground">
            {(publishIssues ?? []).map((issue, i) => (
              <li key={i}>
                <code>{issue.path}</code>: {issue.message}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('landingBuilderPage.revisionsDrawer.cancel')}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rollback confirm */}
      <AlertDialog open={rollbackTarget !== null} onOpenChange={(open) => !open && setRollbackTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('landingBuilderPage.revisionsDrawer.rollbackConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('landingBuilderPage.revisionsDrawer.rollbackConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('landingBuilderPage.revisionsDrawer.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => rollbackTarget && rollbackMutation.mutate(rollbackTarget)}>
              {t('landingBuilderPage.revisionsDrawer.rollbackConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Apply-template confirm */}
      <AlertDialog open={templateTarget !== null} onOpenChange={(open) => !open && setTemplateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('landingBuilderPage.templates.confirmTitle', { defaultValue: 'Применить шаблон?' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('landingBuilderPage.templates.confirmDescription', {
                defaultValue: 'Текущая тема и секции будут заменены содержимым шаблона. Это действие можно отменить, не публикуя черновик.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('landingBuilderPage.revisionsDrawer.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (templateTarget) applyTemplate(templateTarget)
                setTemplateTarget(null)
              }}
            >
              {t('landingBuilderPage.templates.apply', { defaultValue: 'Применить' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TemplatePicker({ onPick }: { onPick: (tpl: LandingTemplate) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline">
          <Sparkles className="mr-1 h-4 w-4" aria-hidden />
          {t('landingBuilderPage.templates.button', { defaultValue: 'Шаблоны' })}
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('landingBuilderPage.templates.title', { defaultValue: 'Готовые шаблоны' })}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          {LANDING_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-muted/50"
              onClick={() => {
                onPick(tpl)
                setOpen(false)
              }}
            >
              <span
                className="h-10 w-10 shrink-0 rounded-md border"
                style={{
                  background: tpl.theme.colors?.bg ?? '#0a0a0a',
                  borderColor: tpl.theme.colors?.primary ?? '#22c55e',
                }}
                aria-hidden
              />
              <div>
                <div className="text-sm font-medium">
                  {t(`landingBuilderPage.templates.${tpl.labelKey}.name`, { defaultValue: tpl.id })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t(`landingBuilderPage.templates.${tpl.labelKey}.desc`, { defaultValue: '' })}
                </div>
              </div>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SectionCatalog({ onAdd }: { onAdd: (type: LandingSectionType) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-2 rounded-md border border-dashed p-3">
      <span className="w-full text-xs font-medium text-muted-foreground">
        {t('landingBuilderPage.sectionCatalog.title')}
      </span>
      {LANDING_SECTION_TYPES.map((type) => (
        <Button key={type} variant="outline" size="sm" onClick={() => onAdd(type)}>
          <Plus className="mr-1 h-3 w-3" aria-hidden />
          {t(`landingBuilderPage.sectionCatalog.${type}`)}
        </Button>
      ))}
    </div>
  )
}

function ThemePanel({ config, onChange }: { config: LandingConfig; onChange: (c: LandingConfig) => void }) {
  const { t } = useTranslation()
  const theme = config.theme
  const patchTheme = (patch: Partial<LandingConfig['theme']>): void =>
    onChange({ ...config, theme: { ...theme, ...patch } })
  const setColor = (key: 'primary' | 'bg' | 'fg' | 'accent', value: string): void =>
    patchTheme({ colors: { ...theme.colors, [key]: value } })
  const contrastWarn = lowContrast(theme.colors?.fg, theme.colors?.bg)
  const bgColors = theme.backgroundColors ?? []
  const setBgColor = (i: number, value: string): void => {
    const next = [...bgColors]
    next[i] = value
    patchTheme({ backgroundColors: next.filter((c) => c.length > 0) })
  }
  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="flex items-center gap-2">
          <Switch
            checked={theme.inherit}
            onCheckedChange={(checked) => patchTheme({ inherit: checked })}
            aria-label={t('landingBuilderPage.theme.inherit')}
          />
          <div>
            <div className="text-sm font-medium">{t('landingBuilderPage.theme.inherit')}</div>
            <div className="text-xs text-muted-foreground">{t('landingBuilderPage.theme.inheritHint')}</div>
          </div>
        </div>

        {!theme.inherit && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {(['primary', 'bg', 'fg', 'accent'] as const).map((key) => (
                <div key={key} className="space-y-1">
                  <Label className="text-xs">{t(`landingBuilderPage.theme.${key}`)}</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={theme.colors?.[key] ?? '#22c55e'}
                      onChange={(e) => setColor(key, e.target.value)}
                      className="h-9 w-9 shrink-0 rounded border bg-transparent"
                      aria-label={t(`landingBuilderPage.theme.${key}`)}
                    />
                    <Input value={theme.colors?.[key] ?? ''} onChange={(e) => setColor(key, e.target.value)} placeholder="#22c55e" />
                  </div>
                </div>
              ))}
              {contrastWarn && (
                <p className="col-span-2 text-xs text-amber-500">{t('landingBuilderPage.theme.contrastWarning')}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t('landingBuilderPage.theme.radius', { defaultValue: 'Радиус' })}</Label>
                <Select value={theme.radius ?? 'lg'} onValueChange={(v) => patchTheme({ radius: v as LandingConfig['theme']['radius'] })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['none', 'sm', 'md', 'lg', 'xl'] as const).map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('landingBuilderPage.theme.surface', { defaultValue: 'Стиль поверхностей' })}</Label>
                <Select value={theme.surfaceStyle ?? 'solid'} onValueChange={(v) => patchTheme({ surfaceStyle: v as LandingSurfaceStyle })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LANDING_SURFACE_STYLES.map((s) => (
                      <SelectItem key={s} value={s}>{t(`landingBuilderPage.theme.surfaceStyle.${s}`, { defaultValue: s })}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </>
        )}

        {/* Background effect — available regardless of inherit (uses brand primary as fallback). */}
        <div className="space-y-2 rounded-md border border-border/60 p-3">
          <Label className="text-xs font-medium">{t('landingBuilderPage.theme.background', { defaultValue: 'Фон' })}</Label>
          <div className="flex flex-wrap gap-1.5">
            {LANDING_BACKGROUNDS.map((bg) => (
              <Button
                key={bg}
                type="button"
                size="sm"
                variant={(theme.background ?? 'none') === bg ? 'default' : 'outline'}
                onClick={() => patchTheme({ background: bg as LandingBackground })}
              >
                {t(`landingBuilderPage.theme.backgrounds.${bg}`, { defaultValue: bg })}
              </Button>
            ))}
          </div>
          {theme.background && theme.background !== 'none' && (
            <>
              <div className="flex items-center gap-2 pt-1">
                <Switch
                  checked={theme.animateBackground !== false}
                  onCheckedChange={(checked) => patchTheme({ animateBackground: checked })}
                  aria-label={t('landingBuilderPage.theme.animateBackground', { defaultValue: 'Анимировать фон' })}
                />
                <span className="text-xs">{t('landingBuilderPage.theme.animateBackground', { defaultValue: 'Анимировать фон' })}</span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                {[0, 1, 2].map((i) => (
                  <input
                    key={i}
                    type="color"
                    value={bgColors[i] ?? theme.colors?.primary ?? '#22c55e'}
                    onChange={(e) => setBgColor(i, e.target.value)}
                    className="h-8 w-8 rounded border bg-transparent"
                    aria-label={t('landingBuilderPage.theme.backgroundColor', { defaultValue: 'Цвет фона {{n}}', n: i + 1 })}
                  />
                ))}
                <span className="text-xs text-muted-foreground">{t('landingBuilderPage.theme.backgroundColors', { defaultValue: 'Цвета эффекта' })}</span>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function JsonPanel({ config, onImport }: { config: LandingConfig; onImport: (c: LandingConfig) => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState(() => JSON.stringify(config, null, 2))
  const [error, setError] = useState<string | null>(null)
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <p className="text-xs text-muted-foreground">{t('landingBuilderPage.json.description')}</p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={18}
          className="font-mono text-xs"
          aria-label={t('landingBuilderPage.json.title')}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            try {
              const parsed = JSON.parse(text) as LandingConfig
              setError(null)
              onImport(parsed)
              toast.success(t('landingBuilderPage.saved'))
            } catch {
              setError(t('landingBuilderPage.json.invalid'))
            }
          }}
        >
          {t('landingBuilderPage.json.import')}
        </Button>
      </CardContent>
    </Card>
  )
}

function RevisionsDrawer({ onRollback }: { onRollback: (id: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { data: revisions } = useQuery<LandingRevisionMeta[]>({
    queryKey: LANDING_BUILDER_KEYS.revisions,
    queryFn: () => landingBuilderApi.listRevisions(),
    enabled: open,
  })
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline">
          <History className="mr-1 h-4 w-4" aria-hidden />
          {t('landingBuilderPage.revisions')}
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('landingBuilderPage.revisionsDrawer.title')}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          {(revisions ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('landingBuilderPage.revisionsDrawer.empty')}</p>
          ) : (
            (revisions ?? []).map((rev) => (
              <div key={rev.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                <div>
                  <div>{new Date(rev.publishedAt).toLocaleString()}</div>
                  {rev.isCurrent && (
                    <Badge variant="secondary" className="text-[10px]">
                      {t('landingBuilderPage.revisionsDrawer.current')}
                    </Badge>
                  )}
                </div>
                {!rev.isCurrent && (
                  <Button variant="outline" size="sm" onClick={() => onRollback(rev.id)}>
                    {t('landingBuilderPage.rollback')}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Rough luminance-based contrast heuristic for two #hex colors. */
function lowContrast(fg: string | undefined, bg: string | undefined): boolean {
  const lum = (hex: string | undefined): number | null => {
    if (typeof hex !== 'string') return null
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return null
    const int = parseInt(m[1], 16)
    const r = (int >> 16) & 255
    const g = (int >> 8) & 255
    const b = int & 255
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  }
  const lf = lum(fg)
  const lb = lum(bg)
  if (lf === null || lb === null) return false
  return Math.abs(lf - lb) < 0.35
}
