/**
 * BrandingPreview
 * ───────────────
 * Live preview of the subscription card as it would appear in the reiwa SPA.
 */

import { useTranslation } from 'react-i18next';
import { Wifi } from "lucide-react";

interface BrandingPreviewProps {
  values: {
    brandName?: string;
    primary?: string;
    primaryFg?: string;
    bgPrimary?: string;
    bgSecondary?: string;
    cardGradient?: string;
    cardPattern?: string | null;
    fontFamily?: string;
    borderRadius?: string;
  };
}

export function BrandingPreview({ values }: BrandingPreviewProps) {
  const { t } = useTranslation();
  const {
    brandName = "Rezeis",
    primary = "#22c55e",
    primaryFg = "#0a0a0a",
    bgPrimary = "#0a0a0a",
    bgSecondary = "#171717",
    cardGradient = "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
    cardPattern,
    fontFamily = "Inter, system-ui, sans-serif",
    borderRadius = "rounded-2xl",
  } = values;

  // Map Tailwind token to px for inline style
  const radiusMap: Record<string, string> = {
    "rounded-none": "0",
    "rounded-lg": "0.5rem",
    "rounded-xl": "0.75rem",
    "rounded-2xl": "1rem",
    "rounded-3xl": "1.5rem",
    "rounded-full": "9999px",
  };
  const radius = radiusMap[borderRadius] ?? "1rem";

  return (
    <div className="flex flex-col items-center">
      {/* Phone frame */}
      <div
        className="relative w-[280px] overflow-hidden rounded-4xl border border-zinc-700 shadow-2xl"
        style={{ backgroundColor: bgPrimary, fontFamily }}
      >
        {/* Status bar */}
        <div className="flex items-center justify-between px-5 pt-3 pb-2">
          <span className="text-[10px] text-white/50">9:41</span>
          <span className="text-[10px] text-white/50">●●●</span>
        </div>

        {/* Content area */}
        <div className="px-4 pb-6 space-y-4">
          {/* Header */}
          <p className="text-[11px] text-white/40 uppercase tracking-wider">
            {brandName}
          </p>

          {/* Subscription card */}
          <div
            className="relative overflow-hidden p-4"
            style={{
              backgroundImage: cardGradient,
              backgroundColor: primary,
              borderRadius: radius,
            }}
          >
            {/* Pattern overlay */}
            {cardPattern && cardPattern !== "none" && (
              <div
                className="absolute inset-0 opacity-40 pointer-events-none"
                style={{ backgroundImage: cardPattern }}
              />
            )}
            <div className="relative z-10 flex flex-col gap-3 text-white">
              {/* Top row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Wifi className="h-3 w-3 opacity-80" />
                  <span className="text-[11px] font-semibold opacity-90">{brandName}</span>
                </div>
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-[8px] font-bold uppercase">
                  {t('brandingPage.sections.preview.statusLabel')}
                </span>
              </div>

              {/* Profile ID */}
              <p className="font-mono text-sm tracking-wider opacity-70">
                usr_a1b2c3d4e5f6
              </p>

              {/* Bottom row */}
              <div className="flex items-end justify-between pt-2">
                <div>
                  <p className="text-[8px] uppercase opacity-50">{t('brandingPage.sections.preview.expires')}</p>
                  <p className="text-[11px] font-semibold">03/2026</p>
                </div>
                <div className="text-right">
                  <p className="text-[8px] uppercase opacity-50">{t('brandingPage.sections.preview.device')}</p>
                  <p className="text-[11px] font-medium">iPhone 15</p>
                </div>
              </div>
            </div>
          </div>

          {/* Action buttons preview */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { key: 'buy', label: t('brandingPage.sections.preview.actions.buy') },
              { key: 'connect', label: t('brandingPage.sections.preview.actions.connect') },
              { key: 'upgrade', label: t('brandingPage.sections.preview.actions.upgrade') },
            ].map((item) => (
              <div
                key={item.key}
                className="flex flex-col items-center gap-1 rounded-xl border border-white/10 py-2"
                style={{ backgroundColor: `${bgSecondary}80` }}
              >
                <div
                  className="h-4 w-4 rounded-full"
                  style={{ backgroundColor: primary }}
                />
                <span className="text-[9px] text-white/60">{item.label}</span>
              </div>
            ))}
          </div>

          {/* Bottom nav preview */}
          <div
            className="flex items-center justify-around rounded-full border border-white/10 py-2"
            style={{ backgroundColor: `${bgSecondary}cc` }}
          >
            <div className="flex items-center gap-1 rounded-full px-3 py-1" style={{ backgroundColor: primary }}>
              <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: primaryFg }} />
              <span className="text-[8px] font-medium" style={{ color: primaryFg }}>{t('brandingPage.sections.preview.nav')}</span>
            </div>
            <div className="h-3 w-3 rounded-full bg-white/20" />
            <div className="h-3 w-3 rounded-full bg-white/20" />
          </div>
        </div>
      </div>

      {/* Legend */}
      <p className="mt-3 text-xs text-muted-foreground text-center">
        {t('brandingPage.sections.preview.liveLabel')}
      </p>
    </div>
  );
}
