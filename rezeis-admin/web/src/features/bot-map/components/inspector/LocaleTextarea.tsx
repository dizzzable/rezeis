/**
 * LocaleTextarea — RU/EN side-by-side textarea pair for inspector
 * editors. Captures the same blur-save flow used by the legacy graph
 * editor so an operator never has to press a save button to persist a
 * copy edit. Empty EN value is allowed (server falls back to RU).
 *
 * Both halves draw their `:slug:` tokens through `EmojiFieldOverlay`, so the
 * operator reads the copy the way Telegram will draw it instead of
 * `:tg_ios_macos_icons_25:`. The layer is a view only — what is typed is what
 * `onSave` hands upstream, byte for byte; see that module for why it steps
 * aside while the field has focus.
 *
 * Every caller of this component edits BOT COPY, not a button caption
 * (`GraphScreenEditor` → screen text, `NotificationEditor` → notification
 * title and body), so `mode` stays the default `text` and is not a prop. A
 * caller that ever feeds an inline-button caption in here needs
 * `mode="buttonLabel"` instead — a caption's leading token is lifted into
 * `icon_custom_emoji_id` and never stays in the string — and that is the point
 * to lift the mode into a prop rather than let this one lie.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { EmojiFieldOverlay } from '@/features/custom-emoji/emoji-field-overlay'

import { insertAtCaret } from '../../utils/insert-at-caret'

interface LocaleTextareaProps {
  readonly labelRu: string
  readonly labelEn: string
  readonly placeholderRu?: string
  readonly placeholderEn?: string
  readonly valueRu: string
  readonly valueEn: string
  readonly rows?: number
  readonly onSave: (next: { readonly ru?: string; readonly en?: string | null }) => void
  readonly disabled?: boolean
}

export function LocaleTextarea({
  labelRu,
  labelEn,
  placeholderRu,
  placeholderEn,
  valueRu,
  valueEn,
  rows = 4,
  onSave,
  disabled,
}: LocaleTextareaProps) {
  const { t } = useTranslation()
  const ruId = useId()
  const enId = useId()
  const ruRef = useRef<HTMLTextAreaElement>(null)
  const enRef = useRef<HTMLTextAreaElement>(null)

  // Mirror the props into local state so the operator sees their typing
  // immediately. Sync back when the canonical values change (a refetch
  // landed) and the local state still matches the previous canonical
  // values — keeps an in-flight edit from being yanked.
  const [localRu, setLocalRu] = useState(valueRu)
  const [localEn, setLocalEn] = useState(valueEn)
  const lastSyncedRu = useRef(valueRu)
  const lastSyncedEn = useRef(valueEn)
  useEffect(() => {
    if (lastSyncedRu.current !== valueRu && localRu === lastSyncedRu.current) {
      setLocalRu(valueRu)
    }
    lastSyncedRu.current = valueRu
  }, [valueRu, localRu])
  useEffect(() => {
    if (lastSyncedEn.current !== valueEn && localEn === lastSyncedEn.current) {
      setLocalEn(valueEn)
    }
    lastSyncedEn.current = valueEn
  }, [valueEn, localEn])
  const handleBlurRu = () => {
    if (localRu === valueRu) return
    onSave({ ru: localRu })
  }
  const handleBlurEn = () => {
    if (localEn === valueEn) return
    // Send `null` to clear the override (fall back to RU at delivery).
    onSave({ en: localEn.length === 0 ? null : localEn })
  }

  // Emoji picker → splice at the caret and persist immediately (the picker is
  // an explicit action, so we don't wait for a blur to save).
  const insertRu = (emoji: string) => {
    const el = ruRef.current
    const start = el?.selectionStart ?? localRu.length
    const end = el?.selectionEnd ?? localRu.length
    const { value: next, caret } = insertAtCaret(localRu, start, end, emoji)
    setLocalRu(next)
    onSave({ ru: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }
  const insertEn = (emoji: string) => {
    const el = enRef.current
    const start = el?.selectionStart ?? localEn.length
    const end = el?.selectionEnd ?? localEn.length
    const { value: next, caret } = insertAtCaret(localEn, start, end, emoji)
    setLocalEn(next)
    onSave({ en: next.length === 0 ? null : next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={ruId} className="text-xs">
            {labelRu}
          </Label>
          <EmojiPicker onSelect={insertRu} ariaLabel={t('botMapPage.inspector.emojiAria')} />
        </div>
        {/* The picker sits in the label row above, not over the field, so it
            needs no `adornment` slot — nothing is positioned against the box
            the layer covers.

            `disabled` goes to the layer as well as to the field: the layer
            paints an opaque background over the control, so a field left to dim
            alone through `disabled:opacity-50` is dimmed underneath something
            at full strength. Every caller here disables mid-save, and this pair
            saves ON BLUR — the exact moment the layer is back up. */}
        <EmojiFieldOverlay
          value={localRu}
          multiline
          overlayClassName="font-mono text-sm"
          disabled={disabled}
        >
          <Textarea
            id={ruId}
            ref={ruRef}
            rows={rows}
            value={localRu}
            onChange={(e) => setLocalRu(e.target.value)}
            onBlur={handleBlurRu}
            placeholder={placeholderRu}
            disabled={disabled}
            className="font-mono text-sm"
          />
        </EmojiFieldOverlay>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={enId} className="text-xs">
            {labelEn}
          </Label>
          <EmojiPicker onSelect={insertEn} ariaLabel={t('botMapPage.inspector.emojiAria')} />
        </div>
        <EmojiFieldOverlay
          value={localEn}
          multiline
          overlayClassName="font-mono text-sm"
          disabled={disabled}
        >
          <Textarea
            id={enId}
            ref={enRef}
            rows={rows}
            value={localEn}
            onChange={(e) => setLocalEn(e.target.value)}
            onBlur={handleBlurEn}
            placeholder={placeholderEn}
            disabled={disabled}
            className="font-mono text-sm"
          />
        </EmojiFieldOverlay>
        {localEn.length === 0 && (
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t('botMapPage.inspector.enFallback')}
          </p>
        )}
      </div>
    </div>
  )
}
