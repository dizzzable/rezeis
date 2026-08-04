import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import type { LandingConfig, LocalizedText } from './landing-builder-api'
import { dropLocale, seedLocale } from './locale-seeding'

/**
 * SettingsPanel — the page-level fields that live outside any section.
 *
 * `meta.title` / `meta.description` / `ogImage` / `locales` / `defaultLocale`
 * and the theme font family were all reachable only by hand-editing the raw
 * JSON tab, which meant the landing's SEO — the part that decides how the page
 * appears in search results and link previews — was effectively unmanaged.
 *
 * The locale list is the sharp edge here: it drives publish-strict (every
 * visible string must be filled for every configured locale), so adding one
 * retroactively blocks publishing until the new language is translated, and
 * removing one throws that translation away. Both actions are therefore
 * explicit and warned about rather than silently applied.
 */

/** Locale codes offered for adding. ISO-639-1, two letters, per the schema. */
const OFFERED_LOCALES = ['ru', 'en', 'de', 'es', 'fr', 'it', 'pt', 'pl', 'tr', 'uk', 'zh'] as const

interface Props {
  config: LandingConfig
  /**
   * `mergeKey` identifies the field being typed into, so a run of keystrokes
   * collapses into one undo step. Omit it for discrete actions (adding a
   * locale, picking from a list) — those deserve a step of their own. Without
   * it a 120-character meta description is 120 steps and evicts the rest of a
   * 100-entry history, including a section deletion the operator meant to undo.
   */
  onChange: (next: LandingConfig, mergeKey?: string) => void
}

export function SettingsPanel({ config, onChange }: Props) {
  const { t } = useTranslation()
  const locales = config.locales
  /**
   * `meta` is read defensively because the config reaching this panel is not
   * always one the builder produced: a JSON import, a rolled-back revision or a
   * draft written by an older schema can arrive without it. Reading
   * `config.meta.title[locale]` straight through threw during render, and the
   * route error boundary then replaced the whole page — so the operator lost
   * the tab they opened precisely to repair the missing field, with a reload as
   * the only way back. Pre-flight rejects this shape now too; this stays because
   * pre-flight is not the only door into the component.
   */
  const meta = {
    title: config.meta?.title ?? {},
    description: config.meta?.description ?? {},
  }

  const label = (key: string): string =>
    t(`landingBuilderPage.settings.${key}`, { defaultValue: key })

  const setLocalized = (field: 'title' | 'description', locale: string, value: string): void =>
    onChange(
      {
        ...config,
        meta: { ...meta, [field]: { ...meta[field], [locale]: value } },
      },
      `settings:meta.${field}.${locale}`,
    )

  const addLocale = (locale: string): void => {
    if (locales.includes(locale)) return
    // Seed the new locale as an empty string everywhere a localized value
    // already exists, so the missing-translation badges point at real gaps
    // instead of at a key that simply does not exist yet.
    onChange({
      ...config,
      locales: [...locales, locale],
      meta: {
        title: { ...meta.title, [locale]: '' },
        description: { ...meta.description, [locale]: '' },
      },
      sections: config.sections.map((section) => ({
        ...section,
        data: seedLocale(section.data, locale) as Record<string, unknown>,
      })),
    })
  }

  const removeLocale = (locale: string): void => {
    if (locales.length <= 1) return
    const next = locales.filter((l) => l !== locale)
    // Take the text out with the language. Text left under a code that is no
    // longer in `locales` is not inert: publish-strict reads "is this field in
    // use" from `config.locales`, so a field written ONLY in the removed
    // language reads as an optional field nobody filled and publish goes
    // through — and the renderer's last-resort fallback then prints that orphan
    // on a page in a language nothing claims it is.
    onChange({
      ...config,
      locales: next,
      // The default must stay inside the list or every localized field renders
      // against a language nothing writes.
      defaultLocale: config.defaultLocale === locale ? next[0] : config.defaultLocale,
      meta: {
        title: dropLocale(meta.title, locale) as LocalizedText,
        description: dropLocale(meta.description, locale) as LocalizedText,
      },
      sections: config.sections.map((section) => ({
        ...section,
        data: dropLocale(section.data, locale) as Record<string, unknown>,
      })),
    })
  }

  return (
    <Card>
      <CardContent className="space-y-5 pt-4">
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{label('seoTitle')}</h3>
          <p className="text-xs text-muted-foreground">{label('seoHint')}</p>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{label('metaTitle')}</Label>
            {locales.map((locale) => (
              <div key={locale} className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-xs font-medium text-muted-foreground uppercase">
                  {locale}
                </span>
                <Input
                  value={meta.title[locale] ?? ''}
                  onChange={(e) => setLocalized('title', locale, e.target.value)}
                  aria-label={`${label('metaTitle')} (${locale})`}
                />
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{label('metaDescription')}</Label>
            {locales.map((locale) => (
              <div key={locale} className="flex items-start gap-2">
                <span className="mt-2 w-6 shrink-0 text-xs font-medium text-muted-foreground uppercase">
                  {locale}
                </span>
                <Textarea
                  rows={2}
                  value={meta.description[locale] ?? ''}
                  onChange={(e) => setLocalized('description', locale, e.target.value)}
                  aria-label={`${label('metaDescription')} (${locale})`}
                />
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{label('ogImage')}</Label>
            <Input
              value={config.ogImage ?? ''}
              placeholder="https://…"
              onChange={(e) => onChange({ ...config, ogImage: e.target.value }, 'settings:ogImage')}
              aria-label={label('ogImage')}
            />
            <p className="text-xs text-muted-foreground">{label('ogImageHint')}</p>
          </div>
        </section>

        <section className="space-y-3 border-t border-border/60 pt-4">
          <h3 className="text-sm font-medium">{label('localesTitle')}</h3>
          <p className="text-xs text-muted-foreground">{label('localesHint')}</p>

          <div className="flex flex-wrap items-center gap-2">
            {locales.map((locale) => (
              <span
                key={locale}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs uppercase"
              >
                {locale}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  disabled={locales.length <= 1}
                  aria-label={`${label('removeLocale')} ${locale}`}
                  onClick={() => removeLocale(locale)}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </Button>
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Select value="" onValueChange={addLocale}>
              <SelectTrigger className="w-40" aria-label={label('addLocale')}>
                <SelectValue placeholder={label('addLocale')} />
              </SelectTrigger>
              <SelectContent>
                {OFFERED_LOCALES.filter((l) => !locales.includes(l)).map((locale) => (
                  <SelectItem key={locale} value={locale}>
                    {locale.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{label('defaultLocale')}</Label>
            <Select
              value={config.defaultLocale}
              onValueChange={(value) => onChange({ ...config, defaultLocale: value })}
            >
              <SelectTrigger className="w-40" aria-label={label('defaultLocale')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {locales.map((locale) => (
                  <SelectItem key={locale} value={locale}>
                    {locale.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{label('defaultLocaleHint')}</p>
          </div>
        </section>

        <section className="space-y-2 border-t border-border/60 pt-4">
          <h3 className="text-sm font-medium">{label('typographyTitle')}</h3>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{label('fontFamily')}</Label>
            <Input
              value={config.theme.font?.family ?? ''}
              placeholder="Inter, system-ui, sans-serif"
              onChange={(e) =>
                onChange(
                  {
                    ...config,
                    theme: { ...config.theme, font: { family: e.target.value } },
                  },
                  'settings:font.family',
                )
              }
              aria-label={label('fontFamily')}
            />
            <p className="text-xs text-muted-foreground">{label('fontFamilyHint')}</p>
          </div>
        </section>
      </CardContent>
    </Card>
  )
}

