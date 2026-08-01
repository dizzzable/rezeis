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
import { useForm, useWatch, Controller, type FieldPath, type Resolver, type UseFormReturn } from "react-hook-form";
import { useTranslation } from 'react-i18next';
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Check, Loader2, Paintbrush, RotateCcw, Save, Search, Sparkles, Upload, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { BrandingPreview } from "./branding-preview";
import { CARD_LOGO_PRESETS, CardLogoMark, type CardLogoPreset } from "./card-logo-mark";
import {
  ConceptCardPresetGallery,
  type ConceptCardPresetGalleryLabels,
} from "./concept-card-preset-gallery";
import {
  CONCEPT_CARD_PRESETS,
  type ConceptCardPresetVisualPatch,
} from "./concept-card-presets";
import {
  createBrandingFormSchema,
  createBrandingDirtyPatch,
  createInitialBrandingDraft,
  getBrandingChangedFields,
  CORNER_RADII_BY_LEGACY_CLASS,
  DEFAULT_APP_BACKGROUND_DRAFT,
  type BrandingCornerRadiiDraft,
  type BrandingSurfaceThemeDraft,
  type BrandingFormData,
  type BrandingFormDraft,
  type BrandingThemeVariantsDraft,
  type BrandingFormValidationMessages,
  type PlanCardStyleDraft,
  type NavItemDraft,
} from "./branding-form-schema";
import { CardEffectSection } from "./card-effect-section";
import { AppBackgroundSection } from "./app-background-section";
import { CardEffectSlotsSection, type CardEffectSlot } from "./card-effect-slots-section";
import { GradientBuilder } from "./gradient-builder";
import { useCustomGradients } from "./use-custom-gradients";
import { IconColorsSection } from "./icon-colors-section";
import { PlanCardStylesSection } from "./plan-card-styles-section";
import { NavConfigSection } from "./nav-config-section";
import {
  CARD_GRADIENT_PRESETS,
  CONCEPT_THEME_PRESETS,
  FONT_OPTIONS,
  LEGACY_THEME_PRESETS,
  THEME_PRESETS,
  createConceptThemeModeVariants,
  createConceptThemePresetVisualPatch,
  createLegacyThemePresetVisualPatch,
  gradientFromPrimary,
  type ConceptThemePreset,
  type LegacyThemePreset,
  type ThemePreset,
} from "./theme-presets";
import { CONCEPT_PRESETS, getConceptSourceMode } from "../../lib/theme/concept-presets";

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
const BRANDING_TABS = ['brand', 'colors', 'card', 'appbg', 'icons', 'planCards', 'nav'] as const;
type BrandingTab = (typeof BRANDING_TABS)[number];

function tabForBrandingField(field: string): BrandingTab {
  if (['brandName', 'tagline', 'logoUrl', 'pwaIconUrl', 'themePresetId', 'themePresetVersion', 'themeModePolicy', 'themeDefaultMode', 'themeVariants'].includes(field)) {
    return 'brand';
  }
  if (['primary', 'primaryFg', 'bgPrimary', 'bgSecondary', 'borderRadius', 'cornerRadii', 'fontFamily', 'surfaceTheme'].includes(field)) {
    return 'colors';
  }
  if (field.startsWith('card')) return 'card';
  if (field === 'bgEffect' || field === 'appBackground') return 'appbg';
  if (field.startsWith('icon')) return 'icons';
  if (field === 'planCardStyles') return 'planCards';
  if (field.startsWith('nav')) return 'nav';
  return 'brand';
}

// ── API ─────────────────────────────────────────────────────────────────────

async function fetchBranding(): Promise<BrandingFormDraft> {
  const { data } = await api.get<Partial<BrandingFormDraft>>("/admin/settings/branding");
  return createInitialBrandingDraft(data);
}

