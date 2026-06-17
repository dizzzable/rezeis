import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Smile, Upload, Loader2, Trash2, Save, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

import { EmojiPreview } from './emoji-preview'
import { EmojiStudioTab } from './emoji-studio-tab'

interface CustomEmoji {
  readonly slug: string
  readonly name: string
  readonly imageUrl: string
  readonly lottieUrl: string | null
  readonly videoUrl: string | null
  readonly fallback: string | null
  readonly customEmojiId: string | null
}
interface CustomEmojiPack {
  readonly id: string
  readonly name: string
  readonly builtin?: boolean
  readonly emojis: readonly CustomEmoji[]
}

const PACKS_KEY = ['admin', 'custom-emoji', 'packs'] as const

export default function CustomEmojiPage() {
  const { t } = useTranslation()
  const { data: packs, isLoading } = useQuery<ReadonlyArray<CustomEmojiPack>>({
    queryKey: PACKS_KEY,
    queryFn: async () => (await api.get<ReadonlyArray<CustomEmojiPack>>('/admin/custom-emoji/packs')).data,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Smile className="h-6 w-6" /> {t('emojiPacksPage.title')}
        </h1>
        <p className="text-muted-foreground">{t('emojiPacksPage.subtitle')}</p>
      </div>

      <Tabs defaultValue="packs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="packs">{t('emojiPacksPage.tabs.packs')}</TabsTrigger>
          <TabsTrigger value="slots">{t('emojiPacksPage.tabs.slots')}</TabsTrigger>
        </TabsList>

        <TabsContent value="packs" className="space-y-6">
          <ImportSetCard />

          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : !packs?.length ? (
            <Card>
              <CardContent className="py-16 text-center text-muted-foreground">
                <Smile className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>{t('emojiPacksPage.empty')}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {packs.map((pack) => (
                <PackCard key={pack.id} pack={pack} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="slots">
          <EmojiStudioTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ImportSetCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [packName, setPackName] = useState('')
  const [link, setLink] = useState('')

  const importMutation = useMutation({
    mutationFn: () =>
      api.post(
        '/admin/custom-emoji/import-by-link',
        { packName: packName.trim(), link: link.trim() },
        { timeout: 300_000 },
      ),
    onSuccess: () => {
      setPackName('')
      setLink('')
      toast.success(t('emojiPacksPage.importSet.success'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('emojiPacksPage.importSet.failed'))),
    onSettled: () => {
      // A big set can outlast the request; refresh either way so the imported
      // pack shows up without a manual page reload.
      queryClient.invalidateQueries({ queryKey: PACKS_KEY })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('emojiPacksPage.importSet.title')}</CardTitle>
        <CardDescription>{t('emojiPacksPage.importSet.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="emoji-set-link">{t('emojiPacksPage.importSet.linkLabel')}</Label>
          <Input
            id="emoji-set-link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://t.me/addemoji/NewsEmoji"
          />
          <p className="text-xs text-muted-foreground">{t('emojiPacksPage.importSet.linkHint')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="emoji-set-name">{t('emojiPacksPage.importSet.nameLabel')}</Label>
          <Input
            id="emoji-set-name"
            value={packName}
            onChange={(e) => setPackName(e.target.value)}
            placeholder={t('emojiPacksPage.importSet.namePlaceholder')}
          />
        </div>
        <Button
          onClick={() => importMutation.mutate()}
          disabled={importMutation.isPending || link.trim().length === 0}
        >
          {importMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
          {t('emojiPacksPage.importSet.button')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('emojiPacksPage.importSet.hint')}</p>
      </CardContent>
    </Card>
  )
}

function PackCard({ pack }: { pack: CustomEmojiPack }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/admin/custom-emoji/packs/${encodeURIComponent(pack.id)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PACKS_KEY })
      toast.success(t('emojiPacksPage.pack.deleted'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('emojiPacksPage.pack.deleteFailed'))),
  })

  const preview = pack.emojis.slice(0, 14)

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{pack.name}</span>
              {pack.builtin && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t('emojiPacksPage.pack.standardBadge')}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {t('emojiPacksPage.pack.count', { count: pack.emojis.length })}
            </div>
          </div>
          {!open && (
            <div className="ml-2 hidden min-w-0 flex-1 items-center gap-1 overflow-hidden sm:flex">
              {preview.map((emoji) => (
                <EmojiPreview
                  key={emoji.slug}
                  imageUrl={emoji.imageUrl}
                  lottieUrl={emoji.lottieUrl}
                  videoUrl={emoji.videoUrl}
                  alt={emoji.name}
                  className="h-6 w-6 shrink-0"
                />
              ))}
              {pack.emojis.length > preview.length && (
                <span className="shrink-0 pl-1 text-xs text-muted-foreground">
                  +{pack.emojis.length - preview.length}
                </span>
              )}
            </div>
          )}
        </button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 text-destructive"
              aria-label={t('emojiPacksPage.pack.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('emojiPacksPage.pack.deleteTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('emojiPacksPage.pack.deleteConfirm')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {t('emojiPacksPage.pack.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {open && (
        <CardContent className="border-t pt-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pack.emojis.map((emoji) => (
              <EmojiRow key={emoji.slug} packId={pack.id} emoji={emoji} />
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function EmojiRow({ packId, emoji }: { packId: string; emoji: CustomEmoji }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState(emoji.name)
  const [fallback, setFallback] = useState(emoji.fallback ?? '')
  const [customEmojiId, setCustomEmojiId] = useState(emoji.customEmojiId ?? '')

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/custom-emoji/packs/${encodeURIComponent(packId)}/emoji/${encodeURIComponent(emoji.slug)}`, {
        name: name.trim(),
        fallback: fallback.trim() || null,
        customEmojiId: customEmojiId.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PACKS_KEY })
      toast.success(t('emojiPacksPage.emoji.saved'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('emojiPacksPage.emoji.saveFailed'))),
  })

  return (
    <div className="flex items-center gap-2 rounded-md border p-2">
      <EmojiPreview
        imageUrl={emoji.imageUrl}
        lottieUrl={emoji.lottieUrl}
        videoUrl={emoji.videoUrl}
        alt={emoji.name}
        className="h-9 w-9 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 text-xs"
          aria-label={t('emojiPacksPage.emoji.name')}
        />
        <div className="flex items-center gap-1">
          <code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">:{emoji.slug}:</code>
          <Input
            value={fallback}
            onChange={(e) => setFallback(e.target.value)}
            className="h-7 w-12 text-xs"
            placeholder={t('emojiPacksPage.emoji.fallbackPlaceholder')}
            aria-label={t('emojiPacksPage.emoji.fallback')}
          />
          <Input
            value={customEmojiId}
            onChange={(e) => setCustomEmojiId(e.target.value)}
            className="h-7 flex-1 font-mono text-[10px]"
            placeholder={t('emojiPacksPage.emoji.idPlaceholder')}
            aria-label={t('emojiPacksPage.emoji.id')}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            aria-label={t('emojiPacksPage.emoji.save')}
          >
            {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
