/**
 * Telegram WebApp Service
 * Provides a wrapper around Telegram WebApp API for Mini App integration
 */

import type { TelegramUser, ThemeParams, TelegramWebApp } from '@/types/telegram-webapp';

/**
 * Haptic feedback types
 */
export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
export type HapticNotificationType = 'error' | 'success' | 'warning';

/**
 * Check if the app is running inside Telegram WebApp
 * @returns True if running inside Telegram WebApp
 */
export function isInTelegram(): boolean {
  return typeof window !== 'undefined' && !!window.Telegram?.WebApp?.initData;
}

/**
 * Get Telegram WebApp instance
 * @returns Telegram WebApp instance or null if not in Telegram
 */
export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/**
 * Initialize Telegram WebApp
 * Should be called when the app starts
 */
export function initTelegramApp(): void {
  const webApp = getTelegramWebApp();
  if (!webApp) return;

  // Notify Telegram that the WebApp is ready
  webApp.ready();

  // Expand to full height
  webApp.expand();

  // Enable closing confirmation
  webApp.enableClosingConfirmation();

  // Disable vertical swipes for better scroll control
  if (webApp.disableVerticalSwipes) {
    webApp.disableVerticalSwipes();
  }
}

/**
 * Get Telegram user data from initData
 * @returns Telegram user data or null if not available
 */
export function getTelegramUser(): TelegramUser | null {
  const webApp = getTelegramWebApp();
  if (!webApp?.initDataUnsafe?.user) return null;
  return webApp.initDataUnsafe.user;
}

/**
 * Get Telegram init data string for validation
 * @returns Init data string or empty string if not available
 */
export function getInitData(): string {
  const webApp = getTelegramWebApp();
  return webApp?.initData ?? '';
}

/**
 * Validate Telegram init data by checking if it exists and has user
 * @returns True if init data is valid
 */
export function validateInitData(): boolean {
  const webApp = getTelegramWebApp();
  if (!webApp?.initData) return false;

  const user = webApp.initDataUnsafe?.user;
  return !!user && !!user.id;
}

/**
 * Expand the WebApp to full height
 */
export function expandApp(): void {
  const webApp = getTelegramWebApp();
  if (webApp) {
    webApp.expand();
  }
}

/**
 * Close the Mini App
 */
export function closeApp(): void {
  const webApp = getTelegramWebApp();
  if (webApp) {
    webApp.close();
  }
}

/**
 * Get current theme parameters
 * @returns Theme parameters or null
 */
export function getThemeParams(): ThemeParams | null {
  const webApp = getTelegramWebApp();
  return webApp?.themeParams ?? null;
}

/**
 * Get color scheme (light/dark)
 * @returns Color scheme or 'light' as default
 */
export function getColorScheme(): 'light' | 'dark' {
  const webApp = getTelegramWebApp();
  return webApp?.colorScheme ?? 'light';
}

/**
 * Get viewport height
 * @returns Current viewport height
 */
export function getViewportHeight(): number {
  const webApp = getTelegramWebApp();
  return webApp?.viewportHeight ?? window.innerHeight;
}

/**
 * Check if the app is expanded
 * @returns True if expanded
 */
export function isExpanded(): boolean {
  const webApp = getTelegramWebApp();
  return webApp?.isExpanded ?? true;
}

/**
 * Show Telegram Main Button
 * @param text - Button text
 * @param callback - Click callback
 * @param options - Optional button settings
 */
export function showMainButton(
  text: string,
  callback: () => void,
  options?: {
    color?: string;
    textColor?: string;
    isVisible?: boolean;
  }
): void {
  const webApp = getTelegramWebApp();
  if (!webApp?.MainButton) return;

  const button = webApp.MainButton;
  button.setText(text);
  button.onClick(callback);

  if (options?.color) {
    button.setParams({ color: options.color });
  }
  if (options?.textColor) {
    button.setParams({ text_color: options.textColor });
  }

  button.show();
}

