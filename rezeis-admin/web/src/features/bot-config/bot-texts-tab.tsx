/**
 * Bot copy texts — searchable table + edit/create dialog with Textarea.
 *
 * Text values can be up to 8000 chars (Telegram caption / message limits
 * leave room) so the editor uses a multi-line Textarea. The seed-only
 * row `bot.banner_url` is editable from here as well — operators set
 * the banner URL by editing this very key, no separate field.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { EmojiFieldOverlay } from '@/features/custom-emoji/emoji-field-overlay'
import { RenderedCopyPreview } from '@/features/custom-emoji/rendered-copy-preview'
import { getErrorMessage } from '@/lib/http-errors'
import { truncate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

import {
  BOT_CONFIG_KEYS,
  type BotText,
  type CreateBotTextPayload,
  type UpdateBotTextPayload,
  botConfigApi,
} from './bot-config-api'
import { botTextKeyMode } from './bot-text-key-mode'

export function BotTextsTab(): JSX.Element {
  const { t } = useTranslation()
  const { data: texts, isLoading } = useQuery({
    queryKey: BOT_CONFIG_KEYS.texts,
    queryFn: botConfigApi.listTexts,
  })

  const [editing, setEditing] = useState<BotText | null>(null)
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!texts) return []
    const query = search.trim().toLowerCase()
    if (query.length === 0) return texts
    return texts.filter(
      (text) =>
        text.key.toLowerCase().includes(query) || text.value.toLowerCase().includes(query),
    )
  }, [texts, search])

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="relative max-w-sm flex-1">
          <Search
            className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('botConfigPage.texts.searchPlaceholder')}
            aria-label={t('botConfigPage.texts.searchAria')}
            className="pl-8"
          />
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          {t('botConfigPage.texts.create')}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {search.trim().length > 0
                ? t('botConfigPage.texts.emptySearch')
                : t('botConfigPage.texts.empty')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/3">{t('botConfigPage.texts.columns.key')}</TableHead>
                  <TableHead>{t('botConfigPage.texts.columns.value')}</TableHead>
                  <TableHead className="w-24 text-center">
                    {t('botConfigPage.texts.columns.visible')}
                  </TableHead>
                  <TableHead className="w-24 text-right">
                    {t('botConfigPage.texts.columns.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((text) => (
                  <TableRow key={text.id}>
                    <TableCell className="align-top">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {text.key}
                      </code>
                    </TableCell>
                    <TableCell className="max-w-xl whitespace-pre-wrap break-words text-sm">
                      {text.value.length === 0 ? (
                        <Badge variant="outline" className="text-xs">
                          {t('botConfigPage.texts.emptyValue')}
                        </Badge>
                      ) : (
                        truncate(text.value, 200)
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {text.visible ? (
                        <Eye
                          className="mx-auto h-4 w-4 text-muted-foreground"
                          aria-label={t('botConfigPage.texts.visible')}
                        />
                      ) : (
                        <EyeOff
                          className="mx-auto h-4 w-4 text-muted-foreground"
                          aria-label={t('botConfigPage.texts.hidden')}
                        />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('botConfigPage.texts.edit')}
                        onClick={() => setEditing(text)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <TextEditDialog
        text={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      />
      <TextCreateDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

/**
 * How a key's fields draw their value, and what sits under them.
 *
 * `mode` is the whole of defect 2: this tab edits ANY key, and a handful of them
 * are read back as inline-button captions, where reiwa cuts a leading token out
 * of the string and ships it as `icon_custom_emoji_id`. `botTextKeyMode` decides
 * which renderer the key feeds; see that module for why the rule is what it is.
 *
 * The two follow from it and are not free choices:
 *
 *   • `RenderedCopyPreview` previews MESSAGE BODIES. It renders `mode: 'text'`
 *     by design — a caption is previewed by the field layer in `buttonLabel`
 *     mode instead, because only the layer has somewhere to put the promoted
 *     icon (its own row, above the field). Showing it under a caption key would
 *     put a second, text-mode answer on screen directly beneath the layer's
 *     caption-mode one, which is the shape of defect 1 all over again.
 *   • `liveStrip` therefore covers the gap it leaves: the layer steps aside for
 *     a focused field, so without the preview below, a caption key would show
 *     nothing at all while being typed into. For body copy the preview is
 *     already there and a strip as well would just be a second copy of it.
 */
function fieldModeFor(key: string): {
  readonly mode: ReturnType<typeof botTextKeyMode>
  readonly liveStrip: boolean
  readonly showsCopyPreview: boolean
} {
  const mode = botTextKeyMode(key)
  return { mode, liveStrip: mode === 'buttonLabel', showsCopyPreview: mode === 'text' }
}

