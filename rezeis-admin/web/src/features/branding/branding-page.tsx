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
import { Switch } from "@/components/ui/switch";
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
  isBrandingCardEffect,
  isSafeBrandingGradient,
  CORNER_RADII_BY_LEGACY_CLASS,
  DEFAULT_APP_BACKGROUND_DRAFT,
  type BrandingAppBackgroundDraft,
  type BrandingCardEffectSlotDraft,
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

/**
 * The per-position slot list a brightness snapshot may carry.
 *
 * Slots belong in a variant for the same reason `subscriptionCardText` does: a
 * variant is a COMPLETE renderable snapshot, so an override the operator
 * configured has to be in both of them or a brightness switch silently drops
 * it. What a variant may NOT do is carry a value this client cannot validate.
 * Unlike the root array — which a PATCH omits while it is unchanged, so a
 * legacy value can never block applying a theme (see `createBrandingDirtyPatch`)
 * — a variant is always sent whole and always revalidated, and one unusable
 * legacy slot gradient would fail the whole submit.
 *
 * So the copy is sanitized exactly the way the API's own `readCardEffectSlots`
 * sanitizes it on read: a gradient this build cannot parse becomes "use the
 * global one", and an override naming an effect outside the catalog demotes to
 * inherit rather than becoming an invisible stale winner. Everything the
 * operator actually chose and this build understands survives verbatim.
 */
function toThemeVariantCardSlots(
  slots: readonly BrandingCardEffectSlotDraft[],
): BrandingCardEffectSlotDraft[] {
  return slots.map((slot) => {
    const cardGradient = isSafeBrandingGradient(slot.cardGradient)
      ? slot.cardGradient.trim()
      : null;
    if (slot.mode !== "override" || !isBrandingCardEffect(slot.cardEffect)) {
      return { mode: "inherit" as const, cardGradient };
    }
    const opacity = slot.cardEffectOpacity;
    return {
      mode: "override" as const,
      cardEffect: slot.cardEffect,
      cardEffectProps: { ...(slot.cardEffectProps ?? {}) },
      cardEffectOpacity:
        typeof opacity === "number" && opacity >= 0.05 && opacity <= 1 ? opacity : 1,
      cardGradient,
    };
  });
}

/**
 * The four colours of the palette section. They are edited one at a time but
 * saved as one unit — see `BrandingFormDraft.brandPaletteSource`.
 */
type BrandPaletteField = 'primary' | 'primaryFg' | 'bgPrimary' | 'bgSecondary';
type BrandPalette = Record<BrandPaletteField, string>;

