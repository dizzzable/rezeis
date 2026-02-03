import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  fetchNotifications as fetchNotificationsService,
  markAllAsRead as markAllAsReadService,
} from '@/services/notification.service';

/**
 * Notification type
 */
export type NotificationType = 'success' | 'error' | 'warning' | 'info';

/**
 * Notification action
 */
export interface NotificationAction {
  label: string;
  action: () => void;
}

/**
 * Notification interface
 */
export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: Date;
  persistent?: boolean;
  actions?: NotificationAction[];
}

/**
 * Notification state
 */
interface NotificationState {
  notifications: Notification[];
  unreadCount: number;

  // Actions
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void;
  removeNotification: (id: string) => void;
  markAsRead: (id: string) => void;
  clearAll: () => void;
  setUnreadCount: (count: number) => void;

  // Backend integration
  fetchNotifications: () => Promise<void>;
  markAllAsRead: () => Promise<void>;
}

/**
 * Generate unique notification ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Notification store
 */
export const useNotificationStore = create<NotificationState>()(
  devtools(
    (set, get) => ({
      notifications: [],
      unreadCount: 0,

      /**
       * Add a new notification
       */
      addNotification: (notification) => {
        const newNotification: Notification = {
          ...notification,
          id: generateId(),
          timestamp: new Date(),
        };

        set((state) => ({
          notifications: [newNotification, ...state.notifications].slice(0, 50), // Keep only last 50
          unreadCount: state.unreadCount + 1,
        }));

        // Auto-remove non-persistent notifications after 5 seconds
        if (!notification.persistent) {
          setTimeout(() => {
            get().removeNotification(newNotification.id);
          }, 5000);
        }
      },

      /**
       * Remove a notification by ID
       */
      removeNotification: (id) => {
        set((state) => {
          const notification = state.notifications.find((n) => n.id === id);
          return {
            notifications: state.notifications.filter((n) => n.id !== id),
            unreadCount: notification ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
          };
        });
      },

      /**
       * Mark notification as read
       */
      markAsRead: (_id) => {
        set((state) => ({
          unreadCount: Math.max(0, state.unreadCount - 1),
        }));
      },

      /**
       * Clear all notifications
       */
      clearAll: () => {
        set({
          notifications: [],
          unreadCount: 0,
        });
      },

      /**
       * Set unread count
       */
      setUnreadCount: (count) => {
        set({ unreadCount: count });
      },

      /**
       * Fetch notifications from backend
       */
      fetchNotifications: async () => {
        try {
          const notifications = await fetchNotificationsService();
          set({ notifications });
        } catch (err) {
          console.error('Error fetching notifications:', err);
        }
      },

      /**
       * Mark all notifications as read on backend
       */
      markAllAsRead: async () => {
        try {
          await markAllAsReadService();
          set({ unreadCount: 0 });
        } catch (err) {
          console.error('Error marking all as read:', err);
        }
      },
    }),
    { name: 'notification-store' }
  )
);

export default useNotificationStore;
