import { useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Megaphone, Send, XCircle, Trash2, Loader2, RefreshCw, Upload, FileImage, FileVideo, X, Pencil, Clock, FlaskConical } from 'lucide-react'
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePicker } from '@/components/ui/date-picker'
import { FadeIn } from '@/lib/motion'
import {
  createBroadcastFormSchema,
  type BroadcastCreateRequest,
  type BroadcastFormDraft,
  type BroadcastFormValidationMessages,
} from './broadcast-form-schema'
import { EmojiPicker } from './emoji-picker'
import { RenderedCopyPreview } from '@/features/custom-emoji/rendered-copy-preview'

const AUDIENCES = [
  { value: 'ALL', labelKey: 'broadcastPage.audiences.ALL' },
  { value: 'ACTIVE_SUBSCRIBERS', labelKey: 'broadcastPage.audiences.ACTIVE_SUBSCRIBERS' },
  { value: 'UNSUBSCRIBED', labelKey: 'broadcastPage.audiences.UNSUBSCRIBED' },
  { value: 'EXPIRED', labelKey: 'broadcastPage.audiences.EXPIRED' },
  { value: 'TRIAL', labelKey: 'broadcastPage.audiences.TRIAL' },
] as const

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  COMPLETED: 'default',
  PROCESSING: 'secondary',
  FAILED: 'destructive',
  CANCELED: 'outline',
  DELETED: 'outline',
}

interface BroadcastRow {
  readonly id: string
  readonly audience: string
  readonly status: string
  readonly successCount: number
  readonly totalCount: number
  readonly failedCount: number
  readonly createdAt: string
}

