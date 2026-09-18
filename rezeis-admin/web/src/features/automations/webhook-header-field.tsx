import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { isSavedHeaderReference, referenceShifted, urlChanged, type SavedHeaderReference } from './saved-header'

/**
 * The `Authorization` header of a «POST webhook» action, which is write-only
 * (see `saved-header.ts`).
 *
 * Three states, each read off the value itself so nothing here has to survive
 * the action list being re-ordered around it:
 *
 *   saved     the panel's reference — «Заменить» and «Удалить»; saving
 *             untouched sends the reference back and keeps the header;
 *   new       a string the operator typed (or a template put in) — an input
 *             bound to it, and «Удалить»;
 *   none      null or absent — «Задать» starts a new one.
 *
 * The one piece of local state — a replacement being typed over a saved
 * header — lives in `SavedHeader`, which is keyed by the reference, so it
 * follows the header rather than a position in the list.
 */
export function WebhookHeaderField({
  id,
  value,
  position,
  url,
  savedUrl,
  disabled,
  onChange,
}: {
  id: string
  value: unknown
  /** Where the action sits in the list now: a kept header belongs to the place it was saved at. */
  position: number
  /** The action's URL as it will be saved. */
  url: unknown
  /** The URL saved on the action the reference names; the header is bound to it exactly. */
  savedUrl: unknown
  disabled: boolean
  onChange: (next: string | SavedHeaderReference | null) => void
}) {
  const { t } = useTranslation()
  const label = t('automationsPage.actions.header.label')

  if (isSavedHeaderReference(value)) {
    return (
      <SavedHeader
        key={`saved-${value.index}`}
        id={id}
        label={label}
        shifted={referenceShifted(value, position)}
        moved={urlChanged(url, savedUrl)}
        disabled={disabled}
        onChange={onChange}
      />
    )
  }

  if (typeof value === 'string') {
    return (
      <div className="space-y-1.5">
        <label htmlFor={id} className="text-xs font-medium">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={t('automationsPage.actions.header.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            disabled={disabled}
          />
          <Button type="button" size="sm" variant="outline" onClick={() => onChange(null)} disabled={disabled}>
            {t('automationsPage.actions.header.remove')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2">
      <span className="text-xs text-muted-foreground">{t('automationsPage.actions.header.none')}</span>
      <Button type="button" size="sm" variant="outline" onClick={() => onChange('')} disabled={disabled}>
        {t('automationsPage.actions.header.set')}
      </Button>
    </div>
  )
}

function SavedHeader({
  id,
  label,
  shifted,
  moved,
  disabled,
  onChange,
}: {
  id: string
  label: string
  shifted: boolean
  moved: boolean
  disabled: boolean
  onChange: (next: string | SavedHeaderReference | null) => void
}) {
  const { t } = useTranslation()
  // A replacement is typed here and handed over only on «Применить»: until
  // then the value stays the reference, so a half-typed or abandoned
  // replacement can never cost the saved header.
  const [replacing, setReplacing] = useState(false)
  const [typed, setTyped] = useState('')

  return (
    <div className="space-y-1.5 rounded-md border px-3 py-2">
      <p className="text-xs font-medium">{label}</p>
      {replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={id}
            aria-label={t('automationsPage.actions.header.newValueAria')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={t('automationsPage.actions.header.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="min-w-[12rem] flex-1 font-mono text-xs"
            disabled={disabled}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => onChange(typed)}
            disabled={disabled || typed.trim().length === 0}
          >
            {t('automationsPage.actions.header.apply')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setReplacing(false)
              setTyped('')
            }}
            disabled={disabled}
          >
            {t('automationsPage.actions.header.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t('automationsPage.actions.header.saved')}</span>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setReplacing(true)} disabled={disabled}>
              {t('automationsPage.actions.header.replace')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => onChange(null)} disabled={disabled}>
              {t('automationsPage.actions.header.remove')}
            </Button>
          </div>
        </div>
      )}
      {shifted ? (
        <p className="text-xs text-destructive">{t('automationsPage.actions.header.shifted')}</p>
      ) : (
        moved && <p className="text-xs text-destructive">{t('automationsPage.actions.header.moved')}</p>
      )}
    </div>
  )
}
