/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { lazy, Suspense, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GripVertical, Sparkles, Plus, Trash2, Bot, Workflow } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'

const BotFlowPage = lazy(() => import('@/features/bot-flow/bot-flow-page'))

export default function BotConfigPage() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Bot className="h-6 w-6" />
          {t('botConfigPage.title')}
        </h1>
        <p className="text-muted-foreground">{t('botConfigPage.subtitle')}</p>
      </div>

      <Tabs defaultValue="flow">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="flow" className="gap-1.5">
            <Workflow className="h-3.5 w-3.5" />
            {t('botConfigPage.tabs.flow')}
          </TabsTrigger>
          <TabsTrigger value="buttons">{t('botConfigPage.tabs.buttons')}</TabsTrigger>
          <TabsTrigger value="emojis">{t('botConfigPage.tabs.emojis')}</TabsTrigger>
          <TabsTrigger value="texts">{t('botConfigPage.tabs.texts')}</TabsTrigger>
        </TabsList>

        <TabsContent value="flow" className="mt-0 -mx-6 -mb-6">
          <Suspense fallback={<Skeleton className="h-[calc(100vh-12rem)] w-full" />}>
            <BotFlowPage />
          </Suspense>
        </TabsContent>
        <TabsContent value="buttons"><ButtonsTab /></TabsContent>
        <TabsContent value="emojis"><EmojisTab /></TabsContent>
        <TabsContent value="texts"><TextsTab /></TabsContent>
      </Tabs>
    </div>
  )
}

// ── Buttons Tab ──────────────────────────────────────────────────────────────

function ButtonsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [newButtonId, setNewButtonId] = useState('')
  const [newButtonLabel, setNewButtonLabel] = useState('')

  const { data: buttons, isLoading } = useQuery({
    queryKey: ['admin', 'bot-config', 'buttons'],
    queryFn: async () => (await api.get('/admin/bot-config/buttons')).data,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.patch(`/admin/bot-config/buttons/${id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'buttons'] }); toast.success(t('botConfigPage.toasts.buttonUpdated')) },
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/admin/bot-config/buttons', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'buttons'] })
      toast.success(t('botConfigPage.toasts.buttonCreated'))
      setNewButtonId('')
      setNewButtonLabel('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/bot-config/buttons/${id}/delete`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'buttons'] }); toast.success(t('botConfigPage.toasts.buttonDeleted')) },
  })

  if (isLoading) return <Skeleton className="h-64 w-full mt-4" />

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('botConfigPage.buttons.title')}</CardTitle>
        <CardDescription>{t('botConfigPage.buttons.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {buttons?.map((btn: any) => (
          <div key={btn.id} className="flex items-center gap-3 p-3 border rounded-lg">
            <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab shrink-0" />

            {/* Visibility toggle */}
            <Switch
              checked={btn.visible}
              onCheckedChange={(v) => updateMutation.mutate({ id: btn.id, data: { visible: v } })}
            />

            {/* Label */}
            <Input
              className="flex-1 h-9"
              defaultValue={btn.label}
              onBlur={(e) => {
                if (e.target.value !== btn.label) {
                  updateMutation.mutate({ id: btn.id, data: { label: e.target.value } })
                }
              }}
            />

            {/* Style */}
            <Select
              defaultValue={btn.style ?? 'primary'}
              onValueChange={(v) => updateMutation.mutate({ id: btn.id, data: { style: v } })}
            >
              <SelectTrigger className="w-28 h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">{t('botConfigExtras.styleLabels.primary')}</SelectItem>
                <SelectItem value="success">{t('botConfigExtras.styleLabels.success')}</SelectItem>
                <SelectItem value="danger">{t('botConfigExtras.styleLabels.danger')}</SelectItem>
                <SelectItem value="default">{t('botConfigExtras.styleLabels.default')}</SelectItem>
              </SelectContent>
            </Select>

            {/* Premium Emoji ID */}
            <Input
              className="w-36 h-9 font-mono text-xs"
              placeholder={t('botConfigExtras.emojiIdPlaceholder')}
              defaultValue={btn.iconCustomEmojiId ?? ''}
              onBlur={(e) => {
                const val = e.target.value.trim() || null
                if (val !== btn.iconCustomEmojiId) {
                  updateMutation.mutate({ id: btn.id, data: { iconCustomEmojiId: val } })
                }
              }}
            />

            {/* One per row */}
            <Badge variant={btn.onePerRow ? 'default' : 'outline'} className="cursor-pointer text-xs shrink-0"
              onClick={() => updateMutation.mutate({ id: btn.id, data: { onePerRow: !btn.onePerRow } })}
            >
              {btn.onePerRow ? 'Full' : '½'}
            </Badge>

            {/* Delete */}
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0"
              onClick={() => { if (confirm(t('botConfigPage.buttons.deleteConfirm'))) deleteMutation.mutate(btn.id) }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}

        <Separator className="my-4" />

        {/* Create new button */}
        <div className="flex items-center gap-3 p-3 border border-dashed rounded-lg">
          <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input className="w-32 h-9" placeholder={t('botConfigPage.buttons.newIdPlaceholder')} value={newButtonId} onChange={(e) => setNewButtonId(e.target.value)} />
          <Input className="flex-1 h-9" placeholder={t('botConfigPage.buttons.newLabelPlaceholder')} value={newButtonLabel} onChange={(e) => setNewButtonLabel(e.target.value)} />
          <Button size="sm" disabled={!newButtonId.trim() || !newButtonLabel.trim()}
            onClick={() => createMutation.mutate({ buttonId: newButtonId.trim(), label: newButtonLabel.trim() })}
          >
            <Plus className="h-4 w-4 mr-1" /> {t('botConfigPage.buttons.add')}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground mt-4">
          {t('botConfigExtras.helpButtons')}
        </p>
      </CardContent>
    </Card>
  )
}

