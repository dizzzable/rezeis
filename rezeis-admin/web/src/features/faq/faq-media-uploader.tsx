/**
 * FaqMediaUploader
 * ────────────────
 * Drag-and-drop area for FAQ attachments. Accepts images and videos,
 * uploads them one-by-one through `POST /admin/faq/uploads`, and
 * reports the resulting URLs back to the parent form. The visible list
 * below the drop zone is sortable via dnd-kit so operators can shuffle
 * the order before saving.
 *
 * The component is intentionally self-contained — it doesn't know
 * anything about the FAQ entry being edited and could be reused by
 * other entities (broadcast, branding) with minimal tweaks.
 */
import { closestCenter, DndContext, DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChangeEvent, DragEvent, useCallback, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical, ImageIcon, Loader2, Trash2, Upload, Video } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface UploadResponse {
  readonly url: string
  readonly originalName: string
  readonly mimeType: string
  readonly mediaType: 'image' | 'video'
  readonly size: number
}

interface FaqMediaUploaderProps {
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  readonly disabled?: boolean
}

const ACCEPTED_MIME = 'image/*,video/*'
const MAX_FILES = 20

export function FaqMediaUploader({
  value,
  onChange,
  disabled,
}: FaqMediaUploaderProps): JSX.Element {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return
      if (value.length + list.length > MAX_FILES) {
        toast.error(
          t('faqPage.media.tooMany', { max: MAX_FILES }),
        )
        return
      }
      setPendingCount((current) => current + list.length)
      const collected: string[] = []
      for (const file of list) {
        try {
          const formData = new FormData()
          formData.append('file', file)
          const response = await api.post<UploadResponse>('/admin/faq/uploads', formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
          collected.push(response.data.url)
        } catch (error) {
          const message =
            (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
            t('faqPage.media.uploadFailed', { name: file.name })
          toast.error(message)
        } finally {
          setPendingCount((current) => Math.max(0, current - 1))
        }
      }
      if (collected.length > 0) {
        onChange([...value, ...collected])
      }
    },
    [onChange, t, value],
  )

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setIsDragging(false)
    if (disabled) return
    const files = event.dataTransfer?.files
    if (files && files.length > 0) {
      void handleFiles(files)
    }
  }

  function onSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files
    if (files && files.length > 0) {
      void handleFiles(files)
    }
    // Reset so the same file can be picked twice in a row.
    event.target.value = ''
  }

  function onRemove(url: string) {
    onChange(value.filter((entry) => entry !== url))
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setIsDragging(true)
        }}
        onDragEnter={(event) => {
          event.preventDefault()
          if (!disabled) setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        disabled={disabled}
        aria-label={t('faqPage.media.chooseFile')}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors',
          isDragging
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-primary/60 hover:bg-accent/40',
          disabled && 'cursor-not-allowed opacity-60',
          !disabled && 'cursor-pointer',
        )}
      >
        {pendingCount > 0 ? (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        ) : (
          <Upload className="h-6 w-6 text-muted-foreground" />
        )}
        <p className="text-sm font-medium">
          {pendingCount > 0
            ? t('faqPage.media.uploading', { count: pendingCount })
            : t('faqPage.media.dropHere')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('faqPage.media.hint', { max: MAX_FILES })}
        </p>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_MIME}
        multiple
        className="hidden"
        onChange={onSelect}
        disabled={disabled}
        aria-label={t('faqPage.media.chooseFile')}
      />

      {value.length > 0 ? (
        <SortableMediaGrid value={value} onChange={onChange} onRemove={onRemove} disabled={disabled} />
      ) : null}
    </div>
  )
}

// ── Sortable grid ──────────────────────────────────────────────────────────

interface SortableMediaGridProps {
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  readonly onRemove: (url: string) => void
  readonly disabled?: boolean
}

function SortableMediaGrid({
  value,
  onChange,
  onRemove,
  disabled,
}: SortableMediaGridProps): JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = value.indexOf(String(active.id))
    const newIndex = value.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    onChange(arrayMove([...value], oldIndex, newIndex))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={[...value]} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {value.map((url) => (
            <SortableMediaTile
              key={url}
              url={url}
              onRemove={() => onRemove(url)}
              disabled={disabled}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

interface SortableMediaTileProps {
  readonly url: string
  readonly onRemove: () => void
  readonly disabled?: boolean
}

function SortableMediaTile({ url, onRemove, disabled }: SortableMediaTileProps): JSX.Element {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: url,
    disabled,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const isVideo = inferIsVideo(url)
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative aspect-square overflow-hidden rounded-md border bg-muted',
        isDragging && 'ring-2 ring-primary',
      )}
    >
      {isVideo ? (
        <video
          src={url}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
        />
      ) : (
        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
      )}

      <div className="absolute left-1 top-1 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100">
        {isVideo ? <Video className="h-3 w-3" /> : <ImageIcon className="h-3 w-3" />}
      </div>

      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute right-1 top-1 cursor-grab rounded bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
        aria-label={t('faqPage.media.reorderAriaLabel')}
      >
        <GripVertical className="h-3 w-3" />
      </button>

      <Button
        type="button"
        variant="destructive"
        size="icon"
        className="absolute bottom-1 right-1 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        disabled={disabled}
        aria-label={t('faqPage.media.removeAriaLabel')}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

const VIDEO_EXTENSION_REGEX = /\.(mp4|webm|mov|ogv|m4v)(\?|$)/i

function inferIsVideo(url: string): boolean {
  return VIDEO_EXTENSION_REGEX.test(url)
}
