import { useState } from 'react'
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
  const queryClient = useQueryClient()

  // ── Settings state ──
  const [showApiKey, setShowApiKey] = useState(false)
  const [settingsForm, setSettingsForm] = useState({
    baseUrl: '',
    apiKey: '',
    model: '',
    modelsEndpoint: '',
  })

  // ── Instruction state ──
  const [instructionDialogOpen, setInstructionDialogOpen] = useState(false)
  const [editingInstruction, setEditingInstruction] = useState<AiInstruction | null>(null)
  const [instructionForm, setInstructionForm] = useState<AiInstructionForm>(EMPTY_INSTRUCTION_FORM)

  // ── Queries ──
  const { data: settings, isLoading: settingsLoading } = useQuery<AiSupportSettings>({
    queryKey: ['admin', 'ai-config', 'settings'],
    queryFn: async () => (await api.get<AiSupportSettings>('/admin/ai-config')).data,
  })

  // Sync settings into form when loaded
  if (settings && settingsForm.baseUrl === '' && settings.apiKey !== undefined) {
    setSettingsForm({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      modelsEndpoint: settings.modelsEndpoint,
    })
  }

  const { data: models } = useQuery<AiModel[]>({
    queryKey: ['admin', 'ai-config', 'models'],
    queryFn: async () => (await api.get<AiModel[]>('/admin/ai-config/models')).data,
    enabled: false,
  })

  const { data: instructions, isLoading: instructionsLoading } = useQuery<AiInstruction[]>({
    queryKey: ['admin', 'ai-instructions'],
    queryFn: async () => (await api.get<AiInstruction[]>('/admin/ai-instructions')).data,
  })

  // ── Mutations ──
  const updateSettingsMutation = useMutation({
    mutationFn: (payload: Partial<AiSupportSettings>) =>
      api.patch('/admin/ai-config', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-config', 'settings'] })
      toast.success('Настройки AI сохранены')
    },
    onError: () => toast.error('Ошибка сохранения настроек'),
  })

  const testConnectionMutation = useMutation({
    mutationFn: () => api.post('/admin/ai-config/test'),
    onSuccess: () => toast.success('Подключение успешно'),
    onError: () => toast.error('Ошибка подключения'),
  })

  const fetchModelsMutation = useMutation({
    mutationFn: () => api.get('/admin/ai-config/models'),
    onSuccess: () => toast.success('Модели загружены'),
    onError: () => toast.error('Ошибка загрузки моделей'),
  })

  const createInstructionMutation = useMutation({
    mutationFn: (payload: { title: string; slug: string; content: string; category: string }) =>
      api.post('/admin/ai-instructions', payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
      setInstructionDialogOpen(false)
      setEditingInstruction(null)
      toast.success('Инструкция создана')
    },
    onError: () => toast.error('Ошибка создания инструкции'),
  })

  const updateInstructionMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<AiInstructionForm> }) =>
      api.patch(`/admin/ai-instructions/${id}`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
      setInstructionDialogOpen(false)
      setEditingInstruction(null)
      toast.success('Инструкция обновлена')
    },
    onError: () => toast.error('Ошибка обновления инструкции'),
  })

  const deleteInstructionMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/ai-instructions/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
      toast.success('Инструкция удалена')
    },
    onError: () => toast.error('Ошибка удаления инструкции'),
  })

  const toggleInstructionMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/ai-instructions/${id}`, { isActive }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'ai-instructions'] })
    },
  })

  // ── Handlers ──
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
      toast.error('Заполните все обязательные поля')
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
              Настройки AI-ассистента для поддержки пользователей
            </p>
          </div>
        </div>
      </FadeIn>

      {/* ── API Settings ── */}
      <FadeIn>
        <Card>
          <CardHeader>
            <CardTitle>Настройки API</CardTitle>
            <CardDescription>
              Подключение к OpenAI-совместимому API
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settingsLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <>
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="baseUrl">Base URL</Label>
                    <Input
                      id="baseUrl"
                      placeholder="https://api.openai.com/v1"
                      value={settingsForm.baseUrl}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, baseUrl: e.target.value })
                      }
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="apiKey">API Key</Label>
                    <div className="flex gap-2">
                      <Input
                        id="apiKey"
                        type={showApiKey ? 'text' : 'password'}
                        placeholder="sk-..."
                        value={settingsForm.apiKey}
                        onChange={(e) =>
                          setSettingsForm({ ...settingsForm, apiKey: e.target.value })
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="model">Модель</Label>
                    <Input
                      id="model"
                      placeholder="gpt-4o-mini"
                      value={settingsForm.model}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, model: e.target.value })
                      }
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="modelsEndpoint">Endpoint для моделей (опционально)</Label>
                    <Input
                      id="modelsEndpoint"
                      placeholder="/v1/models"
                      value={settingsForm.modelsEndpoint}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, modelsEndpoint: e.target.value })
                      }
                    />
                  </div>
                </div>

                <Separator />

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleFetchModels}
                    disabled={fetchModelsMutation.isPending}
                  >
                    {fetchModelsMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Загрузить модели'
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleTestConnection}
                    disabled={testConnectionMutation.isPending}
                  >
                    {testConnectionMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Тест соединения'
                    )}
                  </Button>
                </div>

                <Button onClick={handleSaveSettings} disabled={updateSettingsMutation.isPending}>
                  {updateSettingsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Сохранить
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </FadeIn>

      {/* ── Instructions ── */}
      <FadeIn>
        <Card>
          <CardHeader>
            <CardTitle>Инструкции</CardTitle>
            <CardDescription>
              Гайды по приложениям и подключению. Используются AI-ассистентом для ответов.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {instructionsLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !instructions || instructions.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
                <Bot className="h-10 w-10 opacity-30" />
                <p>Инструкции пока не добавлены</p>
              </div>
            ) : (
              instructions.map((instruction) => (
                <div
                  key={instruction.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{instruction.title}</span>
                      <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                        {instruction.category}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-1">
                      {instruction.content.slice(0, 100)}...
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Switch
                      checked={instruction.isActive}
                      onCheckedChange={(isActive) =>
                        toggleInstructionMutation.mutate({ id: instruction.id, isActive })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openInstructionEdit(instruction)}
                    >
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
                          <AlertDialogTitle>Удалить инструкцию?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Это действие нельзя отменить. Инструкция «{instruction.title}» будет удалена.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Отмена</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteInstructionMutation.mutate(instruction.id)}>
                            Удалить
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ))
            )}

            <Button variant="outline" className="w-full mt-4" onClick={openInstructionCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Добавить инструкцию
            </Button>
          </CardContent>
        </Card>
      </FadeIn>

      {/* ── Instruction Dialog ── */}
      <Dialog open={instructionDialogOpen} onOpenChange={setInstructionDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingInstruction ? 'Редактировать инструкцию' : 'Новая инструкция'}
            </DialogTitle>
            <DialogDescription>
              Создайте гайд для пользователей по подключению или использованию VPN
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="instructionTitle">Название *</Label>
              <Input
                id="instructionTitle"
                placeholder="Happ (iOS/Android)"
                value={instructionForm.title}
                onChange={(e) => {
                  const title = e.target.value
                  setInstructionForm({
                    ...instructionForm,
                    title,
                    slug: slugify(title),
                  })
                }}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="instructionSlug">Slug</Label>
              <Input
                id="instructionSlug"
                placeholder="happ"
                value={instructionForm.slug}
                onChange={(e) =>
                  setInstructionForm({ ...instructionForm, slug: e.target.value })
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="instructionCategory">Категория</Label>
              <Select
                value={instructionForm.category}
                onValueChange={(value) =>
                  setInstructionForm({ ...instructionForm, category: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="app">Приложение</SelectItem>
                  <SelectItem value="vpn">VPN</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="instructionContent">Содержимое (Markdown) *</Label>
              <Textarea
                id="instructionContent"
                placeholder="# Инструкция по Happ&#10;&#10;## Установка...&#10;&#10;1. Скачайте приложение&#10;2. ..."
                value={instructionForm.content}
                onChange={(e) =>
                  setInstructionForm({ ...instructionForm, content: e.target.value })
                }
                className="min-h-[300px] font-mono text-sm"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setInstructionDialogOpen(false)}>
              Отмена
            </Button>
            <Button onClick={handleSubmitInstruction}>
              {editingInstruction ? 'Сохранить' : 'Создать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