function tabForBrandingField(field: string): BrandingTab {
  if (['brandName', 'tagline', 'logoUrl', 'pwaIconUrl', 'themePresetId', 'themePresetVersion', 'themeModePolicy', 'themeDefaultMode', 'themeVariants'].includes(field)) {
    return 'brand';
  }
  if (['primary', 'primaryFg', 'bgPrimary', 'bgSecondary', 'brandPaletteSource', 'borderRadius', 'cornerRadii', 'fontFamily', 'surfaceTheme'].includes(field)) {
    return 'colors';
  }
  if (field.startsWith('card') || field === 'subscriptionCardText' || field === 'subscriptionCardGlass') return 'card';
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
    // Say so out loud. This was the ONE silent exit from a handler where every
    // other outcome speaks: the validation branch above toasts, `onSuccess`
    // toasts `saved`, `onError` toasts `saveFailed`. Returning here sent no
    // request, showed no message and moved nothing on screen, and an operator
    // who has just spent real effort in the configurator cannot tell that apart
    // from a save that failed — which is how it gets reported ("settings do not
    // save"). `info`, not `error`: an empty patch is a legitimate outcome, so
    // this reports a no-op rather than blaming one. Same shape and same call as
    // `adminsPage.toast.noChanges` in `admins-page.tsx`, which already had it.
    //
    // Reaching this today takes a disagreement between two different notions of
    // "changed": the Save button is gated on react-hook-form's `isDirty`
    // (structural, against `defaultValues`) while the patch comes from
    // `getBrandingChangedFields` (semantic, against the loaded server draft).
    // While the two agree the button is disabled and this branch is dead —
    // which is exactly why it must not be a bare `return`: the day they diverge,
    // the symptom is a Save button that responds to nothing, with no clue left
    // behind for whoever has to reproduce it.
    if (result.fields.length === 0) {
      toast.info(t('brandingPage.noChanges'));
      return;
    }
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
    setGlobalBrandPalette(
      {
        primary: patch.primary,
        primaryFg: patch.primaryFg,
        bgPrimary: patch.bgPrimary,
        bgSecondary: patch.bgSecondary,
      },
      { detachFromConcept: false },
    );
    // Re-attach. A theme IS the palette's owner, so applying one must clear a
    // detachment left by an earlier hand-picked colour — otherwise the cabinet
    // keeps serving the old colours over the theme just selected.
    form.setValue("brandPaletteSource", "concept", { shouldDirty: true });
    setGlobalCardGradient(patch.cardGradient);
    form.setValue("bgEffect", patch.bgEffect, { shouldDirty: true });
    // A standard theme never touched the slots, so nothing here needed fixing
    // — but it repaints the global card just the same, and the operator is owed
    // the same explanation for why position 1 did not change with it.
    notifyPreservedCardSlots();
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
    applyConceptVisualPatch(patch);
  }

  /**
   * The public variant must be a complete renderable snapshot, including each
   * configured subscription-card position.  The operator still picks only one
   * concept: these are its two brightness representations, never a user theme
   * catalogue.
   *
   * Slots are copied from the live form (see `toThemeVariantCardSlots` for
   * what a snapshot may carry), for the same reason `subscriptionCardText` is:
   * a variant is a SNAPSHOT, and anything the operator owns that is missing
   * from it comes back wrong the moment the cabinet resolves the other
   * brightness.  Copying costs an inherit slot nothing — it holds no artwork of
   * its own, so it goes on resolving to whichever global artwork the variant
   * carries.  Rebuilding the array as all-inherit placeholders from a bare
   * COUNT is what silently emptied an overridden slot in both snapshots.
   */
  function createThemeVariantsWithSlots(
    preset: ConceptThemePreset,
  ): BrandingThemeVariantsDraft {
    const slots = form.getValues("cardEffectsByIndex") ?? [];
    const subscriptionCardText = form.getValues('subscriptionCardText');
    const variants = createConceptThemeModeVariants(preset, subscriptionCardText);
    const withSlots = (
      variant: (typeof variants)["light"],
    ): BrandingThemeVariantsDraft["light"] => ({
      ...variant,
      subscriptionCardText: { ...subscriptionCardText },
      cardEffectProps: { ...(variant.cardEffectProps ?? {}) },
      cardEffectsByIndex: toThemeVariantCardSlots(slots),
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
    /**
     * `true` while a concept is being applied, `false` while one of its two
     * brightness snapshots is being selected. Everything this function does
     * that a mere brightness change must NOT do keys off this flag.
     *
     * It is a parameter and not something sniffed off the payload, because the
     * payload cannot answer it. A variant built by `createThemeVariantsWithSlots`
     * still carries `themePresetId` — `createConceptThemePresetVisualPatch`
     * puts it there — and only stops carrying it once the API has stored and
     * re-read it (`readThemeVariant` rebuilds a canonical variant without it).
     * So `'themePresetId' in patch` answers "has this been saved yet", which is
     * not the question, and answers it differently for the same operator action
     * depending on whether a save happened in between.
     */
    isConceptApplication = true,
  ): void {
    const cardPatch: ConceptCardPresetVisualPatch = {
      cardGradient: patch.cardGradient,
      cardPattern: patch.cardPattern,
      cardEffect: patch.cardEffect,
      cardEffectProps: patch.cardEffectProps ?? {},
      cardEffectOpacity: patch.cardEffectOpacity,
    };
    if (isConceptApplication && 'themePresetId' in patch) {
      form.setValue("themePresetId", patch.themePresetId, { shouldDirty: true });
      form.setValue("themePresetVersion", patch.themePresetVersion, { shouldDirty: true });
      // Re-attach. A concept owns the palette, so applying one must clear a
      // detachment left by an earlier hand-picked colour — otherwise the
      // cabinet keeps serving those colours over the concept just selected.
      //
      // Deliberately gated: the other caller is the brightness selector.
      // Switching the default brightness is not a change of ownership, and
      // re-attaching there would silently discard the operator's palette.
      form.setValue("brandPaletteSource", "concept", { shouldDirty: true });
    }
    // Never detaching here is the point: this function only ever applies a
    // palette the concept itself supplied, whether from the preset or from one
    // of its two brightness snapshots.
    setGlobalBrandPalette(
      {
        primary: patch.primary,
        primaryFg: patch.primaryFg,
        bgPrimary: patch.bgPrimary,
        bgSecondary: patch.bgSecondary,
      },
      { detachFromConcept: false },
    );
    if ('subscriptionCardText' in patch) {
      form.setValue('subscriptionCardText', { ...patch.subscriptionCardText }, { shouldDirty: true });
    }
    if (isConceptApplication) {
      // Applying a concept must retain its separate light/dark card artwork.
      // Only an explicit card choice made afterwards becomes an operator
      // override across both variants.
      applyConceptCardPreset(cardPatch, false);
    } else {
      // Changing only the default brightness must not replace the animation
      // selected by the operator. The gradient still follows the selected
      // brightness, including its lightweight per-position fallback.
      //
      // `detachFromConcept: false` because selecting a brightness is not a
      // gradient decision, and the setter's default marks every write as one.
      // Left on, it pointed the SAME defect the other way: the operator touched
      // the mode dropdown, the gradient silently became "theirs", and a cabinet
      // user allowed to switch brightness then got the operator's default-mode
      // gradient in BOTH renderings — the concept's second gradient stopped
      // arriving. Whatever the marker already says is still true here: a
      // hand-written gradient was mirrored into both snapshots when it was
      // written, so the value arriving from either one is that same gradient.
      setGlobalCardGradient(cardPatch.cardGradient, {
        synchronizeThemeVariants: false,
        detachFromConcept: false,
      });
      setGlobalCardPattern(cardPatch.cardPattern, { synchronizeThemeVariants: false });
    }

    form.setValue("bgEffect", patch.bgEffect, { shouldDirty: true });
    // The app background and the semantic surfaces genuinely differ between the
    // two renderings of one concept, so a brightness change must repaint them.
    // Both are safe to copy from a snapshot because an operator edit is
    // mirrored INTO both snapshots first — surfaces by
    // `detachSurfaceThemeFromConcept`, the app background by
    // `setGlobalAppBackground` — so what comes back here is the operator's own
    // value, not the concept's stale one.
    form.setValue("appBackground", patch.appBackground, { shouldDirty: true });
    form.setValue("surfaceTheme", patch.surfaceTheme, { shouldDirty: true });
    // Typeface and geometry are NOT brightness tokens, and only applying a
    // concept may write them.
    //
    // SIXTH appearance of the defect this file keeps producing, and the first
    // one on the WRITE side. Reiwa already refuses to read these three from a
    // variant — `resolveBrandingThemeMode` pins `borderRadius`, `cornerRadii`
    // and `fontFamily` to the root because there is nothing per-mode about
    // them: the panel offers ONE font dropdown and ONE set of radius sliders,
    // not one per brightness, and `createOppositeConceptReiwaPreset` copies all
    // three unchanged into the opposite rendering. That fix repaired the read.
    // This line went on performing the identical overwrite one step earlier, in
    // the form: the operator set their font, saved it, later switched the
    // default brightness for an unrelated reason, and the concept's original
    // font was copied back over the root and saved on the next click. The
    // cabinet then served it faithfully — the value was genuinely gone, so
    // "root always wins" could not save it.
    //
    // Gating rather than deleting: applying a concept IS the concept taking
    // ownership of typography and geometry, and that path must keep writing
    // them. A brightness snapshot never has anything new to say here, so
    // skipping the write costs nothing and is what stops it from having
    // something OLD to say.
    if (isConceptApplication) {
      form.setValue("borderRadius", patch.borderRadius, { shouldDirty: true });
      form.setValue("cornerRadii", patch.cornerRadii, { shouldDirty: true });
      form.setValue("fontFamily", patch.fontFamily, { shouldDirty: true });
    }
  }

  /**
   * The site-wide app background belongs to the operator from the first manual
   * edit, and it needs a mirror rather than an ownership marker.
   *
   * It is a real per-brightness token — `buildAppBackground` composes it from
   * the mode's own background colour, so a concept ships a visibly different
   * one for each rendering, and `resolveBrandingThemeMode` reads it from the
   * variant. That is exactly the situation `cardGradientSource` exists for, and
   * the reason a marker is not needed on top: the API already resolves the
   * disagreement by mirroring a direct root edit into both snapshots on save
   * (`mergeBrandingSettings`, `hasDirectVisualPatch`). What was missing is the
   * same mirror HERE, and its absence was visible without saving anything —
   * the panel's own brightness selector copies a whole variant back onto the
   * root, so an operator who chose a background and then switched the default
   * mode watched the concept's background replace it in the form they were
   * looking at, and then saved that. Same reason
   * `synchronizeThemeVariantPalette` and `detachSurfaceThemeFromConcept` exist.
   */
  function setGlobalAppBackground(appBackground: BrandingAppBackgroundDraft): void {
    form.setValue("appBackground", appBackground, { shouldDirty: true });
    const variants = form.getValues("themeVariants");
    if (!variants) return;
    const synchronizeVariant = (variant: BrandingThemeVariantsDraft["light"]) => ({
      ...variant,
      appBackground,
    });
    form.setValue(
      "themeVariants",
      {
        light: synchronizeVariant(variants.light),
        dark: synchronizeVariant(variants.dark),
      },
      { shouldDirty: true },
    );
  }

  /**
   * Reiwa resolves a slot gradient independently from its effect mode. A
   * global gradient edit therefore leaves explicit slot gradients alone HERE:
   * those cards intentionally remain on their own artwork until the operator
   * resets the slot itself.
   *
   * The API used to do the opposite, and this comment used to warn that the
   * preservation stopped at the request body: a PATCH carrying `cardGradient`
   * without `cardEffectsByIndex` nulled every slot gradient, in the root array
   * and in both brightness snapshots. That rule is gone
   * (`rezeis-admin/src/modules/settings/utils/branding-settings.util.ts`), so
   * the gradients now survive the round trip. Its stated premise — "a root
   * gradient has no slot mode discriminator" — was false twice over:
   * `readCardEffectSlots` stamps a `mode` on every slot including legacy ones,
   * and reiwa resolves a slot gradient AHEAD of the global one without
   * consulting `mode` at all, so the rule was not clearing dead data, it was
   * deleting artwork the operator had picked by hand and could still see.
   *
   * `branding-page.test.tsx` covers the round trip with a PATCH double, so
   * reinstating the server rule turns that test red rather than silently
   * undoing this function again.
   */
  function setGlobalCardGradient(
    cardGradient: string,
    {
      synchronizeThemeVariants = true,
      detachFromConcept = true,
    }: {
      readonly synchronizeThemeVariants?: boolean
      readonly detachFromConcept?: boolean
    } = {},
  ): void {
    form.setValue("cardGradient", cardGradient, { shouldDirty: true });
    // A hand-written gradient detaches the concept. Without this the value
    // lands on the root, the concept's per-brightness copy keeps winning in
    // the cabinet, and the operator sees their choice in the panel preview and
    // nowhere else. Concept appliers set it back to `concept` explicitly; the
    // brightness selector, which writes a gradient the concept supplied and is
    // not a gradient decision at all, opts out with `detachFromConcept: false`.
    if (detachFromConcept) {
      form.setValue("cardGradientSource", "custom", { shouldDirty: true });
    }
    if (synchronizeThemeVariants) {
      synchronizeThemeVariantCardGradients(cardGradient);
    }
  }

  function readBrandPalette(): BrandPalette {
    return {
      primary: form.getValues("primary"),
      primaryFg: form.getValues("primaryFg"),
      bgPrimary: form.getValues("bgPrimary"),
      bgSecondary: form.getValues("bgSecondary"),
    };
  }

  /**
   * One colour changed by hand, but the whole quartet is written back.
   *
   * The palette is one design decision: `primary`/`primaryFg` is a contrast
   * pair and `bgPrimary`/`bgSecondary` a surface pair. Detaching only the
   * colour that was touched would leave the cabinet compositing two of the
   * operator's colours with two of the concept's — a palette nobody chose.
   */
  function setBrandPaletteColor(field: BrandPaletteField, value: string): void {
    setGlobalBrandPalette({ ...readBrandPalette(), [field]: value });
  }

  /**
   * A hand-picked colour detaches the concept, exactly as a hand-written card
   * gradient does. Without the marker the value lands on the root, the
   * concept's per-brightness copy keeps winning in the cabinet, and the
   * operator sees their colour in the panel preview and nowhere else. Preset
   * appliers pass `detachFromConcept: false` and re-attach explicitly.
   */
  function setGlobalBrandPalette(
    palette: BrandPalette,
    { detachFromConcept = true }: { readonly detachFromConcept?: boolean } = {},
  ): void {
    form.setValue("primary", palette.primary, { shouldDirty: true });
    form.setValue("primaryFg", palette.primaryFg, { shouldDirty: true });
    form.setValue("bgPrimary", palette.bgPrimary, { shouldDirty: true });
    form.setValue("bgSecondary", palette.bgSecondary, { shouldDirty: true });
    if (!detachFromConcept) return;
    form.setValue("brandPaletteSource", "custom", { shouldDirty: true });
    synchronizeThemeVariantPalette(palette);
  }

  /**
   * The marker alone already makes the cabinet serve the root palette. This
   * mirror exists for the panel's own brightness selector, which copies a
   * whole variant back onto the root: without it, an operator who picks their
   * colours and then switches the default brightness watches the concept's
   * palette overwrite their own, in the very form they just edited.
   */
  function synchronizeThemeVariantPalette(palette: BrandPalette): void {
    const variants = form.getValues("themeVariants");
    if (!variants) return;
    const synchronizeVariant = (variant: BrandingThemeVariantsDraft["light"]) => ({
      ...variant,
      ...palette,
    });
    form.setValue(
      "themeVariants",
      {
        light: synchronizeVariant(variants.light),
        dark: synchronizeVariant(variants.dark),
      },
      { shouldDirty: true },
    );
  }

  /**
   * `cardPattern` is part of the same operator-owned artwork as the gradient.
   * Keeping it in both brightness snapshots prevents a mode switch from
   * resurrecting the pattern that a later operator edit replaced.
   */
  function setGlobalCardPattern(
    cardPattern: string | null,
    { synchronizeThemeVariants = true }: { readonly synchronizeThemeVariants?: boolean } = {},
  ): void {
    form.setValue("cardPattern", cardPattern, { shouldDirty: true });
    if (!synchronizeThemeVariants) return;
    const variants = form.getValues("themeVariants");
    if (!variants) return;
    const synchronizeVariant = (variant: BrandingThemeVariantsDraft["light"]) => ({
      ...variant,
      cardPattern,
    });
    form.setValue(
      "themeVariants",
      {
        light: synchronizeVariant(variants.light),
        dark: synchronizeVariant(variants.dark),
      },
      { shouldDirty: true },
    );
  }

  /**
   * A manually selected card gradient is an operator override, not a
   * brightness token. Reiwa resolves the selected light/dark variant after
   * reading root settings, so both complete variant snapshots must receive
   * the same override too. Page palettes and explicit positional overrides
   * remain independent.
   */
  function synchronizeThemeVariantCardGradients(cardGradient: string): void {
    const variants = form.getValues('themeVariants');
    if (!variants) return;
    const synchronizeVariant = (variant: BrandingThemeVariantsDraft['light']) => ({
      ...variant,
      cardGradient,
    });
    form.setValue(
      'themeVariants',
      {
        light: synchronizeVariant(variants.light),
        dark: synchronizeVariant(variants.dark),
      },
      { shouldDirty: true },
    );
  }

  function applyConceptCardPreset(
    patch: ConceptCardPresetVisualPatch,
    synchronizeThemeVariants = true,
  ): void {
    // Page colors/background, geometry and navigation stay untouched.
    setGlobalCardGradient(patch.cardGradient, { synchronizeThemeVariants });
    setGlobalCardPattern(patch.cardPattern, { synchronizeThemeVariants });
    // Re-attach: `setGlobalCardGradient` marks every write as a manual edit,
    // which is right for the swatches and the constructor and wrong here — a
    // preset IS the concept, so its per-brightness palettes must go on
    // applying. This line must follow the setter, not precede it.
    form.setValue("cardGradientSource", "concept", { shouldDirty: true });
    form.setValue("cardEffect", patch.cardEffect, { shouldDirty: true });
    form.setValue("cardEffectProps", { ...patch.cardEffectProps }, { shouldDirty: true });
    form.setValue("cardEffectOpacity", patch.cardEffectOpacity, { shouldDirty: true });

    // `cardEffectsByIndex` is deliberately NOT written here.
    //
    // A slot has two independent axes, and each already has an "inherit"
    // state: the effect axis (`mode`) and the gradient axis (`cardGradient ===
    // null`). Anything left on inherit holds no artwork of its own and so
    // resolves through the globals this function just replaced — it follows
    // the preset for free, with nothing to rewrite. Anything else is an
    // explicit operator decision, and applying a preset is not a request to
    // delete it.
    //
    // The blanket reset that used to live here was justified by "stale hidden
    // slot values would keep rendering after the selected preset". Nothing can
    // render them: this section (`slot.mode === 'override'`), the preview
    // (`slot?.mode === 'override'`) and the API's `readCardEffectSlots`, which
    // rewrites every non-override slot to `{ mode, cardGradient }` and drops
    // its effect/props/opacity outright, all gate the artwork on the same
    // discriminator. Legacy slots carrying an effect with no `mode` are
    // therefore already inert everywhere and already follow the preset.
    //
    // Nor can a surviving override hold a value a preset invalidates: the slot
    // effect is validated against the fixed `BRANDING_CARD_EFFECT_SET`
    // catalog, props are per-effect, opacity is clamped to 0.05..1 and the
    // gradient is checked as CSS. None of the four is preset-scoped, so there
    // is no such thing as "invalid under this theme" — only "the operator may
    // not like it next to the new palette", which is their call to make and
    // which the per-slot preview page now shows them.
    notifyPreservedCardSlots();
  }

  /**
   * A preset repaints the global card; slots holding their own artwork stay
   * put. That is the intended contract, but it is invisible — the operator
   * clicks a preset, swipes to card 1, sees the old artwork and concludes the
   * preset did not apply. Say it once, with the count, and point at the block
   * that can reset it. Silent when nothing was held back.
   */
  function notifyPreservedCardSlots(): void {
    const preserved = (form.getValues("cardEffectsByIndex") ?? []).filter(
      (slot) =>
        slot.mode === "override" || (slot.cardGradient ?? "").trim().length > 0,
    ).length;
    if (preserved === 0) return;
    toast.info(
      t('brandingPage.sections.cardEffectSlots.presetKeptSlots', {
        count: preserved,
      }),
    );
  }

  function generateGradient(): void {
    const primary = form.getValues("primary");
    setGlobalCardGradient(gradientFromPrimary(primary));
  }

  /**
   * Brightness variants are full Reiwa snapshots. Keep the one global control
   * mirrored into both so changing the user-visible brightness never silently
   * restores an old card-text decision.
   */
  function setSubscriptionCardText(
    value: BrandingFormDraft['subscriptionCardText'],
  ): void {
    form.setValue('subscriptionCardText', value, { shouldDirty: true });
    const variants = form.getValues('themeVariants');
    if (!variants) return;
    form.setValue(
      'themeVariants',
      {
        light: { ...variants.light, subscriptionCardText: { ...value } },
        dark: { ...variants.dark, subscriptionCardText: { ...value } },
      },
      { shouldDirty: true },
    );
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
                              applyConceptVisualPatch(variant, false);
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
                  <ColorField
                    label={t('brandingPage.sections.colors.primary')}
                    name="primary"
                    form={form}
                    onChange={(value) => setBrandPaletteColor('primary', value)}
                  />
                  <ColorField
                    label={t('brandingPage.sections.colors.primaryFg')}
                    name="primaryFg"
                    form={form}
                    onChange={(value) => setBrandPaletteColor('primaryFg', value)}
                  />
                  <ColorField
                    label={t('brandingPage.sections.colors.background')}
                    name="bgPrimary"
                    form={form}
                    onChange={(value) => setBrandPaletteColor('bgPrimary', value)}
                  />
                  <ColorField
                    label={t('brandingPage.sections.colors.surface')}
                    name="bgSecondary"
                    form={form}
                    onChange={(value) => setBrandPaletteColor('bgSecondary', value)}
                  />
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
                    <Label htmlFor="borderRadius">
                      {t('brandingPage.sections.effects.borderRadius')}
                    </Label>
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
                          <SelectTrigger id="borderRadius">
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
                    <Label htmlFor="fontFamily">
                      {t('brandingPage.sections.effects.fontFamily')}
                    </Label>
                    <Controller
                      name="fontFamily"
                      control={form.control}
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id="fontFamily">
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
                    onApply={(_preset, patch) => applyConceptCardPreset(patch)}
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
                          // Third silent exit of the same shape, and the odd
                          // one out in its own handler: the other two ways out
                          // below both toast (`saveExists`, `saved`). An empty
                          // gradient box is visible on screen, so this is the
                          // mildest of the three — but "I pressed the button
                          // and nothing happened" reads identically whatever
                          // the reason, and staying silent here is what makes
                          // the operator doubt the button rather than the box.
                          if (css.length === 0) {
                            toast.info(t('brandingPage.sections.card.saveEmpty'));
                            return;
                          }
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
                              onClick={() => setGlobalCardGradient(preset.value)}
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
                                onClick={() => setGlobalCardGradient(css)}
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
                        onChange={setGlobalCardGradient}
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
                        onChange={(event) => setGlobalCardGradient(event.target.value)}
                        onBlur={field.onBlur}
                        className="font-mono text-xs"
                        placeholder={t('brandingPage.sections.card.gradientPlaceholder')}
                      />
                    )}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cardPattern">{t('brandingPage.sections.card.pattern')}</Label>
                  <Controller
                    name="cardPattern"
                    control={form.control}
                    render={({ field }) => (
                      <Input
                        id="cardPattern"
                        value={field.value ?? ""}
                        onChange={(event) =>
                          setGlobalCardPattern(event.target.value.trim() || null)
                        }
                        onBlur={field.onBlur}
                        className="font-mono text-xs"
                        placeholder={t('brandingPage.sections.card.patternPlaceholder')}
                      />
                    )}
                  />
                </div>
                <Controller
                  name="subscriptionCardText"
                  control={form.control}
                  render={({ field }) => (
                    <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-3">
                      <div className="space-y-1">
                        <Label htmlFor="subscriptionCardTextMode">
                          {t('brandingPage.sections.card.textMode')}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t('brandingPage.sections.card.textModeHint')}
                        </p>
                      </div>
                      <Select
                        value={field.value.mode}
                        onValueChange={(mode) =>
                          setSubscriptionCardText({
                            ...field.value,
                            mode: mode as BrandingFormDraft['subscriptionCardText']['mode'],
                            color: mode === 'custom' ? field.value.color : null,
                          })
                        }
                      >
                        <SelectTrigger id="subscriptionCardTextMode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">
                            {t('brandingPage.sections.card.textModes.auto')}
                          </SelectItem>
                          <SelectItem value="light">
                            {t('brandingPage.sections.card.textModes.light')}
                          </SelectItem>
                          <SelectItem value="dark">
                            {t('brandingPage.sections.card.textModes.dark')}
                          </SelectItem>
                          <SelectItem value="custom">
                            {t('brandingPage.sections.card.textModes.custom')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {field.value.mode === 'custom' && (
                        <div className="space-y-2">
                          <Label htmlFor="subscriptionCardTextColor">
                            {t('brandingPage.sections.card.textColor')}
                          </Label>
                          <Input
                            id="subscriptionCardTextColor"
                            value={field.value.color ?? ''}
                            onChange={(event) =>
                              setSubscriptionCardText({
                                ...field.value,
                                color: event.target.value || null,
                              })
                            }
                            aria-invalid={!!form.formState.errors.subscriptionCardText?.color}
                            className="font-mono text-xs"
                            placeholder="#ffffff"
                          />
                          <FieldError message={form.formState.errors.subscriptionCardText?.color?.message} />
                          <p className="text-[11px] text-muted-foreground">
                            {t('brandingPage.sections.card.textColorHint')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                />
                <Controller
                  name="subscriptionCardGlass"
                  control={form.control}
                  render={({ field }) => (
                    <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <Label htmlFor="subscriptionCardGlassEnabled">
                            {t('brandingPage.sections.card.glass.title')}
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            {t('brandingPage.sections.card.glass.description')}
                          </p>
                        </div>
                        <Switch
                          id="subscriptionCardGlassEnabled"
                          checked={field.value.enabled}
                          onCheckedChange={(enabled) =>
                            field.onChange({ ...field.value, enabled })
                          }
                          aria-label={t('brandingPage.sections.card.glass.title')}
                        />
                      </div>
                      {field.value.enabled && (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="subscriptionCardGlassTint" className="text-xs">
                              {t('brandingPage.sections.card.glass.tint')}
                            </Label>
                            <input
                              id="subscriptionCardGlassTint"
                              type="color"
                              value={field.value.tint}
                              onChange={(event) =>
                                field.onChange({ ...field.value, tint: event.target.value })
                              }
                              className="h-8 w-full cursor-pointer rounded border bg-transparent"
                            />
                          </div>
                          <CardGlassSlider
                            label={t('brandingPage.sections.card.glass.opacity')}
                            value={field.value.opacity}
                            min={0}
                            max={1}
                            step={0.01}
                            format={(value) => `${Math.round(value * 100)}%`}
                            onChange={(opacity) => field.onChange({ ...field.value, opacity })}
                          />
                          <CardGlassSlider
                            label={t('brandingPage.sections.card.glass.blur')}
                            value={field.value.blurPx}
                            min={0}
                            max={40}
                            step={1}
                            format={(value) => `${value}px`}
                            onChange={(blurPx) => field.onChange({ ...field.value, blurPx })}
                          />
                          <CardGlassSlider
                            label={t('brandingPage.sections.card.glass.border')}
                            value={field.value.borderOpacity}
                            min={0}
                            max={1}
                            step={0.01}
                            format={(value) => `${Math.round(value * 100)}%`}
                            onChange={(borderOpacity) =>
                              field.onChange({ ...field.value, borderOpacity })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )}
                />
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

            {/* Animated card background effect.
                This is the ONE place a live tile renderer is allowed: the
                global effect exists once, so `livePreview` here costs a single
                context. The per-position slots below deliberately take no such
                prop — passing the same flag to a section that renders one
                picker per slot is what put ~23 live WebGL contexts on this tab
                and pushed iOS past its ceiling. */}
            <Controller
              name="cardEffect"
              control={form.control}
              render={({ field }) => (
                <CardEffectSection
                  effect={field.value}
                  props={watchedValues.cardEffectProps ?? {}}
                  opacity={watchedValues.cardEffectOpacity ?? 1}
                  livePreview={tab === 'card'}
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
                  // Not `field.onChange`: the write has to reach both brightness
                  // snapshots as well as the root — see `setGlobalAppBackground`.
                  onChange={setGlobalAppBackground}
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
          {/* Kept mounted like the rest of this tab — `gate()` hides it with a
              class. Unmounting it discarded every expanded row on each tab
              visit, so a plan the operator was midway through configuring
              collapsed the moment they glanced at another tab and came back;
              the accordion state lives inside `PlanStyleRow`, so lifting it
              would not have helped while the section above it still died.

              Nothing here pays for that unmount. The thumbs are CSS-only, and
              `PlanCardStylesSection` passes `livePreview={false}` to every
              `CardEffectPicker` — `card-effect-section.tsx` gates the WebGL
              layer on `isActive && livePreview`, so no context is ever created
              whether a row is open or shut. The plan list costs nothing extra
              either: `BrandingPreview` already holds the `usePlans()`
              subscription on every tab. Compare the `card` tab above, which
              keeps its stateful section mounted and gates only the renderer. */}
          <div className={gate('planCards')}>
            <Controller
              name="planCardStyles"
              control={form.control}
              render={({ field }) => (
                <PlanCardStylesSection
                  value={(field.value ?? {}) as Record<string, PlanCardStyleDraft>}
                  onChange={(next) => field.onChange(next)}
                  primary={watchedValues.primary}
                  // The baseline every tariff card inherits. Watched, not read
                  // once: changing the global card text must move every
                  // inheriting tariff thumb in the same render.
                  subscriptionCardText={watchedValues.subscriptionCardText}
                />
              )}
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

/**
 * Both inputs report through `onChange` rather than writing the field.
 *
 * The hex box used to be a bare `form.register(name)`, which writes straight to
 * the root field and to nothing else. That is the whole reported defect: the
 * colour never got marked as the operator's, so the concept's brightness
 * snapshot overwrote it on every read in the cabinet. Overriding `onChange`
 * after the spread keeps register's `name`/`onBlur`/`ref` — the value still
 * reaches the form, just through the setter that also records who owns it.
 */
function ColorField({
  label,
  name,
  form,
  onChange,
}: {
  label: string;
  name: BrandPaletteField;
  form: UseFormReturn<BrandingFormDraft, unknown, BrandingFormData>;
  onChange: (value: string) => void;
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
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label={t('brandingPage.sections.colors.colorPickerAria', { name: label })}
          />
        </label>
        <Input
          id={textInputId}
          {...form.register(name)}
          onChange={(e) => onChange(e.target.value)}
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

/**
 * A hand-edited surface value detaches the concept, through the SAME marker a
 * hand-picked brand colour uses — `brandPaletteSource`, not a marker of its own.
 *
 * `surfaceTheme` carries the FOREGROUND colours; the background behind them is
 * `bgPrimary`/`bgSecondary`, which that marker already governs. Two markers
 * would let the halves disagree about ownership, and a detached palette would
 * then compose the operator's background with the concept's text — the
 * operator's dark surface under the light concept's dark foreground. Not a
 * degraded result, an unreadable one. The reasoning is written out in full on
 * `Branding.brandPaletteSource` in reiwa's `types/branding.ts`, next to the
 * resolver that acts on it.
 *
 * Written as a free function taking the form rather than a prop threaded
 * through eleven call sites: the two field components already own the write, so
 * the detachment belongs beside it and cannot be forgotten at a call site.
 */
function detachSurfaceThemeFromConcept(
  form: UseFormReturn<BrandingFormDraft, unknown, BrandingFormData>,
): void {
  form.setValue('brandPaletteSource', 'custom', { shouldDirty: true })
  // The marker alone already makes the cabinet serve the root surfaces. This
  // mirror is for the panel's own brightness selector, which copies a whole
  // variant back onto the root: without it an operator who edits a surface and
  // then switches the default brightness watches the concept overwrite the edit
  // in the very form they are looking at. Same reason `synchronizeThemeVariantPalette`
  // exists for the four colours.
  const variants = form.getValues('themeVariants')
  if (!variants) return
  const surfaceTheme = form.getValues('surfaceTheme')
  const synchronizeVariant = (variant: BrandingThemeVariantsDraft['light']) => ({
    ...variant,
    surfaceTheme,
  })
  form.setValue(
    'themeVariants',
    {
      light: synchronizeVariant(variants.light),
      dark: synchronizeVariant(variants.dark),
    },
    { shouldDirty: true },
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
  const registration = form.register(path);

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex items-center gap-2">
        <label className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border">
          <span className="absolute inset-0" style={{ backgroundColor: value || '#000000' }} />
          <input
            type="color"
            value={value || '#000000'}
            onChange={(event) => {
              form.setValue(path, event.target.value, { shouldDirty: true })
              detachSurfaceThemeFromConcept(form)
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label={label}
          />
        </label>
        <Input
          id={inputId}
          {...registration}
          // `register` writes straight to the field, past any setter — so the
          // hex box needs its own detachment or it stays the one control whose
          // edits never reach the cabinet. `onChange` comes AFTER the spread on
          // purpose; before it, the registration's own handler wins and this
          // never runs.
          onChange={(event) => {
            void registration.onChange(event)
            detachSurfaceThemeFromConcept(form)
          }}
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
        onValueChange={(next) => {
          form.setValue(path, next[0] ?? value, { shouldDirty: true })
          // The opacities and the blur ride with the surface colours rather
          // than staying attached: they are one object, and a half-owned
          // `surfaceTheme` is the same split this fix exists to remove.
          detachSurfaceThemeFromConcept(form)
        }}
      />
    </div>
  );
}

function CardGlassSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly format: (value: number) => string
  readonly onChange: (value: number) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        <span className="font-mono text-xs text-muted-foreground">{format(value)}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(next[0] ?? value)}
        aria-label={label}
      />
    </div>
  )
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
