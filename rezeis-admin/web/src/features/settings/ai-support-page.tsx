import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Save, Loader2, Plus, Pencil, Trash2, Eye, EyeOff, Bot } from 'lucide-react'

import { api } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FadeIn } from '@/lib/motion'

interface AiSupportSettings {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly modelsEndpoint: string
  readonly enabled: boolean
  readonly systemPrompt: string
}

interface AiInstruction {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly content: string
  readonly category: string
  readonly orderIndex: number
  readonly isActive: boolean
}

interface AiModel {
  readonly id: string
  readonly name?: string
}

interface AiInstructionForm {
  title: string
  slug: string
  content: string
  category: string
  orderIndex: number
  isActive: boolean
}

const EMPTY_INSTRUCTION_FORM: AiInstructionForm = {
  title: '',
  slug: '',
  content: '',
  category: 'app',
  orderIndex: 0,
  isActive: true,
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function AiSupportPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [showApiKey, setShowApiKey] = useState(false)
  const [models, setModels] = useState<AiModel[]>([])
  const hasHydrated = useRef(false)
  const [settingsForm, setSettingsForm] = useState({
    baseUrl: '',
    apiKey: '',
    model: '',
    modelsEndpoint: '',
    enabled: false,
    systemPrompt: '',
  })

  const [instructionDialogOpen, setInstructionDialogOpen] = useState(false)
  const [editingInstruction, setEditingInstruction] = useState<AiInstruction | null>(null)
  const [instructionForm, setInstructionForm] = useState<AiInstructionForm>(EMPTY_INSTRUCTION_FORM)

  const { data: settings, isLoading: settingsLoading } = useQuery<AiSupportSettings>({
    queryKey: ['admin', 'ai-config', 'settings'],
    queryFn: async () => (await api.get<AiSupportSettings>('/admin/ai-config')).data,
  })

  // Hydrate the form ONCE from the server settings (masked apiKey). A ref guard
  // (not a form-value check) ensures a post-save refetch never clobbers the
  // operator's in-progress edits — even when a field is intentionally empty.
  useEffect(() => {
    if (settings && !hasHydrated.current) {
      hasHydrated.current = true
      setSettingsForm({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        modelsEndpoint: settings.modelsEndpoint,
        enabled: settings.enabled ?? false,
        systemPrompt: settings.systemPrompt ?? '',
      })
    }
  }, [settings])

  const { data: instructions, isLoading: instructionsLoading } = useQuery<AiInstruction[]>({
    queryKey: ['admin', 'ai-instructions'],
    queryFn: async () => (await api.get<AiInstruction[]>('/admin/ai-instructions')).data,
  })

  const updateSettingsMutation = useMutation({
    mutationFn: (payload: Partial<AiSupportSettings>) =>
      api.patch('/admin/ai-config', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-config', 'settings'] })
      toast.success(t('aiSupport.savedOk'))
    },
    onError: () => toast.error(t('aiSupport.savedError')),
  })

  const testConnectionMutation = useMutation({
    mutationFn: () => api.post('/admin/ai-config/test'),
    onSuccess: () => toast.success(t('aiSupport.testOk')),
    onError: () => toast.error(t('aiSupport.testError')),
  })

  const fetchModelsMutation = useMutation({
    mutationFn: () => api.get<AiModel[]>('/admin/ai-config/models'),
    onSuccess: (res) => {
      const list = Array.isArray(res.data) ? res.data : []
      setModels(list)
      toast.success(t('aiSupport.modelsLoadedCount', { count: list.length }))
    },
    onError: () => toast.error(t('aiSupport.modelsError')),
  })

  const createInstructionMutation = useMutation({
    mutationFn: (payload: { title: string; slug: string; content: string; category: string }) =>
      api.post('/admin/ai-instructions', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
      setInstructionDialogOpen(false)
      setEditingInstruction(null)
      toast.success(t('aiSupport.instrCreated'))
    },
    onError: () => toast.error(t('aiSupport.instrCreateError')),
  })

  const updateInstructionMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<AiInstructionForm> }) =>
      api.patch(`/admin/ai-instructions/${id}`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
      setInstructionDialogOpen(false)
      setEditingInstruction(null)
      toast.success(t('aiSupport.instrUpdated'))
    },
    onError: () => toast.error(t('aiSupport.instrUpdateError')),
  })

  const learnFromTicketsMutation = useMutation({
    mutationFn: () =>
      api.post<{ scanned: number; created: number; skipped: number }>(
        '/admin/ai-config/learn-from-tickets',
        { limit: 30 },
      ),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
      toast.success(t('aiSupport.learnResult', res.data))
    },
    onError: () => toast.error(t('aiSupport.learnError')),
  })

  const deleteInstructionMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/ai-instructions/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
      toast.success(t('aiSupport.instrDeleted'))
    },
    onError: () => toast.error(t('aiSupport.instrDeleteError')),
  })

  const toggleInstructionMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/ai-instructions/${id}`, { isActive }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
    },
  })

  function handleSaveSettings() {
    updateSettingsMutation.mutate(settingsForm)
  }

  function handleTestConnection() {
    testConnectionMutation.mutate()
  }

  function handleFetchModels() {
    fetchModelsMutation.mutate()
  }

  function openInstructionCreate() {
    setEditingInstruction(null)
    setInstructionForm(EMPTY_INSTRUCTION_FORM)
    setInstructionDialogOpen(true)
  }

  function openInstructionEdit(instruction: AiInstruction) {
    setEditingInstruction(instruction)
    setInstructionForm({
      title: instruction.title,
      slug: instruction.slug,
      content: instruction.content,
      category: instruction.category,
      orderIndex: instruction.orderIndex,
      isActive: instruction.isActive,
    })
    setInstructionDialogOpen(true)
  }

  function handleSubmitInstruction() {
    const trimmedTitle = instructionForm.title.trim()
    const trimmedContent = instructionForm.content.trim()
    if (trimmedTitle.length === 0 || trimmedContent.length === 0) {
      toast.error(t('aiSupport.fillRequired'))
      return
    }

    const payload = {
      title: trimmedTitle,
      slug: instructionForm.slug || slugify(trimmedTitle),
      content: trimmedContent,
      category: instructionForm.category,
    }

    if (editingInstruction) {
      updateInstructionMutation.mutate({ id: editingInstruction.id, payload })
    } else {
      createInstructionMutation.mutate(payload)
    }
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <Bot className="h-6 w-6" />
              AI-Support
            </h1>
            <p className="text-muted-foreground">
              {t('aiSupport.pageSubtitle')}
            </p>
          </div>
        </div>
      </FadeIn>

      <FadeIn>
        <Card>
          <CardHeader>
            <CardTitle>{t('aiSupport.apiCardTitle')}</CardTitle>
            <CardDescription>{t('aiSupport.apiCardDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settingsLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="aiEnabled">{t('aiSupport.enabledLabel')}</Label>
                    <p className="text-xs text-muted-foreground">{t('aiSupport.enabledHint')}</p>
                  </div>
                  <Switch
                    id="aiEnabled"
                    checked={settingsForm.enabled}
                    onCheckedChange={(enabled: boolean) => setSettingsForm({ ...settingsForm, enabled })}
                  />
                </div>
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="baseUrl">{t('aiSupport.baseUrlLabel')}</Label>
                    <Input
                      id="baseUrl"
                      placeholder="https://api.openai.com/v1"
                      value={settingsForm.baseUrl}
                      onChange={(e) => setSettingsForm({ ...settingsForm, baseUrl: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="apiKey">{t('aiSupport.apiKeyLabel')}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="apiKey"
                        type={showApiKey ? 'text' : 'password'}
                        placeholder="sk-..."
                        value={settingsForm.apiKey}
                        onChange={(e) => setSettingsForm({ ...settingsForm, apiKey: e.target.value })}
                      />
                      <Button type="button" variant="outline" size="icon" onClick={() => setShowApiKey(!showApiKey)}>
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="model">{t('aiSupport.modelLabel')}</Label>
                    {models.length > 0 && (
                      <Select
                        value={models.some((m) => m.id === settingsForm.model) ? settingsForm.model : undefined}
                        onValueChange={(value: string) => setSettingsForm({ ...settingsForm, model: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('aiSupport.selectModel')} />
                        </SelectTrigger>
                        <SelectContent>
                          {models.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name ?? m.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Input
                      id="model"
                      placeholder="gpt-4o-mini"
                      value={settingsForm.model}
                      onChange={(e) => setSettingsForm({ ...settingsForm, model: e.target.value })}
                    />
                    {models.length === 0 && (
                      <p className="text-xs text-muted-foreground">{t('aiSupport.noModelsHint')}</p>
                    )}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="modelsEndpoint">{t('aiSupport.modelsEndpointLabel')}</Label>
                    <Input
                      id="modelsEndpoint"
                      placeholder="/v1/models"
                      value={settingsForm.modelsEndpoint}
                      onChange={(e) => setSettingsForm({ ...settingsForm, modelsEndpoint: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="systemPrompt">{t('aiSupport.systemPromptLabel')}</Label>
                    <Textarea
                      id="systemPrompt"
                      placeholder={t('aiSupport.systemPromptPlaceholder')}
                      value={settingsForm.systemPrompt}
                      onChange={(e) => setSettingsForm({ ...settingsForm, systemPrompt: e.target.value })}
                      className="min-h-[140px]"
                      maxLength={8000}
                    />
                    <p className="text-xs text-muted-foreground">{t('aiSupport.systemPromptHint')}</p>
                  </div>
                </div>
                <Separator />
                <div className="flex gap-2">
                  <Button variant="outline" onClick={handleFetchModels} disabled={fetchModelsMutation.isPending}>
                    {fetchModelsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t('aiSupport.loadModels')}
                  </Button>
                  <Button variant="outline" onClick={handleTestConnection} disabled={testConnectionMutation.isPending}>
                    {testConnectionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t('aiSupport.testConnection')}
                  </Button>
                </div>
                <Button onClick={handleSaveSettings} disabled={updateSettingsMutation.isPending}>
                  {updateSettingsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {t('aiSupport.save')}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </FadeIn>

      <FadeIn>
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{t('aiSupport.instrTitle')}</CardTitle>
                <CardDescription>{t('aiSupport.instrDesc')}</CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => learnFromTicketsMutation.mutate()}
                disabled={learnFromTicketsMutation.isPending}
                title={t('aiSupport.learnHint')}
              >
                {learnFromTicketsMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Bot className="h-4 w-4" />
                )}
                {learnFromTicketsMutation.isPending ? t('aiSupport.learnRunning') : t('aiSupport.learnButton')}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('aiSupport.learnHint')}</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {instructionsLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !instructions || instructions.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Bot className="h-10 w-10 opacity-30" />
                <p>{t('aiSupport.instrEmpty')}</p>
              </div>
            ) : (
              instructions.map((instruction) => (
                <div key={instruction.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{instruction.title}</span>
                      <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{instruction.category}</span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-1">{instruction.content.slice(0, 100)}...</p>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Switch
                      checked={instruction.isActive}
                      onCheckedChange={(isActive: boolean) => toggleInstructionMutation.mutate({ id: instruction.id, isActive })}
                    />
                    <Button variant="ghost" size="sm" onClick={() => openInstructionEdit(instruction)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('aiSupport.instrDeleteTitle')}</AlertDialogTitle>
                          <AlertDialogDescription>{t('aiSupport.instrDeleteConfirm', { title: instruction.title })}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('aiSupport.cancel')}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteInstructionMutation.mutate(instruction.id)}>{t('aiSupport.delete')}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ))
            )}
            <Button variant="outline" className="w-full mt-4" onClick={openInstructionCreate}>
              <Plus className="h-4 w-4 mr-2" />
              {t('aiSupport.instrAdd')}
            </Button>
          </CardContent>
        </Card>
      </FadeIn>

      <Dialog open={instructionDialogOpen} onOpenChange={setInstructionDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingInstruction ? t('aiSupport.instrEditTitle') : t('aiSupport.instrNewTitle')}</DialogTitle>
            <DialogDescription>{t('aiSupport.instrDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="instructionTitle">{t('aiSupport.instrNameLabel')}</Label>
              <Input
                id="instructionTitle"
                placeholder="Happ (iOS/Android)"
                value={instructionForm.title}
                onChange={(e) => setInstructionForm({ ...instructionForm, title: e.target.value, slug: slugify(e.target.value) })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="instructionSlug">{t('aiSupport.slugLabel')}</Label>
              <Input id="instructionSlug" placeholder="happ" value={instructionForm.slug} onChange={(e) => setInstructionForm({ ...instructionForm, slug: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="instructionCategory">{t('aiSupport.instrCategoryLabel')}</Label>
              <Select value={instructionForm.category} onValueChange={(value: string) => setInstructionForm({ ...instructionForm, category: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="app">{t('aiSupport.catApp')}</SelectItem>
                  <SelectItem value="vpn">VPN</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="instructionContent">{t('aiSupport.instrContentLabel')}</Label>
              <Textarea
                id="instructionContent"
                placeholder={t('aiSupport.instrContentPlaceholder')}
                value={instructionForm.content}
                onChange={(e) => setInstructionForm({ ...instructionForm, content: e.target.value })}
                className="min-h-[300px] font-mono text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstructionDialogOpen(false)}>{t('aiSupport.cancel')}</Button>
            <Button onClick={handleSubmitInstruction}>{editingInstruction ? t('aiSupport.save') : t('aiSupport.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
