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
  Redo2,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard'
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
  LANDING_BACKGROUND_OVERLAYS,
  LANDING_BUILDER_KEYS,
  LANDING_CARD_HOVERS,
  LANDING_CTA_STYLES,
  LANDING_SECTION_TYPES,
  LANDING_SURFACE_STYLES,
  LandingDraftConflictError,
  LandingDraftInvalidError,
  LandingPublishIncompleteError,
  landingBuilderApi,
  type LandingAnimation,
  type LandingBackground,
  type LandingConfig,
  type LandingDraftResponse,
  type LandingPublishStrictIssue,
  type LandingRevisionMeta,
  type LandingSectionType,
  type LandingSurfaceStyle,
} from './landing-builder-api'
import { SectionEditor } from './section-editor'
import { buildDefaultSection, cloneSection, configMissingLocales, missingLocales } from './section-defaults'
import { LandingPreview, type PreviewWidth } from './preview/landing-preview'
import { LANDING_TEMPLATES, type LandingTemplate } from './templates'
import { preflightConfig } from './config-preflight'
import {
  canRedo,
  canUndo,
  commitHistory,
  fieldMergeKey,
  initHistory,
  redoHistory,
  undoHistory,
  type HistoryState,
} from './editor-history'
import { SettingsPanel } from './settings-panel'
import { ThemeGallery } from './theme-gallery'
import {
  BACKGROUND_COLOR_SLOTS,
  FALLBACK_BG_COLOR,
  setBackgroundColor,
} from './theme-colors'

/**
 * Publish gave up because the draft it would have shipped never reached the
 * server. Not an API error — the publish request was never sent — so it carries
 * the save rejection rather than replacing it, and exists purely so `onError`
 * can tell the two apart.
 */
class LandingDraftUnsavedError extends Error {
  public readonly saveError: unknown
  public constructor(saveError: unknown) {
    super('LANDING_DRAFT_UNSAVED')
    this.saveError = saveError
  }
}

