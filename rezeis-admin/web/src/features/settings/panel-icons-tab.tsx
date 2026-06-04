/**
 * Panel Icons tab — operator's reusable custom-icon library.
 *
 * Upload SVG/PNG/WebP glyphs, rename them, set an optional tint colour, and
 * delete. The library is reusable across the panel (starting with the plan
 * icon picker) and is delivered to the reiwa cabinet via public-config, so a
 * custom plan icon renders on the user's plan card too.
 *
 * Recolour model: a tint applies a CSS mask so a single monochrome glyph can
 * be themed per use site. Clear the colour to keep multicolour art intact.
 */

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Save, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import {
  CUSTOM_ICONS_QUERY_KEY,
  getCustomIcons,
  saveCustomIcons,
  uploadCustomIconFile,
  type CustomIcon,
} from './custom-icons-api'
import { CustomIconView } from './custom-icon-view'

const ACCEPTED_MIME = 'image/svg+xml,image/png,image/webp'
const MAX_ICONS = 200

function makeId(): string {
  return `icon_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export default function PanelIconsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState<CustomIcon[]>([])
  const [dirty, setDirty] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [pending, setPending] = useState(0)

  const iconsQuery = useQuery({
    queryKey: CUSTOM_ICONS_QUERY_KEY,
    queryFn: getCustomIcons,
  })

  // Hydrate the local draft whenever the server list changes and we have no
  // unsaved edits (avoids clobbering in-progress work on background refetch).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (iconsQuery.data && !dirty) {
      setDraft(iconsQuery.data)
    }
  }, [iconsQuery.data, dirty])
  /* eslint-enable react-hooks/set-state-in-effect */

  const saveMutation = useMutation({
    mutationFn: () => saveCustomIcons(draft),
    onSuccess: (saved) => {
      queryClient.setQueryData(CUSTOM_ICONS_QUERY_KEY, saved)
      setDraft(saved)
      setDirty(false)
      toast.success(t('panelIcons.saved'))
    },
    onError: () => toast.error(t('panelIcons.saveFailed')),
  })

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return
    if (draft.length + list.length > MAX_ICONS) {
      toast.error(t('panelIcons.tooMany', { max: MAX_ICONS }))
      return
    }
    setPending((c) => c + list.length)
    const added: CustomIcon[] = []
    for (const file of list) {
      try {
        const url = await uploadCustomIconFile(file)
        added.push({
          id: makeId(),
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 64) || t('panelIcons.untitled'),
          url,
          color: null,
        })
      } catch (error) {
        const message =
          (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('panelIcons.uploadFailed', { name: file.name })
        toast.error(message)
      } finally {
        setPending((c) => Math.max(0, c - 1))
      }
    }
    if (added.length > 0) {
      setDraft((current) => [...current, ...added])
      setDirty(true)
    }
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setIsDragging(false)
    const files = event.dataTransfer?.files
    if (files && files.length > 0) void handleFiles(files)
  }

  function onSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files
    if (files && files.length > 0) void handleFiles(files)
    event.target.value = ''
  }

  function patchIcon(id: string, patch: Partial<CustomIcon>) {
    setDraft((current) => current.map((icon) => (icon.id === id ? { ...icon, ...patch } : icon)))
    setDirty(true)
  }

  function removeIcon(id: string) {
    setDraft((current) => current.filter((icon) => icon.id !== id))
    setDirty(true)
  }

  if (iconsQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{t('panelIcons.title')}</CardTitle>
            <CardDescription>{t('panelIcons.description')}</CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t('panelIcons.save')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Drop zone */}
        <button
          type="button"
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          aria-label={t('panelIcons.chooseFiles')}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors',
            isDragging ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/60 hover:bg-accent/40',
          )}
        >
          {pending > 0 ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="h-6 w-6 text-muted-foreground" />
          )}
          <p className="text-sm font-medium">
            {pending > 0 ? t('panelIcons.uploading', { count: pending }) : t('panelIcons.dropHere')}
          </p>
          <p className="text-xs text-muted-foreground">{t('panelIcons.hint')}</p>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_MIME}
          multiple
          className="hidden"
          onChange={onSelect}
          aria-label={t('panelIcons.chooseFiles')}
        />

        {/* Library grid */}
        {draft.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('panelIcons.empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {draft.map((icon) => (
              <div key={icon.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 p-3">
                {/* Preview on a checker-ish surface so light glyphs stay visible */}
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
                  <CustomIconView url={icon.url} color={icon.color} className="h-7 w-7" title={icon.name} />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    value={icon.name}
                    onChange={(e) => patchIcon(icon.id, { name: e.target.value.slice(0, 64) })}
                    placeholder={t('panelIcons.namePlaceholder')}
                    className="h-8 text-sm"
                    aria-label={t('panelIcons.nameLabel')}
                  />
                  <div className="flex items-center gap-2">
                    <Label className="text-[11px] text-muted-foreground">{t('panelIcons.color')}</Label>
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(icon.color ?? '') ? (icon.color as string) : '#ffffff'}
                      onChange={(e) => patchIcon(icon.id, { color: e.target.value })}
                      className="h-6 w-8 cursor-pointer rounded border"
                      aria-label={t('panelIcons.color')}
                    />
                    {icon.color && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px] text-muted-foreground"
                        onClick={() => patchIcon(icon.id, { color: null })}
                      >
                        <X className="mr-1 h-3 w-3" />
                        {t('panelIcons.clearColor')}
                      </Button>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => removeIcon(icon.id)}
                  aria-label={t('panelIcons.remove')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Plus className="h-3.5 w-3.5" />
          {t('panelIcons.countHint', { count: draft.length, max: MAX_ICONS })}
        </div>
      </CardContent>
    </Card>
  )
}