/**
 * Hide Telegram Main Button
 */
export function hideMainButton(): void {
  const webApp = getTelegramWebApp();
  if (webApp?.MainButton) {
    webApp.MainButton.hide();
  }
}

/**
 * Set Main Button loading state
 * @param isLoading - Whether to show loading indicator
 */
export function setMainButtonLoading(isLoading: boolean): void {
  const webApp = getTelegramWebApp();
  if (!webApp?.MainButton) return;

  if (isLoading) {
    webApp.MainButton.showProgress(true);
  } else {
    webApp.MainButton.hideProgress();
  }
}

/**
 * Enable or disable Main Button
 * @param isEnabled - Whether button should be enabled
 */
export function setMainButtonEnabled(isEnabled: boolean): void {
  const webApp = getTelegramWebApp();
  if (!webApp?.MainButton) return;

  if (isEnabled) {
    webApp.MainButton.enable();
  } else {
    webApp.MainButton.disable();
  }
}

/**
 * Show Telegram Back Button
 * @param callback - Click callback
 */
export function showBackButton(callback: () => void): void {
  const webApp = getTelegramWebApp();
  if (!webApp?.BackButton) return;

  webApp.BackButton.onClick(callback);
  webApp.BackButton.show();
}

/**
 * Hide Telegram Back Button
 */
export function hideBackButton(): void {
  const webApp = getTelegramWebApp();
  if (webApp?.BackButton) {
    webApp.BackButton.hide();
  }
}

/**
 * Trigger haptic feedback
 * @param type - Type of feedback
 */
export function hapticFeedback(type: 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning'): void {
  const webApp = getTelegramWebApp();
  if (!webApp?.HapticFeedback) return;

  const haptic = webApp.HapticFeedback;

  switch (type) {
    case 'light':
      haptic.impactOccurred('light');
      break;
    case 'medium':
      haptic.impactOccurred('medium');
      break;
    case 'heavy':
      haptic.impactOccurred('heavy');
      break;
    case 'success':
      haptic.notificationOccurred('success');
      break;
    case 'error':
      haptic.notificationOccurred('error');
      break;
    case 'warning':
      haptic.notificationOccurred('warning');
      break;
  }
}

/**
 * Set header color
 * @param color - Color value or theme key
 */
export function setHeaderColor(color: 'bg_color' | 'secondary_bg_color' | string): void {
  const webApp = getTelegramWebApp();
  if (webApp?.setHeaderColor) {
    webApp.setHeaderColor(color);
  }
}

/**
 * Set background color
 * @param color - Color value or theme key
 */
export function setBackgroundColor(color: 'bg_color' | 'secondary_bg_color' | string): void {
  const webApp = getTelegramWebApp();
  if (webApp?.setBackgroundColor) {
    webApp.setBackgroundColor(color);
  }
}

/**
 * Show native popup
 * @param title - Popup title
 * @param message - Popup message
 * @param buttons - Button configurations
 * @returns Promise with clicked button id
 */
export function showPopup(
  title: string,
  message: string,
  buttons?: Array<{
    id?: string;
    type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive';
    text: string;
  }>
): Promise<string | null> {
  return new Promise((resolve) => {
    const webApp = getTelegramWebApp();
    if (!webApp?.showPopup) {
      // Fallback to browser confirm
      const result = window.confirm(`${title}\n\n${message}`);
      resolve(result ? 'ok' : null);
      return;
    }

    webApp.showPopup(
      {
        title,
        message,
        buttons: buttons ?? [{ text: 'OK' }],
      },
      (buttonId: string | null) => resolve(buttonId ?? null)
    );
  });
}

/**
 * Show native alert
 * @param message - Alert message
 * @returns Promise that resolves when alert is closed
 */
export function showAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    const webApp = getTelegramWebApp();
    if (!webApp?.showAlert) {
      window.alert(message);
      resolve();
      return;
    }

    webApp.showAlert(message, () => resolve());
  });
}

