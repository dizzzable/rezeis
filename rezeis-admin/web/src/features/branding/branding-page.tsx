/**
 * BrandingPage
 * ────────────
 * Admin configurator for the user-facing branding (reiwa SPA).
 */

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useTranslation } from 'react-i18next';
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paintbrush, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";


import { BrandingPreview } from "./branding-preview";

// ── Schema ──────────────────────────────────────────────────────────────────

const hexPattern = /^#([0-9a-fA-F]{3,8})$/;

function useBrandingSchema() {
  const { t } = useTranslation();
  const hexMessage = t('brandingPage.invalidHex');
  return z.object({
    brandName: z.string().min(1).max(64),
    logoUrl: z.string().max(8192).optional().nullable(),
    primary: z.string().regex(hexPattern, hexMessage),
    primaryFg: z.string().regex(hexPattern, hexMessage),
    bgPrimary: z.string().regex(hexPattern, hexMessage),
    bgSecondary: z.string().regex(hexPattern, hexMessage),
    cardGradient: z.string().min(1).max(512),
    cardPattern: z.string().max(8192).optional().nullable(),
    bgEffect: z.enum(["NONE", "MESH", "PARTICLES", "NOISE", "AURORA"]),
    borderRadius: z.string().min(1).max(64),
    fontFamily: z.string().min(1).max(256),
  });
}

type BrandingFormValues = z.infer<ReturnType<typeof useBrandingSchema>>;

const BG_EFFECT_VALUES = ["NONE", "MESH", "PARTICLES", "NOISE", "AURORA"] as const;
const BORDER_RADIUS_VALUES = [
  { value: "rounded-none", labelKey: "brandingPage.radiusOptions.none" },
  { value: "rounded-lg", labelKey: "brandingPage.radiusOptions.lg" },
  { value: "rounded-xl", labelKey: "brandingPage.radiusOptions.xl" },
  { value: "rounded-2xl", labelKey: "brandingPage.radiusOptions.2xl" },
  { value: "rounded-3xl", labelKey: "brandingPage.radiusOptions.3xl" },
  { value: "rounded-full", labelKey: "brandingPage.radiusOptions.full" },
] as const;

// ── API ─────────────────────────────────────────────────────────────────────

async function fetchBranding(): Promise<BrandingFormValues> {
  const { data } = await api.get("/admin/settings/branding");
  return data;
}

async function updateBranding(values: Partial<BrandingFormValues>): Promise<BrandingFormValues> {
  const { data } = await api.patch("/admin/settings/branding", values);
  return data;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function BrandingPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const brandingSchema = useBrandingSchema();

  const { data: branding, isLoading } = useQuery({
    queryKey: ["admin", "branding"],
    queryFn: fetchBranding,
    staleTime: 60_000,
  });

  const form = useForm<BrandingFormValues>({
    resolver: zodResolver(brandingSchema),
    defaultValues: {
      brandName: "Rezeis",
      primary: "#22c55e",
      primaryFg: "#0a0a0a",
      bgPrimary: "#0a0a0a",
      bgSecondary: "#171717",
      cardGradient: "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
      cardPattern: null,
      bgEffect: "NONE",
      borderRadius: "rounded-2xl",
      fontFamily: "Inter, system-ui, sans-serif",
      logoUrl: null,
    },
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

  // eslint-disable-next-line react-hooks/incompatible-library -- react-hook-form watch() pattern
  const watchedValues = form.watch();

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

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

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('brandingPage.sections.identity.title')}</CardTitle>
              <CardDescription>{t('brandingPage.sections.identity.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="brandName">{t('brandingPage.sections.identity.brandName')}</Label>
                <Input id="brandName" {...form.register("brandName")} placeholder={t('brandingPage.sections.identity.brandNamePlaceholder')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="logoUrl">{t('brandingPage.sections.identity.logoUrl')}</Label>
                <Input id="logoUrl" {...form.register("logoUrl")} placeholder={t('brandingPage.sections.identity.logoUrlPlaceholder')} />
              </div>
            </CardContent>
          </Card>

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
              <CardTitle>{t('brandingPage.sections.card.title')}</CardTitle>
              <CardDescription>{t('brandingPage.sections.card.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cardGradient">{t('brandingPage.sections.card.gradient')}</Label>
                <Input
                  id="cardGradient"
                  {...form.register("cardGradient")}
                  placeholder={t('brandingPage.sections.card.gradientPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cardPattern">{t('brandingPage.sections.card.pattern')}</Label>
                <Input
                  id="cardPattern"
                  {...form.register("cardPattern")}
                  placeholder={t('brandingPage.sections.card.patternPlaceholder')}
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
                  <Label>{t('brandingPage.sections.effects.bgEffect')}</Label>
                  <Controller
                    name="bgEffect"
                    control={form.control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BG_EFFECT_VALUES.map((v) => (
                            <SelectItem key={v} value={v}>
                              {t(`brandingPage.bgEffects.${v}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
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
              </div>
              <div className="space-y-2">
                <Label htmlFor="fontFamily">{t('brandingPage.sections.effects.fontFamily')}</Label>
                <Input
                  id="fontFamily"
                  {...form.register("fontFamily")}
                  placeholder={t('brandingPage.sections.effects.fontFamilyPlaceholder')}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>{t('brandingPage.sections.preview.title')}</CardTitle>
              <CardDescription>{t('brandingPage.sections.preview.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <BrandingPreview values={watchedValues} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ColorField({
  label,
  name,
  form,
}: {
  label: string;
  name: keyof BrandingFormValues;
  form: ReturnType<typeof useForm<BrandingFormValues>>;
}) {
  const value = form.watch(name) as string;
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <label className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border overflow-hidden">
          <span className="absolute inset-0" style={{ backgroundColor: value || "#000" }} />
          <input
            type="color"
            value={value || "#000000"}
            onChange={(e) => form.setValue(name, e.target.value, { shouldDirty: true })}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        <Input
          {...form.register(name)}
          className="font-mono text-xs"
          placeholder="#22c55e"
        />
      </div>
    </div>
  );
}
