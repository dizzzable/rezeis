import type { JSX, ReactNode } from "react";
import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppearanceProvider } from "@/components/AppearanceProvider";
import { EffectsProvider } from "@/components/EffectsProvider";
import { GlassBackground } from "@/components/glass/GlassBackground";
import { I18nProvider } from "@/i18n/provider";
import { LocaleBootstrapper } from "@/i18n/locale-bootstrapper";
import { AuthProvider } from "@/features/auth/auth-provider";
import { queryClient } from "@/lib/query-client";
import { ThemeProvider } from "@/lib/theme/theme-provider";
import { MotionRoot } from "@/lib/motion";
import { installClientLogger } from "@/lib/client-logger";

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
                    <EffectsProvider>
                      {children}
                    </EffectsProvider>
                    <Toaster richColors position="top-right" closeButton />
                    <ReactQueryDevtools initialIsOpen={false} />
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
