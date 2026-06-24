import type { JSX } from 'react'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Plus, Pencil, Trash2, Loader2, Save, ImageIcon, Video } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { FadeIn } from '@/lib/motion'

import { FaqMediaUploader } from './faq-media-uploader'

interface FaqItem {
  readonly id: string
  readonly question: string
  readonly answer: string
  readonly mediaUrls: readonly string[]
  readonly orderIndex: number
  readonly isActive: boolean
  readonly locale: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

interface FaqFormState {
  question: string
  answer: string
  mediaUrls: string[]
  orderIndex: number
  locale: string
  isActive: boolean
}

const EMPTY_FORM: FaqFormState = {
  question: '',
  answer: '',
  mediaUrls: [],
  orderIndex: 0,
  locale: '',
  isActive: true,
}

const VIDEO_EXTENSION_REGEX = /\.(mp4|webm|mov|ogv|m4v)(\?|$)/i

/**
 * FAQ admin page.
 *
 * Backend lives at `/admin/faq` (`AdminFaqController`). Each entry can
 * carry a sortable list of attachments uploaded through
 * `POST /admin/faq/uploads`. The page renders inline previews for both
 * images and short videos.
 *
 * All visible copy comes from the i18n catalog (`faqPage.*`) so no
 * strings are pinned to a single language.
 */
export default function FaqPage(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<FaqItem | null>(null)
  const [formState, setFormState] = useState<FaqFormState>(EMPTY_FORM)
  const [showDialog, setShowDialog] = useState(false)

  const { data: items, isLoading } = useQuery({
    queryKey: ['admin', 'faq'],
    queryFn: async () => (await api.get<readonly FaqItem[]>('/admin/faq')).data,
  })

  const createMutation = useMutation({
    mutationFn: (payload: Omit<FaqFormState, 'orderIndex' | 'locale'> & { orderIndex: number; locale: string | null }) =>
      api.post('/admin/faq', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'faq'] })
      setShowDialog(false)
      setEditing(null)
      toast.success(t('faqPage.toasts.created'))
    },
    onError: (error) => {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('faqPage.toasts.createFailed')
      toast.error(message)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: Partial<Omit<FaqFormState, 'locale'>> & { locale?: string | null }
    }) => api.patch(`/admin/faq/${id}`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'faq'] })
      setShowDialog(false)
      setEditing(null)
      toast.success(t('faqPage.toasts.updated'))
    },
    onError: (error) => {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('faqPage.toasts.updateFailed')
      toast.error(message)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/faq/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'faq'] })
      toast.success(t('faqPage.toasts.deleted'))
    },
    onError: () => toast.error(t('faqPage.toasts.deleteFailed')),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/faq/${id}`, { isActive }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'faq'] })
    },
    onError: () => toast.error(t('faqPage.toasts.toggleFailed')),
  })

  function openCreate() {
    setEditing(null)
    setFormState(EMPTY_FORM)
    setShowDialog(true)
  }

  function openEdit(item: FaqItem) {
    setEditing(item)
    setFormState({
      question: item.question,
      answer: item.answer,
      mediaUrls: [...item.mediaUrls],
      orderIndex: item.orderIndex,
      locale: item.locale ?? '',
      isActive: item.isActive,
    })
    setShowDialog(true)
  }

  function closeDialog() {
    setShowDialog(false)
    setEditing(null)
  }

  function handleSubmit() {
    const trimmedQuestion = formState.question.trim()
    const trimmedAnswer = formState.answer.trim()
    if (trimmedQuestion.length === 0 || trimmedAnswer.length === 0) {
      toast.error(t('faqPage.toasts.validationFailed'))
      return
    }
    const orderIndex = Number.isFinite(formState.orderIndex) ? formState.orderIndex : 0
    const locale = formState.locale.trim().length > 0 ? formState.locale.trim() : null
    const payload = {
      question: trimmedQuestion,
      answer: trimmedAnswer,
      mediaUrls: formState.mediaUrls,
      orderIndex,
      locale,
      isActive: formState.isActive,
    }
    if (editing) {
      updateMutation.mutate({ id: editing.id, payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  function handleDelete(item: FaqItem) {
    deleteMutation.mutate(item.id)
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <HelpCircle className="h-6 w-6" />
              {t('faqPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('faqPage.subtitle')}</p>
          </div>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            {t('faqPage.addButton')}
          </Button>
        </div>
      </FadeIn>

      <Card>
        <CardHeader>
          <CardTitle>{t('faqPage.listTitle')}</CardTitle>
          <CardDescription>{t('faqPage.listDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !items || items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <HelpCircle className="h-10 w-10 opacity-30" />
              <p>{t('faqPage.empty')}</p>
            </div>
          ) : (
            items.map((item) => (
              <FaqRow
                key={item.id}
                item={item}
                onEdit={() => openEdit(item)}
                onDelete={() => handleDelete(item)}
                onToggle={(isActive) => toggleMutation.mutate({ id: item.id, isActive })}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={(open) => { if (!open) closeDialog() }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('faqPage.editTitle') : t('faqPage.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('faqPage.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('faqPage.fields.question')}</Label>
              <Input
                value={formState.question}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, question: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('faqPage.fields.answer')}</Label>
              <Textarea
                value={formState.answer}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, answer: event.target.value }))
                }
                className="min-h-32 font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground">{t('faqPage.fields.answerHint')}</p>
            </div>

            <div className="space-y-2">
              <Label>{t('faqPage.fields.media')}</Label>
              <FaqMediaUploader
                value={formState.mediaUrls}
                onChange={(next) => setFormState((prev) => ({ ...prev, mediaUrls: next }))}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('faqPage.fields.orderIndex')}</Label>
                <Input
                  type="number"
                  value={formState.orderIndex}
                  onChange={(event) =>
                    setFormState((prev) => ({
                      ...prev,
                      orderIndex: Number.isFinite(Number(event.target.value))
                        ? parseInt(event.target.value, 10)
                        : 0,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('faqPage.fields.locale')}</Label>
                <Input
                  placeholder={t('faqPage.fields.localePlaceholder')}
                  value={formState.locale}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, locale: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border px-4 py-2.5">
              <Label>{t('faqPage.fields.isActive')}</Label>
              <Switch
                checked={formState.isActive}
                onCheckedChange={(checked) =>
                  setFormState((prev) => ({ ...prev, isActive: checked }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              {t('faqPage.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              className="gap-2"
            >
              {createMutation.isPending || updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t('faqPage.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface FaqRowProps {
  readonly item: FaqItem
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onToggle: (isActive: boolean) => void
}

function FaqRow({ item, onEdit, onDelete, onToggle }: FaqRowProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">
            #{item.orderIndex}
          </Badge>
          {item.locale ? (
            <Badge variant="secondary" className="text-[10px]">
              {item.locale}
            </Badge>
          ) : null}
          {item.mediaUrls.length > 0 ? (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <ImageIcon className="h-3 w-3" /> {item.mediaUrls.length}
            </Badge>
          ) : null}
          <span className="truncate text-sm font-medium">{item.question}</span>
        </div>
        <p className="max-w-xl truncate text-xs text-muted-foreground">
          {item.answer.replace(/<[^>]+>/g, '').slice(0, 160)}
        </p>
        {item.mediaUrls.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.mediaUrls.slice(0, 6).map((url) => (
              <FaqMediaThumb key={url} url={url} />
            ))}
            {item.mediaUrls.length > 6 ? (
              <div className="flex h-12 w-12 items-center justify-center rounded border bg-muted text-[10px] font-medium text-muted-foreground">
                +{item.mediaUrls.length - 6}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={item.isActive}
          onCheckedChange={onToggle}
          aria-label={t('faqPage.row.toggleAriaLabel')}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onEdit}
          aria-label={t('faqPage.row.editAriaLabel')}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              aria-label={t('faqPage.row.deleteAriaLabel')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('faqPage.deleteDialogTitle')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('faqPage.deleteConfirm', { question: item.question })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('faqPage.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={onDelete}
              >
                {t('faqPage.deleteDialogAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}

function FaqMediaThumb({ url }: { url: string }): JSX.Element {
  const isVideo = VIDEO_EXTENSION_REGEX.test(url)
  return (
    <div className="relative h-12 w-12 overflow-hidden rounded border bg-muted">
      {isVideo ? (
        <>
          <video src={url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
            <Video className="h-3.5 w-3.5" />
          </div>
        </>
      ) : (
        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
      )}
    </div>
  )
}
