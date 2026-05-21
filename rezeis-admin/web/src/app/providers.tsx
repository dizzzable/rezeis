import type { JSX, ReactNode } from "react";
import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppearanceProvider } from "@/components/AppearanceProvider";
import { I18nProvider } from "@/i18n/provider";
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
    <ThemeProvider>
      <AppearanceProvider>
        <MotionRoot>
          <I18nProvider>
            <QueryClientProvider client={queryClient}>
              <TooltipProvider delayDuration={300}>
                {children}
                <Toaster richColors position="top-right" closeButton />
              </TooltipProvider>
            </QueryClientProvider>
          </I18nProvider>
        </MotionRoot>
      </AppearanceProvider>
    </ThemeProvider>
  );
}
