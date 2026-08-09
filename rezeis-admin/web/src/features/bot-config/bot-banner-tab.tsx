/**
 * Bot welcome-banner editor.
 *
 * Lets the operator drop a PNG/JPEG/WebP/GIF image (≤ 8MB) onto a
 * preview pane and have it persisted to the admin host's filesystem.
 * The resulting URL is upserted into the `bot.banner_url` BotText row,
 * which `internal-bot-config` already reads and reiwa-bot already
 * fetches on every `/start`.
 *
 * Three states:
 *   - No banner configured  → "Drop a file" empty drop-zone.
 *   - Banner URL present    → Preview thumbnail + "Replace" + "Remove"
 *                              buttons. Replace re-opens the file
 *                              picker, Remove clears the BotText row
 *                              (reiwa falls back to the bundled
 *                              `assets/banners/default.jpg`).
 *   - Upload in flight      → Same UI but with a loading overlay.
 *
 * The cache invalidate interceptor on the upload endpoint pushes a
 * synchronous bust to reiwa-bot, so the next user `/start` sees the
 * new banner without a manual refresh.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Image as ImageIcon, Loader2, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'
import { Button } from '@/components/ui/button'

const BOT_TEXTS_QUERY_KEY = ['bot-texts'] as const
const BANNER_TEXT_KEY = 'bot.banner_url'
const MAX_FILE_BYTES = 8 * 1024 * 1024

interface BotTextRow {
  readonly id: string
  readonly key: string
  readonly value: string
  readonly visible: boolean
}

interface BannerUploadResponse {
  readonly url: string
  readonly size: number
}

export default function BotBannerTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const { data: texts } = useQuery({
    queryKey: BOT_TEXTS_QUERY_KEY,
    queryFn: async (): Promise<BotTextRow[]> => {
      const { data } = await api.get('/admin/bot-config/texts')
      return expectArray<BotTextRow>(data)
    },
  })

  const bannerRow = texts?.find((row) => row.key === BANNER_TEXT_KEY) ?? null
  const bannerUrl = (bannerRow?.value ?? '').trim()
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  // Sync preview when admin payload changes (e.g. after upload mutation
  // settles and the query refetches). Relative URLs need the admin
  // host prefix to render in the SPA — assume same-origin in dev.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (bannerUrl.length === 0) {
      setPreviewSrc(null)
      return
    }
    setPreviewSrc(bannerUrl)
  /* eslint-enable react-hooks/set-state-in-effect */
  }, [bannerUrl])

  const uploadMutation = useMutation({
    mutationFn: async (file: File): Promise<BannerUploadResponse> => {
      const form = new FormData()
      form.append('file', file)
      const { data } = await api.post<BannerUploadResponse>(
        '/admin/bot-config/banner',
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BOT_TEXTS_QUERY_KEY })
      toast.success(t('botBanner.uploadSuccess'))
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : t('botBanner.uploadErrorGeneric')
      toast.error(message)
    },
  })

  const removeMutation = useMutation({
    mutationFn: async () => {
      if (bannerRow === null) return
      // Soft-clear: write an empty value so the unique key constraint
      // doesn't fight us. Reiwa treats empty string as "no banner" and
      // falls back to the FS default at assets/banners/default.jpg.
      await api.patch(`/admin/bot-config/texts/${bannerRow.id}`, { value: '' })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BOT_TEXTS_QUERY_KEY })
      toast.success(t('botBanner.removed'))
    },
    onError: () => {
      toast.error(t('botBanner.removeError'))
    },
  })

  const handleFile = (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      toast.error(t('botBanner.fileTooLarge'))
      return
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      toast.error(t('botBanner.unsupportedType'))
      return
    }
    uploadMutation.mutate(file)
  }

  const onPickClick = () => {
    fileInputRef.current?.click()
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t('botBanner.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('botBanner.description')}
        </p>
      </div>

      {previewSrc !== null ? (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-lg border">
            <img
              src={previewSrc}
              alt={t('botBanner.previewAlt')}
              className="block h-48 w-full object-cover"
            />
            {uploadMutation.isPending && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onPickClick}
              disabled={uploadMutation.isPending}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t('botBanner.replace')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t('botBanner.remove')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t('botBanner.urlHint')}
          </p>
          <code className="block break-all rounded-md border bg-muted/40 px-2 py-1.5 text-[10px]">
            {bannerUrl}
          </code>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPickClick}
          disabled={uploadMutation.isPending}
          className="flex h-48 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploadMutation.isPending ? (
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
          ) : (
            <ImageIcon className="h-8 w-8 text-muted-foreground" aria-hidden />
          )}
          <span className="text-sm font-medium">
            {t('botBanner.pickHint')}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t('botBanner.formats')}
          </span>
        </button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Reset so the same file can be picked twice in a row
          event.target.value = ''
          if (file) handleFile(file)
        }}
        aria-label={t('botBanner.pickAria')}
      />
    </div>
  )
}
