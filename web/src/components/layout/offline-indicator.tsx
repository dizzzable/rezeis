/**
 * OfflineIndicator
 * ────────────────
 * Tiny banner that appears above the page content when the browser reports
 * itself as offline. The status is read from `navigator.onLine` and updated
 * on `online`/`offline` events.
 *
 * The component is intentionally side-effect free: it never refetches
 * queries or mutates app state. React Query's built-in `online` mode and
 * `useRealtimeUpdates`'s reconnection logic already handle recovery once
 * connectivity returns.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';

export function OfflineIndicator() {
  const { t } = useTranslation();
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs font-medium text-destructive"
    >
      <WifiOff className="h-3.5 w-3.5" aria-hidden />
      <span>{t('offlineBanner.message')}</span>
    </div>
  );
}