export default function BroadcastPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const { data, isLoading, refetch } = useQuery<ReadonlyArray<BroadcastRow>>({
    queryKey: adminQueryKeys.broadcast.all,
    queryFn: async ({ signal }) =>
      (await api.get<ReadonlyArray<BroadcastRow>>('/admin/broadcast/drafts', { signal })).data,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/broadcast/${id}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.canceled'))
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('broadcastPage.toast.cancelFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/broadcast/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.deleted'))
    },
  })

  const stats = data?.reduce(
    (acc: { total: number; completed: number; processing: number }, b) => {
      acc.total++
      if (b.status === 'COMPLETED') acc.completed++
      if (b.status === 'PROCESSING') acc.processing++
      return acc
    },
    { total: 0, completed: 0, processing: 0 },
  ) ?? { total: 0, completed: 0, processing: 0 }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Megaphone className="h-6 w-6" /> {t('broadcastPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('broadcastPage.subtitle')}</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => refetch()}
              aria-label={t('broadcastPage.refreshBroadcasts')}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" /> {t('broadcastPage.newButton')}</Button>
          </div>
        </div>
      </FadeIn>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: t('broadcastPage.stats.total'), value: stats.total, icon: Megaphone },
          { label: t('broadcastPage.stats.completed'), value: stats.completed, icon: Send },
          { label: t('broadcastPage.stats.processing'), value: stats.processing, icon: Loader2 },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <s.icon className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold tabular-nums">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : !data?.length ? (
            <div className="py-16 text-center text-muted-foreground">
              <Megaphone className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>{t('broadcastPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>{t('broadcastPage.columns.audience')}</TableHead>
                  <TableHead>{t('broadcastPage.columns.status')}</TableHead>
                  <TableHead>{t('broadcastPage.columns.progress')}</TableHead>
                  <TableHead>{t('broadcastPage.columns.created')}</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">{b.id}</TableCell>
                    <TableCell><Badge variant="outline">{String(t(`broadcastPage.audiences.${b.audience}`, b.audience))}</Badge></TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[b.status] ?? 'secondary'}>{String(t(`broadcastPage.statuses.${b.status}`, b.status))}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">
                      <span className="text-emerald-600">{b.successCount}</span>
                      <span className="text-muted-foreground">/{b.totalCount}</span>
                      {b.failedCount > 0 && <span className="text-destructive ml-1">({t('broadcastPage.failedCount', { count: b.failedCount })})</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(b.createdAt).toLocaleString('ru-RU')}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {b.status === 'PROCESSING' && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                            aria-label={t('broadcastPage.cancelBroadcast')}
                            onClick={() => cancelMutation.mutate(b.id)}>
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {b.status === 'COMPLETED' && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                            aria-label={t('broadcastPage.editBroadcast')}
                            onClick={() => setEditId(b.id)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {['COMPLETED', 'CANCELED', 'FAILED'].includes(b.status) && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive"
                                aria-label={t('broadcastPage.deleteBroadcast')}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {t('broadcastPage.deleteDialogTitle')}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t('broadcastPage.deleteConfirm')}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel disabled={deleteMutation.isPending}>
                                  {t('common.cancel')}
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  disabled={deleteMutation.isPending}
                                  onClick={() => deleteMutation.mutate(b.id)}
                                >
                                  {t('broadcastPage.deleteDialogAction')}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('broadcastPage.newButton')}</DialogTitle>
            <DialogDescription>{t('broadcastPage.form.description')}</DialogDescription>
          </DialogHeader>
          <CreateBroadcastForm onClose={() => setShowCreate(false)} />
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editId !== null} onOpenChange={(open) => { if (!open) setEditId(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('broadcastPage.edit.title')}</DialogTitle>
            <DialogDescription>{t('broadcastPage.edit.description')}</DialogDescription>
          </DialogHeader>
          {editId !== null && (
            <EditBroadcastForm broadcastId={editId} onClose={() => setEditId(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Create form ───────────────────────────────────────────────────────────────

interface UploadedMedia {
  readonly mediaType: 'photo' | 'video'
  readonly fileId: string
  readonly fileName: string
  readonly mimeType: string
  readonly sizeBytes: number
}

function CreateBroadcastForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const validationMessages = useMemo<BroadcastFormValidationMessages>(() => ({
    audienceInvalid: t('broadcastPage.form.validation.audienceInvalid'),
    titleTooLong: t('broadcastPage.form.validation.titleTooLong'),
    textRequired: t('broadcastPage.form.validation.textRequired'),
    textTooLong: t('broadcastPage.form.validation.textTooLong'),
    mediaTypeInvalid: t('broadcastPage.form.validation.mediaTypeInvalid'),
    mediaRequired: t('broadcastPage.form.validation.mediaRequired'),
    mediaTooLong: t('broadcastPage.form.validation.mediaTooLong'),
    mediaUrlInvalid: t('broadcastPage.form.validation.mediaUrlInvalid'),
    mediaFileIdInvalid: t('broadcastPage.form.validation.mediaFileIdInvalid'),
  }), [t])
  const formSchema = useMemo(() => createBroadcastFormSchema(validationMessages), [validationMessages])
  const form = useForm<BroadcastFormDraft, unknown, BroadcastCreateRequest>({
    defaultValues: {
      audience: 'ALL',
      title: '',
      text: '',
      mediaType: 'none',
      mediaSourceMode: 'upload',
      mediaValue: '',
    },
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
    resolver: zodResolver(formSchema) as Resolver<BroadcastFormDraft, unknown, BroadcastCreateRequest>,
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [audience, setAudience] = useState('ALL')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [mediaType, setMediaType] = useState<'none' | 'photo' | 'video'>('none')
  const [mediaSourceMode, setMediaSourceMode] = useState<'upload' | 'url' | 'fileId'>('upload')
  const [mediaValue, setMediaValue] = useState('')
  const [uploaded, setUploaded] = useState<UploadedMedia | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduledDate, setScheduledDate] = useState<Date | undefined>(undefined)
  const [scheduledTime, setScheduledTime] = useState('12:00')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  function insertTitleAtCaret(emoji: string): void {
    const el = titleRef.current
    if (!el) {
      setTitle((prev) => (prev + emoji).slice(0, 128))
      return
    }
    const start = el.selectionStart ?? title.length
    const end = el.selectionEnd ?? title.length
    const next = (title.slice(0, start) + emoji + title.slice(end)).slice(0, 128)
    setTitle(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = Math.min(start + emoji.length, next.length)
      el.setSelectionRange(caret, caret)
    })
  }

  function insertAtCaret(emoji: string): void {
    const el = textRef.current
    if (!el) {
      setText((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      const res = await api.post<UploadedMedia>('/admin/broadcast/upload-media', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      return res.data
    },
    onSuccess: (data) => {
      setUploaded(data)
      setMediaType(data.mediaType)
      setMediaValue(data.fileId)
      toast.success(t('broadcastPage.upload.success'))
    },
    onError: (err: { response?: { data?: { message?: string } } }) => {
      toast.error(err.response?.data?.message ?? t('broadcastPage.upload.failed'))
    },
  })

  function handleFile(file: File): void {
    if (file.size > 50 * 1024 * 1024) {
      toast.error(t('broadcastPage.upload.tooLarge'))
      return
    }
    uploadMutation.mutate(file)
  }

  function handleDrop(e: React.DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleDragOver(e: React.DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    setIsDragging(false)
  }

  function clearUpload(): void {
    setUploaded(null)
    setMediaValue('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const createMutation = useMutation({
    mutationFn: async (payload: BroadcastCreateRequest) => {
      const response = await api.post<{ id: string }>('/admin/broadcast/drafts', payload)
      const delayMinutes = scheduleEnabled
        ? computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime))
        : undefined
      return api.post(
        `/admin/broadcast/${encodeURIComponent(response.data.id)}/send`,
        delayMinutes !== undefined ? { delayMinutes } : {},
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      const scheduled =
        scheduleEnabled &&
        computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime)) !== undefined
      toast.success(scheduled ? t('broadcastPage.toast.scheduled') : t('broadcastPage.toast.created'))
      onClose()
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? t('broadcastPage.toast.createFailed')),
  })

  const testMutation = useMutation({
    mutationFn: async (payload: BroadcastCreateRequest) => {
      const response = await api.post<{ id: string }>('/admin/broadcast/drafts', payload)
      return api.post(`/admin/broadcast/${encodeURIComponent(response.data.id)}/test`, {})
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.toast.testSent'))
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? t('broadcastPage.toast.testFailed')),
  })

  function validateThen(onValid: (payload: BroadcastCreateRequest) => void) {
    const draft: BroadcastFormDraft = {
      audience,
      title,
      text,
      mediaType,
      mediaSourceMode,
      mediaValue,
    }
    form.reset(draft)
    return form.handleSubmit(
      (payload) => {
        setFormErrors({})
        onValid(payload)
      },
      (errors) => setFormErrors(flattenHookFormErrors(errors)),
    )
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    void validateThen((payload) => createMutation.mutate(payload))(e)
  }

  function handleTest(): void {
    void validateThen((payload) => testMutation.mutate(payload))()
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>{t('broadcastPage.form.audience')}</Label>
        <Select value={audience} onValueChange={setAudience}>
          <SelectTrigger aria-label={t('broadcastPage.form.audience')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {AUDIENCES.map((a) => <SelectItem key={a.value} value={a.value}>{t(a.labelKey)}</SelectItem>)}
          </SelectContent>
        </Select>
        <FieldError message={formErrors.audience} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-title">{t('broadcastPage.form.titleLabel')}</Label>
        <div className="relative">
          <Input
            id="broadcast-title"
            ref={titleRef}
            placeholder={t('broadcastPage.form.titlePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={128}
            className="pr-10"
            aria-invalid={!!formErrors.title}
          />
          <div className="absolute right-1 top-1/2 -translate-y-1/2">
            <EmojiPicker onSelect={insertTitleAtCaret} ariaLabel={t('broadcastPage.emoji.trigger')} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('broadcastPage.form.titleHint')}</p>
        {title.trim().length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('broadcastPage.form.preview')}</p>
            <RenderedCopyPreview value={title} />
          </div>
        )}
        <FieldError message={formErrors.title} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="broadcast-message-text">{t('broadcastPage.form.text')}</Label>
        <div className="relative">
          <Textarea
            id="broadcast-message-text"
            ref={textRef}
            placeholder={t('broadcastPage.form.textPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            className="resize-none pr-10"
            aria-invalid={!!formErrors.text}
          />
          <div className="absolute right-1.5 top-1.5">
            <EmojiPicker onSelect={insertAtCaret} ariaLabel={t('broadcastPage.emoji.trigger')} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('broadcastPage.form.charCount', { count: text.length })}
        </p>
        {text.trim().length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('broadcastPage.form.preview')}</p>
            <RenderedCopyPreview value={text} />
          </div>
        )}
        <FieldError message={formErrors.text} />
      </div>

      <div className="space-y-2">
        <Label>{t('broadcastPage.form.mediaLabel')}</Label>
        <div className="flex gap-2">
          {(['none', 'photo', 'video'] as const).map((mt) => (
            <button
              type="button"
              key={mt}
              onClick={() => { setMediaType(mt); if (mt === 'none') clearUpload() }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                mediaType === mt
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              {mt === 'none'
                ? t('broadcastPage.form.media.none')
                : mt === 'photo'
                  ? `📷 ${t('broadcastPage.form.media.photo')}`
                  : `🎥 ${t('broadcastPage.form.media.video')}`}
            </button>
          ))}
        </div>
        {mediaType !== 'none' ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant={mediaSourceMode === 'upload' ? 'default' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setMediaSourceMode('upload')}
              >
                <Upload className="h-3 w-3 mr-1" />
                {t('broadcastPage.form.mediaSource.upload')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mediaSourceMode === 'url' ? 'default' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setMediaSourceMode('url')}
              >
                {t('broadcastPage.form.mediaSource.url')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mediaSourceMode === 'fileId' ? 'default' : 'outline'}
                className="h-7 text-xs"
                onClick={() => setMediaSourceMode('fileId')}
              >
                {t('broadcastPage.form.mediaSource.fileId')}
              </Button>
            </div>

            {mediaSourceMode === 'upload' ? (
              uploaded ? (
                <div className="flex items-center gap-3 rounded-md border bg-background p-3">
                  {uploaded.mediaType === 'photo' ? (
                    <FileImage className="h-8 w-8 shrink-0 text-emerald-500" />
                  ) : (
                    <FileVideo className="h-8 w-8 shrink-0 text-blue-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{uploaded.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(uploaded.sizeBytes)} · file_id: <span className="font-mono">{uploaded.fileId.slice(0, 16)}…</span>
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive shrink-0"
                    onClick={clearUpload}
                    aria-label={t('broadcastPage.upload.clear')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadMutation.isPending}
                    aria-label={t('broadcastPage.upload.chooseFile')}
                    className={`flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
                      isDragging
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50 hover:bg-muted/40'
                    } ${uploadMutation.isPending ? 'opacity-50' : ''}`}
                  >
                    {uploadMutation.isPending ? (
                      <>
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">
                          {t('broadcastPage.upload.uploading')}
                        </p>
                      </>
                    ) : (
                      <>
                        <Upload className="h-8 w-8 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">
                            {t('broadcastPage.upload.dropHere')}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t('broadcastPage.upload.orClick')} ·{' '}
                            {mediaType === 'photo'
                              ? t('broadcastPage.upload.photoLimits')
                              : t('broadcastPage.upload.videoLimits')}
                          </p>
                        </div>
                      </>
                    )}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={mediaType === 'photo' ? 'image/*' : 'video/*'}
                    className="hidden"
                    aria-label={t('broadcastPage.upload.chooseFile')}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleFile(file)
                    }}
                  />
                </>
              )
            ) : (
              <>
                <Input
                  placeholder={
                    mediaSourceMode === 'url'
                      ? t('broadcastPage.form.urlPlaceholder', { type: t(`broadcastPage.form.media.${mediaType}`) })
                      : t('broadcastPage.form.fileIdPlaceholder', { type: t(`broadcastPage.form.media.${mediaType}`) })
                  }
                  value={mediaValue}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMediaValue(e.target.value)}
                  className={mediaSourceMode === 'fileId' ? 'font-mono text-xs' : 'text-xs'}
                  aria-invalid={!!formErrors.mediaValue}
                />
                <p className="text-xs text-muted-foreground">
                  {mediaSourceMode === 'url'
                    ? t('broadcastPage.form.urlHint')
                    : t('broadcastPage.form.fileIdHint', { type: t(`broadcastPage.form.media.${mediaType}`) })}
                </p>
              </>
            )}
            <FieldError message={formErrors.mediaValue} />
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t('broadcastPage.schedule.label')}</Label>
          <Button
            type="button"
            size="sm"
            variant={scheduleEnabled ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setScheduleEnabled((v) => !v)}
          >
            <Clock className="h-3 w-3 mr-1" />
            {scheduleEnabled ? t('broadcastPage.schedule.on') : t('broadcastPage.schedule.off')}
          </Button>
        </div>
        {scheduleEnabled && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <DatePicker
                  value={scheduledDate}
                  onChange={setScheduledDate}
                  placeholder={t('broadcastPage.schedule.datePlaceholder')}
                />
              </div>
              <Input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="w-28"
                aria-label={t('broadcastPage.schedule.timeLabel')}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {scheduledDate && computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime)) !== undefined
                ? t('broadcastPage.schedule.willSendIn', {
                    minutes: computeDelayMinutes(combineDateTime(scheduledDate, scheduledTime)),
                  })
                : t('broadcastPage.schedule.hint')}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handleTest}
          disabled={createMutation.isPending || testMutation.isPending || uploadMutation.isPending}
        >
          {testMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-2" />}
          {t('broadcastPage.form.testSend')}
        </Button>
        <Button
          type="submit"
          disabled={createMutation.isPending || testMutation.isPending || uploadMutation.isPending}
        >
          {createMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : scheduleEnabled ? <Clock className="h-4 w-4 mr-2" /> : <Send className="h-4 w-4 mr-2" />}
          {scheduleEnabled ? t('broadcastPage.form.scheduleSend') : t('broadcastPage.form.sendNow')}
        </Button>
      </div>
    </form>
  )
}

function FieldError({ message }: { readonly message?: string }) {
  if (!message) return null
  return <p className="text-xs font-medium text-destructive" role="alert">{message}</p>
}

/**
 * Combine a calendar date (local midnight) with an `HH:mm` time string into a
 * single local-time `Date`. Returns `null` when the date is unset or the time
 * is malformed.
 */
function combineDateTime(date: Date | undefined, time: string): Date | null {
  if (!date) return null
  const [hh, mm] = time.split(':')
  const hours = Number.parseInt(hh ?? '', 10)
  const minutes = Number.parseInt(mm ?? '', 10)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null
  const combined = new Date(date)
  combined.setHours(hours, minutes, 0, 0)
  return combined
}

/**
 * Delay in whole minutes from now to the target instant. Returns `undefined`
 * when the target is null or not at least a minute in the future — the caller
 * then sends immediately instead of scheduling.
 */
function computeDelayMinutes(target: Date | null): number | undefined {
  if (!target) return undefined
  const diffMinutes = Math.ceil((target.getTime() - Date.now()) / 60_000)
  return diffMinutes >= 1 ? diffMinutes : undefined
}

// ── Edit form ───────────────────────────────────────────────────────────────

interface BroadcastDetail {
  readonly id: string
  readonly payload: {
    readonly text: string | null
    readonly parseMode: 'HTML' | 'MarkdownV2' | null
  }
}

function EditBroadcastForm({ broadcastId, onClose }: { broadcastId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)

  const { data, isLoading } = useQuery<BroadcastDetail>({
    queryKey: adminQueryKeys.broadcast.detail(broadcastId),
    queryFn: async ({ signal }) =>
      (await api.get<BroadcastDetail>(`/admin/broadcast/${encodeURIComponent(broadcastId)}`, { signal })).data,
  })

  if (data && !loaded) {
    setText(data.payload.text ?? '')
    setLoaded(true)
  }

  function insertAtCaret(emoji: string): void {
    const el = textRef.current
    if (!el) {
      setText((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    setText(text.slice(0, start) + emoji + text.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  const editMutation = useMutation({
    mutationFn: () =>
      api.post(`/admin/broadcast/${encodeURIComponent(broadcastId)}/edit`, {
        text,
        parseMode: data?.payload.parseMode ?? null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.broadcast.all })
      toast.success(t('broadcastPage.edit.saved'))
      onClose()
    },
    onError: (err) => toast.error(getErrorMessage(err, t('broadcastPage.edit.saveFailed'))),
  })

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="broadcast-edit-text">{t('broadcastPage.form.text')}</Label>
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="relative">
            <Textarea
              id="broadcast-edit-text"
              ref={textRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="resize-none pr-10"
              placeholder={t('broadcastPage.form.textPlaceholder')}
            />
            <div className="absolute right-1.5 top-1.5">
              <EmojiPicker onSelect={insertAtCaret} ariaLabel={t('broadcastPage.emoji.trigger')} />
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('broadcastPage.edit.hint')}</p>
        {text.trim().length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t('broadcastPage.form.preview')}</p>
            <RenderedCopyPreview value={text} />
          </div>
        )}
      </div>
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          type="button"
          disabled={editMutation.isPending || isLoading || text.trim().length === 0}
          onClick={() => editMutation.mutate()}
        >
          {editMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Pencil className="h-4 w-4 mr-2" />}
          {t('broadcastPage.edit.save')}
        </Button>
      </div>
    </div>
  )
}

function flattenHookFormErrors(errors: FieldErrors<BroadcastFormDraft>): Record<string, string> {
  const flattenedErrors: Record<string, string> = {}
  collectHookFormErrors(errors, [], flattenedErrors)
  return flattenedErrors
}

function collectHookFormErrors(value: unknown, path: string[], output: Record<string, string>): void {
  if (value === null || typeof value !== 'object') return

  const maybeError = value as { readonly message?: unknown }
  if (typeof maybeError.message === 'string') {
    const key = path.length > 0 ? path.join('.') : 'form'
    output[key] ??= maybeError.message
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'message' || key === 'type' || key === 'types' || key === 'ref') continue
    collectHookFormErrors(child, [...path, key], output)
  }
}
