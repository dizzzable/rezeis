/**
 * AppBackgroundSection — configurator for the site-wide reiwa cabinet
 * background. Four modes:
 *   - none     — plain colour (the brand background).
 *   - gradient — static CSS gradient (presets + visual builder + generate).
 *   - texture  — static tiled SVG pattern (picker + colours + scale + opacity).
 *   - effect   — animated ReactBits effect (reuses the card-effect picker).
 *
 * Fully controlled via a single `value`/`onChange` pair mirroring the
 * `appBackground` branding draft.
 */

import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'

import { CardEffectPicker } from './card-effect-section'
import { GradientBuilder } from './gradient-builder'
import { CARD_GRADIENT_PRESETS, gradientFromPrimary } from './theme-presets'
import { APP_BG_TEXTURE_PATTERNS, buildTextureCss } from './app-texture'
import {
  BRANDING_APP_BG_KINDS,
  type BrandingAppBackgroundDraft,
} from './branding-form-schema'

interface AppBackgroundSectionProps {
  value: BrandingAppBackgroundDraft
  primary: string
  bgPrimary: string
  onChange: (value: BrandingAppBackgroundDraft) => void
}

export function AppBackgroundSection({
  value,
  primary,
  bgPrimary,
  onChange,
}: AppBackgroundSectionProps) {
  const { t } = useTranslation()
  const set = (patch: Partial<BrandingAppBackgroundDraft>) => onChange({ ...value, ...patch })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('brandingPage.sections.appBackground.title')}</CardTitle>
        <CardDescription>{t('brandingPage.sections.appBackground.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode tabs */}
        <div className="grid grid-cols-4 gap-2">
          {BRANDING_APP_BG_KINDS.map((kind) => {
            const active = value.kind === kind
            return (
              <button
                key={kind}
                type="button"
                onClick={() => set({ kind })}
                className={`relative rounded-lg border px-2 py-2 text-xs font-medium transition-all hover:scale-[1.02] ${
                  active ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/40'
                }`}
              >
                {t(`brandingPage.sections.appBackground.kinds.${kind}`)}
                {active && (
                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {value.kind === 'none' && (
          <p className="text-[11px] text-muted-foreground">
            {t('brandingPage.sections.appBackground.noneHint')}
          </p>
        )}

        {value.kind === 'gradient' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t('brandingPage.sections.appBackground.gradient')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => set({ gradient: gradientFromPrimary(primary) })}
              >
                {t('brandingPage.sections.appBackground.generateFromPrimary')}
              </Button>
            </div>
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
              {CARD_GRADIENT_PRESETS.map((preset) => {
                const active = value.gradient.trim().toLowerCase() === preset.value.toLowerCase()
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-label={t(`brandingPage.cardGradients.${preset.id}`)}
                    title={t(`brandingPage.cardGradients.${preset.id}`)}
                    onClick={() => set({ gradient: preset.value })}
                    className={`relative aspect-square rounded-lg ring-1 transition-all hover:scale-[1.06] ${
                      active ? 'ring-2 ring-primary' : 'ring-white/10 hover:ring-primary/40'
                    }`}
                    style={{ backgroundImage: preset.value }}
                  />
                )
              })}
            </div>
            <div className="h-16 w-full rounded-md ring-1 ring-border" style={{ background: value.gradient }} />
            <GradientBuilder value={value.gradient} onChange={(css) => set({ gradient: css })} />
            <Input
              value={value.gradient}
              onChange={(e) => set({ gradient: e.target.value })}
              className="font-mono text-xs"
              placeholder="linear-gradient(...)"
            />
          </div>
        )}

        {value.kind === 'texture' && (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {APP_BG_TEXTURE_PATTERNS.map((pattern) => {
                const active = value.texture.pattern === pattern
                const css = buildTextureCss({ ...value.texture, pattern })
                return (
                  <button
                    key={pattern}
                    type="button"
                    aria-label={t(`brandingPage.sections.appBackground.textures.${pattern}`)}
                    title={t(`brandingPage.sections.appBackground.textures.${pattern}`)}
                    onClick={() => set({ texture: { ...value.texture, pattern } })}
                    className={`relative aspect-square rounded-lg ring-1 transition-all hover:scale-[1.06] ${
                      active ? 'ring-2 ring-primary' : 'ring-white/10 hover:ring-primary/40'
                    }`}
                    style={{
                      backgroundColor: css.backgroundColor,
                      backgroundImage: css.backgroundImage,
                      backgroundSize: css.backgroundSize,
                    }}
                  />
                )
              })}
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-xs">{t('brandingPage.sections.appBackground.autoPick')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  set({ texture: { ...value.texture, color: primary, background: bgPrimary } })
                }
              >
                {t('brandingPage.sections.appBackground.applyBrandColors')}
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <TextureColor
                label={t('brandingPage.sections.appBackground.textureColor')}
                value={value.texture.color}
                onChange={(c) => set({ texture: { ...value.texture, color: c } })}
              />
              <TextureColor
                label={t('brandingPage.sections.appBackground.textureBackground')}
                value={value.texture.background}
                onChange={(c) => set({ texture: { ...value.texture, background: c } })}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t('brandingPage.sections.appBackground.scale')}</Label>
                <span className="font-mono text-[10px] text-muted-foreground">{value.texture.scale}px</span>
              </div>
              <Slider
                value={[value.texture.scale]}
                min={8}
                max={120}
                step={2}
                onValueChange={(v: number[]) =>
                  set({ texture: { ...value.texture, scale: v[0] ?? value.texture.scale } })
                }
                aria-label={t('brandingPage.sections.appBackground.scale')}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t('brandingPage.sections.appBackground.opacity')}</Label>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {(value.texture.opacity * 100).toFixed(0)}%
                </span>
              </div>
              <Slider
                value={[value.texture.opacity]}
                min={0.05}
                max={1}
                step={0.05}
                onValueChange={(v: number[]) =>
                  set({ texture: { ...value.texture, opacity: v[0] ?? value.texture.opacity } })
                }
                aria-label={t('brandingPage.sections.appBackground.opacity')}
              />
            </div>

            <div
              className="h-24 w-full rounded-md ring-1 ring-border"
              style={{
                backgroundColor: buildTextureCss(value.texture).backgroundColor,
                backgroundImage: buildTextureCss(value.texture).backgroundImage,
                backgroundSize: buildTextureCss(value.texture).backgroundSize,
              }}
            />
          </div>
        )}

        {value.kind === 'effect' && (
          <CardEffectPicker
            effect={value.effect}
            props={value.props}
            opacity={value.opacity}
            onEffectChange={(e) => set({ effect: e, props: e === 'NONE' ? {} : value.props })}
            onPropsChange={(p) => set({ props: p })}
            onOpacityChange={(o) => set({ opacity: o })}
          />
        )}
      </CardContent>
    </Card>
  )
}

function TextureColor({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border"
          aria-label={label}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />
      </div>
    </div>
  )
}
