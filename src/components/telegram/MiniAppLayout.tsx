/**
 * MiniAppLayout Component
 * Layout optimized for Telegram Mini App
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { initTelegramApp, isInTelegram } from '@/services/telegram';
import { initTelegramTheme } from '@/services/telegram-theme';
import { TelegramBackButton } from './TelegramBackButton';
import { cn } from '@/lib/utils';

/**
 * MiniAppLayout props interface
 */
interface MiniAppLayoutProps {
  /** Children content */
  children: React.ReactNode;
  /** Page title */
  title?: string;
  /** Whether to show back button */
  showBackButton?: boolean;
  /** Back button click handler (defaults to navigate(-1)) */
  onBackClick?: () => void;
  /** Container className */
  className?: string;
  /** Content className */
  contentClassName?: string;
}

/**
 * Mini App Layout component
 * Optimized layout for Telegram Mini App with theme integration
 */
export function MiniAppLayout({
  children,
  title,
  showBackButton = false,
  onBackClick,
  className = '',
  contentClassName = '',
}: MiniAppLayoutProps): React.ReactElement {
  const navigate = useNavigate();

  useEffect(() => {
    if (isInTelegram()) {
      // Initialize Telegram WebApp
      initTelegramApp();

      // Initialize theme
      const unsubscribe = initTelegramTheme();

      // Update document title if provided
      if (title) {
        document.title = title;
      }

      return () => {
        unsubscribe();
      };
    }
  }, [title]);

  const handleBackClick = (): void => {
    if (onBackClick) {
      onBackClick();
    } else {
      navigate(-1);
    }
  };

  return (
    <div
      className={cn(
        'min-h-screen bg-background',
        // Use Telegram theme colors when available
        '[&_[style*="--tg-bg-color"]]:bg-[var(--tg-bg-color)]',
        '[&_[style*="--tg-text-color"]]:text-[var(--tg-text-color)]',
        className
      )}
    >
      {/* Telegram Back Button */}
      <TelegramBackButton isVisible={showBackButton} onClick={handleBackClick} />

      {/* Main content */}
      <main className={cn('flex-1', contentClassName)}>
        {children}
      </main>
    </div>
  );
}

export default MiniAppLayout;
