/**
 * Telegram WebApp theme colors
 */
export interface ThemeParams {
  /** Background color */
  bg_color?: string;
  /** Text color */
  text_color?: string;
  /** Hint text color */
  hint_color?: string;
  /** Link color */
  link_color?: string;
  /** Button color */
  button_color?: string;
  /** Button text color */
  button_text_color?: string;
  /** Secondary background color */
  secondary_bg_color?: string;
}

/**
 * Telegram WebApp user data from initDataUnsafe
 */
export interface TelegramUser {
  /** Unique identifier for this user or bot */
  id: number;
  /** True, if this user is a bot */
  is_bot?: boolean;
  /** User's or bot's first name */
  first_name: string;
  /** User's or bot's last name */
  last_name?: string;
  /** User's or bot's username */
  username?: string;
  /** IETF language tag of the user's language */
  language_code?: string;
  /** True, if this user is a Telegram Premium user */
  is_premium?: boolean;
  /** True, if this user added the bot to the attachment menu */
  added_to_attachment_menu?: boolean;
  /** True, if this user allowed the bot to message them */
  allows_write_to_pm?: boolean;
  /** URL of the user's profile photo. The photo can be in .jpeg or .svg formats. Only returned for Web Apps launched from the attachment menu. */
  photo_url?: string;
}

/**
 * Telegram WebApp chat data (when opened via attachment menu)
 */
export interface TelegramChat {
  /** Unique identifier for this chat */
  id: number;
  /** Type of chat, can be either 'group', 'supergroup' or 'channel' */
  type: 'group' | 'supergroup' | 'channel';
  /** Title of the chat */
  title: string;
  /** Username of the chat */
  username?: string;
  /** URL of the chat's photo. The photo can be in .jpeg or .svg formats */
  photo_url?: string;
}

/**
 * Telegram WebApp initDataUnsafe structure
 */
export interface InitDataUnsafe {
  /** Query ID for Telegram API */
  query_id?: string;
  /** User data */
  user?: TelegramUser;
  /** Receiver data (for chats) */
  receiver?: TelegramUser;
  /** Chat data */
  chat?: TelegramChat;
  /** Chat instance identifier */
  chat_instance?: string;
  /** Chat type */
  chat_type?: 'sender' | 'private' | 'group' | 'supergroup' | 'channel';
  /** Start parameter passed in startAttach or startapp */
  start_param?: string;
  /** Timestamp when the Web App was opened */
  auth_date?: number;
  /** Hash for validation */
  hash?: string;
}

/**
 * Telegram WebApp BackButton
 */
export interface BackButton {
  /** Shows whether the button is visible */
  isVisible: boolean;
  /** Bot API 6.1+ A method that sets the button press event handler */
  onClick(callback: () => void): void;
  /** Bot API 6.1+ A method that removes the button press event handler */
  offClick(callback: () => void): void;
  /** Bot API 6.1+ A method to make the button active and visible */
  show(): void;
  /** Bot API 6.1+ A method to hide the button */
  hide(): void;
}

/**
 * Telegram WebApp MainButton
 */
export interface MainButton {
  /** Current button text */
  text: string;
  /** Current button color */
  color: string;
  /** Current button text color */
  textColor: string;
  /** Shows whether the button is visible */
  isVisible: boolean;
  /** Shows whether the button is active */
  isActive: boolean;
  /** Readonly. Shows whether the button is displaying a loading indicator */
  isProgressVisible: boolean;
  /** A method to set the button text */
  setText(text: string): void;
  /** A method to set the button press event handler */
  onClick(callback: () => void): void;
  /** A method to remove the button press event handler */
  offClick(callback: () => void): void;
  /** A method to make the button visible */
  show(): void;
  /** A method to hide the button */
  hide(): void;
  /** A method to enable the button */
  enable(): void;
  /** A method to disable the button */
  disable(): void;
  /** A method to show a loading indicator on the button */
  showProgress(leaveActive?: boolean): void;
  /** A method to hide the loading indicator */
  hideProgress(): void;
  /** A method to set the button parameters */
  setParams(params: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }): void;
}

/**
 * Telegram WebApp HapticFeedback
 */
export interface HapticFeedback {
  /** Bot API 6.1+ A method that tells that an impact occurred */
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  /** Bot API 6.1+ A method that tells that a task or action has succeeded */
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  /** Bot API 6.1+ A method that tells that the user has changed a selection */
  selectionChanged(): void;
}

/**
 * Telegram WebApp CloudStorage
 */
export interface CloudStorage {
  /** Bot API 6.9+ A method that stores a value in the cloud storage */
  setItem(key: string, value: string, callback?: (error: string | null, success: boolean | null) => void): void;
  /** Bot API 6.9+ A method that receives a value from the cloud storage */
  getItem(key: string, callback: (error: string | null, value: string | null) => void): void;
  /** Bot API 6.9+ A method that receives values from the cloud storage */
  getItems(keys: string[], callback: (error: string | null, values: Record<string, string | null>) => void): void;
  /** Bot API 6.9+ A method that removes a value from the cloud storage */
  removeItem(key: string, callback?: (error: string | null, success: boolean | null) => void): void;
  /** Bot API 6.9+ A method that removes values from the cloud storage */
  removeItems(keys: string[], callback?: (error: string | null, success: boolean | null) => void): void;
  /** Bot API 6.9+ A method that receives the list of all keys stored in the cloud storage */
  getKeys(callback: (error: string | null, keys: string[]) => void): void;
}

