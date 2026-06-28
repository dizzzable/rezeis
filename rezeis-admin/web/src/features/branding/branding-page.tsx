/**
 * WEB Reiwa — visual configurator for the user-facing reiwa cabinet.
 *
 * Operators skin the whole cabinet here, organized into category tabs (Brand /
 * Colors / Subscription card / App background / Menu icons / Tariff cards) with
 * a sticky live phone-frame preview on the right. Each tab keeps the SAME form
 * state and a single Save/Reset action — switching tabs only changes which
 * sections are visible, never the dirty/submit lifecycle.
 *
 * Persists through `GET/PATCH /admin/settings/branding`, which feeds the reiwa
 * SPA via the internal `public-config` endpoint.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, Controller, type Resolver, type UseFormReturn } from "react-hook-form";
import { useTranslation } from 'react-i18next';
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Paintbrush, RotateCcw, Save, Sparkles, Upload, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { BrandingPreview } from "./branding-preview";
import { CARD_LOGO_PRESETS, CardLogoMark, type CardLogoPreset } from "./card-logo-mark";
import {
  createBrandingFormSchema,
  createInitialBrandingDraft,
  DEFAULT_APP_BACKGROUND_DRAFT,
  type BrandingFormData,
  type BrandingFormDraft,
  type BrandingFormValidationMessages,
  type PlanCardStyleDraft,
} from "./branding-form-schema";
import { CardEffectSection } from "./card-effect-section";
import { AppBackgroundSection } from "./app-background-section";
import { CardEffectSlotsSection, type CardEffectSlot } from "./card-effect-slots-section";
import { GradientBuilder } from "./gradient-builder";
import { IconColorsSection } from "./icon-colors-section";
import { PlanCardStylesSection } from "./plan-card-styles-section";
import { FONT_OPTIONS, THEME_PRESETS, CARD_GRADIENT_PRESETS, gradientFromPrimary, type ThemePreset } from "./theme-presets";

// ── Schema ──────────────────────────────────────────────────────────────────

const BORDER_RADIUS_VALUES = [
  { value: "rounded-none", labelKey: "brandingPage.radiusOptions.none" },
  { value: "rounded-lg", labelKey: "brandingPage.radiusOptions.lg" },
  { value: "rounded-xl", labelKey: "brandingPage.radiusOptions.xl" },
  { value: "rounded-2xl", labelKey: "brandingPage.radiusOptions.2xl" },
  { value: "rounded-3xl", labelKey: "brandingPage.radiusOptions.3xl" },
  { value: "rounded-full", labelKey: "brandingPage.radiusOptions.full" },
] as const;

/** Configurator tabs (category grouping). */
const BRANDING_TABS = ['brand', 'colors', 'card', 'appbg', 'icons', 'planCards'] as const;
type BrandingTab = (typeof BRANDING_TABS)[number];

// ── API ─────────────────────────────────────────────────────────────────────

async function fetchBranding(): Promise<BrandingFormDraft> {
  const { data } = await api.get<Partial<BrandingFormDraft>>("/admin/settings/branding");
  return createInitialBrandingDraft(data);
}

async function updateBranding(values: BrandingFormData): Promise<BrandingFormDraft> {
  const { data } = await api.patch<Partial<BrandingFormDraft>>("/admin/settings/branding", values);
  return createInitialBrandingDraft(data);
}