/**
 * Show native confirmation dialog
 * @param message - Confirmation message
 * @returns Promise with boolean result
 */
export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const webApp = getTelegramWebApp();
    if (!webApp?.showConfirm) {
      const result = window.confirm(message);
      resolve(result);
      return;
    }

    webApp.showConfirm(message, (confirmed: boolean) => resolve(confirmed));
  });
}

/**
 * Open external link
 * @param url - URL to open
 * @param options - Opening options
 */
export function openLink(url: string, options?: { try_instant_view?: boolean }): void {
  const webApp = getTelegramWebApp();
  if (webApp?.openLink) {
    webApp.openLink(url, options);
  } else {
    window.open(url, '_blank');
  }
}

/**
 * Open Telegram link
 * @param url - Telegram URL to open
 */
export function openTelegramLink(url: string): void {
  const webApp = getTelegramWebApp();
  if (webApp?.openTelegramLink) {
    webApp.openTelegramLink(url);
  } else {
    window.open(url, '_blank');
  }
}

/**
 * Send data to bot (closes the app)
 * @param data - Data to send
 */
export function sendData(data: string): void {
  const webApp = getTelegramWebApp();
  if (webApp?.sendData) {
    webApp.sendData(data);
  }
}

// Cloud Storage Methods

/**
 * Save data to cloud storage
 * @param key - Storage key
 * @param value - Value to store
 * @returns Promise with success status
 */
export function cloudStorageSet(key: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    const webApp = getTelegramWebApp();
    if (!webApp?.CloudStorage) {
      // Fallback to localStorage
      try {
        localStorage.setItem(`tg_cloud_${key}`, value);
        resolve(true);
      } catch {
        resolve(false);
      }
      return;
    }

    webApp.CloudStorage.setItem(key, value, (_error: string | null, success: boolean | null) => {
      resolve(success ?? false);
    });
  });
}

/**
 * Get data from cloud storage
 * @param key - Storage key
 * @returns Promise with stored value or null
 */
export function cloudStorageGet(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const webApp = getTelegramWebApp();
    if (!webApp?.CloudStorage) {
      // Fallback to localStorage
      try {
        const value = localStorage.getItem(`tg_cloud_${key}`);
        resolve(value);
      } catch {
        resolve(null);
      }
      return;
    }

    webApp.CloudStorage.getItem(key, (_error: string | null, value: string | null) => {
      resolve(value);
    });
  });
}

/**
 * Remove data from cloud storage
 * @param key - Storage key
 * @returns Promise with success status
 */
export function cloudStorageRemove(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    const webApp = getTelegramWebApp();
    if (!webApp?.CloudStorage) {
      // Fallback to localStorage
      try {
        localStorage.removeItem(`tg_cloud_${key}`);
        resolve(true);
      } catch {
        resolve(false);
      }
      return;
    }

    webApp.CloudStorage.removeItem(key, (_error: string | null, success: boolean | null) => {
      resolve(success ?? false);
    });
  });
}

// Language Detection

/**
 * Get language from Telegram WebApp
 * @returns Language code ('ru', 'en') or null if not in Telegram
 */
export function getTelegramLanguage(): string | null {
  const user = getTelegramUser();
  if (!user?.language_code) return null;

  // Map Telegram language codes to supported languages
  const lang = user.language_code.toLowerCase();
  if (lang === 'ru' || lang.startsWith('ru')) return 'ru';
  return 'en'; // Default to English for other languages
}

/**
 * Initialize language from Telegram WebApp
 * @param i18n - i18n instance to set language on
 */
export function initTelegramLanguage(i18n: { changeLanguage: (lang: string) => Promise<unknown> }): void {
  const tgLang = getTelegramLanguage();
  if (tgLang) {
    void i18n.changeLanguage(tgLang);
  }
}

// Event handling

/**
 * Subscribe to viewport changes
 * @param callback - Callback function for viewport changes
 * @returns Unsubscribe function
 */