// ── Emojis Tab ───────────────────────────────────────────────────────────────

function EmojisTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [newKey, setNewKey] = useState('')
  const [newUnicode, setNewUnicode] = useState('')

  const { data: emojis, isLoading } = useQuery({
    queryKey: ['admin', 'bot-config', 'emojis'],
    queryFn: async () => (await api.get('/admin/bot-config/emojis')).data,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.patch(`/admin/bot-config/emojis/${id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'emojis'] }); toast.success(t('botConfigPage.toasts.emojiUpdated')) },
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/admin/bot-config/emojis', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'emojis'] })
      toast.success(t('botConfigPage.toasts.emojiCreated'))
      setNewKey('')
      setNewUnicode('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/bot-config/emojis/${id}/delete`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'emojis'] }); toast.success(t('botConfigPage.toasts.emojiDeleted')) },
  })

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('botConfigPage.emojis.title')}</CardTitle>
        <CardDescription>
          {t('botConfigPage.emojis.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {emojis?.map((emoji: any) => (
            <div key={emoji.id} className="flex items-center gap-3">
              <Badge variant="outline" className="w-32 justify-center font-mono text-xs">{emoji.key}</Badge>
              <Input
                className="w-16 h-9 text-center text-lg"
                defaultValue={emoji.unicode}
                onBlur={(e) => {
                  if (e.target.value !== emoji.unicode) {
                    updateMutation.mutate({ id: emoji.id, data: { unicode: e.target.value } })
                  }
                }}
              />
              <Input
                className="flex-1 h-9 font-mono text-xs"
                placeholder={t('botConfigExtras.customEmojiPlaceholder')}
                defaultValue={emoji.tgEmojiId ?? ''}
                onBlur={(e) => {
                  const val = e.target.value.trim() || null
                  if (val !== emoji.tgEmojiId) {
                    updateMutation.mutate({ id: emoji.id, data: { tgEmojiId: val } })
                  }
                }}
              />
              <Sparkles className={`h-4 w-4 shrink-0 ${emoji.tgEmojiId ? 'text-amber-500' : 'text-muted-foreground/30'}`} />
              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0"
                onClick={() => { if (confirm(t('botConfigPage.emojis.deleteConfirm'))) deleteMutation.mutate(emoji.id) }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        <Separator className="my-4" />

        {/* Create new emoji */}
        <div className="flex items-center gap-3">
          <Input className="w-32 h-9 font-mono" placeholder={t('botConfigPage.emojis.newKeyPlaceholder')} value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} />
          <Input className="w-16 h-9 text-center text-lg" placeholder={t('botConfigPage.emojis.newUnicodePlaceholder')} value={newUnicode} onChange={(e) => setNewUnicode(e.target.value)} />
          <Button size="sm" disabled={!newKey.trim() || !newUnicode.trim()}
            onClick={() => createMutation.mutate({ key: newKey.trim(), unicode: newUnicode.trim() })}
          >
            <Plus className="h-4 w-4 mr-1" /> {t('botConfigPage.emojis.add')}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground mt-4">
          {t('botConfigExtras.helpEmoji')}
        </p>
      </CardContent>
    </Card>
  )
}

// ── Texts Tab ────────────────────────────────────────────────────────────────

function TextsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const { data: texts, isLoading } = useQuery({
    queryKey: ['admin', 'bot-config', 'texts'],
    queryFn: async () => (await api.get('/admin/bot-config/texts')).data,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api.patch(`/admin/bot-config/texts/${id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'texts'] }); toast.success(t('botConfigPage.toasts.textUpdated')) },
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/admin/bot-config/texts', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'texts'] })
      toast.success(t('botConfigPage.toasts.textCreated'))
      setNewKey('')
      setNewValue('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/bot-config/texts/${id}/delete`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'bot-config', 'texts'] }); toast.success(t('botConfigPage.toasts.textDeleted')) },
  })

  if (isLoading) return <Skeleton className="h-48 w-full mt-4" />

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('botConfigPage.texts.title')}</CardTitle>
        <CardDescription>
          {t('botConfigPage.texts.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {texts?.map((text: any) => (
          <div key={text.id} className="flex items-center gap-3">
            <Switch
              checked={text.visible}
              onCheckedChange={(v) => updateMutation.mutate({ id: text.id, data: { visible: v } })}
            />
            <Badge variant="outline" className="w-40 justify-center font-mono text-xs shrink-0">{text.key}</Badge>
            <Input
              className="flex-1 h-9"
              defaultValue={text.value}
              onBlur={(e) => {
                if (e.target.value !== text.value) {
                  updateMutation.mutate({ id: text.id, data: { value: e.target.value } })
                }
              }}
            />
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0"
              onClick={() => { if (confirm(t('botConfigPage.texts.deleteConfirm'))) deleteMutation.mutate(text.id) }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}

        <Separator className="my-4" />

        {/* Create new text */}
        <div className="flex items-center gap-3">
          <Input className="w-40 h-9 font-mono text-xs" placeholder={t('botConfigPage.texts.newKeyPlaceholder')} value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <Input className="flex-1 h-9" placeholder={t('botConfigPage.texts.newValuePlaceholder')} value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <Button size="sm" disabled={!newKey.trim() || !newValue.trim()}
            onClick={() => createMutation.mutate({ key: newKey.trim(), value: newValue.trim() })}
          >
            <Plus className="h-4 w-4 mr-1" /> {t('botConfigPage.texts.add')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
