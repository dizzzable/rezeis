/**
 * BannerField — assign a banner to a bot node: pick from the reusable
 * library, upload a new one (which joins the library), or clear it (fall
 * back to the global default). Used by the bot-map inspectors.
 *
 * The stored value is the banner URL (relative `/uploads/...` or absolute).
 * Relative URLs preview correctly because the admin SPA is served from the
 * same origin that hosts the uploads.
 */
import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ImageOff, Loader2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  BOT_BANNERS_QUERY_KEY,
  deleteBanner,
  fetchBanners,
  uploadBanner,
  type BotBannerView,
} from '../bot-map-api'

interface BannerFieldProps {
  readonly value: string | null
  readonly onChange: (url: string | null) => void
  readonly disabled?: boolean
}

export function BannerField({ value, onChange, disabled }: BannerFieldProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: banners } = useQuery({
    queryKey: BOT_BANNERS_QUERY_KEY,
    queryFn: fetchBanners,
  })

  const [uploading, setUploading] = useState(false)

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadBanner(file),
    onSuccess: (created: BotBannerView) => {
      void queryClient.invalidateQueries({ queryKey: BOT_BANNERS_QUERY_KEY })
      onChange(created.url)
      toast.success(t('botMapPage.banner.uploaded'))
    },
    onError: () => toast.error(t('botMapPage.banner.uploadFailed')),
    onSettled: () => setUploading(false),
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteBanner(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BOT_BANNERS_QUERY_KEY }),
  })

  const handleFile = (file: File) => {
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t('botMapPage.banner.tooLarge'))
      return
    }
    setUploading(true)
    uploadMutation.mutate(file)
  }

  // Match the current value to a known library entry (for the select).
  const selectedId = banners?.find((b) => b.url === value)?.id ?? ''

  return (
    <div className="space-y-2">
      <Label className="text-xs">{t('botMapPage.banner.label')}</Label>

      {value ? (
        <div className="relative overflow-hidden rounded-md border">
          <img src={value} alt="" className="h-24 w-full object-cover" />
          <Button
            type="button"
            size="icon"
            variant="destructive"
            className="absolute right-1 top-1 h-6 w-6"
            onClick={() => onChange(null)}
            disabled={disabled}
            aria-label={t('botMapPage.banner.clear')}
          >
            <X className="h-3 w-3" aria-hidden />
          </Button>
        </div>
      ) : (
        <div className="flex h-16 items-center justify-center rounded-md border border-dashed text-[11px] text-muted-foreground">
          <ImageOff className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {t('botMapPage.banner.none')}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Select
          value={selectedId}
          onValueChange={(id) => {
            const picked = banners?.find((b) => b.id === id)
            if (picked) onChange(picked.url)
          }}
          disabled={disabled || (banners?.length ?? 0) === 0}
        >
          <SelectTrigger className="h-8 flex-1 text-xs" aria-label={t('botMapPage.banner.pick')}>
            <SelectValue placeholder={t('botMapPage.banner.pick')} />
          </SelectTrigger>
          <SelectContent>
            {banners?.map((b) => (
              <SelectItem key={b.id} value={b.id} className="text-xs">
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-xs"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || uploading}
        >
          {uploading ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Upload className="mr-1 h-3.5 w-3.5" aria-hidden />
          )}
          {t('botMapPage.banner.upload')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          aria-label={t('botMapPage.banner.upload')}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
      </div>

      {selectedId.length > 0 && (
        <button
          type="button"
          onClick={() => removeMutation.mutate(selectedId)}
          disabled={disabled || removeMutation.isPending}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
        >
          {t('botMapPage.banner.deleteFromLibrary')}
        </button>
      )}

      <p className="text-[10px] leading-snug text-muted-foreground">
        {t('botMapPage.banner.hint')}
      </p>
    </div>
  )
}
