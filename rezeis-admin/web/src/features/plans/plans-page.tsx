import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Archive, ArchiveRestore, Package, BarChart3, List } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FadeIn } from '@/lib/motion'
import { PlanForm, type PlanFormData } from './plan-form'
import { plansQueryKeys, usePlans, type Plan } from './plans-api'
import { PlansStatsTab } from './plans-stats-tab'

export default function PlansPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null)

  const { data: plans, isLoading } = usePlans()

  const createMutation = useMutation({
    mutationFn: (data: PlanFormData) => api.post('/admin/plans', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      setShowCreate(false)
      toast.success(t('plansPage.created'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.createFailed'))),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: PlanFormData }) =>
      api.patch(`/admin/plans/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      setEditingPlan(null)
      toast.success(t('plansPage.updated'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.updateFailed'))),
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/plans/${id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      toast.success(t('plansPage.archived'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.archiveFailed'))),
  })

  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/plans/${id}/unarchive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: plansQueryKeys.all })
      toast.success(t('plansPage.unarchived'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.unarchiveFailed'))),
  })

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/plans/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: plansQueryKeys.all }),
    onError: (err) => toast.error(getErrorMessage(err, t('plansPage.toggleActiveFailed'))),
  })

  const formatTraffic = (gb: number) =>
    gb === 0 ? t('plansPage.unlimited') : `${gb} GB`

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Package className="h-6 w-6" /> {t('plansPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('plansPage.subtitle')}</p>
          </div>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-2" /> {t('plansPage.createPlan')}
          </Button>
        </div>
      </FadeIn>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list" className="gap-2">
            <List className="h-4 w-4" /> {t('plansPage.tabs.list')}
          </TabsTrigger>
          <TabsTrigger value="stats" className="gap-2">
            <BarChart3 className="h-4 w-4" /> {t('plansPage.tabs.stats')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : !plans?.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-muted-foreground mb-4">{t('plansPage.empty')}</p>
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-2" /> {t('plansPage.createFirst')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold">{plans.length}</p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.total')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-emerald-500">
                {plans.filter((p) => p.isActive && !p.isArchived).length}
              </p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.active')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-amber-500">
                {plans.filter((p) => p.isArchived).length}
              </p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.archived')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-blue-500">
                {plans.filter((p) => p.availability === 'TRIAL').length}
              </p>
              <p className="text-xs text-muted-foreground">{t('plansPage.summary.trial')}</p>
            </div>
          </div>

          {/* Plan grid — compact, no expand */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className={`rounded-lg border bg-card transition-all hover:shadow-md ${
                  plan.isArchived ? 'opacity-60' : ''
                }`}
              >
                <div className="px-3 py-2.5 space-y-2">
                  {/* Title row */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm truncate" title={plan.name}>
                      {plan.name}
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Switch
                        checked={plan.isActive}
                        onCheckedChange={(v) =>
                          toggleActiveMutation.mutate({ id: plan.id, isActive: v })
                        }
                        disabled={plan.isArchived}
                        className="scale-75"
                        aria-label={t('plansPage.aria.toggleActive')}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setEditingPlan(plan)}
                        aria-label={t('plansPage.aria.edit')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {plan.isArchived ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-emerald-500 hover:text-emerald-600"
                          onClick={() => unarchiveMutation.mutate(plan.id)}
                          disabled={unarchiveMutation.isPending}
                          aria-label={t('plansPage.aria.unarchive')}
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => archiveMutation.mutate(plan.id)}
                          disabled={archiveMutation.isPending}
                          aria-label={t('plansPage.aria.archive')}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Badges row */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {plan.tag && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {plan.tag}
                      </Badge>
                    )}
                    <Badge
                      variant={plan.isActive ? 'default' : 'secondary'}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {plan.isActive
                        ? t('plansPage.status.active')
                        : t('plansPage.status.inactive')}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {plan.type}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {plan.availability}
                    </Badge>
                    {plan.isArchived && (
                      <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                        {t('plansPage.status.archived')}
                      </Badge>
                    )}
                  </div>

                  {/* Stats row */}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground pt-1 border-t">
                    <span>
                      {t('plansPage.labels.traffic')}:{' '}
                      <span className="text-foreground font-medium">
                        {formatTraffic(plan.trafficLimit)}
                      </span>
                    </span>
                    <span>
                      {t('plansPage.labels.devices')}:{' '}
                      <span className="text-foreground font-medium">
                        {plan.deviceLimit <= 0 ? '∞' : plan.deviceLimit}
                      </span>
                    </span>
                    <span>
                      {t('plansPage.labels.durations')}:{' '}
                      <span className="text-foreground font-medium">
                        {plan.durations.length}
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
          <PlansStatsTab />
        </TabsContent>
      </Tabs>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('plansPage.createTitle')}</DialogTitle>
          </DialogHeader>
          <PlanForm
            onSubmit={(data) => createMutation.mutate(data)}
            isLoading={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingPlan} onOpenChange={() => setEditingPlan(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('plansPage.editTitle')}: {editingPlan?.name}
            </DialogTitle>
          </DialogHeader>
          {editingPlan && (
            <PlanForm
              plan={editingPlan}
              onSubmit={(data) => updateMutation.mutate({ id: editingPlan.id, data })}
              isLoading={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