interface TextEditDialogProps {
  readonly text: BotText | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function TextEditDialog({ text, open, onOpenChange }: TextEditDialogProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(true)
  const [enEnabled, setEnEnabled] = useState(false)
  const [valueEn, setValueEn] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const enTextareaRef = useRef<HTMLTextAreaElement>(null)

  // RU and EN are two values of ONE key, so they feed the same renderer and are
  // drawn the same way.
  const field = fieldModeFor(text?.key ?? '')

  function insertAtCaret(emoji: string): void {
    const el = textareaRef.current
    if (!el) {
      setValue((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = value.slice(0, start) + emoji + value.slice(end)
    setValue(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  function insertAtCaretEn(emoji: string): void {
    const el = enTextareaRef.current
    if (!el) {
      setValueEn((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? valueEn.length
    const end = el.selectionEnd ?? valueEn.length
    const next = valueEn.slice(0, start) + emoji + valueEn.slice(end)
    setValueEn(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
    if (text !== null && open) {
      setValue(text.value)
      setVisible(text.visible)
      const en = text.valueEn ?? ''
      setValueEn(en)
      setEnEnabled(en.length > 0)
    }
  }, [text, open])
    /* eslint-enable react-hooks/set-state-in-effect */

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { readonly id: string; readonly payload: UpdateBotTextPayload }) =>
      botConfigApi.updateText(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.texts })
      toast.success(t('botConfigPage.texts.toasts.updated'))
      onOpenChange(false)
    },
    // Surface the server's reason. The write path refuses specific things and
    // names them — a duplicate key, a key that is not alphanumeric — and a bare
    // "Не удалось сохранить" sends the operator back to the same value with
    // nothing to change.
    onError: (error) =>
      toast.error(getErrorMessage(error, t('botConfigPage.texts.toasts.updateFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => botConfigApi.deleteText(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.texts })
      toast.success(t('botConfigPage.texts.toasts.deleted'))
      onOpenChange(false)
    },
    onError: () => toast.error(t('botConfigPage.texts.toasts.deleteFailed')),
  })

  function submit(): void {
    if (text === null) return
    updateMutation.mutate({
      id: text.id,
      payload: { value, visible, valueEn: enEnabled ? valueEn : null },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('botConfigPage.texts.editTitle')}</DialogTitle>
          {text !== null && (
            <DialogDescription>
              <code className="font-mono text-xs">{text.key}</code>
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bc-text-value">{t('botConfigPage.texts.fields.value')}</Label>
            <EmojiFieldOverlay
              value={value}
              mode={field.mode}
              multiline
              // For body copy the delivery preview below already carries the
              // rendered line while this field is focused, so no second strip.
              // A caption has no preview below it and needs one.
              liveStrip={field.liveStrip}
              overlayClassName="font-mono text-sm pr-10"
              adornment={
                <div className="absolute right-1.5 top-1.5">
                  <EmojiPicker onSelect={insertAtCaret} ariaLabel={t('emojiPicker.trigger')} />
                </div>
              }
            >
              <Textarea
                id="bc-text-value"
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={8000}
                rows={10}
                className="font-mono text-sm pr-10"
              />
            </EmojiFieldOverlay>
            <p className="text-xs text-muted-foreground">
              {value.length}/8000
            </p>
            {field.showsCopyPreview && <RenderedCopyPreview value={value} />}
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="bc-text-en-toggle" className="font-medium">
                  {t('botConfigPage.texts.fields.enToggle')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('botConfigPage.texts.fields.enToggleHint')}
                </p>
              </div>
              <Switch
                id="bc-text-en-toggle"
                checked={enEnabled}
                onCheckedChange={setEnEnabled}
              />
            </div>
            {enEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="bc-text-value-en">
                  {t('botConfigPage.texts.fields.enValue')}
                </Label>
                <EmojiFieldOverlay
                  value={valueEn}
                  mode={field.mode}
                  multiline
                  liveStrip={field.liveStrip}
                  overlayClassName="font-mono text-sm pr-10"
                  adornment={
                    <div className="absolute right-1.5 top-1.5">
                      <EmojiPicker
                        onSelect={insertAtCaretEn}
                        ariaLabel={t('emojiPicker.trigger')}
                      />
                    </div>
                  }
                >
                  <Textarea
                    id="bc-text-value-en"
                    ref={enTextareaRef}
                    value={valueEn}
                    onChange={(e) => setValueEn(e.target.value)}
                    maxLength={8000}
                    rows={8}
                    className="font-mono text-sm pr-10"
                  />
                </EmojiFieldOverlay>
                <p className="text-xs text-muted-foreground">{valueEn.length}/8000</p>
                {field.showsCopyPreview && <RenderedCopyPreview value={valueEn} />}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="bc-text-visible" className="font-medium">
                {t('botConfigPage.texts.fields.visible')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('botConfigPage.texts.fields.visibleHint')}
              </p>
            </div>
            <Switch id="bc-text-visible" checked={visible} onCheckedChange={setVisible} />
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="destructive"
            onClick={() => text !== null && deleteMutation.mutate(text.id)}
            disabled={text === null || deleteMutation.isPending}
          >
            <Trash2 className="mr-1 h-4 w-4" aria-hidden />
            {t('botConfigPage.texts.delete')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('botConfigPage.texts.cancel')}
            </Button>
            <Button onClick={submit} disabled={updateMutation.isPending}>
              {t('botConfigPage.texts.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface TextCreateDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

function TextCreateDialog({ open, onOpenChange }: TextCreateDialogProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [visible, setVisible] = useState(true)
  const [enEnabled, setEnEnabled] = useState(false)
  const [valueEn, setValueEn] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const enTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Follows the key field as it is typed: the row does not exist yet, so the key
  // above is the only thing that says which renderer this copy will feed.
  const field = fieldModeFor(key)

  function insertAtCaret(emoji: string): void {
    const el = textareaRef.current
    if (!el) {
      setValue((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = value.slice(0, start) + emoji + value.slice(end)
    setValue(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  function insertAtCaretEn(emoji: string): void {
    const el = enTextareaRef.current
    if (!el) {
      setValueEn((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? valueEn.length
    const end = el.selectionEnd ?? valueEn.length
    const next = valueEn.slice(0, start) + emoji + valueEn.slice(end)
    setValueEn(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + emoji.length
      el.setSelectionRange(caret, caret)
    })
  }

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      setKey('')
      setValue('')
      setVisible(true)
      setEnEnabled(false)
      setValueEn('')
    }
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  const createMutation = useMutation({
    mutationFn: (payload: CreateBotTextPayload) => botConfigApi.createText(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.texts })
      toast.success(t('botConfigPage.texts.toasts.created'))
      onOpenChange(false)
    },
    onError: (error) =>
      toast.error(getErrorMessage(error, t('botConfigPage.texts.toasts.createFailed'))),
  })

  function submit(): void {
    createMutation.mutate({
      key: key.trim(),
      value,
      visible,
      valueEn: enEnabled ? valueEn : null,
    })
  }

  const canSubmit =
    key.trim().length > 0 &&
    value.length > 0 &&
    /^[a-z0-9._-]+$/i.test(key.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('botConfigPage.texts.createTitle')}</DialogTitle>
          <DialogDescription>{t('botConfigPage.texts.createDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bc-new-text-key">{t('botConfigPage.texts.fields.key')}</Label>
            <Input
              id="bc-new-text-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t('botConfigPage.texts.fields.keyPlaceholder')}
              maxLength={160}
            />
            <p className="text-xs text-muted-foreground">
              {t('botConfigPage.texts.fields.keyHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bc-new-text-value">{t('botConfigPage.texts.fields.value')}</Label>
            <EmojiFieldOverlay
              value={value}
              mode={field.mode}
              multiline
              liveStrip={field.liveStrip}
              overlayClassName="font-mono text-sm pr-10"
              adornment={
                <div className="absolute right-1.5 top-1.5">
                  <EmojiPicker onSelect={insertAtCaret} ariaLabel={t('emojiPicker.trigger')} />
                </div>
              }
            >
              <Textarea
                id="bc-new-text-value"
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={8000}
                rows={10}
                className="font-mono text-sm pr-10"
              />
            </EmojiFieldOverlay>
            <p className="text-xs text-muted-foreground">{value.length}/8000</p>
            {field.showsCopyPreview && <RenderedCopyPreview value={value} />}
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="bc-new-text-en-toggle" className="font-medium">
                  {t('botConfigPage.texts.fields.enToggle')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('botConfigPage.texts.fields.enToggleHint')}
                </p>
              </div>
              <Switch
                id="bc-new-text-en-toggle"
                checked={enEnabled}
                onCheckedChange={setEnEnabled}
              />
            </div>
            {enEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="bc-new-text-value-en">
                  {t('botConfigPage.texts.fields.enValue')}
                </Label>
                <EmojiFieldOverlay
                  value={valueEn}
                  mode={field.mode}
                  multiline
                  liveStrip={field.liveStrip}
                  overlayClassName="font-mono text-sm pr-10"
                  adornment={
                    <div className="absolute right-1.5 top-1.5">
                      <EmojiPicker
                        onSelect={insertAtCaretEn}
                        ariaLabel={t('emojiPicker.trigger')}
                      />
                    </div>
                  }
                >
                  <Textarea
                    id="bc-new-text-value-en"
                    ref={enTextareaRef}
                    value={valueEn}
                    onChange={(e) => setValueEn(e.target.value)}
                    maxLength={8000}
                    rows={8}
                    className="font-mono text-sm pr-10"
                  />
                </EmojiFieldOverlay>
                <p className="text-xs text-muted-foreground">{valueEn.length}/8000</p>
                {field.showsCopyPreview && <RenderedCopyPreview value={valueEn} />}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="bc-new-text-visible" className="font-medium">
              {t('botConfigPage.texts.fields.visible')}
            </Label>
            <Switch id="bc-new-text-visible" checked={visible} onCheckedChange={setVisible} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('botConfigPage.texts.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit || createMutation.isPending}>
            {t('botConfigPage.texts.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
