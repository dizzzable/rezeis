import { lazy, Suspense, useEffect, type JSX, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppearanceProvider } from "@/components/AppearanceProvider";
import { EffectsProvider } from "@/components/EffectsProvider";
import { GlassBackground } from "@/components/glass/GlassBackground";
import { LiquidGlassFilters } from "@/components/glass/LiquidGlassFilters";
import { LiquidGlassMotion } from "@/components/glass/LiquidGlassMotion";
import { I18nProvider } from "@/i18n/provider";
import { LocaleBootstrapper } from "@/i18n/locale-bootstrapper";
import { AuthProvider } from "@/features/auth/auth-provider";
import { queryClient } from "@/lib/query-client";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import { MotionRoot } from "@/lib/motion";
import { installClientLogger } from "@/lib/client-logger";

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() => import("@tanstack/react-query-devtools").then((m) => ({ default: m.ReactQueryDevtools })))
  : null;

interface ProvidersProps {
  readonly children: ReactNode;
}

export function Providers({ children }: ProvidersProps): JSX.Element {
  useEffect(() => {
    installClientLogger();
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppearanceProvider>
          <MotionRoot>
            <I18nProvider>
              <LocaleBootstrapper>
                <TooltipProvider delayDuration={300}>
                  <AuthProvider>
                    <GlassBackground />
                    <LiquidGlassFilters />
                    <LiquidGlassMotion />
                    <EffectsProvider>
                      {children}
                    </EffectsProvider>
                    <Toaster richColors position="top-right" closeButton />
                    {ReactQueryDevtools ? (
                      <Suspense fallback={null}>
                        <ReactQueryDevtools initialIsOpen={false} />
                      </Suspense>
                    ) : null}
                  </AuthProvider>
                </TooltipProvider>
              </LocaleBootstrapper>
            </I18nProvider>
          </MotionRoot>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