/**
 * Telegram WebApp interface
 */
export interface TelegramWebApp {
  /** Web App init data */
  initData: string;
  /** Web App init data unsafe (parsed) */
  initDataUnsafe: InitDataUnsafe;
  /** Web App version */
  version: string;
  /** Platform name */
  platform: string;
  /** Color scheme (light/dark) */
  colorScheme: 'light' | 'dark';
  /** Theme parameters */
  themeParams: ThemeParams;
  /** Is the Web App expanded */
  isExpanded: boolean;
  /** Current viewport height */
  viewportHeight: number;
  /** Current stable viewport height */
  viewportStableHeight: number;
  /** Is the confirmation dialog enabled when closing */
  isClosingConfirmationEnabled: boolean;
  /** Is the vertical swiping enabled */
  isVerticalSwipesEnabled: boolean;
  /** BackButton instance */
  BackButton: BackButton;
  /** MainButton instance */
  MainButton: MainButton;
  /** HapticFeedback instance */
  HapticFeedback: HapticFeedback;
  /** CloudStorage instance */
  CloudStorage: CloudStorage;
  /** A method that informs the Telegram app that the Web App is ready to be displayed */
  ready(): void;
  /** A method that expands the Web App to the maximum available height */
  expand(): void;
  /** A method that closes the Web App */
  close(): void;
  /** A method that enables the confirmation dialog while closing the Web App */
  enableClosingConfirmation(): void;
  /** A method that disables the confirmation dialog while closing the Web App */
  disableClosingConfirmation(): void;
  /** A method that sets the app header color */
  setHeaderColor(color: 'bg_color' | 'secondary_bg_color' | string): void;
  /** A method that sets the app background color */
  setBackgroundColor(color: 'bg_color' | 'secondary_bg_color' | string): void;
  /** A method that sends data to the bot */
  sendData(data: string): void;
  /** A method that opens a link in an external browser */
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  /** A method that opens a telegram link */
  openTelegramLink(url: string): void;
  /** A method that opens an invoice */
  openInvoice(url: string, callback?: (status: 'paid' | 'cancelled' | 'failed' | 'pending') => void): void;
  /** A method that shows a native popup */
  showPopup(params: {
    title?: string;
    message: string;
    buttons?: Array<{ id?: string; type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive'; text: string }>;
  }, callback?: (buttonId: string | null) => void): void;
  /** A method that shows an alert */
  showAlert(message: string, callback?: () => void): void;
  /** A method that shows a confirmation */
  showConfirm(message: string, callback?: (confirmed: boolean) => void): void;
  /** A method that sets a handler for viewport changes */
  onEvent(eventType: 'viewportChanged', eventHandler: (event: { isStateStable: boolean }) => void): void;
  /** A method that sets a handler for theme changes */
  onEvent(eventType: 'themeChanged', eventHandler: () => void): void;
  /** A method that sets a handler for main button presses */
  onEvent(eventType: 'mainButtonClicked', eventHandler: () => void): void;
  /** A method that sets a handler for back button presses */
  onEvent(eventType: 'backButtonClicked', eventHandler: () => void): void;
  /** A method that sets a handler for popup closed events */
  onEvent(eventType: 'popupClosed', eventHandler: (event: { button_id: string | null }) => void): void;
  /** A method that sets a handler for invoice closed events */
  onEvent(eventType: 'invoiceClosed', eventHandler: (event: { url: string; status: 'paid' | 'cancelled' | 'failed' | 'pending' }) => void): void;
  /** A method that sets a handler for viewport changes */
  offEvent(eventType: 'viewportChanged', eventHandler: (event: { isStateStable: boolean }) => void): void;
  /** A method that removes a handler for theme changes */
  offEvent(eventType: 'themeChanged', eventHandler: () => void): void;
  /** A method that removes a handler for main button presses */
  offEvent(eventType: 'mainButtonClicked', eventHandler: () => void): void;
  /** A method that removes a handler for back button presses */
  offEvent(eventType: 'backButtonClicked', eventHandler: () => void): void;
  /** A method that removes a handler for popup closed events */
  offEvent(eventType: 'popupClosed', eventHandler: (event: { button_id: string | null }) => void): void;
  /** A method that removes a handler for invoice closed events */
  offEvent(eventType: 'invoiceClosed', eventHandler: (event: { url: string; status: 'paid' | 'cancelled' | 'failed' | 'pending' }) => void): void;
  /** A method that requests write access to the user's messages */
  requestWriteAccess(callback?: (success: boolean) => void): void;
  /** A method that requests contact information */
  requestContact(callback?: (success: boolean, response: { response: string | null }) => void): void;
  /** A method that enables vertical swipes */
  enableVerticalSwipes(): void;
  /** A method that disables vertical swipes */
  disableVerticalSwipes(): void;
}

/**
 * Telegram WebApp global declaration
 */
declare global {
  interface Window {
    /** Telegram WebApp API */
    Telegram?: {
      WebApp: TelegramWebApp;
    };
  }
}

export {};
