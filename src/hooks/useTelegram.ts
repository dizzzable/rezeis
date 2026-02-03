/**
 * useTelegram Hook
 * React hook for accessing Telegram WebApp functionality
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  isInTelegram,
  getTelegramUser,
  getThemeParams,
  getColorScheme,
  getViewportHeight,
  isExpanded,
  showMainButton,
  hideMainButton,
  setMainButtonLoading,
  setMainButtonEnabled,
  showBackButton,
  hideBackButton,
  hapticFeedback,
  setHeaderColor,
  setBackgroundColor,
  showPopup,
  showAlert,
  showConfirm,
  closeApp,
  expandApp,
  sendData,
  cloudStorageSet,
  cloudStorageGet,
  cloudStorageRemove,
  onViewportChange,
  onThemeChange,
} from '@/services/telegram';
import type { TelegramUser, ThemeParams } from '@/types/telegram-webapp';

/**
 * Options for useMainButton
 */
interface UseMainButtonOptions {
  text: string;
  onClick: () => void;
  isVisible?: boolean;
  isEnabled?: boolean;
  isLoading?: boolean;
  color?: string;
  textColor?: string;
}

/**
 * Options for useBackButton
 */
interface UseBackButtonOptions {
  isVisible: boolean;
  onClick: () => void;
}

/**
 * Hook for accessing Telegram WebApp state and methods
 * @returns Telegram WebApp state and methods
 */
export function useTelegram() {
  const [telegramUser, setTelegramUser] = useState<TelegramUser | null>(null);
  const [themeParams, setThemeParams] = useState<ThemeParams | null>(null);
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>('light');
  const [viewportHeight, setViewportHeight] = useState<number>(window.innerHeight);
  const [isAppExpanded, setIsAppExpanded] = useState<boolean>(true);

  useEffect(() => {
    // Initial state
    setTelegramUser(getTelegramUser());
    setThemeParams(getThemeParams());
    setColorScheme(getColorScheme());
    setViewportHeight(getViewportHeight());
    setIsAppExpanded(isExpanded());

    // Subscribe to viewport changes
    const unsubscribeViewport = onViewportChange(() => {
      setViewportHeight(getViewportHeight());
      setIsAppExpanded(isExpanded());
    });

    // Subscribe to theme changes
    const unsubscribeTheme = onThemeChange(() => {
      setThemeParams(getThemeParams());
      setColorScheme(getColorScheme());
    });

    return () => {
      unsubscribeViewport();
      unsubscribeTheme();
    };
  }, []);

  const triggerHaptic = useCallback((type: 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning') => {
    hapticFeedback(type);
  }, []);

  return {
    // State
    isInTelegram: isInTelegram(),
    telegramUser,
    themeParams,
    colorScheme,
    viewportHeight,
    isExpanded: isAppExpanded,
    // Methods
    closeApp,
    expandApp,
    setHeaderColor,
    setBackgroundColor,
    hapticFeedback: triggerHaptic,
    showPopup,
    showAlert,
    showConfirm,
    sendData,
    cloudStorageSet,
    cloudStorageGet,
    cloudStorageRemove,
  };
}

/**
 * Hook for managing Telegram Main Button
 * @param options - Main button configuration
 */
export function useMainButton(options: UseMainButtonOptions) {
  const { text, onClick, isVisible = true, isEnabled = true, isLoading = false, color, textColor } = options;
  const callbackRef = useRef(onClick);

  // Update callback ref
  useEffect(() => {
    callbackRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!isInTelegram() || !isVisible) {
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
}

/**
 * Hook for managing Telegram Back Button
 * @param options - Back button configuration
 */
export function useBackButton(options: UseBackButtonOptions) {
  const { isVisible, onClick } = options;
  const callbackRef = useRef(onClick);

  // Update callback ref
  useEffect(() => {
    callbackRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!isInTelegram() || !isVisible) {
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
}

/**
 * Hook for haptic feedback
 * @returns Haptic feedback function
 */
export function useHapticFeedback() {
  const trigger = useCallback((type: 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning') => {
    hapticFeedback(type);
  }, []);

  return trigger;
}

/**
 * Hook for cloud storage operations
 * @returns Cloud storage methods
 */
export function useCloudStorage() {
  const setItem = useCallback(async (key: string, value: string): Promise<boolean> => {
    return cloudStorageSet(key, value);
  }, []);

  const getItem = useCallback(async (key: string): Promise<string | null> => {
    return cloudStorageGet(key);
  }, []);

  const removeItem = useCallback(async (key: string): Promise<boolean> => {
    return cloudStorageRemove(key);
  }, []);

  return {
    setItem,
    getItem,
    removeItem,
  };
}

/**
 * Combined telegram hooks export
 */
export const telegramHooks = {
  useTelegram,
  useMainButton,
  useBackButton,
  useHapticFeedback,
  useCloudStorage,
};

export default useTelegram;