async function updateBranding(values: Partial<BrandingFormData>): Promise<BrandingFormDraft> {
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
  const [presetQuery, setPresetQuery] = useState('');
  const customGradients = useCustomGradients();
  const validationMessages = useMemo<BrandingFormValidationMessages>(() => ({
    hexInvalid: t('brandingPage.invalidHex'),
    imageUrlInvalid: t('brandingPage.invalidImageUrl'),
    gradientInvalid: t('brandingPage.invalidGradient'),
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
      form.reset(data);
      toast.success(t('brandingPage.saved'));
    },
    onError: () => toast.error(t('brandingPage.saveFailed')),
  });

  const onSubmit = (): void => {
    form.clearErrors();
    const values = form.getValues();
    const result = createBrandingDirtyPatch({
      values,
      dirtyFields: getBrandingChangedFields(
        values,
        branding ?? createInitialBrandingDraft(),
      ),
      schema: brandingSchema,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        if (issue.path.length === 0) continue;
        form.setError(issue.path.join('.') as FieldPath<BrandingFormDraft>, {
          type: 'validate',
          message: issue.message,
        });
      }
      const firstIssue = result.error.issues[0];
      const firstField = firstIssue?.path[0];
      if (typeof firstField === 'string') {
        setTab(tabForBrandingField(firstField));
      }
      toast.error(
        firstIssue
          ? `${t('brandingPage.validationFailed')}: ${firstIssue.message}`
          : t('brandingPage.validationFailed'),
      );
      return;
    }
    if (result.fields.length === 0) return;
    mutation.mutate(result.data);
  };

  function applyPreset(preset: ThemePreset): void {
    if (preset.kind === 'legacy') {
      applyLegacyPreset(preset);
      return;
    }
    applyConceptPreset(preset);
  }

  /**
   * A standard theme repaints the palette, the card gradient and the legacy
   * background effect — nothing else. Corner radii, typography, semantic
   * surfaces, card artwork and the app background stay as the operator left
   * them, exactly as these themes behaved before the concept catalog arrived.
   */
  function applyLegacyPreset(preset: LegacyThemePreset): void {
    const patch = createLegacyThemePresetVisualPatch(preset);
    form.setValue("themePresetId", patch.themePresetId, { shouldDirty: true });
    form.setValue("themePresetVersion", patch.themePresetVersion, { shouldDirty: true });
    // The brightness chooser is intentionally a capability of the resolved
    // concept family only. A legacy palette remains exactly operator-fixed.
    form.setValue("themeModePolicy", "fixed", { shouldDirty: true });
    form.setValue("themeDefaultMode", "dark", { shouldDirty: true });
    form.setValue("themeVariants", null, { shouldDirty: true });
    form.setValue("primary", patch.primary, { shouldDirty: true });
    form.setValue("primaryFg", patch.primaryFg, { shouldDirty: true });
    form.setValue("bgPrimary", patch.bgPrimary, { shouldDirty: true });
    form.setValue("bgSecondary", patch.bgSecondary, { shouldDirty: true });
    form.setValue("cardGradient", patch.cardGradient, { shouldDirty: true });
    form.setValue("bgEffect", patch.bgEffect, { shouldDirty: true });
    synchronizeCardSlotGradient(patch.cardGradient);
  }

  function applyConceptPreset(preset: ConceptThemePreset): void {
    const patch = createConceptThemePresetVisualPatch(preset);
    const descriptor = CONCEPT_PRESETS.find((candidate) => candidate.id === preset.id);
    if (!descriptor) return;
    const sourceMode = getConceptSourceMode(descriptor);
    form.setValue("themeModePolicy", "fixed", { shouldDirty: true });
    form.setValue("themeDefaultMode", sourceMode, { shouldDirty: true });
    form.setValue(
      "themeVariants",
      createThemeVariantsWithSlots(preset),
      { shouldDirty: true },
    );
    applyConceptVisualPatch(patch, true);
  }

  /**
   * The public variant must be a complete renderable snapshot, including each
   * configured subscription-card position.  The operator still picks only one
   * concept: these are its two brightness representations, never a user theme
   * catalogue.  We keep the existing number of slots and resolve every slot
   * from the corresponding mode so an old slot cannot leak the opposite mode.
   */
  function createThemeVariantsWithSlots(
    preset: ConceptThemePreset,
  ): BrandingThemeVariantsDraft {
    const variants = createConceptThemeModeVariants(preset);
    const slotCount = (form.getValues("cardEffectsByIndex") ?? []).length;
    const withSlots = (
      variant: (typeof variants)["light"],
    ): BrandingThemeVariantsDraft["light"] => ({
      ...variant,
      cardEffectProps: { ...(variant.cardEffectProps ?? {}) },
      cardEffectsByIndex: Array.from({ length: slotCount }, () => ({
        cardEffect: variant.cardEffect,
        cardEffectProps: { ...(variant.cardEffectProps ?? {}) },
        cardEffectOpacity: variant.cardEffectOpacity,
        cardGradient: variant.cardGradient,
      })),
    });

    return {
      light: withSlots(variants.light),
      dark: withSlots(variants.dark),
    };
  }

  function applyConceptVisualPatch(
    patch:
      | ReturnType<typeof createConceptThemePresetVisualPatch>
      | BrandingThemeVariantsDraft['light'],
    synchronizeSlots: boolean,
    applyCardArtwork = true,
  ): void {
    const cardPatch: ConceptCardPresetVisualPatch = {
      cardGradient: patch.cardGradient,
      cardPattern: patch.cardPattern,
      cardEffect: patch.cardEffect,
      cardEffectProps: patch.cardEffectProps ?? {},
      cardEffectOpacity: patch.cardEffectOpacity,
    };
    if ('themePresetId' in patch) {
      form.setValue("themePresetId", patch.themePresetId, { shouldDirty: true });
      form.setValue("themePresetVersion", patch.themePresetVersion, { shouldDirty: true });
    }
    form.setValue("primary", patch.primary, { shouldDirty: true });
    form.setValue("primaryFg", patch.primaryFg, { shouldDirty: true });
    form.setValue("bgPrimary", patch.bgPrimary, { shouldDirty: true });
    form.setValue("bgSecondary", patch.bgSecondary, { shouldDirty: true });
    if (applyCardArtwork) {
      applyConceptCardPreset(cardPatch, synchronizeSlots);
    } else {
      // Changing only the default brightness must not replace the animation
      // selected by the operator. The gradient still follows the selected
      // brightness, including its lightweight per-position fallback.
      form.setValue("cardGradient", cardPatch.cardGradient, { shouldDirty: true });
      form.setValue("cardPattern", cardPatch.cardPattern, { shouldDirty: true });
      if (synchronizeSlots) synchronizeCardSlotGradient(cardPatch.cardGradient);
    }

    form.setValue("bgEffect", patch.bgEffect, { shouldDirty: true });
    form.setValue("appBackground", patch.appBackground, { shouldDirty: true });
    form.setValue("borderRadius", patch.borderRadius, { shouldDirty: true });
    form.setValue("cornerRadii", patch.cornerRadii, { shouldDirty: true });
    form.setValue("fontFamily", patch.fontFamily, { shouldDirty: true });
    form.setValue("surfaceTheme", patch.surfaceTheme, { shouldDirty: true });
  }

  /**
   * A positional slot gradient wins over the global card visual in Reiwa, so a
   * stale slot would make the applied standard theme invisible on the card.
   * Only the gradient is synchronized — the slot animation stays operator-owned
   * because a standard theme never had an opinion about it.
   */
  function synchronizeCardSlotGradient(cardGradient: string | null): void {
    const existingSlots = form.getValues("cardEffectsByIndex") ?? [];
    if (existingSlots.length === 0) return;
    form.setValue(
      "cardEffectsByIndex",
      existingSlots.map((slot) => ({ ...slot, cardGradient })),
      { shouldDirty: true },
    );
  }

  function applyConceptCardPreset(
    patch: ConceptCardPresetVisualPatch,
    synchronizeSlots = false,
  ): void {
    // Page colors/background, geometry and navigation stay untouched.
    form.setValue("cardGradient", patch.cardGradient, { shouldDirty: true });
    form.setValue("cardPattern", patch.cardPattern, { shouldDirty: true });
    form.setValue("cardEffect", patch.cardEffect, { shouldDirty: true });
    form.setValue("cardEffectProps", { ...patch.cardEffectProps }, { shouldDirty: true });
    form.setValue("cardEffectOpacity", patch.cardEffectOpacity, { shouldDirty: true });

    // A positional slot wins over the global card visual in Reiwa. Preserve
    // the configured slot count, but synchronize its visual when an explicit
    // full-theme or concept-card preset is chosen. Otherwise the UI would say
    // that a preset was applied while Reiwa kept rendering stale slot artwork.
    if (!synchronizeSlots) return;
    const existingSlots = form.getValues("cardEffectsByIndex") ?? [];
    if (existingSlots.length === 0) return;
    form.setValue(
      "cardEffectsByIndex",
      existingSlots.map((slot) => ({
        ...slot,
        cardEffect: patch.cardEffect,
        cardEffectProps: { ...patch.cardEffectProps },
        cardEffectOpacity: patch.cardEffectOpacity,
        cardGradient: patch.cardGradient,
      })),
      { shouldDirty: true },
    );
  }

  function generateGradient(): void {
    const primary = form.getValues("primary");
    form.setValue("cardGradient", gradientFromPrimary(primary), { shouldDirty: true });
  }

  // The form is seeded with a complete draft and every server response is
  // normalized through createInitialBrandingDraft, so the watched snapshot is
  // complete even though react-hook-form exposes it as DeepPartial.
  const watchedValues = useWatch({ control: form.control }) as BrandingFormDraft;
  const selectedConceptPreset = useMemo(
    () =>
      CONCEPT_THEME_PRESETS.find(
        (preset) =>
          preset.id === watchedValues.themePresetId &&
          preset.version === watchedValues.themePresetVersion,
      ) ?? null,
    [watchedValues.themePresetId, watchedValues.themePresetVersion],
  );
  const legacyPresetLabel = (preset: LegacyThemePreset): string =>
    t(`brandingPage.presets.${preset.id}`);
  const filteredLegacyPresets = useMemo(() => {
    const needle = presetQuery.trim().toLocaleLowerCase();
    if (!needle) return LEGACY_THEME_PRESETS;
    return LEGACY_THEME_PRESETS.filter((preset) =>
      [preset.id, t(`brandingPage.presets.${preset.id}`)].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    );
  }, [presetQuery, t]);
  const filteredConceptPresets = useMemo(() => {
    const needle = presetQuery.trim().toLocaleLowerCase();
    if (!needle) return CONCEPT_THEME_PRESETS;
    return CONCEPT_THEME_PRESETS.filter((preset) =>
      [
        preset.code,
        preset.name,
        preset.id,
        preset.visualFamily,
      ].some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [presetQuery]);
  const visibleThemePresetCount =
    filteredLegacyPresets.length + filteredConceptPresets.length;
  const conceptCardGalleryLabels = useMemo<ConceptCardPresetGalleryLabels>(
    () => ({
      catalogLabel: t('brandingPage.sections.card.catalogLabel'),
      searchLabel: t('brandingPage.sections.card.catalogSearchLabel'),
      searchPlaceholder: t('brandingPage.sections.card.catalogSearchPlaceholder'),
      familyFilterLabel: t('brandingPage.sections.card.catalogFamilyFilter'),
      allFamilies: t('brandingPage.sections.card.catalogAllFamilies'),
      effectFilterLabel: t('brandingPage.sections.card.catalogEffectFilter'),
      allEffects: t('brandingPage.sections.card.catalogAllEffects'),
      effect: t('brandingPage.sections.card.catalogEffect'),
      pattern: t('brandingPage.sections.card.catalogPattern'),
      noPattern: t('brandingPage.sections.card.catalogNoPattern'),
      selected: t('brandingPage.sections.card.catalogApplied'),
      noResults: t('brandingPage.sections.card.catalogNoResults'),
      showMore: t('brandingPage.sections.card.catalogShowMore'),
      results: (visible, total) =>
        t('brandingPage.sections.card.catalogResults', { visible, total }),
      apply: (preset) =>
        t('brandingPage.sections.card.catalogApply', {
          code: preset.code,
          name: preset.name,
          effect: preset.cardEffectName,
        }),
    }),
    [t],
  );
  const selectedConceptCardPresetId = useMemo(() => {
    const props = JSON.stringify(watchedValues.cardEffectProps ?? {});
    return (
      CONCEPT_CARD_PRESETS.find(
        (preset) =>
          preset.cardGradient === watchedValues.cardGradient &&
          preset.cardPattern === watchedValues.cardPattern &&
          preset.cardEffect === watchedValues.cardEffect &&
          preset.cardEffectOpacity === watchedValues.cardEffectOpacity &&
          JSON.stringify(preset.cardEffectProps) === props,
      )?.id ?? null
    );
  }, [
    watchedValues.cardEffect,
    watchedValues.cardEffectOpacity,
    watchedValues.cardEffectProps,
    watchedValues.cardGradient,
    watchedValues.cardPattern,
  ]);

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
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="relative w-full sm:max-w-sm">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={presetQuery}
                      onChange={(event) => setPresetQuery(event.target.value)}
                      placeholder={t('brandingPage.sections.presets.searchPlaceholder')}
                      aria-label={t('brandingPage.sections.presets.searchLabel')}
                      className="pl-9"
                    />
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {t('brandingPage.sections.presets.count', {
                      visible: visibleThemePresetCount,
                      total: THEME_PRESETS.length,
                    })}
                  </span>
                </div>
                <div className="max-h-[640px] space-y-5 overflow-y-auto pr-1">
                  {filteredLegacyPresets.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('brandingPage.sections.presets.standardGroup')}
                        <span className="font-normal normal-case tracking-normal">
                          {filteredLegacyPresets.length}
                        </span>
                      </h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                        {filteredLegacyPresets.map((preset) => (
                          <ThemePresetButton
                            key={preset.id}
                            preset={preset}
                            label={legacyPresetLabel(preset)}
                            isActive={
                              watchedValues.themePresetId === preset.id &&
                              watchedValues.themePresetVersion === preset.version
                            }
                            onSelect={() => applyPreset(preset)}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  {filteredConceptPresets.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('brandingPage.sections.presets.conceptGroup')}
                        <span className="font-normal normal-case tracking-normal">
                          {filteredConceptPresets.length}
                        </span>
                      </h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                        {filteredConceptPresets.map((preset) => (
                          <ThemePresetButton
                            key={preset.id}
                            preset={preset}
                            label={preset.name}
                            isActive={
                              watchedValues.themePresetId === preset.id &&
                              watchedValues.themePresetVersion === preset.version
                            }
                            onSelect={() => applyPreset(preset)}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </div>
                {visibleThemePresetCount === 0 && (
                  <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                    {t('brandingPage.sections.presets.empty')}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.themeMode.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.themeMode.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedConceptPreset ? (
                  watchedValues.themeVariants ? (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="themeModePolicy">
                            {t('brandingPage.sections.themeMode.permissionLabel')}
                          </Label>
                          <Select
                            value={watchedValues.themeModePolicy}
                            onValueChange={(value) =>
                              form.setValue(
                                'themeModePolicy',
                                value as BrandingFormDraft['themeModePolicy'],
                                { shouldDirty: true },
                              )
                            }
                          >
                            <SelectTrigger id="themeModePolicy">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="fixed">
                                {t('brandingPage.sections.themeMode.fixed')}
                              </SelectItem>
                              <SelectItem value="user-selectable">
                                {t('brandingPage.sections.themeMode.userSelectable')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="themeDefaultMode">
                            {t('brandingPage.sections.themeMode.defaultLabel')}
                          </Label>
                          <Select
                            value={watchedValues.themeDefaultMode}
                            onValueChange={(value) => {
                              const mode = value as BrandingFormDraft['themeDefaultMode'];
                              const variant = watchedValues.themeVariants?.[mode];
                              if (!variant) return;
                              form.setValue('themeDefaultMode', mode, { shouldDirty: true });
                              applyConceptVisualPatch(variant, true, false);
                            }}
                          >
                            <SelectTrigger id="themeDefaultMode">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="light">
                                {t('brandingPage.sections.themeMode.light')}
                              </SelectItem>
                              <SelectItem value="dark">
                                {t('brandingPage.sections.themeMode.dark')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('brandingPage.sections.themeMode.hint')}
                      </p>
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
                      <p className="text-sm text-muted-foreground">
                        {t('brandingPage.sections.themeMode.prepareHint')}
                      </p>
                      <Button type="button" variant="outline" onClick={() => applyConceptPreset(selectedConceptPreset)}>
                        {t('brandingPage.sections.themeMode.prepareAction')}
                      </Button>
                    </div>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('brandingPage.sections.themeMode.conceptRequired')}
                  </p>
                )}
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
                        <Select
                          value={field.value}
                          onValueChange={(value) => {
                            field.onChange(value)
                            const radii = CORNER_RADII_BY_LEGACY_CLASS[value]
                            if (radii) {
                              form.setValue('cornerRadii', radii, { shouldDirty: true })
                            }
                          }}
                        >
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
                                  {f.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
                <div className="grid gap-5 border-t pt-4 sm:grid-cols-3">
                  <CornerRadiusSliderField
                    label={t('brandingPage.sections.effects.cardRadius')}
                    name="cardPx"
                    value={watchedValues.cornerRadii.cardPx}
                    max={48}
                    form={form}
                  />
                  <CornerRadiusSliderField
                    label={t('brandingPage.sections.effects.itemRadius')}
                    name="itemPx"
                    value={watchedValues.cornerRadii.itemPx}
                    max={32}
                    form={form}
                  />
                  <CornerRadiusSliderField
                    label={t('brandingPage.sections.effects.pillRadius')}
                    name="pillPx"
                    value={watchedValues.cornerRadii.pillPx}
                    max={64}
                    capsule
                    form={form}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('brandingPage.sections.effects.cornerRadiiHint')}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.surfaces.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.surfaces.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                  <SurfaceColorField
                    label={t('brandingPage.sections.surfaces.foreground')}
                    name="foreground"
                    form={form}
                  />
                  <SurfaceColorField
                    label={t('brandingPage.sections.surfaces.mutedForeground')}
                    name="mutedForeground"
                    form={form}
                  />
                  <SurfaceColorField
                    label={t('brandingPage.sections.surfaces.surface')}
                    name="surface"
                    form={form}
                  />
                  <SurfaceColorField
                    label={t('brandingPage.sections.surfaces.surfaceHigh')}
                    name="surfaceHigh"
                    form={form}
                  />
                  <SurfaceColorField
                    label={t('brandingPage.sections.surfaces.borderSoft')}
                    name="borderSoft"
                    form={form}
                  />
                  <SurfaceColorField
                    label={t('brandingPage.sections.surfaces.borderStrong')}
                    name="borderStrong"
                    form={form}
                  />
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <SurfaceSliderField
                    label={t('brandingPage.sections.surfaces.surfaceOpacity')}
                    name="surfaceOpacity"
                    value={watchedValues.surfaceTheme.surfaceOpacity}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(value) => `${Math.round(value * 100)}%`}
                    form={form}
                  />
                  <SurfaceSliderField
                    label={t('brandingPage.sections.surfaces.surfaceHighOpacity')}
                    name="surfaceHighOpacity"
                    value={watchedValues.surfaceTheme.surfaceHighOpacity}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(value) => `${Math.round(value * 100)}%`}
                    form={form}
                  />
                  <SurfaceSliderField
                    label={t('brandingPage.sections.surfaces.borderSoftOpacity')}
                    name="borderSoftOpacity"
                    value={watchedValues.surfaceTheme.borderSoftOpacity}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(value) => `${Math.round(value * 100)}%`}
                    form={form}
                  />
                  <SurfaceSliderField
                    label={t('brandingPage.sections.surfaces.borderStrongOpacity')}
                    name="borderStrongOpacity"
                    value={watchedValues.surfaceTheme.borderStrongOpacity}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(value) => `${Math.round(value * 100)}%`}
                    form={form}
                  />
                  <SurfaceSliderField
                    label={t('brandingPage.sections.surfaces.glassBlur')}
                    name="glassBlurPx"
                    value={watchedValues.surfaceTheme.glassBlurPx}
                    min={0}
                    max={40}
                    step={1}
                    format={(value) => `${value}px`}
                    form={form}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Subscription card tab ─────────────────────────────────── */}
          <div className={gate('card')}>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  {t('brandingPage.sections.card.catalogTitle')}
                </CardTitle>
                <CardDescription>
                  {t('brandingPage.sections.card.catalogDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {tab === 'card' ? (
                  <ConceptCardPresetGallery
                    selectedPresetId={selectedConceptCardPresetId}
                    onApply={(_preset, patch) =>
                      applyConceptCardPreset(patch, true)
                    }
                    labels={conceptCardGalleryLabels}
                  />
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('brandingPage.sections.card.title')}</CardTitle>
                <CardDescription>{t('brandingPage.sections.card.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="cardGradient">{t('brandingPage.sections.card.gradient')}</Label>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const css = (form.getValues("cardGradient") ?? "").trim();
                          if (css.length === 0) return;
                          const isPreset = CARD_GRADIENT_PRESETS.some(
                            (p) => p.value.toLowerCase() === css.toLowerCase(),
                          );
                          if (isPreset || customGradients.custom.some((g) => g.toLowerCase() === css.toLowerCase())) {
                            toast.info(t('brandingPage.sections.card.saveExists'));
                            return;
                          }
                          customGradients.add(css);
                          toast.success(t('brandingPage.sections.card.saved'));
                        }}
                      >
                        <Bookmark className="mr-1.5 h-3.5 w-3.5" />
                        {t('brandingPage.sections.card.saveToPalette')}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={generateGradient}>
                        <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                        {t('brandingPage.sections.card.generate')}
                      </Button>
                    </div>
                  </div>
                  {/* Preset + saved swatches — one-click ready-made gradients.
                      Compact auto-fill grid keeps the tiles small regardless of
                      the panel width. */}
                  <Controller
                    name="cardGradient"
                    control={form.control}
                    render={({ field }) => (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(38px,1fr))] gap-1.5">
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
                              className={`relative aspect-square rounded-md ring-1 transition-all hover:scale-[1.08] ${
                                isActive ? "ring-2 ring-primary" : "ring-white/10 hover:ring-primary/40"
                              }`}
                              style={{ backgroundImage: preset.value }}
                            >
                              {isActive && (
                                <span className="absolute inset-0 flex items-center justify-center">
                                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/50 text-white">
                                    <Check className="h-2 w-2" />
                                  </span>
                                </span>
                              )}
                            </button>
                          );
                        })}
                        {/* Operator-saved custom gradients (browser-local). */}
                        {customGradients.custom.map((css) => {
                          const isActive =
                            (field.value ?? "").trim().toLowerCase() === css.toLowerCase();
                          return (
                            <div key={css} className="group relative aspect-square">
                              <button
                                type="button"
                                aria-label={t('brandingPage.sections.card.customSwatch')}
                                title={css}
                                onClick={() => field.onChange(css)}
                                className={`h-full w-full rounded-md ring-1 transition-all hover:scale-[1.08] ${
                                  isActive ? "ring-2 ring-primary" : "ring-white/10 hover:ring-primary/40"
                                }`}
                                style={{ backgroundImage: css }}
                              >
                                {isActive && (
                                  <span className="absolute inset-0 flex items-center justify-center">
                                    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/50 text-white">
                                      <Check className="h-2 w-2" />
                                    </span>
                                  </span>
                                )}
                              </button>
                              <button
                                type="button"
                                aria-label={t('brandingPage.sections.card.removeSwatch')}
                                title={t('brandingPage.sections.card.removeSwatch')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  customGradients.remove(css);
                                }}
                                className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow group-hover:flex"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </div>
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
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2">
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
                            className={`relative flex aspect-square items-center justify-center rounded-lg border bg-muted/30 transition-all hover:scale-[1.06] ${
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
                                className="h-8 w-8"
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

          {/* ── Navigation tab ────────────────────────────────────────── */}
          <div className={gate('nav')}>
            <Controller
              name="navItems"
              control={form.control}
              render={({ field }) =>
                tab === 'nav' ? (
                  <NavConfigSection
                    value={(field.value ?? []) as NavItemDraft[]}
                    onChange={(next) => field.onChange(next)}
                    gap={watchedValues.navGap ?? 2}
                    onGapChange={(next) => form.setValue('navGap', next, { shouldDirty: true })}
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

function ThemePresetButton({
  preset,
  label,
  isActive,
  onSelect,
}: {
  readonly preset: ThemePreset
  readonly label: string
  readonly isActive: boolean
  readonly onSelect: () => void
}) {
  const ariaLabel =
    preset.kind === 'concept' ? `${preset.code} ${preset.name}` : label
  const palette =
    preset.kind === 'concept' ? preset.palette : ([preset.primary, preset.bgPrimary, preset.bgSecondary] as const)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isActive}
      aria-label={ariaLabel}
      className={`group relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all hover:scale-[1.02] ${
        isActive ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/40'
      }`}
    >
      <div
        className="h-12 w-full rounded-lg ring-1 ring-white/10"
        style={{ backgroundImage: preset.cardGradient }}
      />
      <div className="flex h-2 overflow-hidden rounded-full">
        {palette.map((color, index) => (
          <span
            key={`${preset.id}-${color}-${index}`}
            className="h-full flex-1"
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-xs font-medium">
          {preset.kind === 'concept' && (
            <span className="mr-1 font-mono text-[10px] text-muted-foreground">
              {preset.code}
            </span>
          )}
          <span className="line-clamp-1">{label}</span>
        </span>
        <span
          className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/20"
          style={{ backgroundColor: preset.primary }}
        />
      </div>
      {isActive && (
        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      )}
    </button>
  )
}

function SurfaceColorField({
  label,
  name,
  form,
}: {
  readonly label: string;
  readonly name: keyof Pick<
    BrandingSurfaceThemeDraft,
    'foreground' | 'mutedForeground' | 'surface' | 'surfaceHigh' | 'borderSoft' | 'borderStrong'
  >;
  readonly form: UseFormReturn<BrandingFormDraft, unknown, BrandingFormData>;
}) {
  const path = `surfaceTheme.${name}` as FieldPath<BrandingFormDraft>;
  const value = form.watch(path) as string;
  const inputId = `branding-surface-${name}`;

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex items-center gap-2">
        <label className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border">
          <span className="absolute inset-0" style={{ backgroundColor: value || '#000000' }} />
          <input
            type="color"
            value={value || '#000000'}
            onChange={(event) =>
              form.setValue(path, event.target.value, { shouldDirty: true })
            }
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label={label}
          />
        </label>
        <Input
          id={inputId}
          {...form.register(path)}
          className="font-mono text-xs"
          placeholder="#18181b"
        />
      </div>
    </div>
  );
}

function SurfaceSliderField({
  label,
  name,
  value,
  min,
  max,
  step,
  format,
  form,
}: {
  readonly label: string;
  readonly name: keyof Pick<
    BrandingSurfaceThemeDraft,
    | 'surfaceOpacity'
    | 'surfaceHighOpacity'
    | 'borderSoftOpacity'
    | 'borderStrongOpacity'
    | 'glassBlurPx'
  >;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly form: UseFormReturn<BrandingFormDraft, unknown, BrandingFormData>;
}) {
  const path = `surfaceTheme.${name}` as FieldPath<BrandingFormDraft>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        <span className="font-mono text-xs text-muted-foreground">{format(value)}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) =>
          form.setValue(path, next[0] ?? value, { shouldDirty: true })
        }
      />
    </div>
  );
}

function CornerRadiusSliderField({
  label,
  name,
  value,
  max,
  capsule = false,
  form,
}: {
  readonly label: string
  readonly name: keyof BrandingCornerRadiiDraft
  readonly value: number
  readonly max: number
  readonly capsule?: boolean
  readonly form: UseFormReturn<BrandingFormDraft, unknown, BrandingFormData>
}) {
  const { t } = useTranslation()
  const path = `cornerRadii.${name}` as FieldPath<BrandingFormDraft>
  const sliderValue = capsule && value >= max ? max : value
  const displayed =
    capsule && value >= max
      ? t('brandingPage.sections.effects.capsule')
      : `${Math.round(value)}px`

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        <span className="font-mono text-xs text-muted-foreground">{displayed}</span>
      </div>
      <Slider
        value={[sliderValue]}
        min={0}
        max={max}
        step={1}
        onValueChange={(next) => {
          const selected = next[0] ?? sliderValue
          form.setValue(
            path,
            capsule && selected >= max ? 9999 : selected,
            { shouldDirty: true },
          )
        }}
      />
    </div>
  )
}