/** Upload a branding asset (logo / PWA icon) → returns its `/uploads/branding/...` URL. */
async function uploadBrandingAsset(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<{ url: string }>("/admin/settings/branding/logo-upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data.url;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function WebReiwaPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<BrandingTab>('brand');
  const validationMessages = useMemo<BrandingFormValidationMessages>(() => ({
    hexInvalid: t('brandingPage.invalidHex'),
    imageUrlInvalid: t('brandingPage.invalidImageUrl'),
  }), [t]);
  const brandingSchema = useMemo(
    () => createBrandingFormSchema(validationMessages),
    [validationMessages],
  );

  const { data: branding, isLoading } = useQuery({
    queryKey: ["admin", "branding"],
    queryFn: fetchBranding,
    staleTime: 60_000,
  });

  const form = useForm<BrandingFormDraft, unknown, BrandingFormData>({
    resolver: zodResolver(brandingSchema) as Resolver<BrandingFormDraft, unknown, BrandingFormData>,
    defaultValues: createInitialBrandingDraft(),
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
  });

  useEffect(() => {
    if (branding) {
      form.reset(branding);
    }
  }, [branding, form]);

  const mutation = useMutation({
    mutationFn: updateBranding,
    onSuccess: (data) => {
      queryClient.setQueryData(["admin", "branding"], data);
      toast.success(t('brandingPage.saved'));
    },
    onError: () => toast.error(t('brandingPage.saveFailed')),
  });

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(values);
  });

  function applyPreset(preset: ThemePreset): void {
    form.setValue("primary", preset.primary, { shouldDirty: true });
    form.setValue("primaryFg", preset.primaryFg, { shouldDirty: true });
    form.setValue("bgPrimary", preset.bgPrimary, { shouldDirty: true });
    form.setValue("bgSecondary", preset.bgSecondary, { shouldDirty: true });
    form.setValue("cardGradient", preset.cardGradient, { shouldDirty: true });
    form.setValue("bgEffect", preset.bgEffect, { shouldDirty: true });
  }

  function generateGradient(): void {
    const primary = form.getValues("primary");
    form.setValue("cardGradient", gradientFromPrimary(primary), { shouldDirty: true });
  }

  // eslint-disable-next-line react-hooks/incompatible-library -- react-hook-form watch() pattern
  const watchedValues = form.watch();

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  /** Visibility gate for a tab's sections (kept mounted so the form/preview stay intact). */
  const gate = (id: BrandingTab): string => cn('space-y-6', tab !== id && 'hidden');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Paintbrush className="h-6 w-6" /> {t('brandingPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('brandingPage.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => form.reset(branding)}
            disabled={!form.formState.isDirty}
          >
            <RotateCcw className="mr-2 h-4 w-4" /> {t('brandingPage.reset')}
          </Button>
          <Button
            size="sm"
            onClick={onSubmit}
            disabled={mutation.isPending || !form.formState.isDirty}
          >
            <Save className="mr-2 h-4 w-4" />
            {mutation.isPending ? t('brandingPage.saving') : t('brandingPage.save')}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as BrandingTab)}>
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          {BRANDING_TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(`brandingPage.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {/* ── Brand tab ─────────────────────────────────────────────── */}
          <div className={gate('brand')}>
            {/* Theme presets — the headline "visual" control */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4" /> {t('brandingPage.sections.presets.title')}
                </CardTitle>
                <CardDescription>{t('brandingPage.sections.presets.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {THEME_PRESETS.map((preset) => {
                    const isActive = watchedValues.primary?.toLowerCase() === preset.primary.toLowerCase();
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        className={`group relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all hover:scale-[1.02] ${
                          isActive ? "border-primary ring-2 ring-primary/40" : "border-border hover:border-primary/40"
                        }`}
                      >
                        <div
                          className="h-12 w-full rounded-lg ring-1 ring-white/10"
                          style={{ backgroundImage: preset.cardGradient }}
                        />
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium">
                            {t(`brandingPage.presets.${preset.id}`)}
                          </span>
                          <span
                            className="h-3 w-3 rounded-full ring-1 ring-white/20"
                            style={{ backgroundColor: preset.primary }}
                          />
                        </div>
                        {isActive && (
                          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.identity.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.identity.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                  <div className="space-y-2">
                    <Label htmlFor="brandName">{t('brandingPage.sections.identity.brandName')}</Label>
                    <Input id="brandName" {...form.register("brandName")} placeholder={t('brandingPage.sections.identity.brandNamePlaceholder')} />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('brandingPage.sections.identity.logoPreview')}</Label>
                    <div className="flex h-9 items-center justify-center rounded-md border bg-muted/40 px-4">
                      {watchedValues.logoUrl ? (
                        <img src={watchedValues.logoUrl} alt="logo" className="h-6 w-6 object-contain" />
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('brandingPage.sections.identity.logoDefault')}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tagline">{t('brandingPage.sections.identity.tagline')}</Label>
                  <Input id="tagline" {...form.register("tagline")} placeholder={t('brandingPage.sections.identity.taglinePlaceholder')} />
                  <p className="text-[11px] text-muted-foreground">{t('brandingPage.sections.identity.taglineHint')}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="logoUrl">{t('brandingPage.sections.identity.logoUrl')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="logoUrl"
                      {...form.register("logoUrl")}
                      aria-invalid={!!form.formState.errors.logoUrl}
                      placeholder={t('brandingPage.sections.identity.logoUrlPlaceholder')}
                    />
                    <AssetUploadButton
                      accept="image/png,image/webp,image/svg+xml"
                      label={t('brandingPage.sections.identity.upload')}
                      onUploaded={(url) => form.setValue("logoUrl", url, { shouldDirty: true })}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t('brandingPage.sections.identity.logoHint')}</p>
                  <FieldError message={form.formState.errors.logoUrl?.message} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.pwaIcon.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.pwaIcon.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-muted/40">
                    {watchedValues.pwaIconUrl ?? watchedValues.logoUrl ? (
                      <img
                        src={(watchedValues.pwaIconUrl ?? watchedValues.logoUrl) as string}
                        alt="pwa icon"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="px-2 text-center text-[10px] text-muted-foreground">
                        {t('brandingPage.sections.pwaIcon.previewEmpty')}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="flex gap-2">
                      <Input
                        id="pwaIconUrl"
                        {...form.register("pwaIconUrl")}
                        aria-invalid={!!form.formState.errors.pwaIconUrl}
                        placeholder={t('brandingPage.sections.pwaIcon.urlPlaceholder')}
                      />
                      <AssetUploadButton
                        accept="image/png,image/webp"
                        label={t('brandingPage.sections.identity.upload')}
                        onUploaded={(url) => form.setValue("pwaIconUrl", url, { shouldDirty: true })}
                      />
                      {watchedValues.pwaIconUrl ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={t('brandingPage.sections.pwaIcon.remove')}
                          onClick={() => form.setValue("pwaIconUrl", null, { shouldDirty: true })}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t('brandingPage.sections.pwaIcon.hint')}</p>
                    <FieldError message={form.formState.errors.pwaIconUrl?.message} />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Colors & layout tab ───────────────────────────────────── */}
          <div className={gate('colors')}>
            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.colors.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.colors.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <ColorField label={t('brandingPage.sections.colors.primary')} name="primary" form={form} />
                  <ColorField label={t('brandingPage.sections.colors.primaryFg')} name="primaryFg" form={form} />
                  <ColorField label={t('brandingPage.sections.colors.background')} name="bgPrimary" form={form} />
                  <ColorField label={t('brandingPage.sections.colors.surface')} name="bgSecondary" form={form} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.effects.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.effects.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('brandingPage.sections.effects.borderRadius')}</Label>
                    <Controller
                      name="borderRadius"
                      control={form.control}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {BORDER_RADIUS_VALUES.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {t(r.labelKey)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('brandingPage.sections.effects.fontFamily')}</Label>
                    <Controller
                      name="fontFamily"
                      control={form.control}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FONT_OPTIONS.map((f) => (
                              <SelectItem key={f.id} value={f.value}>
                                <span style={{ fontFamily: f.value }}>
                                  {t(`brandingPage.fonts.${f.id}`)}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Subscription card tab ─────────────────────────────────── */}
          <div className={gate('card')}>
            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.card.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.card.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="cardGradient">{t('brandingPage.sections.card.gradient')}</Label>
                    <Button type="button" variant="ghost" size="sm" onClick={generateGradient}>
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                      {t('brandingPage.sections.card.generate')}
                    </Button>
                  </div>
                  {/* Preset swatches — one-click ready-made gradients */}
                  <Controller
                    name="cardGradient"
                    control={form.control}
                    render={({ field }) => (
                      <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
                        {CARD_GRADIENT_PRESETS.map((preset) => {
                          const isActive =
                            (field.value ?? "").trim().toLowerCase() ===
                            preset.value.toLowerCase();
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              aria-label={t(`brandingPage.cardGradients.${preset.id}`)}
                              title={t(`brandingPage.cardGradients.${preset.id}`)}
                              onClick={() => field.onChange(preset.value)}
                              className={`relative aspect-square rounded-lg ring-1 transition-all hover:scale-[1.06] ${
                                isActive ? "ring-2 ring-primary" : "ring-white/10 hover:ring-primary/40"
                              }`}
                              style={{ backgroundImage: preset.value }}
                            >
                              {isActive && (
                                <span className="absolute inset-0 flex items-center justify-center">
                                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-black/50 text-white">
                                    <Check className="h-2.5 w-2.5" />
                                  </span>
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  />
                  <div
                    className="h-10 w-full rounded-md ring-1 ring-border"
                    style={{ backgroundImage: watchedValues.cardGradient }}
                  />
                  {/* Visual gradient builder — angle + colour stops → CSS */}
                  <Controller
                    name="cardGradient"
                    control={form.control}
                    render={({ field }) => (
                      <GradientBuilder
                        value={field.value ?? ""}
                        onChange={(css) => field.onChange(css)}
                      />
                    )}
                  />
                  {/* Manual CSS field — controlled so it mirrors builder / preset
                      / generator edits live (stays in sync with form state). */}
                  <Controller
                    name="cardGradient"
                    control={form.control}
                    render={({ field }) => (
                      <Input
                        id="cardGradient"
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        className="font-mono text-xs"
                        placeholder={t('brandingPage.sections.card.gradientPlaceholder')}
                      />
                    )}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cardPattern">{t('brandingPage.sections.card.pattern')}</Label>
                  <Input
                    id="cardPattern"
                    {...form.register("cardPattern")}
                    className="font-mono text-xs"
                    placeholder={t('brandingPage.sections.card.patternPlaceholder')}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Card logo / watermark — preset glyphs + custom upload */}
            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.cardLogo.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.cardLogo.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Controller
                  name="cardLogo"
                  control={form.control}
                  render={({ field }) => (
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                      {CARD_LOGO_PRESETS.map((preset) => {
                        const isActive = field.value === preset && !watchedValues.cardLogoUrl;
                        return (
                          <button
                            key={preset}
                            type="button"
                            aria-label={t(`brandingPage.cardLogos.${preset}`)}
                            title={t(`brandingPage.cardLogos.${preset}`)}
                            onClick={() => {
                              field.onChange(preset);
                              form.setValue("cardLogoUrl", null, { shouldDirty: true });
                            }}
                            className={`relative flex aspect-square items-center justify-center rounded-xl border bg-muted/30 transition-all hover:scale-[1.04] ${
                              isActive ? "border-primary ring-2 ring-primary/40" : "border-border hover:border-primary/40"
                            }`}
                          >
                            {preset === "NONE" ? (
                              <span className="text-[10px] font-medium text-muted-foreground">
                                {t('brandingPage.cardLogos.NONE')}
                              </span>
                            ) : (
                              <CardLogoMark
                                preset={preset as CardLogoPreset}
                                className="h-6 w-6"
                                style={{ color: watchedValues.primary }}
                              />
                            )}
                            {isActive && (
                              <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="h-2.5 w-2.5" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                />
                <div className="space-y-2">
                  <Label htmlFor="cardLogoUrl">{t('brandingPage.sections.cardLogo.customUrl')}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="cardLogoUrl"
                      {...form.register("cardLogoUrl")}
                      aria-invalid={!!form.formState.errors.cardLogoUrl}
                      className="font-mono text-xs"
                      placeholder={t('brandingPage.sections.cardLogo.customUrlPlaceholder')}
                    />
                    {watchedValues.cardLogoUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => form.setValue("cardLogoUrl", null, { shouldDirty: true })}
                      >
                        {t('brandingPage.sections.cardLogo.clearCustom')}
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t('brandingPage.sections.cardLogo.customHint')}</p>
                  <FieldError message={form.formState.errors.cardLogoUrl?.message} />
                </div>
              </CardContent>
            </Card>

            {/* Animated card background effect */}
            <Controller
              name="cardEffect"
              control={form.control}
              render={({ field }) => (
                <CardEffectSection
                  effect={field.value}
                  props={watchedValues.cardEffectProps ?? {}}
                  opacity={watchedValues.cardEffectOpacity ?? 1}
                  onEffectChange={(e) => field.onChange(e)}
                  onPropsChange={(p) => form.setValue("cardEffectProps", p, { shouldDirty: true })}
                  onOpacityChange={(o) => form.setValue("cardEffectOpacity", o, { shouldDirty: true })}
                />
              )}
            />

            {/* Per-position card backgrounds (slot N → Nth subscription card) */}
            <Controller
              name="cardEffectsByIndex"
              control={form.control}
              render={({ field }) => (
                <CardEffectSlotsSection
                  slots={(field.value ?? []) as CardEffectSlot[]}
                  onChange={(slots) => field.onChange(slots)}
                />
              )}
            />
          </div>

          {/* ── App background tab ────────────────────────────────────── */}
          <div className={gate('appbg')}>
            <Controller
              name="appBackground"
              control={form.control}
              render={({ field }) => (
                <AppBackgroundSection
                  value={field.value ?? DEFAULT_APP_BACKGROUND_DRAFT}
                  primary={watchedValues.primary}
                  bgPrimary={watchedValues.bgPrimary}
                  onChange={(v) => field.onChange(v)}
                />
              )}
            />
          </div>

          {/* ── Menu icons tab ────────────────────────────────────────── */}
          <div className={gate('icons')}>
            <Controller
              name="iconColorMode"
              control={form.control}
              render={({ field }) => (
                <IconColorsSection
                  mode={field.value}
                  colors={watchedValues.iconColors ?? {}}
                  primary={watchedValues.primary}
                  onModeChange={(m) => field.onChange(m)}
                  onColorsChange={(c) => form.setValue("iconColors", c, { shouldDirty: true })}
                />
              )}
            />
          </div>

          {/* ── Tariff cards tab ──────────────────────────────────────── */}
          <div className={gate('planCards')}>
            <Controller
              name="planCardStyles"
              control={form.control}
              render={({ field }) =>
                tab === 'planCards' ? (
                  <PlanCardStylesSection
                    value={(field.value ?? {}) as Record<string, PlanCardStyleDraft>}
                    onChange={(next) => field.onChange(next)}
                    primary={watchedValues.primary}
                  />
                ) : (
                  <></>
                )
              }
            />
          </div>
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>{t('brandingPage.sections.preview.title')}</CardTitle>
              <CardDescription>{t('brandingPage.sections.preview.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <BrandingPreview values={watchedValues} focus={tab} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FieldError({ message }: { readonly message?: string }) {
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}

/**
 * Hidden-input file uploader. Posts the chosen file to the branding asset
 * endpoint and hands the resulting `/uploads/branding/...` URL back to the
 * caller (which sets the relevant form field). Self-contained pending state.
 */
function AssetUploadButton({
  onUploaded,
  label,
  accept,
}: {
  readonly onUploaded: (url: string) => void;
  readonly label: string;
  readonly accept: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: uploadBrandingAsset,
    onSuccess: (url) => {
      onUploaded(url);
      toast.success(t('brandingPage.sections.identity.uploadSuccess'));
    },
    onError: () => toast.error(t('brandingPage.sections.identity.uploadFailed')),
  });

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) mutation.mutate(file);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {mutation.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Upload className="mr-2 h-4 w-4" />
        )}
        {label}
      </Button>
    </>
  );
}

function ColorField({
  label,
  name,
  form,
}: {
  label: string;
  name: keyof BrandingFormDraft;
  form: UseFormReturn<BrandingFormDraft, unknown, BrandingFormData>;
}) {
  const { t } = useTranslation();
  const value = form.watch(name) as string;
  const textInputId = `branding-${String(name)}-hex`;
  return (
    <div className="space-y-2">
      <Label htmlFor={textInputId}>{label}</Label>
      <div className="flex items-center gap-2">
        <label className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border overflow-hidden">
          <span className="absolute inset-0" style={{ backgroundColor: value || "#000" }} />
          <input
            type="color"
            value={value || "#000000"}
            onChange={(e) => form.setValue(name, e.target.value, { shouldDirty: true })}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label={t('brandingPage.sections.colors.colorPickerAria', { name: label })}
          />
        </label>
        <Input
          id={textInputId}
          {...form.register(name)}
          className="font-mono text-xs"
          placeholder="#22c55e"
        />
      </div>
    </div>
  );
}
