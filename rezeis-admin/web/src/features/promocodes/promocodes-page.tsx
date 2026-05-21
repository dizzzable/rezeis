/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Tag, UserPlus, Loader2, BarChart3, List } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FadeIn } from '@/lib/motion'
import { PromocodeForm, type PromocodeFormData } from './promocode-form'
import { PromocodesStatsTab } from './promocodes-stats-tab'

interface Promocode {
  id: number
  code: string
  rewardType: string
  reward: string | null
  availability: string
  isActive: boolean
  maxActivations: number | null
  lifetime: number | null
  activationsCount?: number | null
  plan?: { id: string; name: string } | null
}

export default function PromocodesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [applyTarget, setApplyTarget] = useState<{ id: number; code: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Promocode | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'promocodes'],
    queryFn: async () => {
      const raw = (await api.get('/admin/promocodes?limit=100')).data as
        | unknown[]
        | { items?: unknown[] }
      const items = Array.isArray(raw) ? raw : (raw?.items ?? [])
      return { items: items as Promocode[] }
    },
  })

  const createMutation = useMutation({
    mutationFn: (input: PromocodeFormData) => api.post('/admin/promocodes', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'promocodes'] })
      setShowCreate(false)
      toast.success(t('promocodesIndex.created'))
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('promocodesIndex.createFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/promocodes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'promocodes'] })
      setDeleteTarget(null)
      toast.success(t('promocodesIndex.deleted'))
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api.patch(`/admin/promocodes/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'promocodes'] }),
  })

  const promos = data?.items ?? []

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Tag className="h-6 w-6" /> {t('promocodesIndex.title')}
            </h1>
            <p className="text-muted-foreground">{t('promocodesIndex.subtitle')}</p>
          </div>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" /> {t('promocodesIndex.createCode')}
          </Button>
        </div>
      </FadeIn>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list" className="gap-2">
            <List className="h-4 w-4" /> {t('promocodesIndex.tabs.list')}
          </TabsTrigger>
          <TabsTrigger value="stats" className="gap-2">
            <BarChart3 className="h-4 w-4" /> {t('promocodesIndex.tabs.stats')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : !promos.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Tag className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-muted-foreground mb-4">{t('promocodesIndex.empty')}</p>
            <Button variant="outline" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-2" /> {t('promocodesIndex.createFirst')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold">{promos.length}</p>
              <p className="text-xs text-muted-foreground">{t('promocodesIndex.summary.total')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-emerald-500">
                {promos.filter((p) => p.isActive).length}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('promocodesIndex.summary.active')}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-blue-500">
                {promos.filter((p) => p.rewardType === 'SUBSCRIPTION').length}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('promocodesIndex.summary.subscription')}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-amber-500">
                {promos.reduce((sum, p) => sum + (p.activationsCount ?? 0), 0)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('promocodesIndex.summary.activations')}
              </p>
            </div>
          </div>

          {/* Promocode grid */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start">
            {promos.map((promo) => (
              <div
                key={promo.id}
                className={`rounded-lg border bg-card transition-all hover:shadow-md ${
                  !promo.isActive ? 'opacity-60' : ''
                }`}
              >
                <div className="px-3 py-2.5 space-y-2">
                  {/* Title row */}
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="font-mono font-bold text-sm truncate"
                      title={promo.code}
                    >
                      {promo.code}
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Switch
                        checked={promo.isActive}
                        onCheckedChange={(v) =>
                          toggleMutation.mutate({ id: promo.id, isActive: v })
                        }
                        className="scale-75"
                        aria-label={t('promocodesIndex.aria.toggleActive')}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-blue-500"
                        onClick={() =>
                          setApplyTarget({ id: promo.id, code: promo.code })
                        }
                        aria-label={t('promocodesIndex.aria.apply')}
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={() => setDeleteTarget(promo)}
                        aria-label={t('promocodesIndex.aria.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Badges row */}
                  <div className="flex items-center gap-1 flex-wrap">
                    <Badge
                      variant={promo.isActive ? 'default' : 'secondary'}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {promo.isActive
                        ? t('promocodesIndex.status.active')
                        : t('promocodesIndex.status.inactive')}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {promo.rewardType.replace(/_/g, ' ')}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {promo.availability}
                    </Badge>
                  </div>

                  {/* Stats row */}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground pt-1 border-t">
                    <span>
                      {t('promocodesIndex.labels.value')}:{' '}
                      <span className="text-foreground font-medium font-mono">
                        {promo.rewardType === 'SUBSCRIPTION'
                          ? (promo.plan?.name ?? '—')
                          : (promo.reward ?? '—')}
                      </span>
                    </span>
                    <span>
                      {t('promocodesIndex.labels.uses')}:{' '}
                      <span className="text-foreground font-medium">
                        {promo.maxActivations === -1 || promo.maxActivations == null
                          ? '∞'
                          : promo.maxActivations}
                      </span>
                    </span>
                    <span>
                      {t('promocodesIndex.labels.lifetime')}:{' '}
                      <span className="text-foreground font-medium">
                        {promo.lifetime === -1 || promo.lifetime == null
                          ? '∞'
                          : t('promocodesIndex.labels.daysShort', { count: promo.lifetime })}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

        </TabsContent>

        <TabsContent value="stats">
          <PromocodesStatsTab />
        </TabsContent>
      </Tabs>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('promocodesIndex.createTitle')}</DialogTitle>
          </DialogHeader>
          <PromocodeForm
            onSubmit={(input) => createMutation.mutate(input)}
            isLoading={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      {/* Apply to user Dialog */}
      <Dialog open={!!applyTarget} onOpenChange={() => setApplyTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('promocodesIndex.applyTitle')} {applyTarget?.code}
            </DialogTitle>
          </DialogHeader>
          {applyTarget && (
            <ApplyToUserForm code={applyTarget.code} onClose={() => setApplyTarget(null)} />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('promocodesIndex.deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('promocodesIndex.deleteText', { code: deleteTarget?.code })}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {t('promocodesIndex.deleteConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Apply to user form ────────────────────────────────────────────────────────

function ApplyToUserForm({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [telegramId, setTelegramId] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/admin/promocodes/apply-by-code', { code, telegramId }),
    onSuccess: (res: any) => {
      toast.success(
        t('promocodesIndex.applied', { reward: res.data?.rewardType ?? '' }),
      )
      onClose()
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.message ?? t('promocodesIndex.applyFailed')),
  })

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t('promocodesIndex.apply.telegramId')}</Label>
        <Input
          type="text"
          placeholder="123456789"
          value={telegramId}
          onChange={(e) => setTelegramId(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t('promocodesIndex.apply.hint')}
        </p>
      </div>
      <div className="flex gap-3 justify-end">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          onClick={() => mutation.mutate()}
          disabled={!telegramId.trim() || mutation.isPending}
        >
          {mutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <UserPlus className="h-4 w-4 mr-2" />
          )}
          {t('promocodesIndex.apply.submit')}
        </Button>
      </div>
    </div>
  )
}