export function onViewportChange(callback: (isStateStable: boolean) => void): () => void {
  const webApp = getTelegramWebApp();
  if (!webApp) return () => {};

  const handler = (event: { isStateStable: boolean }): void => {
    callback(event.isStateStable);
  };

  (webApp as TelegramWebApp & { onEvent: (event: string, handler: unknown) => void }).onEvent('viewportChanged', handler);

  return (): void => {
    (webApp as TelegramWebApp & { offEvent?: (event: string, handler: unknown) => void }).offEvent?.('viewportChanged', handler);
  };
}

/**
 * Subscribe to theme changes
 * @param callback - Callback function for theme changes
 * @returns Unsubscribe function
 */
export function onThemeChange(callback: () => void): () => void {
  const webApp = getTelegramWebApp();
  if (!webApp) return () => {};

  (webApp as TelegramWebApp & { onEvent: (event: string, handler: unknown) => void }).onEvent('themeChanged', callback);

  return (): void => {
    (webApp as TelegramWebApp & { offEvent?: (event: string, handler: unknown) => void }).offEvent?.('themeChanged', callback);
  };
}

/**
 * WebSocket integration for Telegram Mini App
 * Provides haptic feedback and popup notifications for WebSocket events
 */
export class TelegramWebSocketService {
  private notificationPriorityMap: Record<string, 'error' | 'success' | 'warning'> = {
    'subscription:expired': 'warning',
    'payment:failed': 'error',
    'system:maintenance:started': 'warning',
    'system:maintenance:ended': 'success',
    'system:broadcast': 'success',
    'error': 'error',
  };

  /**
   * Handle incoming WebSocket notification with haptic feedback
   */
  onNotificationReceived(notification: {
    type: string;
    title?: string;
    message?: string;
    priority?: 'low' | 'normal' | 'high' | 'critical';
  }): void {
    // Determine haptic feedback type based on notification priority/type
    let hapticType: 'error' | 'success' | 'warning';

    if (notification.priority === 'critical') {
      hapticType = 'error';
    } else if (notification.priority === 'high') {
      hapticType = 'warning';
    } else {
      hapticType = this.notificationPriorityMap[notification.type] || 'success';
    }

    // Trigger haptic feedback
    hapticFeedback(hapticType);

    // Show popup for important notifications in Telegram
    if (
      notification.type === 'system:broadcast' ||
      notification.type === 'system:maintenance:started' ||
      notification.type === 'payment:failed' ||
      notification.priority === 'critical'
    ) {
      const title = notification.title || 'Уведомление';
      const message = notification.message || '';

      showPopup(title, message, [{ id: 'ok', type: 'ok', text: 'OK' }]);
    }
  }

  /**
   * Show loading state during WebSocket connection
   */
  showConnectionLoading(): void {
    const webApp = getTelegramWebApp();
    if (webApp?.MainButton) {
      webApp.MainButton.showProgress(true);
    }
  }

  /**
   * Hide loading state after WebSocket connection
   */
  hideConnectionLoading(): void {
    const webApp = getTelegramWebApp();
    if (webApp?.MainButton) {
      webApp.MainButton.hideProgress();
    }
  }

  /**
   * Show connection status popup
   */
  showConnectionStatus(isConnected: boolean): void {
    if (!isConnected) {
      hapticFeedback('warning');
    } else {
      hapticFeedback('success');
    }
  }
}

// Export singleton instance
export const telegramWebSocketService = new TelegramWebSocketService();

/**
 * Telegram service object with all methods
 */
export const telegramService = {
  isInTelegram,
  initTelegramApp,
  getTelegramUser,
  getInitData,
  validateInitData,
  expandApp,
  closeApp,
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
  openLink,
  openTelegramLink,
  sendData,
  cloudStorageSet,
  cloudStorageGet,
  cloudStorageRemove,
  onViewportChange,
  onThemeChange,
  // Language detection
  getTelegramLanguage,
  initTelegramLanguage,
  // WebSocket integration
  telegramWebSocketService,
};

export default telegramService;
