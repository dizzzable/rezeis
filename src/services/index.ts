/**
 * Services barrel export
 * Centralizes exports for all business logic services
 */

// Telegram-related services
export {
  telegramService,
  telegramWebSocketService,
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
  getTelegramLanguage,
  initTelegramLanguage,
} from './telegram';
export type { HapticImpactStyle, HapticNotificationType } from './telegram';

// Telegram theme service
export {
  telegramThemeService,
  applyTelegramTheme,
  clearTelegramTheme,
  initTelegramTheme,
  getTelegramColorPalette,
  isTelegramDarkTheme,
  getTelegramThemeClass,
  TG_CSS_VARIABLES,
} from './telegram-theme';

// WebSocket service
export {
  WebSocketService,
  initializeWebSocketService,
  getWebSocketService,
  useWebSocket,
} from './websocket';
export type {
  ConnectionState,
  WebSocketMessage,
  WebSocketServiceOptions,
  EventHandler,
} from './websocket';

// Notification service
export {
  notificationService,
  fetchNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getUnreadCount,
} from './notification.service';
export type {
  BackendNotification,
  FetchNotificationsOptions,
} from './notification.service';
