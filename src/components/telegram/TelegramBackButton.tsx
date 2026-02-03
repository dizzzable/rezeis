/**
 * TelegramBackButton Component
 * Wrapper component for Telegram WebApp BackButton
 */

import { useEffect, useRef } from 'react';
import { isInTelegram, showBackButton, hideBackButton } from '@/services/telegram';

/**
 * TelegramBackButton props interface
 */
interface TelegramBackButtonProps {
  /** Whether button is visible */
  isVisible: boolean;
  /** Click handler */
  onClick: () => void;
}

/**
 * Telegram Back Button component
 * Displays a native Telegram back button when running in Telegram WebApp
 */
export function TelegramBackButton({
  isVisible,
  onClick,
}: TelegramBackButtonProps): React.ReactElement | null {
  const callbackRef = useRef(onClick);

  // Update callback ref
  useEffect(() => {
    callbackRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!isInTelegram()) {
      return;
    }

    if (!isVisible) {
      hideBackButton();
      return;
    }

    // Show back button with callback wrapper
    showBackButton(() => {
      callbackRef.current();
    });

    return () => {
      hideBackButton();
    };
  }, [isVisible]);

  // Don't render anything - BackButton is handled by Telegram native UI
  return null;
}

export default TelegramBackButton;
