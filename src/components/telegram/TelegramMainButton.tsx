/**
 * TelegramMainButton Component
 * Wrapper component for Telegram WebApp MainButton
 */

import { useEffect, useRef } from 'react';
import { isInTelegram, showMainButton, hideMainButton, setMainButtonLoading, setMainButtonEnabled } from '@/services/telegram';

/**
 * TelegramMainButton props interface
 */
interface TelegramMainButtonProps {
  /** Button text */
  text: string;
  /** Click handler */
  onClick: () => void;
  /** Whether button is visible */
  isVisible?: boolean;
  /** Whether button is enabled */
  isEnabled?: boolean;
  /** Whether button shows loading indicator */
  isLoading?: boolean;
  /** Button color (hex or theme key) */
  color?: string;
  /** Button text color (hex or theme key) */
  textColor?: string;
}

/**
 * Telegram Main Button component
 * Displays a native Telegram main button when running in Telegram WebApp
 */
export function TelegramMainButton({
  text,
  onClick,
  isVisible = true,
  isEnabled = true,
  isLoading = false,
  color,
  textColor,
}: TelegramMainButtonProps): React.ReactElement | null {
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
      hideMainButton();
      return;
    }

    // Show main button with callback wrapper
    showMainButton(
      text,
      () => {
        callbackRef.current();
      },
      { color, textColor }
    );

    // Set enabled state
    setMainButtonEnabled(isEnabled);

    // Set loading state
    setMainButtonLoading(isLoading);

    return () => {
      hideMainButton();
    };
  }, [text, isVisible, isEnabled, isLoading, color, textColor]);

  // Don't render anything - MainButton is handled by Telegram native UI
  return null;
}

export default TelegramMainButton;