export default function LandingBuilderPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: LANDING_BUILDER_KEYS.all,
    queryFn: () => landingBuilderApi.get(),
  })

  const [history, setHistory] = useState<HistoryState<LandingConfig> | null>(null)
  const config = history?.present.value ?? null
  const selectedId = history?.present.selectedId ?? null
  /**
   * Version of the STORED draft this editor is holding — `null` until the
   * first load lands.
   *
   * A ref, not state, because the autosave timer must read it at FIRE time. As
   * state it was captured when the effect was armed, and a save completing
   * while the timer was pending bumped it without re-running the effect — so
   * the timer sent the pre-save number and the server rejected it as a conflict
   * nobody had caused.
   *
   * It doubles as the seed guard below. `data` takes a new identity every time
   * the cache entry is written — including by our own post-save write-back and
   * by the refetch publish/rollback trigger — but only a change of VERSION
   * means the stored draft actually moved. Nothing renders it.
   */
  const versionRef = useRef<number | null>(null)
  /**
   * The exact config object the server has confirmed stored. Dirtiness is the
   * identity comparison `config !== savedConfig`, not a shared boolean: a flag
   * cleared on save also clears the edits typed while that save was in flight,
   * and those edits then never reached the server at all.
   */
  const [savedConfig, setSavedConfig] = useState<LandingConfig | null>(null)
  /**
   * The same value as `savedConfig`, for the readers that run AFTER an await.
   *
   * `flushPendingSave` waits for the save already in flight and only then
   * decides whether there is anything left to send — but as a closure it holds
   * the `savedConfig` of the render it was created in, which is one save behind
   * exactly when a PUT was in the air. Leaving the page mid-save therefore sent
   * the identical snapshot a second time.
   */
  const savedConfigRef = useRef<LandingConfig | null>(null)
  /**
   * The snapshot whose save the server rejected. Autosave will not resend it —
   * it is reopened by a fresh edit (a new object), by stepping onto it through
   * undo/redo, or by the retry button next to the status line. Without this a
   * rejected save is retried about once a second forever, with a toast, a
   * flickering issues banner, or an undismissable conflict dialog on every
   * round trip.
   */
  const [failedConfig, setFailedConfig] = useState<LandingConfig | null>(null)
  /** Last snapshot handed to `persist`, so the debounce cannot send it twice. */
  const requestedRef = useRef<LandingConfig | null>(null)
  /**
   * Set while publish is flushing the draft. A save rejected in that window is
   * reported once, as the publish it aborted, instead of stacking a bare "could
   * not save the draft" toast under a "could not publish" one that is not true.
   */
  const publishingRef = useRef(false)
  /** Tail of the save queue. Never rejects — the next save chains onto it. */
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())
  const [publishedSnapshot, setPublishedSnapshot] = useState<string>('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [previewWidth, setPreviewWidth] = useState<PreviewWidth>('mobile')
  const [selectedPreviewLocale, setSelectedPreviewLocale] = useState<string>('ru')
  const [conflictVersion, setConflictVersion] = useState<number | null>(null)
  const [publishIssues, setPublishIssues] = useState<LandingPublishStrictIssue[] | null>(null)
  const [saveIssues, setSaveIssues] = useState<LandingPublishStrictIssue[] | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null)
  const [templateTarget, setTemplateTarget] = useState<LandingTemplate | null>(null)

  useEffect(() => {
    if (!data?.draft) return
    /* eslint-disable react-hooks/set-state-in-effect -- seed local editor state from the async query */
    // Published moves independently of the draft — publish and rollback repoint
    // it without touching the draft row — so it is refreshed on every load.
    setPublishedSnapshot(
      data.published && 'sections' in data.published ? JSON.stringify(data.published) : '',
    )
    // Seed the EDITOR only when the stored draft has actually moved. Re-seeding
    // on every `data` identity threw away 100 steps of undo plus any edit made
    // since — including the one still inside the autosave debounce at the
    // moment Publish was pressed.
    if (versionRef.current === data.version) return
    versionRef.current = data.version
    setHistory(initHistory(data.draft, null))
    setSavedConfig(data.draft)
    savedConfigRef.current = data.draft
    setSelectedPreviewLocale(data.draft.defaultLocale)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data])

  const saveMutation = useMutation({
    mutationFn: (payload: { config: LandingConfig; version: number }) =>
      landingBuilderApi.saveDraft(payload.config, payload.version),
    onSuccess: (result, variables) => {
      versionRef.current = result.version
      // Only the snapshot that was actually sent becomes clean. Anything typed
      // while the PUT was in flight is a different object and stays dirty, so
      // the autosave effect re-arms for it.
      setSavedConfig(variables.config)
      savedConfigRef.current = variables.config
      // Write the result back into the cache. Without this the entry still held
      // the initial GET — old draft, old version — and `staleTime: 30_000` made
      // `refetchOnMount` a no-op, so leaving and returning inside that window
      // re-seeded the editor from the pre-save draft and the next keystroke PUT
      // a stale version, i.e. a conflict dialog nobody had caused.
      const cached = queryClient.getQueryData<LandingDraftResponse>(LANDING_BUILDER_KEYS.all)
      if (cached !== undefined) {
        queryClient.setQueryData<LandingDraftResponse>(LANDING_BUILDER_KEYS.all, {
          ...cached,
          draft: result.config,
          version: result.version,
          stored: true,
        })
      }
    },
    onError: (error, variables) => {
      setFailedConfig(variables.config)
      if (error instanceof LandingDraftConflictError) {
        setConflictVersion(error.currentVersion)
      } else if (error instanceof LandingDraftInvalidError) {
        // Schema rejection — show which fields, not just "save failed". The
        // draft stays dirty so a fix re-triggers the save.
        setSaveIssues(error.issues.length > 0 ? error.issues : [{ path: '<root>', message: '' }])
      } else if (!publishingRef.current) {
        toast.error(t('landingBuilderPage.toasts.saveFailed'))
      }
    },
    onMutate: () => setSaveIssues(null),
  })

  // A stored draft that failed validation is served as the bundled default.
  // Autosaving over it would replace the operator's real content with a blank
  // landing and there is no undo — so editing is frozen until someone looks.
  const corrupted = data?.corrupted ?? null

  /**
   * Sends one draft save, queued behind any save already in flight.
   *
   * Two PUTs in the air at once means the second carries the version the first
   * is about to bump, and the operator is shown a conflict dialog for a
   * conflict nobody caused. Queueing rather than skipping is what makes the
   * deferred save actually happen: the version is read inside the chain, after
   * the previous save has bumped it.
   */
  const persist = (next: LandingConfig): Promise<unknown> => {
    requestedRef.current = next
    const sent = inFlightRef.current.then(() =>
      saveMutation.mutateAsync({ config: next, version: versionRef.current ?? 0 }),
    )
    inFlightRef.current = sent.catch(() => undefined)
    return sent
  }

  /**
   * Persists what is on screen right now and resolves once it is stored.
   *
   * Called when the operator leaves the page — unmounting used to just
   * `clearTimeout` the armed save — and before publishing, which reads the
   * STORED draft and would otherwise ship a page the operator never saw.
   */
  const flushPendingSave = async (): Promise<void> => {
    // Wait out a save already in flight either way: returning before that PUT
    // lands would publish the previous draft.
    await inFlightRef.current
    // Read what is stored through the ref, not the captured `savedConfig`: the
    // save just awaited may be the one that stored this very snapshot, and the
    // closure cannot have seen it land.
    if (config === null || corrupted !== null || config === savedConfigRef.current) return
    await persist(config)
  }

  // Debounced autosave whenever the local config changes after a user edit.
  useEffect(() => {
    if (config === null || corrupted !== null) return
    // What is on screen is what the server stored.
    if (config === savedConfig) return
    // A rejected snapshot waits for the next operator edit; see `failedConfig`.
    if (config === failedConfig) return
    // Its debounce already fired — the save is queued or settled.
    if (config === requestedRef.current) return
    const handle = setTimeout(() => {
      void persist(config).catch(() => undefined)
    }, 800)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, savedConfig, failedConfig, corrupted])

  // The unmount cleanup runs with the closure it was created with, so the flush
  // it calls is kept in a ref that every render refreshes.
  const flushRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    flushRef.current = flushPendingSave
  })
  useEffect(() => {
    // Fire the armed save instead of cancelling it. The mutation runs on the
    // QueryClient, not on this component, so it completes — and writes back to
    // the cache — after the editor has gone.
    return () => {
      void flushRef.current().catch(() => undefined)
    }
  }, [])

  const dirty = config !== null && config !== savedConfig

  /**
   * Whether leaving can still lose work — which is narrower than `dirty`.
   *
   * A corrupted draft never saves: autosave is frozen and the unmount flush is
   * a no-op, by design, so there is no round trip for a prompt to buy time for.
   * `dirty` is pure identity, so the first keystroke on such a draft raises it
   * for good — and every navigation and every reload from then on costs a
   * dialog, permanently, on the one page whose banner is asking the operator to
   * leave and restore the draft by hand.
   */
  const unsavedWork = dirty && corrupted === null

  const publishMutation = useMutation({
    // Publish takes the STORED draft, so an edit still sitting in the autosave
    // debounce would be left behind and the operator would publish a page that
    // is not the one on their screen. Flush first; a save that fails aborts the
    // publish rather than shipping the previous draft.
    mutationFn: async () => {
      publishingRef.current = true
      try {
        await flushPendingSave()
      } catch (error) {
        // Re-thrown under its own type. Everything the flush can reject with —
        // a network failure, a 409, a schema rejection — used to arrive at
        // `onError` as "not a LandingPublishIncompleteError" and be reported as
        // a failed publish, which is the one thing that did not happen: the
        // server was never asked.
        throw new LandingDraftUnsavedError(error)
      } finally {
        publishingRef.current = false
      }
      return landingBuilderApi.publish()
    },
    onSuccess: () => {
      setPublishIssues(null)
      void queryClient.invalidateQueries({ queryKey: LANDING_BUILDER_KEYS.all })
      toast.success(t('landingBuilderPage.toasts.published'))
    },
    onError: (error) => {
      if (error instanceof LandingPublishIncompleteError) {
        setPublishIssues(error.issues)
      } else if (error instanceof LandingDraftUnsavedError) {
        toast.error(t('landingBuilderPage.toasts.publishAbortedUnsaved'))
      } else {
        toast.error(t('landingBuilderPage.toasts.publishFailed'))
      }
    },
  })

  const rollbackMutation = useMutation({
    // Rollback re-publishes an old revision; the backend never touches the
    // draft row, so the editor keeps what the operator was working on and the
    // draft-vs-published banner lights up. The invalidation below is only there
    // to refresh the published side.
    mutationFn: (revisionId: string) => landingBuilderApi.rollback(revisionId),
    onSuccess: () => {
      setRollbackTarget(null)
      void queryClient.invalidateQueries({ queryKey: LANDING_BUILDER_KEYS.all })
      toast.success(t('landingBuilderPage.toasts.rolledBack'))
    },
    onError: () => toast.error(t('landingBuilderPage.toasts.rollbackFailed')),
  })

  /**
   * Records an edit. `mergeKey` identifies the field being typed into so a run
   * of keystrokes collapses into one undo step; structural edits omit it and
   * are always their own step.
   */
  const update = (next: LandingConfig, mergeKey?: string): void => {
    setHistory((prev) =>
      prev === null ? prev : commitHistory(prev, next, { mergeKey: mergeKey ?? null, at: Date.now() }),
    )
  }

  /** Selection alone is not an edit — it rides on the current snapshot. */
  const setSelectedId = (id: string | null): void => {
    setHistory((prev) =>
      prev === null ? prev : { ...prev, present: { ...prev.present, selectedId: id } },
    )
  }

  /**
   * Lifts the save gate for a snapshot the operator has just stepped onto.
   *
   * The gate remembers the REJECTED OBJECT, and undo restores that very object
   * rather than a copy — so undoing onto a snapshot whose save once failed left
   * the editor dirty, gated, reading "Save failed", and with no path back to a
   * retry except an unrelated edit. Stepping through history is an operator
   * action, not the automatic retry loop the gate exists to stop, so it counts
   * as a fresh edit. `requestedRef` names the same object and would keep gating
   * it on its own; it is cleared only when it IS that object, or a save still in
   * flight for a newer one would lose its guard and be sent twice.
   */
  const reopenSaveGate = (restored: LandingConfig): void => {
    if (restored !== failedConfig) return
    setFailedConfig(null)
    if (requestedRef.current === restored) requestedRef.current = null
  }

  // Undo/redo restore an earlier snapshot object, so dirtiness falls out of the
  // same identity comparison: stepping back onto the stored draft leaves
  // nothing to save, stepping anywhere else re-arms the autosave.
  const undo = (): void => {
    if (history === null || !canUndo(history)) return
    const next = undoHistory(history)
    reopenSaveGate(next.present.value)
    setHistory(next)
  }

  const redo = (): void => {
    if (history === null || !canRedo(history)) return
    const next = redoHistory(history)
    reopenSaveGate(next.present.value)
    setHistory(next)
  }

  /**
   * Sends the rejected snapshot again, now.
   *
   * The status line can say "Save failed" about a draft that nothing on screen
   * will ever retry — autosave is gated on exactly that snapshot — so the way
   * out must not be a guess. Straight to `persist` rather than re-arming the
   * debounce: a button press is not something to wait 800 ms after.
   */
  const retrySave = (): void => {
    if (config === null || corrupted !== null) return
    setFailedConfig(null)
    void persist(config).catch(() => undefined)
  }

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (plus Ctrl+Y). Ignored while focus is in a
  // text field so the browser's own per-input undo keeps working for typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true) return
      event.preventDefault()
      if (key === 'y' || event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history])

  const hasDraftChanges = useMemo(() => {
    if (config === null) return false
    return publishedSnapshot === '' || JSON.stringify(config) !== publishedSnapshot
  }, [config, publishedSnapshot])

  // A corrupted draft blocks publishing too: `config` is then the bundled
  // default, which is fully localized and so passes the locale check — one
  // click would push a blank landing live, right under the warning banner.
  // The server refuses this as well; the button state is only the first line.
  const publishBlocked =
    corrupted !== null || (config !== null && configMissingLocales(config.sections, config.locales))

  /**
   * The one line the operator can trust about their work. `isPending` wins: a
   * save in flight is the most specific true statement about the draft.
   */
  const saveStatus: 'saving' | 'failed' | 'unsaved' | 'saved' = saveMutation.isPending
    ? 'saving'
    : config !== null && config === failedConfig
      ? 'failed'
      : dirty
        ? 'unsaved'
        : 'saved'

  /**
   * The Settings tab can delete the locale the preview is pinned to. Deriving
   * the effective locale rather than reconciling it in an effect means the
   * dropdown never holds a value it has no option for (it rendered blank) and
   * the iframe never renders the page in a language nothing writes to any more.
   * Re-adding the locale — Ctrl+Z — puts the preview straight back.
   */
  const previewLocale =
    config !== null && !config.locales.includes(selectedPreviewLocale)
      ? config.defaultLocale
      : selectedPreviewLocale

  // A load that failed leaves `isLoading` false and `data` undefined, and the
  // query client sets `retry: false` + `refetchOnWindowFocus: false`, so the
  // skeleton below would sit there for good. Only when there is nothing to
  // edit, though — a background refetch failing under a live editor must not
  // replace the operator's work with an error card.
  if (isError && config === null) {
    return (
      <div className="p-4">
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-destructive" aria-hidden />
            <p>{t('landingBuilderPage.loadError')}</p>
            <Button variant="outline" className="mt-4" onClick={() => void refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> {t('landingBuilderPage.retry')}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

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
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={undo}
              disabled={history === null || !canUndo(history)}
              aria-label={t('landingBuilderPage.history.undo')}
              title={t('landingBuilderPage.history.undo')}
            >
              <Undo2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={redo}
              disabled={history === null || !canRedo(history)}
              aria-label={t('landingBuilderPage.history.redo')}
              title={t('landingBuilderPage.history.redo')}
            >
              <Redo2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <span
            role="status"
            aria-live="polite"
            data-testid="save-status"
            className={cn(
              'text-xs',
              saveStatus === 'failed' && 'text-destructive',
              saveStatus === 'unsaved' && 'text-amber-600',
              (saveStatus === 'saving' || saveStatus === 'saved') && 'text-muted-foreground',
            )}
          >
            {saveStatus === 'saving' && t('landingBuilderPage.saving')}
            {saveStatus === 'failed' && t('landingBuilderPage.saveStatus.failed')}
            {saveStatus === 'unsaved' && t('landingBuilderPage.saveStatus.unsaved')}
            {saveStatus === 'saved' && t('landingBuilderPage.saved')}
          </span>
          {saveStatus === 'failed' && (
            <Button variant="outline" size="sm" onClick={retrySave}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('landingBuilderPage.saveStatus.retry')}
            </Button>
          )}
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

      {corrupted !== null && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p className="font-medium">{t('landingBuilderPage.corrupted.title')}</p>
          <p>{t('landingBuilderPage.corrupted.description')}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {corrupted.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <code>{issue.path}</code> — {issue.message}
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Hand the operator the unparseable row itself. Recovery is
              // manual by design: anything automatic would have to guess, and
              // guessing is what destroyed the draft in the first place.
              const blob = new Blob([JSON.stringify(corrupted.raw, null, 2)], {
                type: 'application/json',
              })
              const url = URL.createObjectURL(blob)
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = 'landing-draft-corrupted.json'
              anchor.click()
              URL.revokeObjectURL(url)
            }}
          >
            {t('landingBuilderPage.corrupted.download')}
          </Button>
        </div>
      )}

      {saveIssues !== null && (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p className="font-medium">{t('landingBuilderPage.saveInvalid.title')}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {saveIssues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <code>{issue.path}</code>
                {issue.message.length > 0 ? ` — ${issue.message}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasDraftChanges && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          {t('landingBuilderPage.draftDiffersBanner')}
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div>
          <Tabs defaultValue="sections">
            <TabsList>
              <TabsTrigger value="sections">{t('landingBuilderPage.tabs.sections')}</TabsTrigger>
              <TabsTrigger value="theme">{t('landingBuilderPage.tabs.theme')}</TabsTrigger>
              <TabsTrigger value="settings">{t('landingBuilderPage.tabs.settings')}</TabsTrigger>
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
                            onChange={(nextData, path) =>
                              update(
                                {
                                  ...config,
                                  sections: config.sections.map((s, i) =>
                                    i === index ? { ...s, data: nextData } : s,
                                  ),
                                },
                                path === undefined ? undefined : fieldMergeKey(section.id, path),
                              )
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

            <TabsContent value="settings">
              <SettingsPanel config={config} onChange={update} />
            </TabsContent>

            <TabsContent value="json">
              <JsonPanel config={config} onImport={update} />
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-2 lg:sticky lg:top-4 self-start">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('landingBuilderPage.preview.title')}</span>
            <div className="flex items-center gap-2">
              <Select value={previewLocale} onValueChange={setSelectedPreviewLocale}>
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

      {/* Both layers, from one component. The browser prompt is not decoration
          here: autosave debounces and a save takes a round trip, so a reload
          inside either window takes the edits with it, and holding the tab is
          what buys the unmount flush above enough time to land. The in-app
          blocker is the other half — leaving by the side menu does not throw
          the work away, but the flush it relies on is fire-and-forget, so if it
          is rejected the operator is already gone and will never see why.
          Both skip a forced sign-out; the shared component owns that rule. */}
      <UnsavedChangesGuard
        when={unsavedWork}
        title={t('landingBuilderPage.unsavedGuard.title')}
        description={t('landingBuilderPage.unsavedGuard.description')}
        stay={t('landingBuilderPage.unsavedGuard.stay')}
        leave={t('landingBuilderPage.unsavedGuard.leave')}
      />

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

function ThemePanel({
  config,
  onChange,
}: {
  config: LandingConfig
  onChange: (c: LandingConfig, mergeKey?: string) => void
}) {
  const { t } = useTranslation()
  const theme = config.theme
  // Without a merge key every character typed into a hex field, and every frame
  // of a colour-picker drag, becomes its own undo step. The history holds 100;
  // one colour drag can evict a section deletion the operator meant to undo.
  const patchTheme = (patch: Partial<LandingConfig['theme']>, mergeKey?: string): void =>
    onChange({ ...config, theme: { ...theme, ...patch } }, mergeKey)
  const setColor = (key: 'primary' | 'bg' | 'fg' | 'accent', value: string): void =>
    patchTheme({ colors: { ...theme.colors, [key]: value } }, `theme:colors.${key}`)
  const contrastWarn = lowContrast(theme.colors?.fg, theme.colors?.bg)
  const bgColors = theme.backgroundColors ?? []
  const setBgColor = (i: number, value: string): void =>
    patchTheme(
      {
        backgroundColors: setBackgroundColor(
          bgColors,
          i,
          value,
          theme.colors?.primary ?? FALLBACK_BG_COLOR,
        ),
      },
      `theme:backgroundColors.${i}`,
    )
  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <ThemeGallery
          theme={theme}
          // Full replace, not a patch: merging would leave any key the incoming
          // preset does not set behind, so a preset would render differently
          // depending on which one was applied before it. The gallery has
          // already carried the operator's font onto what it hands over, which
          // is the one key no preset has an opinion about. Sections are passed
          // through untouched — that is what makes re-skinning non-destructive.
          onApply={(nextTheme) => onChange({ ...config, theme: nextTheme })}
        />
        <div className="border-t border-border/60 pt-4" />
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

          {/* Overlay is an independent axis, offered whatever the base is —
              including `none`, where a texture alone over the flat page colour
              is a perfectly good look. */}
          <Label className="pt-2 text-xs text-muted-foreground">
            {t('landingBuilderPage.theme.backgroundOverlay', { defaultValue: 'Текстура поверх' })}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {LANDING_BACKGROUND_OVERLAYS.map((ov) => (
              <Button
                key={ov}
                size="sm"
                variant={(theme.backgroundOverlay ?? 'none') === ov ? 'default' : 'outline'}
                onClick={() => patchTheme({ backgroundOverlay: ov })}
              >
                {t(`landingBuilderPage.theme.overlays.${ov}`, { defaultValue: ov })}
              </Button>
            ))}
          </div>

          <Label className="pt-2 text-xs text-muted-foreground">
            {t('landingBuilderPage.theme.cardHover', { defaultValue: 'Наведение на карточки' })}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {LANDING_CARD_HOVERS.map((h) => (
              <Button
                key={h}
                size="sm"
                variant={(theme.cardHover ?? 'none') === h ? 'default' : 'outline'}
                onClick={() => patchTheme({ cardHover: h })}
              >
                {t(`landingBuilderPage.theme.cardHovers.${h}`, { defaultValue: h })}
              </Button>
            ))}
          </div>

          <Label className="pt-2 text-xs text-muted-foreground">
            {t('landingBuilderPage.theme.ctaStyle', { defaultValue: 'Наведение на кнопки' })}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {LANDING_CTA_STYLES.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={(theme.ctaStyle ?? 'none') === c ? 'default' : 'outline'}
                onClick={() => patchTheme({ ctaStyle: c })}
              >
                {t(`landingBuilderPage.theme.ctaStyles.${c}`, { defaultValue: c })}
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
                {BACKGROUND_COLOR_SLOTS.map((i) => (
                  <input
                    key={i}
                    type="color"
                    value={bgColors[i] ?? theme.colors?.primary ?? FALLBACK_BG_COLOR}
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

/**
 * Raw-JSON export/import.
 *
 * The buffer MIRRORS the editor until the operator types into it. It used to be
 * snapshotted once at mount, and the preview pane lives outside the tabs and
 * stays interactive — so deleting a section in the preview and then pressing
 * Import brought the section back and reverted every other preview edit.
 * Disabling Import instead would have broken the documented copy-edit-paste
 * workflow every time the preview moved; mirroring keeps it working and only
 * stops once the operator has text of their own worth protecting. From then on
 * the buffer is theirs — clobbering a half-finished paste on every preview edit
 * would be the same bug pointed the other way — so the divergence is announced
 * instead.
 */
function JsonPanel({ config, onImport }: { config: LandingConfig; onImport: (c: LandingConfig) => void }) {
  const { t } = useTranslation()
  const serialized = useMemo(() => JSON.stringify(config, null, 2), [config])
  /** `null` while the buffer just mirrors the editor; `base` is the snapshot it was forked from. */
  const [edited, setEdited] = useState<{ text: string; base: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const text = edited?.text ?? serialized
  const stale = edited !== null && edited.base !== serialized
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <p className="text-xs text-muted-foreground">{t('landingBuilderPage.json.description')}</p>
        <Textarea
          value={text}
          onChange={(e) => setEdited({ text: e.target.value, base: edited?.base ?? serialized })}
          rows={18}
          className="font-mono text-xs"
          aria-label={t('landingBuilderPage.json.title')}
        />
        {stale && (
          <p role="alert" className="text-xs text-amber-600">
            {t('landingBuilderPage.json.stale')}
          </p>
        )}
        {error && <p className="text-xs whitespace-pre-line text-destructive">{error}</p>}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            let parsed: unknown
            try {
              parsed = JSON.parse(text)
            } catch {
              setError(t('landingBuilderPage.json.invalid'))
              return
            }
            // Structural pre-flight only. The server owns the schema; this
            // catches the mistakes that would otherwise be imported, blow up
            // the editor mid-render, and only surface as a failed autosave.
            const problems = preflightConfig(parsed, t)
            if (problems.length > 0) {
              setError(problems.join('\n'))
              return
            }
            setError(null)
            onImport(parsed as LandingConfig)
            // Back to mirroring: the editor now holds what the buffer held.
            setEdited(null)
            // Nothing has been SAVED here — this only loads the JSON into the
            // editor, and the autosave that follows is what reaches the server.
            toast.success(t('landingBuilderPage.json.imported'))
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
