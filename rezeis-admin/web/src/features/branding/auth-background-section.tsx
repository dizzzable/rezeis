/**
 * AuthBackgroundSection — background media for the WEB cabinet's entry screens
 * (sign in, sign up, "forgot password").
 *
 * Three states, one block: `none` (the shipped look), `image` and `video`. The
 * file itself is uploaded to the panel (same bucket as the logo, and the same
 * `/uploads/branding/...` relay in the cabinet), or an absolute `https://`
 * address is pasted; the stored value is the address. The upload route answers
 * the KIND it sniffed from the bytes, so a clip picked through the photo button
 * becomes a video instead of being stored as an image — which is exactly the
 * failure the operator hit. The API replaces this block WHOLE, so every change
 * below sends both members — a `kind` without a matching URL renders nothing.
 *
 * Fully controlled via a single `value`/`onChange` pair mirroring the
 * `authBackground` branding draft.
 */

import { useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
  BRANDING_AUTH_BACKGROUND_KINDS,
  type BrandingAuthBackgroundDraft,
} from './branding-form-schema'

/** i18n key for each background mode's label. */
const KIND_LABEL_KEYS = {
  none: 'brandingPage.authBackground.kindNone',
  image: 'brandingPage.authBackground.kindImage',
  video: 'brandingPage.authBackground.kindVideo',
} as const

/** What the upload route answers: the stored URL and the kind it sniffed. */
export interface AuthBackgroundUploadResult {
  readonly kind: 'image' | 'video'
  readonly url: string
}

interface AuthBackgroundSectionProps {
  readonly value: BrandingAuthBackgroundDraft
  readonly onChange: (value: BrandingAuthBackgroundDraft) => void
  /**
   * Uploads the chosen file and resolves to its URL plus its sniffed kind. The
   * address being replaced travels along so the API can retire a file this
   * session staged and then dropped — one the saved row never pointed at, so
   * removing it cannot break the live entry screen.
   */
  readonly upload: (file: File, previousUrl: string | null) => Promise<AuthBackgroundUploadResult>
  readonly error?: string
}

export function AuthBackgroundSection({
  value,
  onChange,
  upload,
  error,
}: AuthBackgroundSectionProps) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<'image' | 'video' | null>(null)

  const handleUpload = async (
    event: ChangeEvent<HTMLInputElement>,
    picked: 'image' | 'video',
  ): Promise<void> => {
    const file = event.target.files?.[0]
    // Reset first: picking the same file twice must fire `change` again.
    event.target.value = ''
    if (!file) return
    setUploading(picked)
    try {
      const result = await upload(file, value.kind === 'none' ? null : (value.url ?? null))
      onChange({ kind: result.kind, url: result.url })
    } catch {
      toast.error(t('brandingPage.authBackground.uploadFailed'))
    } finally {
      setUploading(null)
    }
  }

  // A preview needs BOTH halves: a URL without a kind is not rendered by the
  // cabinet, and the API would answer such a block with the default.
  const previewUrl =
    value.kind === 'none' ? null : (value.url ?? '').trim() || null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.authBackground.title')}</CardTitle>
        <CardDescription>{t('brandingPage.authBackground.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="branding-auth-background-kind">
            {t('brandingPage.authBackground.kindLabel')}
          </Label>
          <Select
            value={value.kind}
            onValueChange={(kind) =>
              onChange({
                kind: kind as BrandingAuthBackgroundDraft['kind'],
                // `none` means "no background"; keeping the old address would
                // send a block whose halves disagree, which the API refuses.
                url: kind === 'none' ? null : value.url,
              })
            }
          >
            <SelectTrigger id="branding-auth-background-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BRANDING_AUTH_BACKGROUND_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(KIND_LABEL_KEYS[kind])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {value.kind !== 'none' && (
          <div className="space-y-2">
            <Label htmlFor="branding-auth-background-url">
              {t('brandingPage.authBackground.urlLabel')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="branding-auth-background-url"
                value={value.url ?? ''}
                onChange={(event) =>
                  onChange({ ...value, url: event.target.value })
                }
                placeholder={t('brandingPage.authBackground.urlPlaceholder')}
                className="font-mono text-xs"
                aria-invalid={error ? true : undefined}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => void handleUpload(event, 'image')}
              />
              <input
                id="branding-auth-background-video-file"
                type="file"
                accept="video/mp4,video/webm"
                className="hidden"
                onChange={(event) => void handleUpload(event, 'video')}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading !== null}
                onClick={() => fileRef.current?.click()}
              >
                {uploading === 'image' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {uploading === 'image'
                  ? t('brandingPage.authBackground.uploading')
                  : t('brandingPage.authBackground.upload')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading !== null}
                onClick={() =>
                  document.getElementById('branding-auth-background-video-file')?.click()
                }
              >
                {uploading === 'video' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {uploading === 'video'
                  ? t('brandingPage.authBackground.uploading')
                  : t('brandingPage.authBackground.uploadVideo')}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('brandingPage.authBackground.urlHint')}
            </p>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-[42rem] text-[11px] text-muted-foreground">
            {t('brandingPage.authBackground.appliesTo')}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={value.kind === 'none' && value.url === null}
            onClick={() => onChange({ kind: 'none', url: null })}
          >
            {t('brandingPage.authBackground.clear')}
          </Button>
        </div>

        {previewUrl !== null && (
          <div className="space-y-2">
            <Label>{t('brandingPage.authBackground.preview')}</Label>
            {value.kind === 'image' ? (
              <img
                src={previewUrl}
                alt={t('brandingPage.authBackground.preview')}
                className="max-h-56 w-full rounded-md object-cover ring-1 ring-border"
              />
            ) : (
              <video
                src={previewUrl}
                aria-label={t('brandingPage.authBackground.preview')}
                className="max-h-56 w-full rounded-md object-cover ring-1 ring-border"
                muted
                loop
                autoPlay
                playsInline
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
