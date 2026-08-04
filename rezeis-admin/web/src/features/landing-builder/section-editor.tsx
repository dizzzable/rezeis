import { useTranslation } from 'react-i18next'
import { Trash2, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import type { LandingSection } from './landing-builder-api'
import { newArrayItem } from './section-defaults'

/**
 * Known enum fields → allowed options. Rendered as a dropdown instead of a raw
 * text input so the operator can actually pick values (e.g. hero alignment
 * left/center, pricing source, CTA action) without guessing the string.
 */
const ENUM_OPTIONS: Record<string, readonly (string | number)[]> = {
  align: ['left', 'center'],
  columns: [2, 3, 4],
  source: ['catalog', 'static'],
  style: ['solid', 'gradient', 'outline'],
  currency: ['RUB', 'USD', 'EUR'],
  action: ['register', 'login', 'url'],
  platform: ['telegram', 'x', 'github', 'youtube', 'instagram', 'vk', 'email'],
  icon: [
    'shield', 'lock', 'zap', 'globe', 'server', 'wifi', 'eye-off', 'key', 'check',
    'star', 'rocket', 'users', 'clock', 'download', 'smartphone', 'gauge', 'heart',
    'award', 'refresh', 'help-circle',
  ],
}

/**
 * SectionEditor — a data-driven recursive editor over a section's `data`.
 *
 * Rather than 10 bespoke forms, it introspects the value shape and renders the
 * right control: localized-text (one input per configured locale with a
 * missing badge), string, number, boolean, arrays (add/remove + recurse), and
 * nested objects. Known keys get friendly i18n labels; unknown keys fall back
 * to the raw key. Every mutation produces a new immutable `data` object passed
 * up via `onChange`.
 */
interface Props {
  section: LandingSection
  locales: readonly string[]
  editorLocale: string
  /**
   * `path` is the field that changed, used upstream as the undo merge key so a
   * run of keystrokes in one input collapses into a single undo step. It is
   * omitted for structural array edits (add/remove item), which must each be
   * their own step.
   */
  onChange: (data: Record<string, unknown>, path?: readonly (string | number)[]) => void
}

function isLocalized(node: unknown): node is Record<string, string> {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
  const keys = Object.keys(node)
  return keys.length > 0 && keys.every((k) => /^[a-z]{2}$/.test(k))
}

function looksLocalizedKey(key: string): boolean {
  return /heading|subheading|eyebrow|body|label|title|question|answer|author|role|quote|legal|alt|badge|name|description|features/i.test(
    key,
  )
}

export function SectionEditor({ section, locales, editorLocale, onChange }: Props) {
  const { t } = useTranslation()

  const setAtPath = (
    path: Array<string | number>,
    value: unknown,
    options?: { structural?: boolean },
  ): void => {
    const root = structuredClone(section.data) as Record<string, unknown>
    let node: Record<string, unknown> | unknown[] = root
    for (let i = 0; i < path.length - 1; i += 1) {
      node = (node as Record<string, unknown>)[path[i] as string] as Record<string, unknown> | unknown[]
    }
    const last = path[path.length - 1]
    if (Array.isArray(node)) (node as unknown[])[last as number] = value
    else (node as Record<string, unknown>)[last as string] = value
    onChange(root, options?.structural === true ? undefined : path)
  }

  const fieldLabel = (key: string): string => t(`landingBuilderPage.fields.${key}`, { defaultValue: key })

  const renderValue = (value: unknown, path: Array<string | number>, key: string): React.ReactNode => {
    // Localized text — one input per configured locale (show editor locale first).
    if (isLocalized(value) || (looksLocalizedKey(key) && value !== null && typeof value === 'object' && !Array.isArray(value))) {
      const map = value as Record<string, string>
      // `editorLocale` follows the preview dropdown, which is not reconciled
      // when the locale list changes — it can still name a language removed a
      // tab ago. An input rendered for it writes text under a code that is not
      // in `config.locales`, and autosave persists that orphan: the operator
      // cannot see it (no other input is rendered for it), publish-strict does
      // not count it (it reads `config.locales`), and the renderer's last-resort
      // fallback prints it. `locales` is therefore the whole rendered set, which
      // also keeps the missing-translation badge below off a dead language.
      const ordered = locales.includes(editorLocale)
        ? [editorLocale, ...locales.filter((l) => l !== editorLocale)]
        : locales
      return (
        <div className="space-y-1.5">
          {ordered.map((locale) => {
            const v = typeof map[locale] === 'string' ? map[locale] : ''
            const missing = v.trim().length === 0
            return (
              <div key={locale} className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-xs font-medium text-muted-foreground uppercase">{locale}</span>
                <Input
                  value={v}
                  onChange={(e) => setAtPath([...path, locale], e.target.value)}
                  aria-label={`${fieldLabel(key)} (${locale})`}
                />
                {missing && (
                  <Badge variant="outline" className="shrink-0 text-[10px] text-amber-500">
                    {t('landingBuilderPage.sectionList.missingTranslation', { locale })}
                  </Badge>
                )}
              </div>
            )
          })}
        </div>
      )
    }

    if (typeof value === 'boolean') {
      return (
        <Switch
          checked={value}
          onCheckedChange={(checked) => setAtPath(path, checked)}
          aria-label={fieldLabel(key)}
        />
      )
    }

    if (typeof value === 'number' && !ENUM_OPTIONS[key]) {
      return (
        <Input
          type="number"
          value={value}
          onChange={(e) => setAtPath(path, Number(e.target.value))}
          aria-label={fieldLabel(key)}
        />
      )
    }

    // Enum field → dropdown (align, columns, source, style, currency, action, …).
    if ((typeof value === 'string' || typeof value === 'number') && ENUM_OPTIONS[key]) {
      const options = ENUM_OPTIONS[key]
      return (
        <Select
          value={String(value)}
          onValueChange={(v) => {
            const asNumber = options.every((o) => typeof o === 'number')
            setAtPath(path, asNumber ? Number(v) : v)
          }}
        >
          <SelectTrigger aria-label={fieldLabel(key)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={String(opt)} value={String(opt)}>
                {t(`landingBuilderPage.enums.${key}.${opt}`, { defaultValue: String(opt) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }

    if (typeof value === 'string') {
      const isLong = key === 'answer' || key === 'body'
      return isLong ? (
        <Textarea
          value={value}
          onChange={(e) => setAtPath(path, e.target.value)}
          aria-label={fieldLabel(key)}
          rows={3}
        />
      ) : (
        <Input value={value} onChange={(e) => setAtPath(path, e.target.value)} aria-label={fieldLabel(key)} />
      )
    }

    if (Array.isArray(value)) {
      return (
        <div className="space-y-2 rounded-md border border-border/60 p-2">
          {value.map((item, index) => (
            <div key={index} className="space-y-2 rounded-md bg-muted/30 p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">#{index + 1}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('landingBuilderPage.fields.removeItem')}
                  onClick={() => {
                    const next = value.filter((_, i) => i !== index)
                    setAtPath(path, next, { structural: true })
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              {renderValue(item, [...path, index], key)}
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setAtPath(path, [...value, newArrayItem(key, locales, value)], { structural: true })
            }
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            {t('landingBuilderPage.fields.addItem')}
          </Button>
        </div>
      )
    }

    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      // A CTA's `url` is only meaningful when action === 'url' — hide it
      // otherwise to keep the form clean (the key stays in data, seeded blank).
      const isUrlAction = obj['action'] === 'url'
      // Show a `url` field when the CTA action is `url` even if the key is
      // absent (e.g. templates seed CTAs without it) — writing seeds the key.
      const needsSyntheticUrl = isUrlAction && !('url' in obj)
      return (
        <div className="space-y-3 rounded-md border border-border/60 p-3">
          {Object.entries(obj)
            .filter(([childKey]) => !(childKey === 'url' && 'action' in obj && !isUrlAction))
            .map(([childKey, childValue]) => (
              <div key={childKey} className="space-y-1">
                <Label className="text-xs text-muted-foreground">{fieldLabel(childKey)}</Label>
                {renderValue(childValue, [...path, childKey], childKey)}
              </div>
            ))}
          {needsSyntheticUrl && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{fieldLabel('url')}</Label>
              <Input
                value=""
                placeholder="https://…"
                onChange={(e) => setAtPath([...path, 'url'], e.target.value)}
                aria-label={fieldLabel('url')}
              />
            </div>
          )}
        </div>
      )
    }

    return null
  }

  // `staticPlans` only drives the render when `source === 'static'`; showing the
  // list under the catalog source would invite the operator to fill in plans
  // that the page will never display. The key stays in data, seeded empty, so
  // flipping the source reveals a working list (mirrors the CTA `url` rule).
  const hiddenForSource = (key: string): boolean =>
    key === 'staticPlans' && (section.data as Record<string, unknown>)['source'] !== 'static'

  return (
    <div className="space-y-3">
      {Object.entries(section.data)
        .filter(([key]) => !hiddenForSource(key))
        .map(([key, value]) => (
          <div key={key} className="space-y-1">
            <Label className="text-sm font-medium">{fieldLabel(key)}</Label>
            {renderValue(value, [key], key)}
          </div>
        ))}
    </div>
  )
}


