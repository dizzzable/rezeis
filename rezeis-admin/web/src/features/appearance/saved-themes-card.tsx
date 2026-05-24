import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Check, Loader2, Plus, Save, Share2, Trash2, User } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { useThemeStore, type ThemeToken, type TokenOverrides } from '@/lib/theme/theme-store'

interface SavedThemeData {
  presetId: string
  customCss: string
  overridesLight: TokenOverrides
  overridesDark: TokenOverrides
  radius: number
}

interface SavedThemePreset {
  id: string
  ownerId: string
  ownerName: string | null
  name: string
  description: string | null
  isShared: boolean
  isOwn: boolean
  themeData: SavedThemeData
  createdAt: string
  updatedAt: string
}

export function SavedThemesCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SavedThemePreset | null>(null)

  const { data: presets, isLoading } = useQuery({
    queryKey: ['admin', 'theme-presets'],
    queryFn: async () =>
      (await api.get<readonly SavedThemePreset[]>('/admin/theme-presets')).data,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/theme-presets/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'theme-presets'] })
      setDeleteTarget(null)
      toast.success(t('appearancePage.savedThemes.deleted'))
    },
    onError: (err) =>
      toast.error(
        getErrorMessage(err, t('appearancePage.savedThemes.deleteFailed')),
      ),
  })

  const toggleShareMutation = useMutation({
    mutationFn: ({ id, isShared }: { id: string; isShared: boolean }) =>
      api.patch(`/admin/theme-presets/${id}`, { isShared }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['admin', 'theme-presets'] }),
  })

  function applyPreset(preset: SavedThemePreset) {
    const store = useThemeStore.getState()
    store.setPreset(preset.themeData.presetId)
    store.setCustomCss(preset.themeData.customCss)
    store.setRadius(preset.themeData.radius)
    store.clearOverrides('light')
    store.clearOverrides('dark')
    Object.entries(preset.themeData.overridesLight ?? {}).forEach(([token, value]) => {
      store.setOverride('light', token as ThemeToken, value)
    })
    Object.entries(preset.themeData.overridesDark ?? {}).forEach(([token, value]) => {
      store.setOverride('dark', token as ThemeToken, value)
    })
    toast.success(t('appearancePage.savedThemes.applied', { name: preset.name }))
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bookmark className="h-5 w-5" />
              {t('appearancePage.savedThemes.title')}
            </CardTitle>
            <CardDescription>
              {t('appearancePage.savedThemes.description')}
            </CardDescription>
          </div>
          <Button onClick={() => setShowSaveDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('appearancePage.savedThemes.saveCurrent')}
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : !presets?.length ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {t('appearancePage.savedThemes.empty')}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="rounded-lg border bg-card p-3 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-semibold text-sm truncate">{preset.name}</p>
                        {preset.isOwn && (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0">
                            {t('appearancePage.savedThemes.own')}
                          </Badge>
                        )}
                        {preset.isShared && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            <Share2 className="h-2.5 w-2.5 mr-0.5" />
                            {t('appearancePage.savedThemes.shared')}
                          </Badge>
                        )}
                      </div>
                      {preset.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {preset.description}
                        </p>
                      )}
                      {!preset.isOwn && preset.ownerName && (
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {preset.ownerName}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 text-xs"
                      onClick={() => applyPreset(preset)}
                    >
                      <Check className="h-3 w-3 mr-1" />
                      {t('appearancePage.savedThemes.apply')}
                    </Button>
                    {preset.isOwn && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            toggleShareMutation.mutate({
                              id: preset.id,
                              isShared: !preset.isShared,
                            })
                          }
                        >
                          <Share2 className="h-3 w-3 mr-1" />
                          {preset.isShared
                            ? t('appearancePage.savedThemes.unshare')
                            : t('appearancePage.savedThemes.share')}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive ml-auto"
                          onClick={() => setDeleteTarget(preset)}
                          aria-label={t('appearancePage.savedThemes.deleteAria')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <SaveThemeDialog
        open={showSaveDialog}
        onOpenChange={() => setShowSaveDialog(false)}
      />

      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('appearancePage.savedThemes.deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('appearancePage.savedThemes.deleteText', {
              name: deleteTarget?.name,
            })}
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
              {t('appearancePage.savedThemes.deleteConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SaveThemeDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isShared, setIsShared] = useState(false)

  const createMutation = useMutation({
    mutationFn: (input: {
      name: string
      description?: string
      isShared: boolean
      themeData: SavedThemeData
    }) => api.post('/admin/theme-presets', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'theme-presets'] })
      toast.success(t('appearancePage.savedThemes.created'))
      setName('')
      setDescription('')
      setIsShared(false)
      onOpenChange()
    },
    onError: (err) =>
      toast.error(getErrorMessage(err, t('appearancePage.savedThemes.createFailed'))),
  })

  function handleSubmit() {
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      toast.error(t('appearancePage.savedThemes.nameRequired'))
      return
    }
    const store = useThemeStore.getState()
    createMutation.mutate({
      name: trimmedName,
      description: description.trim().length > 0 ? description.trim() : undefined,
      isShared,
      themeData: {
        presetId: store.presetId,
        customCss: store.customCss,
        overridesLight: store.overridesLight,
        overridesDark: store.overridesDark,
        radius: store.radius,
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={() => onOpenChange()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('appearancePage.savedThemes.saveDialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('appearancePage.savedThemes.fields.name')} *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('appearancePage.savedThemes.fields.namePlaceholder')}
              maxLength={80}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('appearancePage.savedThemes.fields.description')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('appearancePage.savedThemes.fields.descriptionPlaceholder')}
              maxLength={280}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label className="cursor-pointer">
                {t('appearancePage.savedThemes.fields.shared')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('appearancePage.savedThemes.fields.sharedHint')}
              </p>
            </div>
            <Switch checked={isShared} onCheckedChange={setIsShared} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={onOpenChange}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {t('appearancePage.savedThemes.saveButton')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
