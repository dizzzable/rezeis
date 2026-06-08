import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2, Puzzle, Loader2, BarChart3, List } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, badgeVariants } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FadeIn } from '@/lib/motion'
import { usePlans } from '@/features/plans/plans-api'
import { IconPicker } from '@/features/settings/icon-picker'
import { AddOnsStatsTab } from './add-ons-stats-tab'

const CURRENCIES = ['RUB', 'USD', 'USDT', 'TON', 'XTR', 'EUR'] as const
const ADD_ON_TYPES = ['EXTRA_TRAFFIC', 'EXTRA_DEVICES'] as const

interface AddOnPrice {
  id?: string
  currency: string
  price: number
}

interface AddOn {
  id: string
  name: string
  description: string | null
  type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES'
  icon: string | null
  value: number
  isActive: boolean
  orderIndex: number
  applicablePlanIds: string[]
  prices: AddOnPrice[]
}

interface AddOnFormData {
  name: string
  description?: string
  type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES'
  icon?: string | null
  value: number
  isActive: boolean
  applicablePlanIds: string[]
  prices: { currency: string; price: string }[]
}

export default function AddOnsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showDialog, setShowDialog] = useState(false)
  const [editingAddOn, setEditingAddOn] = useState<AddOn | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const { data: addOns, isLoading } = useQuery({
    queryKey: ['admin', 'add-ons'],
    queryFn: async () => (await api.get<AddOn[]>('/admin/add-ons')).data,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/add-ons/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'add-ons'] })
      toast.success(t('addOnsPage.deleted'))
      setDeleteConfirmId(null)
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('addOnsPage.deleteFailed'))),
  })

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/add-ons/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'add-ons'] }),
  })

  function handleEdit(addOn: AddOn) {
    setEditingAddOn(addOn)
    setShowDialog(true)
  }

  function handleCloseDialog() {
    setShowDialog(false)
    setEditingAddOn(null)
  }

  const items = addOns ?? []
  const activeCount = items.filter((a) => a.isActive).length
  const trafficCount = items.filter((a) => a.type === 'EXTRA_TRAFFIC').length
  const devicesCount = items.filter((a) => a.type === 'EXTRA_DEVICES').length

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Puzzle className="h-6 w-6" /> {t('addOnsPage.title')}
            </h1>
            <p className="text-muted-foreground">{t('addOnsPage.subtitle')}</p>
          </div>
          <Button
            onClick={() => {
              setEditingAddOn(null)
              setShowDialog(true)
            }}
          >
            <Plus className="h-4 w-4 mr-2" /> {t('addOnsPage.create')}
          </Button>
        </div>
      </FadeIn>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list" className="gap-2">
            <List className="h-4 w-4" /> {t('addOnsPage.tabs.list')}
          </TabsTrigger>
          <TabsTrigger value="stats" className="gap-2">
            <BarChart3 className="h-4 w-4" /> {t('addOnsPage.tabs.stats')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : !items.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-muted-foreground mb-4">{t('addOnsPage.empty')}</p>
            <Button
              onClick={() => {
                setEditingAddOn(null)
                setShowDialog(true)
              }}
            >
              <Plus className="h-4 w-4 mr-2" /> {t('addOnsPage.createFirst')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold">{items.length}</p>
              <p className="text-xs text-muted-foreground">{t('addOnsPage.summary.total')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-emerald-500">{activeCount}</p>
              <p className="text-xs text-muted-foreground">{t('addOnsPage.summary.active')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-blue-500">{trafficCount}</p>
              <p className="text-xs text-muted-foreground">{t('addOnsPage.summary.traffic')}</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-2xl font-bold text-purple-500">{devicesCount}</p>
              <p className="text-xs text-muted-foreground">{t('addOnsPage.summary.devices')}</p>
            </div>
          </div>

          {/* Add-on grid */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start">
            {items.map((addOn) => (
              <div
                key={addOn.id}
                className={`rounded-lg border bg-card transition-all hover:shadow-md ${
                  !addOn.isActive ? 'opacity-60' : ''
                }`}
              >
                <div className="px-3 py-2.5 space-y-2">
                  {/* Title row */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm truncate" title={addOn.name}>
                      {addOn.name}
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <Switch
                        checked={addOn.isActive}
                        onCheckedChange={(v) =>
                          toggleActiveMutation.mutate({ id: addOn.id, isActive: v })
                        }
                        className="scale-75"
                        aria-label={t('addOnsPage.aria.toggleActive')}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => handleEdit(addOn)}
                        aria-label={t('addOnsPage.aria.edit')}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={() => setDeleteConfirmId(addOn.id)}
                        aria-label={t('addOnsPage.aria.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Badges row */}
                  <div className="flex items-center gap-1 flex-wrap">
                    <Badge
                      variant={addOn.isActive ? 'default' : 'secondary'}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {addOn.isActive
                        ? t('addOnsPage.active')
                        : t('addOnsPage.inactive')}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {t(`addOnsPage.types.${addOn.type}`)}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-mono">
                      {addOn.value}{' '}
                      {addOn.type === 'EXTRA_TRAFFIC'
                        ? 'GB'
                        : t('addOnsPage.devices')}
                    </Badge>
                    {addOn.applicablePlanIds.length > 0 && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {t('addOnsPage.plansCount', {
                          count: addOn.applicablePlanIds.length,
                        })}
                      </Badge>
                    )}
                  </div>

                  {/* Prices row */}
                  <div className="flex flex-wrap gap-1 pt-1 border-t">
                    {addOn.prices.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {t('addOnsPage.noPrices')}
                      </span>
                    ) : (
                      addOn.prices.map((p, i) => (
                        <Badge
                          key={i}
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 font-mono"
                        >
                          {p.price} {p.currency}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

        </TabsContent>

        <TabsContent value="stats">
          <AddOnsStatsTab />
        </TabsContent>
      </Tabs>

      {/* Create/Edit Dialog */}
      <AddOnDialog
        open={showDialog}
        onOpenChange={handleCloseDialog}
        addOn={editingAddOn}
      />

      {/* Delete Confirmation */}
      <Dialog
        open={!!deleteConfirmId}
        onOpenChange={() => setDeleteConfirmId(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('addOnsPage.deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('addOnsPage.deleteConfirmText')}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteConfirmId && deleteMutation.mutate(deleteConfirmId)
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {t('addOnsPage.deleteConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Add-On Create/Edit Dialog ─────────────────────────────────────────────────

function AddOnDialog({
  open,
  onOpenChange,
  addOn,
}: {
  open: boolean
  onOpenChange: () => void
  addOn: AddOn | null
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<'EXTRA_TRAFFIC' | 'EXTRA_DEVICES'>('EXTRA_TRAFFIC')
  const [icon, setIcon] = useState<string | null>(null)
  const [value, setValue] = useState('1')
  const [isActive, setIsActive] = useState(true)
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([])
  const [prices, setPrices] = useState<{ currency: string; price: string }[]>([
    { currency: 'RUB', price: '' },
  ])

  // Reset/populate form when dialog opens
  // TODO: refactor — initialize state from `addOn` via key prop instead of mirroring in an effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    if (addOn) {
      setName(addOn.name)
      setDescription(addOn.description ?? '')
      setType(addOn.type)
      setIcon(addOn.icon ?? null)
      setValue(addOn.value.toString())
      setIsActive(addOn.isActive)
      setSelectedPlanIds(addOn.applicablePlanIds)
      setPrices(
        addOn.prices.length > 0
          ? addOn.prices.map((p) => ({
              currency: p.currency,
              price: p.price.toString(),
            }))
          : [{ currency: 'RUB', price: '' }],
      )
    } else {
      setName('')
      setDescription('')
      setType('EXTRA_TRAFFIC')
      setIcon(null)
      setValue('1')
      setIsActive(true)
      setSelectedPlanIds([])
      setPrices([{ currency: 'RUB', price: '' }])
    }
  }, [open, addOn])
  /* eslint-enable react-hooks/set-state-in-effect */

  const { data: plans } = usePlans()

  const createMutation = useMutation({
    mutationFn: (input: AddOnFormData) => api.post('/admin/add-ons', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'add-ons'] })
      toast.success(t('addOnsPage.created'))
      onOpenChange()
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('addOnsPage.createFailed'))),
  })

  const updateMutation = useMutation({
    mutationFn: (input: AddOnFormData) =>
      api.patch(`/admin/add-ons/${addOn!.id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'add-ons'] })
      toast.success(t('addOnsPage.updated'))
      onOpenChange()
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('addOnsPage.updateFailed'))),
  })

  const isPending = createMutation.isPending || updateMutation.isPending

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const formData: AddOnFormData = {
      name,
      description: description || undefined,
      type,
      icon: icon ?? null,
      value: parseInt(value, 10),
      isActive,
      applicablePlanIds: selectedPlanIds,
      prices: prices
        .filter((p) => p.price.trim() !== '' && parseFloat(p.price) >= 0)
        .map((p) => ({ currency: p.currency, price: p.price.trim() })),
    }
    if (addOn) {
      updateMutation.mutate(formData)
    } else {
      createMutation.mutate(formData)
    }
  }

  function addPriceRow() {
    setPrices((prev) => [...prev, { currency: 'USD', price: '' }])
  }

  function removePriceRow(idx: number) {
    setPrices((prev) => prev.filter((_, i) => i !== idx))
  }

  function togglePlan(planId: string) {
    setSelectedPlanIds((prev) =>
      prev.includes(planId) ? prev.filter((id) => id !== planId) : [...prev, planId],
    )
  }

  return (
    <Dialog open={open} onOpenChange={() => onOpenChange()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {addOn ? t('addOnsPage.editTitle') : t('addOnsPage.createTitle')}
          </DialogTitle>
          <DialogDescription>
            {addOn ? t('addOnsPage.editDescription') : t('addOnsPage.createDescription')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{t('addOnsPage.form.name')} *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('addOnsPage.form.namePlaceholder')}
              required
            />
          </div>

          <div className="space-y-2">
            <Label>{t('addOnsPage.form.description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('addOnsPage.form.descriptionPlaceholder')}
            />
          </div>

          <div className="grid gap-4 grid-cols-2">
            <div className="space-y-2">
              <Label>{t('addOnsPage.form.type')}</Label>
              <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADD_ON_TYPES.map((t2) => (
                    <SelectItem key={t2} value={t2}>
                      {t(`addOnsPage.types.${t2}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('addOnsPage.form.value')}</Label>
              <Input
                type="number"
                min="1"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                {type === 'EXTRA_TRAFFIC'
                  ? t('addOnsPage.form.valueHintTraffic')
                  : t('addOnsPage.form.valueHintDevices')}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Label>{t('addOnsPage.form.active')}</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="space-y-2">
            <Label>{t('addOnsPage.form.icon')}</Label>
            <IconPicker value={icon} onChange={setIcon} autoLabel={t('addOnsPage.form.iconAuto')} />
            <p className="text-[11px] text-muted-foreground">{t('addOnsPage.form.iconHint')}</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>{t('addOnsPage.form.plans')}</Label>
            <p className="text-[11px] text-muted-foreground">
              {t('addOnsPage.form.plansHint')}
            </p>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              {plans?.map((plan) => {
                const planId = String(plan.id)
                const isSelected = selectedPlanIds.includes(planId)
                return (
                  <button
                    key={plan.id}
                    type="button"
                    className={badgeVariants({
                      variant: isSelected ? 'default' : 'outline',
                      className: 'cursor-pointer',
                    })}
                    aria-pressed={isSelected}
                    onClick={() => togglePlan(planId)}
                  >
                    {plan.name}
                  </button>
                )
              })}
              {!plans?.length && (
                <p className="text-xs text-muted-foreground">
                  {t('addOnsPage.form.noPlans')}
                </p>
              )}
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('addOnsPage.form.prices')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={addPriceRow}
              >
                <Plus className="h-3 w-3 mr-1" /> {t('addOnsPage.form.addPrice')}
              </Button>
            </div>
            <div className="space-y-2">
              {prices.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <Select
                    value={p.currency}
                    onValueChange={(v) =>
                      setPrices((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, currency: v } : x)),
                      )
                    }
                  >
                    <SelectTrigger
                      className="w-24"
                      aria-label={t('addOnsPage.form.priceCurrencyAria', { index: i + 1 })}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={p.price}
                    onChange={(e) =>
                      setPrices((prev) =>
                        prev.map((x, j) =>
                          j === i ? { ...x, price: e.target.value } : x,
                        ),
                      )
                    }
                    className="flex-1"
                    aria-label={t('addOnsPage.form.priceAmountAria', { index: i + 1 })}
                  />
                  {prices.length > 1 && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9 text-destructive"
                      onClick={() => removePriceRow(i)}
                      aria-label={t('addOnsPage.form.removePriceAria', { index: i + 1 })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <Separator />

          <Button type="submit" className="w-full" disabled={isPending || !name.trim()}>
            {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {addOn ? t('addOnsPage.form.update') : t('addOnsPage.form.submit')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
