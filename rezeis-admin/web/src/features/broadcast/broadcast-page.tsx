import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Megaphone, Users, Send, XCircle, Trash2, Loader2, RefreshCw, Upload, FileImage, FileVideo, X } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FadeIn } from '@/lib/motion'

const AUDIENCES = [
  { value: 'ALL', labelKey: 'broadcastPage.audiences.ALL' },
  { value: 'SUBSCRIBED', labelKey: 'broadcastPage.audiences.SUBSCRIBED' },
  { value: 'UNSUBSCRIBED', labelKey: 'broadcastPage.audiences.UNSUBSCRIBED' },
  { value: 'EXPIRED', labelKey: 'broadcastPage.audiences.EXPIRED' },
  { value: 'TRIAL', labelKey: 'broadcastPage.audiences.TRIAL' },
]

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  COMPLETED: 'default',
  PROCESSING: 'secondary',
  ERROR: 'destructive',
  CANCELED: 'outline',
  DELETED: 'outline',
}

interface BroadcastRow {
  readonly id: number
  readonly audience: string
  readonly status: string
  readonly successCount: number
  readonly totalCount: number
  readonly failedCount: number
  readonly createdAt: string
}

interface BroadcastListResponse {
  readonly items: ReadonlyArray<BroadcastRow>
}

export default function BroadcastPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading, refetch } = useQuery<BroadcastListResponse>({
    queryKey: ['admin', 'broadcast'],
    queryFn: async ({ signal }) =>
      (await api.get<BroadcastListResponse>('/admin/broadcast?limit=50', { signal })).data,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: number) => api.post(`/admin/broadcast/${id}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'broadcast'] })
      toast.success(t('broadcastPage.toast.canceled'))
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('broadcastPage.toast.cancelFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/broadcast/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'broadcast'] })
      toast.success(t('broadcastPage.toast.deleted'))
    },
  })

  const stats = data?.items?.reduce(
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
            <Button variant="outline" size="icon" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /></Button>
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
          ) : !data?.items?.length ? (
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
                {data.items.map((b) => (
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
                            onClick={() => cancelMutation.mutate(b.id)}>
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {['COMPLETED', 'CANCELED', 'ERROR'].includes(b.status) && (
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                            onClick={() => { if (confirm(t('broadcastPage.deleteConfirm'))) deleteMutation.mutate(b.id) }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
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
          <DialogHeader><DialogTitle>{t('broadcastPage.newButton')}</DialogTitle></DialogHeader>
          <CreateBroadcastForm onClose={() => setShowCreate(false)} />
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
  const [audience, setAudience] = useState('ALL')
  const [text, setText] = useState('')
  const [mediaType, setMediaType] = useState<'none' | 'photo' | 'video'>('none')
  const [mediaSourceMode, setMediaSourceMode] = useState<'upload' | 'url' | 'fileId'>('upload')
  const [mediaValue, setMediaValue] = useState('')
  const [uploaded, setUploaded] = useState<UploadedMedia | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: audienceCount, refetch: refetchCount } = useQuery({
    queryKey: ['admin', 'broadcast', 'audience-count', audience],
    queryFn: async () =>
      (await api.get(`/admin/broadcast/audience-count?audience=${audience}`)).data as { count: number },
    enabled: !!audience,
  })

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

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setIsDragging(false)
  }

  function clearUpload(): void {
    setUploaded(null)
    setMediaValue('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/admin/broadcast', {
        audience,
        payload: {
          text,
          ...(mediaType !== 'none' && mediaValue
            ? mediaSourceMode === 'url'
              ? { mediaType, mediaUrl: mediaValue }
              : { mediaType, mediaFileId: mediaValue }
            : {}),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'broadcast'] })
      toast.success(t('broadcastPage.toast.created'))
      onClose()
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error(err.response?.data?.message ?? t('broadcastPage.toast.createFailed')),
  })

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t('broadcastPage.form.audience')}</Label>
        <Select value={audience} onValueChange={(v) => { setAudience(v); refetchCount() }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {AUDIENCES.map((a) => <SelectItem key={a.value} value={a.value}>{t(a.labelKey)}</SelectItem>)}
          </SelectContent>
        </Select>
        {audienceCount !== undefined && (
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Users className="h-3.5 w-3.5" />
            {t('broadcastPage.form.recipients', { count: audienceCount.count })}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label>{t('broadcastPage.form.text')}</Label>
        <Textarea
          placeholder={t('broadcastPage.form.textPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className="resize-none"
        />
        <p className="text-xs text-muted-foreground">
          {t('broadcastPage.form.charCount', { count: text.length })}
        </p>
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
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
                    isDragging
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50 hover:bg-muted/40'
                  } ${uploadMutation.isPending ? 'opacity-50 pointer-events-none' : ''}`}
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
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={mediaType === 'photo' ? 'image/*' : 'video/*'}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleFile(file)
                    }}
                  />
                </div>
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
                />
                <p className="text-xs text-muted-foreground">
                  {mediaSourceMode === 'url'
                    ? t('broadcastPage.form.urlHint')
                    : t('broadcastPage.form.fileIdHint', { type: t(`broadcastPage.form.media.${mediaType}`) })}
                </p>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex gap-3 justify-end">
        <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!text.trim() || createMutation.isPending}
        >
          {createMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
          {t('broadcastPage.form.send', { count: audienceCount?.count ?? 0 })}
        </Button>
      </div>
    </div>
  )
}
